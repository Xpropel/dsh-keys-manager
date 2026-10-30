import assert from 'node:assert/strict'
import { after, before, test, type TestContext } from 'node:test'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { LlmError, LlmRuntime, ProviderRequestId, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmFailure, ResolvedNormalRetryPolicy, StreamChunk } from '@deepseek-ai/dsh-llm'
import * as LlmRetry from '@deepseek-ai/dsh-llm-retry'
import { KeyPool } from '../src/pool.ts'
import { PROVIDER, credentialFailure, registerPoolProvider } from '../src/provider.ts'
import type { PoolMetadata } from '../src/types.ts'

// Only this file's isolated process and localhost server see these synthetic credentials.
const keyA = 'sk-transport-test-aaaaaaaa'
const keyB = 'sk-transport-test-bbbbbbbb'
let testHome: string
let previousHome: string | undefined

before(async () => {
  previousHome = process.env.DSH_HOME
  testHome = await mkdtemp(join(tmpdir(), 'key-pool-transport-test-'))
  process.env.DSH_HOME = testHome
})

after(async () => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  await rm(testHome, { recursive: true, force: true })
})

type RecordedCall = { key: string; body: Record<string, unknown> }
type Handler = (call: RecordedCall, response: ServerResponse, request: IncomingMessage) => void | Promise<void>
type RetryEvent = { type: string; data: Record<string, unknown> }
type ProjectionDefinition = {
  key: string
  init(): unknown
  apply(state: unknown, event: RetryEvent): unknown
}

function frame(event: Record<string, unknown>): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}

function startMessage(response: ServerResponse): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.write(frame({ type: 'message_start', message: {
    id: 'synthetic-message', type: 'message', role: 'assistant', model: 'deepseek-flash', content: [],
    usage: { input_tokens: 20, output_tokens: 0 },
  } }))
}

/** This matches the incident's reasoning followed by an unfinished tool call. */
function partialTool(response: ServerResponse): void {
  startMessage(response)
  for (const event of [
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'synthetic reasoning' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'synthetic-tool', name: 'local_test', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"synthetic' } },
  ]) response.write(frame(event))
}

function success(response: ServerResponse): void {
  startMessage(response)
  for (const event of [
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'same key recovered' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
  ]) response.write(frame(event))
  response.end(frame({ type: 'message_stop' }))
}

async function breakStream(response: ServerResponse): Promise<void> {
  // Let response bytes reach the real fetch reader before breaking its socket.
  await pause(15)
  response.destroy()
}

