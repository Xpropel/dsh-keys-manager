import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { LlmError, assertUsableApiKey, isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmFailure, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Options as OfficialOptions } from '@deepseek-ai/dsh-llm-deepseek-api-key'
import { KeyPool, PoolError } from './pool.ts'
import { classifyNativeRequestError, hasSafePrototype, safeRequestErrorType } from './request-errors.ts'
import { createRequestDiagnostics } from './request-diagnostics.ts'
import { createOfficialConnectionSource } from './official-config.ts'
import { registerOfficialPoolTransport, type PoolConnection } from './official-provider.ts'

export const PROVIDER = 'deepseek-key-pool'
export const ROTATE_CODE = 'KEY_POOL_ROTATE'

/** A finite budget per agent step, even when a balance refresh races a failure. */
export class RotationBudget {
  private states = new WeakMap<object, { turn: number; step: number; remaining: number }>()

  allow(owner: object, turn: number, step: number, keyCount: number): boolean {
    let state = this.states.get(owner)
    if (!state || state.turn !== turn || state.step !== step) {
      state = { turn, step, remaining: Math.max(0, keyCount - 1) }
      this.states.set(owner, state)
    }
    if (state.remaining <= 0) return false
    state.remaining--
    return true
  }
}

function canRotate(pool: KeyPool): boolean {
  const state = pool.snapshot()
  return state.settings.autoSwitch && state.keys.some(key => key.enabled && key.status !== 'invalid' && key.status !== 'exhausted')
}

function isLlmError(error: unknown): error is LlmError {
  return hasSafePrototype(error, LlmError.prototype)
}

/** Only quota exhaustion changes official request behavior; every other error is untouched. */
export async function credentialFailure(pool: KeyPool, id: string, error: unknown, signal?: AbortSignal): Promise<unknown> {
  if (signal?.aborted || !isLlmError(error) || error.failure.status !== 402) return error
  const status = error.failure.status
  try { await pool.reportFailure(id, status) }
  catch {
    // The transport rethrows its original provider error if this callback throws.
    return new LlmError('无法保存 Key 状态，自动切换已停止。请重新加载插件后重试。', 'KEY_POOL_STATE_ERROR', { status })
  }
  const state = pool.snapshot()
  const failure = '当前 API Key 余额不足（HTTP 402）。'
  const message = !state.settings.autoSwitch
    ? `${failure}自动切换已关闭，请手动选择可用 Key 后重试。`
    : !canRotate(pool)
      ? '所有已启用 Key 均不可用于当前请求，已停止自动切换。请刷新余额、充值或添加可用 Key 后重试。'
      : failure
  return new LlmError(message, ROTATE_CODE, { status })
}

function isRotation(failure: LlmFailure): boolean {
  return failure.code === ROTATE_CODE && failure.status === 402
}

/** Raw consumers may retry only before handing any chunks to their caller. */
export async function* rotateUnstartedStream(
  pool: KeyPool,
  options: GenerateOptions,
  firstAttempt: () => AsyncIterable<StreamChunk>,
  retryAttempt: () => AsyncIterable<StreamChunk>,
): AsyncIterable<StreamChunk> {
  const maxAttempts = Math.max(1, pool.snapshot().keys.length)
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    options.signal?.throwIfAborted()
    let emitted = false
    let retry = false
    for await (const chunk of attempt === 0 ? firstAttempt() : retryAttempt()) {
      options.signal?.throwIfAborted()
      if (!emitted && chunk.type === 'finish' && chunk.reason.kind === 'error'
        && isRotation(chunk.reason.failure) && canRotate(pool) && attempt + 1 < maxAttempts) {
        retry = true
        break
      }
      emitted = true
      yield chunk
    }
    if (!retry) return
  }
}

