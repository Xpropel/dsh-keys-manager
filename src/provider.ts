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
/** Hard cap on credential attempts for one logical request, including the first. */
export const MAX_ROTATION_ATTEMPTS = 5

/** Per-logical-request facts shared across a fresh Host waterfall (e.g. a 402 redispatch). */
export interface RequestScope {
  signal?: AbortSignal
  usedIds: Set<string>
  requestId: string
  sessionId?: string
  model: string
  startedAt: number
  receivedChunks: number
  lastError?: { keyId: string; errorType: string; networkCode?: string }
  rotationConnection?: PoolConnection
}

/** A finite budget per agent step, even when a balance refresh races a failure. */
export class RotationBudget {
  private states = new WeakMap<object, { turn: number; step: number; remaining: number }>()

  allow(owner: object, turn: number, step: number, keyCount: number): boolean {
    let state = this.states.get(owner)
    if (!state || state.turn !== turn || state.step !== step) {
      // The hard attempt cap and the available key count both bound one step.
      state = { turn, step, remaining: Math.max(0, Math.min(keyCount - 1, MAX_ROTATION_ATTEMPTS - 1)) }
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

/**
 * Tracks one logical request across a fresh Host waterfall.
 *
 * Cordis 4.1 gives every listener's `next()` exactly one call, so a 402 retry must
 * enter a new waterfall (`ctx.llm.stream`) instead of reusing the failed attempt's
 * `next`. The mark must outlive the return of `ctx.llm.stream`: an upstream
 * `llm/stream` listener may call its own `next()` asynchronously while the retry
 * stream is being consumed, and that re-entry is the same retry, not a new request.
 */
export class RedispatchTracker {
  private readonly marked = new WeakSet<GenerateOptions>()

  has(request: GenerateOptions): boolean { return this.marked.has(request) }

  /** Run a fresh dispatch; release the mark only after the returned stream ends. */
  run(request: GenerateOptions, dispatch: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
    this.marked.add(request)
    let stream: AsyncIterable<StreamChunk>
    try { stream = dispatch() }
    catch (error) {
      this.marked.delete(request)
      throw error
    }
    const release = (): void => { this.marked.delete(request) }
    return (async function* (): AsyncIterable<StreamChunk> {
      try { yield* stream }
      finally { release() }
    })()
  }
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

/**
 * Report an officially classified credential rejection (blank/undeliverable key)
 * without rewriting the official failure. Key-health bookkeeping is best-effort.
 */
export function reportInvalidCredential(pool: KeyPool, id: string, error: unknown): boolean {
  if (!isLlmError(error) || error.failure.code !== 'INVALID_CREDENTIAL') return false
  void pool.reportInvalidCredential(id).catch(() => undefined)
  return true
}

function isRotation(failure: LlmFailure): boolean {
  return failure.code === ROTATE_CODE && failure.status === 402
}

/**
 * The official auth hook's error mapping. Exported so the quota/credential
 * contracts can be tested without synthesizing an unreachable transport failure.
 */
export async function handleAuthRequestError(args: {
  pool: KeyPool
  leaseId: string
  connection: PoolConnection
  request?: RequestScope
  error: unknown
}): Promise<unknown> {
  const { pool, leaseId, connection, request, error } = args
  if (request) {
    const native = classifyNativeRequestError(error, request.signal)
    request.lastError = { keyId: leaseId, errorType: isLlmError(error) ? 'LlmError' : safeRequestErrorType(error), networkCode: native.networkCode }
  }
  // An upstream credential rejection changes only key health; the official error
  // keeps its identity, code, and message.
  if (reportInvalidCredential(pool, leaseId, error)) return error
  // In particular, raw TypeErrors reach the official outer TRANSPORT wrapper.
  // This hook must never rename, sanitize, or reconstruct non-quota errors.
  const failure = await credentialFailure(pool, leaseId, error, request?.signal)
  if (request && isLlmError(failure) && isRotation(failure.failure)) {
    request.rotationConnection = connection
  }
  return failure
}

export interface RotationLimit {
  attempts: number
  failure: LlmFailure
}

/** Raw consumers may retry only before handing any chunks to their caller. */
export async function* rotateUnstartedStream(
  pool: KeyPool,
  options: GenerateOptions,
  firstAttempt: () => AsyncIterable<StreamChunk>,
  retryAttempt: () => AsyncIterable<StreamChunk>,
  onRotationLimit?: (limit: RotationLimit) => void,
): AsyncIterable<StreamChunk> {
  // Including the first attempt: never more than the hard cap or the available keys.
  const maxAttempts = Math.max(1, Math.min(pool.snapshot().keys.length, MAX_ROTATION_ATTEMPTS))
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    options.signal?.throwIfAborted()
    let emitted = false
    let retry = false
    for await (const chunk of attempt === 0 ? firstAttempt() : retryAttempt()) {
      options.signal?.throwIfAborted()
      if (!emitted && chunk.type === 'finish' && chunk.reason.kind === 'error'
        && isRotation(chunk.reason.failure)) {
        if (canRotate(pool) && attempt + 1 < maxAttempts) {
          retry = true
          break
        }
        // Keys remain but the hard attempt cap ended the rotation: report it once.
        if (canRotate(pool) && onRotationLimit !== undefined) {
          try { onRotationLimit({ attempts: attempt + 1, failure: chunk.reason.failure }) }
          catch { /* Diagnostics never change the stream. */ }
        }
      }
      emitted = true
      yield chunk
    }
    if (!retry) return
  }
}

/**
 * Lightweight capability probe for Hosts older than the DSH 0.2.2 / Cordis 4.1
 * surface this release targets. It never throws into provider registration.
 */
export function probeHostCapabilities(ctx: Context, hasConfigOverride = false): string[] {
  const missing: string[] = []
  try {
    if (typeof ctx.on !== 'function' || typeof ctx.effect !== 'function' || typeof ctx.get !== 'function') {
      missing.push('cordis-events')
    }
    if (ctx.get('llm') === undefined) missing.push('llm')
    const discovery = hasConfigOverride || ctx.get('loader') !== undefined
      || ctx.get('configEditor') !== undefined || ctx.get('settings') !== undefined
    if (!discovery) missing.push('official-config-discovery')
    // Cordis 4.1 exposes validated live settings as `fiber.effectiveConfig`.
    if (!hasConfigOverride && discovery && !('effectiveConfig' in ctx.fiber)) missing.push('fiber.effectiveConfig')
  } catch {
    missing.push('cordis-context')
  }
  return missing
}

let warnedHostCapabilities = false

/** Warn once when the Host is missing a seam this plugin relies on; never throw. */
export function warnMissingHostCapabilities(missing: readonly string[]): boolean {
  if (missing.length === 0 || warnedHostCapabilities) return false
  warnedHostCapabilities = true
  console.warn(
    '[deepseek-key-pool]',
    `检测到可能不受支持的宿主版本（缺少 ${missing.join(', ')}）；Key 池仍会注册，但相关功能可能不可用。`,
  )
  return true
}

/** Reuse official Messages/Files transport and the durable agent recovery seam. */
export function registerPoolProvider(
  ctx: Context,
  pool: KeyPool,
  internal?: { baseURL?: string; options?: () => OfficialOptions },
): { redispatch: RedispatchTracker } {
  const requests = new AsyncLocalStorage<RequestScope>()
  const diagnostics = createRequestDiagnostics()
  let disposed = false
  const source = createOfficialConnectionSource(ctx, internal?.options || internal?.baseURL
    ? () => ({ ...internal.options?.(), ...(internal.baseURL === undefined ? {} : { baseURL: internal.baseURL }) })
    : undefined)
  warnMissingHostCapabilities(probeHostCapabilities(ctx, internal?.options !== undefined || internal?.baseURL !== undefined))
  // Balance checks follow the official connection's origin instead of a hard-coded
  // public endpoint; a temporarily unavailable official config falls back centrally.
  pool.useBalanceBaseURL(() => {
    try { return source.get().baseURL }
    catch { return undefined }
  })
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
      try {
        if (request !== undefined && request.usedIds.size > 0) {
          // A 402 rotation reuses the logical request's first-use baseline: waiting
          // for another check would stack up to three extra seconds per rotation.
          lease = await pool.acquire(request.signal, { observeBalance: false })
          void pool.scheduleRefresh([lease.id])
        } else {
          lease = await pool.acquire(request?.signal)
        }
      } catch (error) {
        if (error instanceof PoolError) throw new LlmError(error.message, 'KEY_POOL_UNAVAILABLE')
        throw error
      }
      request?.usedIds.add(lease.id)
      let headerKey: string
      try { headerKey = assertUsableApiKey(lease.key, 'llm-deepseek', connection.apiKeyEnv) }
      catch (error) {
        // The installed 0.2.2 adapters await resolveAuth before the onRequestError
        // wrapper, so an unusable stored secret is classified here; semantics stay.
        reportInvalidCredential(pool, lease.id, error)
        throw error
      }
      return {
        headers: { 'x-api-key': headerKey },
        onRequestError: async error => handleAuthRequestError({ pool, leaseId: lease.id, connection, request, error }),
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
  const redispatch = new RedispatchTracker()
  ctx.on('llm/stream', (request, next) => {
    if (request.provider !== PROVIDER) return next()
    if (redispatch.has(request)) return next()
    const retryAttempt = () => redispatch.run(request, () => ctx.llm.stream(request))
    return (async function* (): AsyncIterable<StreamChunk> {
      const usage: RequestScope = {
        signal: request.signal, usedIds: new Set<string>(), requestId: randomUUID(),
        sessionId: request.sessionId === undefined ? undefined : String(request.sessionId),
        model: request.model, startedAt: Date.now(), receivedChunks: 0,
      }
      const recordRotationLimit = (limit: RotationLimit): void => {
        try {
          diagnostics.record({
            requestId: usage.requestId, sessionId: usage.sessionId, keyId: usage.lastError?.keyId,
            model: usage.model, phase: 'before-output', code: 'KEY_POOL_ROTATION_LIMIT',
            errorType: usage.lastError?.errorType ?? 'LlmError', status: limit.failure.status,
            elapsedMs: Math.max(0, Date.now() - usage.startedAt), receivedChunks: usage.receivedChunks,
          })
        } catch { /* Diagnostics never change a stream chunk or throw into its consumer. */ }
      }
      const upstream = () => isAgentLoopRequest(request)
        ? next()
        : rotateUnstartedStream(pool, request, next, retryAttempt, recordRotationLimit)
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
  return { redispatch }
}