async function fixture(t: TestContext, handler: Handler) {
  const calls: RecordedCall[] = []
  const handlerErrors: unknown[] = []
  const server = createServer((request, response) => {
    void (async () => {
      let bytes = ''
      for await (const chunk of request) bytes += chunk
      const call = { key: String(request.headers['x-api-key'] ?? ''), body: JSON.parse(bytes) as Record<string, unknown> }
      calls.push(call)
      if (calls.length > 10) throw new Error('The local test exceeded its HTTP request budget')
      await handler(call, response, request)
    })().catch(error => {
      handlerErrors.push(error)
      response.destroy()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const credentials = new Map<string, string>()
  let stored: PoolMetadata | undefined
  const pool = new KeyPool({
    credentials: {
      resolve: async id => credentials.get(id),
      set: async (id, key) => { credentials.set(id, key) },
      unset: async id => { credentials.delete(id) },
    },
    metadata: {
      load: async () => stored,
      save: async value => { stored = structuredClone(value) },
    },
    fetch: async () => Response.json({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '1.0000' }] }),
  }, { baselineTimeoutMs: 100, afterRequestDelayMs: 5, minimumRefreshIntervalMs: 10 })
  const ctx = new Context()
  t.after(async () => {
    pool.stop()
    await ctx.fiber.dispose()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    assert.deepEqual(handlerErrors, [])
  })
  await pool.init()
  await pool.updateSettings({ refreshIntervalSeconds: 0 })
  const imported = await pool.importKeys([{ key: keyA }, { key: keyB }])
  await ctx.plugin(LlmRuntime)
  const provider = ctx.plugin({
    name: 'transport-test-provider', inject: ['llm'],
    apply(child: Context) { registerPoolProvider(child, pool, { baseURL: `http://127.0.0.1:${address.port}` }) },
  })
  await provider
  return { ctx, pool, calls, provider, activeId: imported.addedIds[0]! }
}

async function recordedDiagnostics(activeId: string): Promise<Array<Record<string, unknown>>> {
  try {
    const data = JSON.parse(await readFile(join(testHome, 'plugins/deepseek-key-pool/request-errors.json'), 'utf8'))
    return data.entries.filter((entry: Record<string, unknown>) => entry.keyId === activeId)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
    throw error
  }
}

function request(signal?: AbortSignal): GenerateOptions {
  return {
    provider: PROVIDER, model: 'deepseek-flash', maxTokens: 16,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Synthetic localhost request' }] }],
    ...(signal === undefined ? {} : { signal }),
  }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 500
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error('The expected local retry event was not appended')
    await pause(1)
  }
}

function failure(chunks: StreamChunk[]): LlmFailure {
  const finish = chunks.at(-1)
  assert.ok(finish?.type === 'finish' && finish.reason.kind === 'error')
  return finish.reason.failure
}

function assertHealthyKey(pool: KeyPool, activeId: string): void {
  const state = pool.snapshot()
  assert.equal(state.activeId, activeId)
  assert.equal(state.keys[0]!.status, 'ready')
  assert.equal(state.keys.some(key => key.status === 'exhausted' || key.status === 'invalid'), false)
  assert.equal(state.events.some(event => event.kind === 'exhausted' || event.kind === 'invalid'), false)
}

function assertRedacted(value: unknown): void {
  const text = JSON.stringify(value)
  for (const key of [keyA, keyB]) assert.equal(text.includes(key), false)
}

/**
 * Load the actual retry plugin and its actual projection fold. This in-memory
 * session carrier stores events only; it does not reimplement retry decisions,
 * counters, delays, or cancellation and never creates a real Harness session.
 */
async function attachRetry(ctx: Context) {
  const definitions = new Map<string, ProjectionDefinition>()
  const states = new Map<string, unknown>()
  const events: RetryEvent[] = []
  ctx.provide('agents', {} as Context['agents'])
  ctx.provide('sessionProjections', {
    register(definition: ProjectionDefinition) {
      definitions.set(definition.key, definition)
      states.set(definition.key, definition.init())
      return () => { definitions.delete(definition.key); states.delete(definition.key) }
    },
    stateOf(_session: unknown, key: string) { return states.get(key) },
  })
  const session = {
    append(type: string, data: Record<string, unknown>) {
      const event = { type, data }
      events.push(structuredClone(event))
      for (const [key, definition] of definitions) states.set(key, definition.apply(states.get(key), event))
    },
  }
  const actor = { session } as unknown as Agent
  await ctx.plugin(LlmRetry)
  assert.equal(definitions.has('llmRetry'), true, 'The official retry projection was not registered')
  return { events, dispatch: agentEvents(ctx, actor) }
}

async function shortPolicy(ctx: Context): Promise<ResolvedNormalRetryPolicy> {
  const prepared = await ctx.llm.prepareCall({ provider: PROVIDER, model: 'deepseek-flash', maxTokens: 16 })
  assert.equal(prepared.retryPolicy.mode, 'normal')
  assert.ok(prepared.retryPolicy.mode === 'normal')
  // Preserve the real provider's eligible codes; reduce only test timing/budget.
  return { ...prepared.retryPolicy, maxRetries: 2, initialDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 }
}

for (const mode of ['before headers', 'during a reasoning/tool stream', 'while reading an HTTP 500 body'] as const) {
  test(`a socket reset ${mode} is TRANSPORT and does not consume another key`, { timeout: 5000 }, async t => {
    const f = await fixture(t, async (_call, response, incoming) => {
      if (mode === 'before headers') { incoming.socket.destroy(); return }
      if (mode === 'during a reasoning/tool stream') partialTool(response)
      else {
        response.writeHead(500, { 'content-type': 'application/json', 'content-length': '2000' })
        response.write('{"error":')
      }
      await breakStream(response)
    })
    const chunks = await collect(f.ctx.llm.stream(request()))
    assert.equal(failure(chunks).code, 'TRANSPORT')
    assert.deepEqual(f.calls.map(call => call.key), [keyA])
    assertHealthyKey(f.pool, f.activeId)
    if (mode === 'during a reasoning/tool stream') {
      assert.deepEqual(chunks.filter(chunk => chunk.type === 'reasoning-delta').map(chunk => chunk.text), ['synthetic reasoning'])
      assert.equal(chunks.filter(chunk => chunk.type === 'tool-call-delta').length, 2)
      assert.equal(chunks.some(chunk => chunk.type === 'usage'), false)
    }
    assertRedacted(chunks)
  })
}

for (const mode of ['clean EOF', 'invalid SSE JSON', 'invalid completed tool JSON'] as const) {
  test(`${mode} retains its protocol classification instead of becoming TRANSPORT`, { timeout: 5000 }, async t => {
    const f = await fixture(t, (_call, response) => {
      if (mode === 'invalid SSE JSON') {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end('event: message_start\ndata: {not-json}\n\n')
        return
      }
      partialTool(response)
      if (mode === 'invalid completed tool JSON') {
        response.write(frame({ type: 'content_block_stop', index: 1 }))
        response.write(frame({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } }))
        response.end(frame({ type: 'message_stop' }))
      } else response.end()
    })
    const chunks = await collect(f.ctx.llm.stream(request()))
    assert.equal(failure(chunks).code, mode === 'clean EOF' ? 'STREAM_CLOSED' : 'MALFORMED_RESPONSE')
    assert.deepEqual(f.calls.map(call => call.key), [keyA])
    assertHealthyKey(f.pool, f.activeId)
    assertRedacted(chunks)
  })
}