/** Reuse official Messages/Files transport and the durable agent recovery seam. */
export function registerPoolProvider(ctx: Context, pool: KeyPool, internal?: { baseURL?: string; options?: () => OfficialOptions }): void {
  const requests = new AsyncLocalStorage<{
    signal?: AbortSignal; usedIds: Set<string>; requestId: string; sessionId?: string;
    model: string; startedAt: number; receivedChunks: number;
    lastError?: { keyId: string; errorType: string; networkCode?: string };
    rotationConnection?: PoolConnection;
  }>()
  const diagnostics = createRequestDiagnostics()
  let disposed = false
  const source = createOfficialConnectionSource(ctx, internal?.options || internal?.baseURL
    ? () => ({ ...internal.options?.(), ...(internal.baseURL === undefined ? {} : { baseURL: internal.baseURL }) })
    : undefined)
  registerOfficialPoolTransport(ctx, PROVIDER, source, {
    rotationConnection: () => requests.getStore()?.rotationConnection,
    present: async connection => {
      try {
        // Discovery needs a credential, not a balance-observation side effect.
        const lease = await pool.acquire(undefined, { observeBalance: false })
        return assertUsableApiKey(lease.key, 'llm-deepseek', connection.apiKeyEnv)
      } catch (error) {
        if (error instanceof PoolError && error.code === 'NO_AVAILABLE_KEY') return undefined
        throw error
      }
    },
    resolveAuth: async connection => {
      const request = requests.getStore()
      let lease: Awaited<ReturnType<KeyPool['acquire']>>
      try { lease = await pool.acquire(request?.signal) }
      catch (error) {
        if (error instanceof PoolError) throw new LlmError(error.message, 'KEY_POOL_UNAVAILABLE')
        throw error
      }
      request?.usedIds.add(lease.id)
      return {
        headers: { 'x-api-key': assertUsableApiKey(lease.key, 'llm-deepseek', connection.apiKeyEnv) },
        onRequestError: async error => {
          if (request) {
            const native = classifyNativeRequestError(error, request?.signal)
            request.lastError = { keyId: lease.id, errorType: isLlmError(error) ? 'LlmError' : safeRequestErrorType(error), networkCode: native.networkCode }
          }
          // In particular, raw TypeErrors reach the official outer TRANSPORT wrapper.
          // This hook must never rename, sanitize, or reconstruct non-quota errors.
          const failure = await credentialFailure(pool, lease.id, error, request?.signal)
          if (request && isLlmError(failure) && isRotation(failure.failure)) {
            request.rotationConnection = connection
          }
          return failure
        },
      }
    },
  })

  const budget = new RotationBudget()
  ctx.effect(() => async () => {
    disposed = true; requests.disable()
    await diagnostics.flush()
  }, 'key-pool: stop recovery and flush safe diagnostics')
  ctx.on('agent/request-error', async (payload, next) => {
    if (payload.provider !== PROVIDER || !isRotation(payload.failure)) return next()
    payload.signal.throwIfAborted()
    // Do not delegate exhausted rotation to an unrelated unbounded retry policy.
    if (disposed || !canRotate(pool)
      || !budget.allow(payload.agent, payload.turn, payload.step, pool.snapshot().keys.length)) return undefined
    return { kind: 'retry' }
  })
  // Each 402 retry enters a fresh Host waterfall. Only the outer call owns the
  // rotation budget, diagnostics and balance refresh for this logical stream.
  const redispatch = new WeakSet<GenerateOptions>()
  ctx.on('llm/stream', (request, next) => {
    if (request.provider !== PROVIDER) return next()
    if (redispatch.delete(request)) return next()
    const retryAttempt = () => {
      redispatch.add(request)
      try { return ctx.llm.stream(request) }
      finally { redispatch.delete(request) }
    }
    const upstream = () => isAgentLoopRequest(request) ? next() : rotateUnstartedStream(pool, request, next, retryAttempt)
    return (async function* (): AsyncIterable<StreamChunk> {
      const usage: NonNullable<ReturnType<typeof requests.getStore>> = {
        signal: request.signal, usedIds: new Set<string>(), requestId: randomUUID(),
        sessionId: request.sessionId === undefined ? undefined : String(request.sessionId),
        model: request.model, startedAt: Date.now(), receivedChunks: 0,
      }
      const iterator = requests.run(usage, () => upstream()[Symbol.asyncIterator]())
      let completed = false
      try {
        while (true) {
          const item = await requests.run(usage, () => iterator.next())
          if (item.done) { completed = true; return }
          if (item.value.type !== 'finish') usage.receivedChunks++
          else if (!disposed && item.value.reason.kind === 'error') {
            // Observe the final classification chosen by the official adapter; facts
            // captured in the auth hook are diagnostic-only and never affect routing.
            try {
              const failure = item.value.reason.failure
              diagnostics.record({
                requestId: usage.requestId, sessionId: usage.sessionId, keyId: usage.lastError?.keyId,
                model: usage.model, phase: usage.receivedChunks ? 'during-stream' : 'before-output',
                code: failure.code, errorType: usage.lastError?.errorType ?? 'Unknown',
                networkCode: usage.lastError?.networkCode, status: failure.status,
                elapsedMs: Math.max(0, Date.now() - usage.startedAt), receivedChunks: usage.receivedChunks,
              })
            } catch { /* Diagnostics never change a stream chunk or throw into its consumer. */ }
          }
          yield item.value
        }
      } finally {
        try {
          if (!completed && iterator.return) await requests.run(usage, () => iterator.return!())
        } finally {
          // A targeted check is best-effort, coalesced, and never changes the model result.
          void pool.scheduleRefresh([...usage.usedIds])
        }
      }
    })()
  })
}