test('canceling an active streamed request remains aborted and does not rotate credentials', { timeout: 5000 }, async t => {
  const f = await fixture(t, (_call, response) => { partialTool(response) })
  const controller = new AbortController()
  const chunks: StreamChunk[] = []
  for await (const chunk of f.ctx.llm.stream(markAgentLoopRequest(request(controller.signal)))) {
    chunks.push(chunk)
    if (chunk.type === 'tool-call-delta') controller.abort(new Error('synthetic cancellation'))
  }
  const finish = chunks.at(-1)
  assert.ok(finish?.type === 'finish' && finish.reason.kind === 'aborted')
  assert.deepEqual(f.calls.map(call => call.key), [keyA])
  assertHealthyKey(f.pool, f.activeId)
  assertRedacted(chunks)
  await f.provider.dispose()
  assert.deepEqual(await recordedDiagnostics(f.activeId), [], 'User cancellation is not a request failure diagnostic')
})

test('provider diagnostics retain safe socket facts and stream phase without recording content', { timeout: 5000 }, async t => {
  const f = await fixture(t, async (_call, response) => {
    partialTool(response)
    await breakStream(response)
  })
  const chunks = await collect(f.ctx.llm.stream(markAgentLoopRequest(request())))
  assert.equal(failure(chunks).code, 'TRANSPORT')
  await f.provider.dispose()
  const entries = await recordedDiagnostics(f.activeId)
  assert.equal(entries.length, 1)
  assert.equal(entries[0]!.phase, 'during-stream')
  assert.equal(entries[0]!.code, 'TRANSPORT')
  assert.equal(entries[0]!.networkCode, 'UND_ERR_SOCKET')
  assert.equal(entries[0]!.errorType, 'TypeError')
  assert.ok(Number(entries[0]!.receivedChunks) >= 6)
  assert.ok(Number(entries[0]!.elapsedMs) >= 0)
  assertRedacted(entries)
  assert.doesNotMatch(JSON.stringify(entries), /synthetic reasoning|Synthetic localhost request|synthetic-tool|argumentsDelta|headers|stack|cause/)
})

test('an unknown local TypeError is returned unchanged for the official outer transport to classify', { timeout: 5000 }, async t => {
  const f = await fixture(t, (_call, response) => success(response))
  const original = new TypeError(`local processing failed: ${keyA}`)
  const error = await credentialFailure(f.pool, f.activeId, original)
  assert.strictEqual(error, original)
  assert.equal(f.calls.length, 0)
  assert.equal(f.pool.snapshot().activeId, f.activeId)
})

test('non-402 errors preserve identity, original causes, and all official failure facts', async t => {
  const f = await fixture(t, (_call, response) => success(response))
  const state = f.pool.snapshot()
  const cause = new Error(`synthetic original cause ${keyA}`)
  const originals = [
    new LlmError('original authentication response', 'AUTH', {
      status: 401, requestId: ProviderRequestId('synthetic-auth-request'), cause,
    }),
    new LlmError('original retry response', 'RATE_LIMIT', {
      status: 429, providerRetryAfterMs: 1234, requestId: ProviderRequestId('synthetic-rate-request'), cause,
    }),
    new LlmError('original offload response', 'IMAGE_OFFLOAD_REQUIRED', {
      status: 413, offloadImages: 3, requestId: ProviderRequestId('synthetic-image-request'), cause,
    }),
    new LlmError('future official taxonomy', 'FUTURE_OFFICIAL_CODE', { cause }),
    new TypeError('fetch failed', { cause: Object.assign(new Error('synthetic socket'), { code: 'ECONNRESET' }) }),
    new TypeError('fetch failed', { cause: Object.assign(new Error('synthetic certificate'), { code: 'CERT_HAS_EXPIRED' }) }),
  ]
  for (const original of originals) {
    const returned = await credentialFailure(f.pool, f.activeId, original)
    assert.strictEqual(returned, original)
    if (original instanceof LlmError) {
      assert.ok(returned instanceof LlmError)
      assert.strictEqual(returned.failure, original.failure)
      assert.strictEqual(returned.cause, original.cause)
    }
  }
  assert.deepEqual(f.pool.snapshot(), state)
  assert.equal(f.calls.length, 0)
})

test('an already-canceled request leaves even an arriving 402 to the official cancellation path', async t => {
  const f = await fixture(t, (_call, response) => success(response))
  const controller = new AbortController()
  controller.abort(new Error('synthetic canceled owner'))
  const original = new LlmError('late quota response', 'QUOTA', { status: 402 })
  const before = f.pool.snapshot()
  assert.strictEqual(await credentialFailure(f.pool, f.activeId, original, controller.signal), original)
  assert.deepEqual(f.pool.snapshot(), before)
  assert.equal(f.calls.length, 0)
})

for (const reset of ['before headers', 'after partial tool output'] as const) test(`the real retry plugin recovers a reset ${reset} on the same key`, { timeout: 5000 }, async t => {
  let attempt = 0
  const f = await fixture(t, async (_call, response, incoming) => {
    if (++attempt >= 3) { success(response); return }
    if (reset === 'before headers') incoming.socket.destroy()
    else {
      partialTool(response)
      await breakStream(response)
    }
  })
  const retry = await attachRetry(f.ctx)
  const policy = await shortPolicy(f.ctx)
  const signal = new AbortController().signal
  const attempts: StreamChunk[][] = []
  for (let index = 0; index < 4; index++) {
    const prepared = await f.ctx.llm.prepareCall({ provider: PROVIDER, model: 'deepseek-flash', maxTokens: 16 }, signal)
    const chunks = await collect(prepared.stream(markAgentLoopRequest({ ...request(signal), ...prepared.config })))
    attempts.push(chunks)
    const finish = chunks.at(-1)
    assert.ok(finish?.type === 'finish')
    if (finish.reason.kind !== 'error') break
    const decision = await retry.dispatch.waterfall('agent/request-error', {
      provider: PROVIDER, turn: 1, step: 1, failure: finish.reason.failure, retryPolicy: policy, signal,
    }, async () => undefined)
    if (decision?.kind !== 'retry') break
  }
  assert.equal(attempts.length, 3)
  assert.deepEqual(attempts.slice(0, 2).map(failure).map(item => item.code), ['TRANSPORT', 'TRANSPORT'])
  if (reset === 'after partial tool output') {
    assert.deepEqual(attempts.slice(0, 2).map(chunks => chunks.filter(chunk => chunk.type === 'tool-call-delta').length), [2, 2])
    assert.equal(attempts.slice(0, 2).some(chunks => chunks.some(chunk => chunk.type === 'usage')), false)
  }
  assert.deepEqual(attempts[2]!.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text), ['same key recovered'])
  assert.deepEqual(f.calls.map(call => call.key), [keyA, keyA, keyA])
  assert.deepEqual(f.calls[0]!.body, f.calls[2]!.body)
  const scheduled = retry.events.filter(event => event.type === 'llm/retry')
  assert.deepEqual(scheduled.map(event => event.data.retry), [1, 2])
  assert.equal(new Set(scheduled.map(event => event.data.retryId)).size, 1)
  assert.equal(retry.events.filter(event => event.type === 'llm/retry-started').length, 2)
  assertHealthyKey(f.pool, f.activeId)
  assertRedacted([attempts, retry.events])
})

test('the real retry plugin stops at its finite budget without exhausting or rotating keys', { timeout: 5000 }, async t => {
  const f = await fixture(t, (_call, _response, incoming) => { incoming.socket.destroy() })
  const retry = await attachRetry(f.ctx)
  const policy = await shortPolicy(f.ctx)
  const signal = new AbortController().signal
  let attempts = 0
  for (; attempts < 4; attempts++) {
    const chunks = await collect(f.ctx.llm.stream(markAgentLoopRequest(request(signal))))
    assert.equal(failure(chunks).code, 'TRANSPORT')
    const decision = await retry.dispatch.waterfall('agent/request-error', {
      provider: PROVIDER, turn: 1, step: 1, failure: failure(chunks), retryPolicy: policy, signal,
    }, async () => undefined)
    if (decision?.kind !== 'retry') break
  }
  assert.equal(attempts + 1, 3, 'One initial attempt and exactly two retries are allowed')
  assert.deepEqual(f.calls.map(call => call.key), [keyA, keyA, keyA])
  assert.equal(retry.events.filter(event => event.type === 'llm/retry').length, 2)
  assert.equal(retry.events.filter(event => event.type === 'llm/retry-started').length, 2)
  assertHealthyKey(f.pool, f.activeId)
  assertRedacted(retry.events)
})

test('canceling the real retry plugin during backoff sends no further HTTP request', { timeout: 5000 }, async t => {
  const f = await fixture(t, (_call, _response, incoming) => { incoming.socket.destroy() })
  const retry = await attachRetry(f.ctx)
  const policy = { ...await shortPolicy(f.ctx), initialDelayMs: 1000, maxDelayMs: 1000 }
  const controller = new AbortController()
  const chunks = await collect(f.ctx.llm.stream(markAgentLoopRequest(request(controller.signal))))
  assert.equal(failure(chunks).code, 'TRANSPORT')
  const recovery = retry.dispatch.waterfall('agent/request-error', {
    provider: PROVIDER, turn: 1, step: 1, failure: failure(chunks), retryPolicy: policy, signal: controller.signal,
  }, async () => undefined)
  // Scheduling is durable before the cancellable timer starts.
  await until(() => retry.events.some(event => event.type === 'llm/retry'))
  assert.equal(retry.events.filter(event => event.type === 'llm/retry').length, 1)
  controller.abort(new Error('synthetic cancellation during retry backoff'))
  assert.equal(await recovery, undefined)
  assert.equal(retry.events.filter(event => event.type === 'llm/retry-started').length, 0)
  assert.deepEqual(f.calls.map(call => call.key), [keyA])
  assertHealthyKey(f.pool, f.activeId)
  assertRedacted([chunks, retry.events])
})
