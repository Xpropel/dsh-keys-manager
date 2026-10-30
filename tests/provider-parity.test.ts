import assert from 'node:assert/strict'
import { after, before, test, type TestContext } from 'node:test'
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { isVolatile, updateVolatile } from '@deepseek-ai/cosmokit'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { APP_IDENTITY, createAssistantMessage, createToolResultMessage, LlmRuntime, markAgentLoopRequest, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmFailure, LlmModelInfo, ResolvedNormalRetryPolicy, StreamChunk } from '@deepseek-ai/dsh-llm'
import * as OfficialApiKey from '@deepseek-ai/dsh-llm-deepseek-api-key'
import { PUBLIC_BASE_URL } from '@deepseek-ai/dsh-llm-deepseek'
import * as LlmRetry from '@deepseek-ai/dsh-llm-retry'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import type {} from '@deepseek-ai/dsh-credentials'
import { KeyPool } from '../src/pool.ts'
import { PROVIDER, registerPoolProvider } from '../src/provider.ts'
import type { PoolMetadata } from '../src/types.ts'

const OFFICIAL = 'deepseek-official'
const syntheticKey = 'test-credential-parity-test-aaaaaaaa'
const spareKey = 'test-credential-parity-test-bbbbbbbb'
const sessionId = '57990d72-b251-4d62-9a90-46dc78949a4b' as GenerateOptions['sessionId']
let isolatedHome: string
let previousHome: string | undefined

before(async () => {
  previousHome = process.env.DSH_HOME
  isolatedHome = await mkdtemp(join(tmpdir(), 'key-pool-official-parity-'))
  process.env.DSH_HOME = isolatedHome
})

after(async () => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  await rm(isolatedHome, { recursive: true, force: true })
})

type WireRequest = { method: string; path: string; headers: IncomingHttpHeaders; rawBody: string; body: Record<string, unknown> }
type Handler = (request: WireRequest, response: ServerResponse, incoming: IncomingMessage) => void | Promise<void>
type RetryEvent = { type: string; data: Record<string, unknown> }
type ProjectionDefinition = { key: string; init(): unknown; apply(state: unknown, event: RetryEvent): unknown }

function frame(event: Record<string, unknown>): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}

function start(response: ServerResponse): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.write(frame({ type: 'message_start', message: {
    id: 'synthetic-parity-message', type: 'message', role: 'assistant', model: 'deepseek-flash', content: [],
    usage: { input_tokens: 20, output_tokens: 0, cache_read_input_tokens: 3, cache_creation_input_tokens: 1 },
  } }))
}

function thinking(response: ServerResponse): void {
  response.write(frame({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }))
  response.write(frame({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'synthetic reasoning' } }))
  response.write(frame({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'synthetic-signature' } }))
  response.write(frame({ type: 'content_block_stop', index: 0 }))
}

function partialTool(response: ServerResponse): void {
  start(response)
  thinking(response)
  response.write(frame({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'synthetic-tool-call', name: 'local_tool', input: {} } }))
  response.write(frame({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"synthetic' } }))
}

function success(response: ServerResponse, toolId = 'synthetic-tool-call'): void {
  start(response)
  thinking(response)
  for (const event of [
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'synthetic response' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: toolId, name: 'local_tool', input: {} } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"synthetic"}' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } },
  ]) response.write(frame(event))
  response.end(frame({ type: 'message_stop' }))
}

function httpFailure(response: ServerResponse, status: number): void {
  response.writeHead(status, { 'content-type': 'application/json', 'retry-after': '0.01', 'request-id': 'synthetic-provider-request-id' })
  response.end(JSON.stringify({ error: {
    type: status === 429 ? 'rate_limit_error' : status === 401 ? 'authentication_error' : status === 402 ? 'insufficient_quota' : status >= 500 ? 'api_error' : 'invalid_request_error',
    message: `Synthetic upstream HTTP ${status}`,
  } }))
}

async function fixture(
  t: TestContext,
  initialHandler: Handler = (_request, response) => success(response),
  config: OfficialApiKey.Options = {},
  testing: { officialOrigin?: boolean; establishBaseline?: boolean } = {},
) {
  let handler = initialHandler
  const wires: WireRequest[] = []
  const serverErrors: unknown[] = []
  const server = createServer((incoming, response) => {
    void (async () => {
      let rawBody = ''
      for await (const chunk of incoming) rawBody += chunk
      const wire = {
        method: incoming.method ?? '', path: incoming.url ?? '', headers: { ...incoming.headers }, rawBody,
        body: (rawBody === '' ? {} : JSON.parse(rawBody)) as Record<string, unknown>,
      }
      wires.push(wire)
      if (wires.length > 20) throw new Error('Parity test exceeded the localhost request budget')
      await handler(wire, response, incoming)
    })().catch(error => { serverErrors.push(error); response.destroy() })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const localhost = `http://127.0.0.1:${address.port}`
  const baseURL = testing.officialOrigin ? PUBLIC_BASE_URL : `${localhost}/anthropic`
  if (testing.officialOrigin) {
    // Preserve the real official-origin listing switch while guaranteeing that
    // every byte is sent only to our localhost server. Unexpected origins fail.
    const realFetch = globalThis.fetch.bind(globalThis)
    t.mock.method(globalThis, 'fetch', (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      assert.equal(url.origin, new URL(PUBLIC_BASE_URL).origin, 'Unexpected network origin in isolated parity test')
      return realFetch(new URL(`${url.pathname}${url.search}`, localhost), init)
    })
  }
  const ctx = new Context()
  let officialKey = syntheticKey
  let balanceCalls = 0
  const credentials = new Map<string, string>()
  let metadata: PoolMetadata | undefined
  const pool = new KeyPool({
    credentials: {
      resolve: async ref => credentials.get(ref),
      set: async (ref, key) => { credentials.set(ref, key) },
      unset: async ref => { credentials.delete(ref) },
    },
    metadata: { load: async () => metadata, save: async value => { metadata = structuredClone(value) } },
    fetch: async () => {
      balanceCalls++
      return Response.json({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '1.0000' }] })
    },
  }, { baselineTimeoutMs: 100, afterRequestDelayMs: 5, minimumRefreshIntervalMs: 10 })
  t.after(async () => {
    pool.stop()
    await ctx.fiber.dispose()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    assert.deepEqual(serverErrors, [])
  })
  // The official provider cannot see the user's environment or credential store.
  ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([]))
  ctx.provide('credentials', { resolve: async ref => ref === 'PARITY_TEST_KEY' ? { value: officialKey } : undefined } as Context['credentials'])
  await ctx.plugin(LlmRuntime)
  let liveConfig = { ...config, baseURL, apiKeyEnv: 'PARITY_TEST_KEY' }
  const official = ctx.plugin(OfficialApiKey, liveConfig)
  await official
  await pool.init()
  await pool.updateSettings({ refreshIntervalSeconds: 0 })
  await pool.importKeys([{ key: syntheticKey }, { key: spareKey }])
  if (testing.establishBaseline !== false) await pool.refresh()
  await ctx.plugin({
    name: 'pool-official-parity', inject: ['llm'],
    apply(child: Context) { registerPoolProvider(child, pool, { baseURL, options: () => OfficialApiKey.plainOptions(official.config) }) },
  })
  return {
    ctx, pool, wires, baseURL, official,
    balanceCalls: () => balanceCalls,
    setHandler(next: Handler) { handler = next },
    setOfficialKey(value: string) { officialKey = value },
    updateConfig(patch: OfficialApiKey.Options) {
      liveConfig = { ...liveConfig, ...patch }
      // The product loader commits validated snapshots into stable references.
      // Bare Fiber.update() would instead restart the official provider and hide
      // stale-listing or stale-policy bugs behind a new adapter instance.
      const candidate = OfficialApiKey.Config(liveConfig)
      for (const [key, value] of Object.entries(candidate)) {
        const target: unknown = official.config[key]
        assert.ok(isVolatile(value) && isVolatile(target))
        updateVolatile(target, value)
      }
      ctx.emit('loader/volatile-update', [])
    },
  }
}

function options(provider: string, signal?: AbortSignal): GenerateOptions {
  return {
    provider, model: 'deepseek-flash', sessionId,
    system: 'Synthetic system instruction', maxTokens: 128, reasoningEffort: ReasoningEffortId('max'), temperature: 0.25, stop: ['synthetic-stop'],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Synthetic user content' }] }],
    tools: [{ name: 'local_tool', description: 'Synthetic tool', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
    ...(signal === undefined ? {} : { signal }),
  }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function failure(chunks: StreamChunk[]): LlmFailure {
  const finish = chunks.at(-1)
  assert.ok(finish?.type === 'finish' && finish.reason.kind === 'error')
  return finish.reason.failure
}

function withoutRoute(models: readonly LlmModelInfo[]) {
  return models.map(({ provider: _provider, ...model }) => model)
}

async function pair(f: Awaited<ReturnType<typeof fixture>>) {
  const before = f.wires.length
  const official = await collect(f.ctx.llm.stream(markAgentLoopRequest(options(OFFICIAL))))
  const pooled = await collect(f.ctx.llm.stream(markAgentLoopRequest(options(PROVIDER))))
  assert.equal(f.wires.length - before, 2)
  // Compare the entire recorded wire, including authorization, attribution,
  // session ID, content-length, beta headers, body bytes, and parsed body.
  assert.deepEqual(f.wires[before + 1], f.wires[before])
  return { official, pooled }
}

test('the actual official API-key provider and pool send identical normal requests and stream events', { timeout: 5000 }, async t => {
  const f = await fixture(t)
  const result = await pair(f)
  assert.deepEqual(result.pooled, result.official)
  assert.equal(result.pooled.some(chunk => chunk.type === 'reasoning-delta'), true)
  assert.equal(result.pooled.some(chunk => chunk.type === 'text-delta'), true)
  assert.equal(result.pooled.some(chunk => chunk.type === 'tool-call-delta'), true)
  const usage = result.pooled.find(chunk => chunk.type === 'usage')
  assert.ok(usage?.type === 'usage')
  assert.equal(usage.usage.inputTokens, 20)
  assert.equal(usage.usage.outputTokens, 9)
  assert.equal(usage.usage.cacheReadTokens, 3)
  assert.equal(usage.usage.cacheWriteTokens, 1)
  assert.equal(f.wires[0]!.headers['x-api-key'], syntheticKey)
  assert.equal(f.wires[0]!.headers['x-deepseek-harness-session-id'], sessionId)
  assert.equal(f.wires[0]!.path, '/anthropic/v1/messages')
  assert.equal(f.pool.snapshot().keys.every(key => key.status === 'ready'), true)
})

test('continuous own-route history and a later 402 key rotation preserve official thinking replay and tool results', { timeout: 5000 }, async t => {
  const f = await fixture(t, (_wire, response) => success(response, 'synthetic-round-1'))
  const first = await pair(f)
  const histories = new Map<string, GenerateOptions['messages']>()
  const appendAttempt = (provider: string, chunks: StreamChunk[]) => {
    const finish = chunks.at(-1)
    assert.ok(finish?.type === 'finish' && finish.reason.kind === 'tool-calls')
    assert.ok(finish.replayState)
    const blocks = chunks.flatMap(chunk => chunk.type === 'block-end' ? [chunk.block] : [])
    const call = blocks.find(block => block.type === 'tool-call')
    assert.ok(call?.type === 'tool-call')
    histories.set(provider, [
      ...histories.get(provider) ?? options(provider).messages,
      createAssistantMessage({ content: blocks, source: { provider, model: 'deepseek-flash', replayState: finish.replayState } }),
      createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: 'Synthetic completed tool result' }], isError: false }),
    ])
  }
  appendAttempt(OFFICIAL, first.official)
  appendAttempt(PROVIDER, first.pooled)
  f.setHandler((_wire, response) => success(response, 'synthetic-round-2'))
  const continued: StreamChunk[][] = []
  for (const provider of [OFFICIAL, PROVIDER]) {
    const messages = histories.get(provider)!
    const before = JSON.stringify(messages)
    const chunks = await collect(f.ctx.llm.stream(markAgentLoopRequest({ ...options(provider), messages })))
    assert.equal(JSON.stringify(messages), before, 'The provider must not mutate durable assistant/tool history')
    continued.push(chunks)
    appendAttempt(provider, chunks)
  }
  assert.deepEqual(continued[1], continued[0])
  assert.deepEqual(f.wires[3], f.wires[2])
  assert.equal((f.wires[2]!.rawBody.match(/"signature":"synthetic-signature"/g) ?? []).length, 1)
  assert.match(f.wires[2]!.rawBody, /Synthetic completed tool result/)

  // A credential change stays inside the same pool adapter. Give the official
  // baseline the working replacement key and let only the pool encounter 402.
  f.setOfficialKey(spareKey)
  f.setHandler((wire, response) => wire.headers['x-api-key'] === syntheticKey
    ? httpFailure(response, 402) : success(response, 'synthetic-round-3'))
  const baseline = await collect(f.ctx.llm.stream({ ...options(OFFICIAL), messages: histories.get(OFFICIAL)! }))
  const pooledHistory = histories.get(PROVIDER)!
  const beforeRotation = JSON.stringify(pooledHistory)
  const rotated = await collect(f.ctx.llm.stream({ ...options(PROVIDER), messages: pooledHistory }))
  assert.equal(JSON.stringify(pooledHistory), beforeRotation)
  assert.deepEqual(rotated, baseline)
  assert.deepEqual(f.wires.slice(4).map(wire => wire.headers['x-api-key']), [spareKey, syntheticKey, spareKey])
  assert.equal(f.wires[5]!.rawBody, f.wires[4]!.rawBody)
  assert.deepEqual(f.wires[6], f.wires[4])
  assert.equal((f.wires[6]!.rawBody.match(/"signature":"synthetic-signature"/g) ?? []).length, 2)
  assert.equal(f.pool.snapshot().keys[0]!.status, 'exhausted')
  assert.equal(f.pool.snapshot().activeId, f.pool.snapshot().keys[1]!.id)
})

test('the actual official provider and pool expose the same built-in model capabilities and retry policy', async t => {
  const f = await fixture(t)
  assert.deepEqual(withoutRoute(await f.ctx.llm.listModels(PROVIDER)), withoutRoute(await f.ctx.llm.listModels(OFFICIAL)))
  for (const model of ['deepseek-flash', 'deepseek-v4-pro']) {
    const official = await f.ctx.llm.prepareCall({ provider: OFFICIAL, model })
    const pooled = await f.ctx.llm.prepareCall({ provider: PROVIDER, model })
    const { provider: _a, ...officialConfig } = official.config
    const { provider: _b, ...pooledConfig } = pooled.config
    assert.deepEqual(pooledConfig, officialConfig)
    assert.deepEqual(pooled.context, official.context)
    assert.deepEqual(pooled.retryPolicy, official.retryPolicy)
    assert.equal(pooled.systemPromptUpdate, official.systemPromptUpdate)
    assert.equal(pooled.toolUpdate, official.toolUpdate)
  }
  assert.equal(f.wires.length, 0, 'Localhost discovery must never contact a models endpoint')
})

for (const status of [400, 401, 403, 413, 429, 500, 503]) test(`HTTP ${status} keeps the official error code, message, request ID and retry facts`, { timeout: 5000 }, async t => {
  const f = await fixture(t, (_request, response) => httpFailure(response, status))
  const result = await pair(f)
  assert.deepEqual(result.pooled, result.official)
  const observed = failure(result.pooled)
  assert.equal(observed.status, status)
  assert.equal(observed.requestId, 'synthetic-provider-request-id')
  assert.equal(observed.providerRetryAfterMs, 10)
  assert.equal(observed.message, `Synthetic upstream HTTP ${status}`)
  assert.equal(f.pool.snapshot().keys.every(key => key.status === 'ready'), true)
})

test('HTTP 402 is the sole intentional protocol difference and the replacement key sends the same request', { timeout: 5000 }, async t => {
  const f = await fixture(t, (wire, response) => wire.headers['x-api-key'] === syntheticKey ? httpFailure(response, 402) : success(response))
  const original = await collect(f.ctx.llm.stream(options(OFFICIAL)))
  assert.equal(failure(original).code, 'QUOTA')
  assert.equal(failure(original).status, 402)
  const pooled = await collect(f.ctx.llm.stream(options(PROVIDER)))
  assert.deepEqual(f.wires.slice(0, 3).map(wire => wire.headers['x-api-key']), [syntheticKey, syntheticKey, spareKey])
  assert.deepEqual(f.wires[1], f.wires[0])
  f.setOfficialKey(spareKey)
  const replacementBaseline = await collect(f.ctx.llm.stream(options(OFFICIAL)))
  assert.deepEqual(pooled, replacementBaseline)
  assert.deepEqual(f.wires[2], f.wires[3])
  assert.equal(f.pool.snapshot().keys[0]!.status, 'exhausted')
  assert.equal(f.pool.snapshot().keys[1]!.status, 'ready')
  assert.equal(f.pool.snapshot().activeId, f.pool.snapshot().keys[1]!.id)
})

test('custom official defaults and volatile model/retry updates remain identical', { timeout: 5000 }, async t => {
  const f = await fixture(t, undefined, {
    thinking: 'disabled', reasoningEffort: 'off', maxTokens: 77,
    models: [{ id: 'deepseek-flash', name: 'Synthetic custom Flash', contextWindow: 4096, maxTokens: 66, inputModalities: ['text'] }],
    retryPolicy: { mode: 'normal', maxRetries: 2, backoff: { initialDelayMs: 7, maxDelayMs: 20, jitterRatio: 0 } },
  })
  const compare = async (contextWindow: number, maxTokens: number, thinkingMode: string, maxRetries: number) => {
    assert.deepEqual(withoutRoute(await f.ctx.llm.listModels(PROVIDER)), withoutRoute(await f.ctx.llm.listModels(OFFICIAL)))
    const result: StreamChunk[][] = []
    const startIndex = f.wires.length
    for (const provider of [OFFICIAL, PROVIDER]) {
      const prepared = await f.ctx.llm.prepareCall({ provider, model: 'deepseek-flash' })
      assert.equal(prepared.context?.contextWindow, contextWindow)
      assert.ok(prepared.retryPolicy.mode === 'normal')
      assert.equal(prepared.retryPolicy.maxRetries, maxRetries)
      const { maxTokens: _maxTokens, reasoningEffort: _effort, temperature: _temperature, stop: _stop, ...base } = options(provider)
      result.push(await collect(prepared.stream(markAgentLoopRequest({ ...base, ...prepared.config }))))
    }
    assert.deepEqual(result[1], result[0])
    assert.deepEqual(f.wires[startIndex + 1], f.wires[startIndex])
    assert.equal(f.wires[startIndex]!.body.max_tokens, maxTokens)
    assert.deepEqual(f.wires[startIndex]!.body.thinking, { type: thinkingMode })
  }
  await compare(4096, 66, 'disabled', 2)
  f.updateConfig({
    thinking: 'enabled', reasoningEffort: 'high', maxTokens: 200,
    models: [{ id: 'deepseek-flash', name: 'Updated synthetic Flash', contextWindow: 8192, maxTokens: 120, inputModalities: ['text'] }],
    retryPolicy: { mode: 'normal', maxRetries: 1, backoff: { initialDelayMs: 11, maxDelayMs: 30, jitterRatio: 0 } },
  })
  await compare(8192, 120, 'enabled', 1)
})

test('the official stream-idle timeout remains the same timeout for both providers', { timeout: 5000 }, async t => {
  const f = await fixture(t, (_wire, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(': synthetic keep-alive\n\n')
  }, { streamIdleTimeoutMs: 30 })
  const result = await pair(f)
  assert.deepEqual(result.pooled, result.official)
  assert.equal(failure(result.pooled).code, 'TIMEOUT')
  assert.equal(f.pool.snapshot().keys.every(key => key.status === 'ready'), true)
})

function listingEntry(id: string, name: string, contextWindow: number, maxOutputTokens: number, minVersion?: string) {
  return {
    id, name, context_window: contextWindow, max_output_tokens: maxOutputTokens,
    input_modalities: ['text'], output_modalities: ['text'],
    api_capabilities: { anthropic_messages: { system_prompt_update: 'leading-only', tool_update: 'leading-only' } },
    ...(minVersion === undefined ? {} : { client_requirements: { [APP_IDENTITY.product]: { min_version: minVersion } } }),
  }
}

function listingResponse(response: ServerResponse, entries: ReturnType<typeof listingEntry>[]): void {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ data: entries }))
}

test('official-origin dynamic model listing preserves capabilities, new models and version admission', { timeout: 5000 }, async t => {
  const f = await fixture(t, (wire, response) => {
    assert.equal(wire.method, 'GET')
    assert.equal(wire.path, '/models')
    listingResponse(response, [
      listingEntry('deepseek-flash', 'Listed synthetic Flash', 20000, 88),
      listingEntry('deepseek-v4-pro', 'Upgrade-only synthetic Pro', 30000, 99, '999.0.0'),
      listingEntry('synthetic-new-model', 'Declared compatible synthetic model', 16000, 64, '0.0.0'),
      listingEntry('synthetic-unsupported-model', 'No client compatibility declaration', 16000, 64),
    ])
  }, {}, { officialOrigin: true, establishBaseline: false })
  const official = await f.ctx.llm.listModels(OFFICIAL)
  const pooled = await f.ctx.llm.listModels(PROVIDER)
  assert.deepEqual(withoutRoute(pooled), withoutRoute(official))
  assert.deepEqual(official.map(model => model.id), ['deepseek-flash', 'synthetic-new-model'])
  for (const model of ['deepseek-flash', 'synthetic-new-model']) {
    const baseline = await f.ctx.llm.prepareCall({ provider: OFFICIAL, model })
    const current = await f.ctx.llm.prepareCall({ provider: PROVIDER, model })
    assert.deepEqual(current.context, baseline.context)
    assert.equal(current.systemPromptUpdate, undefined)
    assert.equal(current.toolUpdate, undefined)
    assert.deepEqual(current.retryPolicy, baseline.retryPolicy)
  }
  assert.equal((await f.ctx.llm.prepareCall({ provider: PROVIDER, model: 'deepseek-flash' })).context?.contextWindow, 20000)
  for (const [model, code] of [['deepseek-v4-pro', 'CLIENT_UPGRADE_REQUIRED'], ['synthetic-unsupported-model', 'MODEL_UNSUPPORTED']]) {
    const failures: unknown[] = []
    for (const provider of [OFFICIAL, PROVIDER]) {
      try { await f.ctx.llm.prepareCall({ provider, model }); assert.fail('A listed refusal must fail before model HTTP') }
      catch (error) {
        assert.ok(error instanceof Error && 'failure' in error)
        failures.push(error.failure)
        assert.ok('code' in error)
        assert.equal(error.code, code)
      }
    }
    assert.deepEqual(failures[1], failures[0])
  }
  assert.equal(f.wires.length, 2, 'Each provider loads once and reuses the listing for preparation/admission')
  assert.deepEqual(f.wires[1], f.wires[0])
  assert.equal(f.balanceCalls(), 0, 'Model discovery must not establish or refresh consumption statistics')
  assert.equal(f.pool.snapshot().keys.every(key => key.statistics.startedAt === null), true)
})

test('model-list cache reuse and credential changes match the actual official provider', { timeout: 5000 }, async t => {
  const f = await fixture(t, (wire, response) => {
    assert.equal(wire.path, '/models')
    const first = wire.headers['x-api-key'] === syntheticKey
    listingResponse(response, [listingEntry('deepseek-flash', first ? 'Credential A catalog' : 'Credential B catalog', first ? 4096 : 8192, 64)])
  }, {}, { officialOrigin: true, establishBaseline: false })
  const compare = async (name: string) => {
    const official = await f.ctx.llm.listModels(OFFICIAL)
    const pooled = await f.ctx.llm.listModels(PROVIDER)
    assert.deepEqual(withoutRoute(pooled), withoutRoute(official))
    assert.equal(official[0]!.name, name)
  }
  await compare('Credential A catalog')
  await compare('Credential A catalog')
  await compare('Credential A catalog')
  assert.equal(f.wires.length, 2)
  f.setOfficialKey(spareKey)
  await f.pool.setActive(f.pool.snapshot().keys[1]!.id)
  await compare('Credential B catalog')
  await compare('Credential B catalog')
  assert.deepEqual(f.wires.map(wire => wire.headers['x-api-key']), [syntheticKey, syntheticKey, spareKey, spareKey])
  assert.deepEqual(f.wires[0], f.wires[1])
  assert.deepEqual(f.wires[2], f.wires[3])
  assert.equal(f.balanceCalls(), 0)
})

test('explicit model config stops listing and restoring built-ins reloads the official catalog', { timeout: 5000 }, async t => {
  let revision = 'first'
  const f = await fixture(t, (wire, response) => {
    assert.equal(wire.path, '/models')
    listingResponse(response, [listingEntry('deepseek-flash', `${revision} listed catalog`, 4096, 64)])
  }, {}, { officialOrigin: true, establishBaseline: false })
  const compare = async (id: string, name: string) => {
    const official = await f.ctx.llm.listModels(OFFICIAL)
    const pooled = await f.ctx.llm.listModels(PROVIDER)
    assert.deepEqual(withoutRoute(pooled), withoutRoute(official))
    assert.equal(official[0]!.id, id)
    assert.equal(official[0]!.name, name)
  }
  await compare('deepseek-flash', 'first listed catalog')
  assert.equal(f.wires.length, 2)
  f.updateConfig({ models: [{ id: 'synthetic-explicit', name: 'Explicit deployment model', contextWindow: 1024, maxTokens: 32, inputModalities: ['text'] }] })
  await compare('synthetic-explicit', 'Explicit deployment model')
  assert.equal(f.wires.length, 2, 'A custom models list must not issue /models requests')
  revision = 'refreshed'
  f.updateConfig({ models: undefined })
  await compare('deepseek-flash', 'refreshed listed catalog')
  assert.equal(f.wires.length, 4, 'Switching back to built-ins starts a new listing generation')
  assert.equal(f.balanceCalls(), 0)
})

for (const mode of ['before headers', 'after partial tool output', 'inside an HTTP error body'] as const) test(`native socket failure ${mode} matches the official request outcome`, { timeout: 5000 }, async t => {
  const f = await fixture(t, async (_request, response, incoming) => {
    if (mode === 'before headers') { incoming.socket.destroy(); return }
    if (mode === 'after partial tool output') partialTool(response)
    else {
      response.writeHead(500, { 'content-type': 'application/json', 'content-length': '2000' })
      response.write('{"error":')
    }
    await pause(15)
    response.destroy()
  })
  const result = await pair(f)
  assert.deepEqual(result.pooled, result.official)
  assert.equal(failure(result.pooled).code, 'TRANSPORT')
  assert.equal(failure(result.pooled).message, 'DeepSeek Messages transport failed')
  assert.equal(f.pool.snapshot().keys.every(key => key.status === 'ready'), true)
})

for (const fault of ['unknown local TypeError', 'TLS certificate error', 'native connect timeout'] as const) test(`${fault} follows the same outer official error handling`, { timeout: 5000 }, async t => {
  const f = await fixture(t)
  const attempts: Array<{ url: string; method: string | undefined; body: BodyInit | null | undefined; headers: Array<[string, string]> }> = []
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    assert.equal(url, `${f.baseURL}/v1/messages`)
    attempts.push({ url, method: init?.method, body: init?.body, headers: [...new Headers(init?.headers)] })
    if (fault === 'unknown local TypeError') throw new TypeError('Synthetic local processing error')
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('Synthetic native request failure'), {
      code: fault === 'TLS certificate error' ? 'CERT_HAS_EXPIRED' : 'UND_ERR_CONNECT_TIMEOUT',
    }) })
  })
  const official = await collect(f.ctx.llm.stream(markAgentLoopRequest(options(OFFICIAL))))
  const pooled = await collect(f.ctx.llm.stream(markAgentLoopRequest(options(PROVIDER))))
  assert.deepEqual(pooled, official)
  assert.deepEqual(attempts[1], attempts[0])
  assert.equal(failure(pooled).code, 'TRANSPORT')
  assert.equal(f.wires.length, 0)
  assert.equal(f.pool.snapshot().keys.every(key => key.status === 'ready'), true)
})

test('cancellation after streamed tool output has the same official chunks and terminal reason', { timeout: 5000 }, async t => {
  const f = await fixture(t, (_request, response) => partialTool(response))
  const results: StreamChunk[][] = []
  for (const provider of [OFFICIAL, PROVIDER]) {
    const controller = new AbortController()
    const chunks: StreamChunk[] = []
    for await (const chunk of f.ctx.llm.stream(markAgentLoopRequest(options(provider, controller.signal)))) {
      chunks.push(chunk)
      if (chunk.type === 'tool-call-delta') controller.abort(new Error('Synthetic cancellation'))
    }
    const finish = chunks.at(-1)
    assert.ok(finish?.type === 'finish' && finish.reason.kind === 'aborted')
    results.push(chunks)
  }
  assert.deepEqual(results[1], results[0])
  assert.deepEqual(f.wires[1], f.wires[0])
  assert.equal(f.pool.snapshot().keys.every(key => key.status === 'ready'), true)
})

/** The carrier only stores the actual official retry plugin's registered fold. */
async function officialRetry(ctx: Context) {
  const definitions = new Map<string, ProjectionDefinition>()
  const cells = new WeakMap<object, Map<string, unknown>>()
  ctx.provide('agents', {} as Context['agents'])
  ctx.provide('sessionProjections', {
    register(definition: ProjectionDefinition) { definitions.set(definition.key, definition); return () => definitions.delete(definition.key) },
    stateOf(session: object, key: string) {
      let state = cells.get(session)
      if (!state) { state = new Map(); cells.set(session, state) }
      if (!state.has(key)) state.set(key, definitions.get(key)!.init())
      return state.get(key)
    },
  })
  await ctx.plugin(LlmRetry)
  return () => {
    const events: RetryEvent[] = []
    const session = {
      append(type: string, data: Record<string, unknown>) {
        const event = { type, data }
        events.push(structuredClone(event))
        let state = cells.get(session)
        if (!state) { state = new Map(); cells.set(session, state) }
        for (const [key, definition] of definitions) state.set(key, definition.apply(state.has(key) ? state.get(key) : definition.init(), event))
      },
    }
    return { events, dispatch: agentEvents(ctx, { session } as unknown as Agent) }
  }
}

test('official retry service gives both providers identical bounded retries and successful output', { timeout: 5000 }, async t => {
  const f = await fixture(t)
  const actor = await officialRetry(f.ctx)
  const result: Array<{ attempts: StreamChunk[][]; retries: unknown[]; wires: WireRequest[] }> = []
  for (const provider of [OFFICIAL, PROVIDER]) {
    let call = 0
    f.setHandler((_wire, response, incoming) => {
      if (++call < 3) incoming.socket.destroy()
      else success(response)
    })
    const run = actor()
    const signal = new AbortController().signal
    const prepared = await f.ctx.llm.prepareCall({ provider, model: 'deepseek-flash', maxTokens: 128 }, signal)
    assert.ok(prepared.retryPolicy.mode === 'normal')
    const policy: ResolvedNormalRetryPolicy = { ...prepared.retryPolicy, maxRetries: 2, initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 }
    const attempts: StreamChunk[][] = []
    const startIndex = f.wires.length
    for (let attempt = 0; attempt < 4; attempt++) {
      const chunks = await collect(f.ctx.llm.stream(markAgentLoopRequest(options(provider, signal))))
      attempts.push(chunks)
      const finish = chunks.at(-1)
      assert.ok(finish?.type === 'finish')
      if (finish.reason.kind !== 'error') break
      const decision = await run.dispatch.waterfall('agent/request-error', {
        provider, turn: 1, step: 1, failure: finish.reason.failure, retryPolicy: policy, signal,
      }, async () => undefined)
      if (decision?.kind !== 'retry') break
    }
    result.push({ attempts, wires: f.wires.slice(startIndex), retries: run.events.filter(event => event.type === 'llm/retry').map(event => ({
      retry: event.data.retry, maxRetries: event.data.maxRetries, delayMs: event.data.delayMs, failure: event.data.failure,
    })) })
  }
  assert.equal(result[0]!.attempts.length, 3)
  assert.deepEqual(result[1], result[0])
  assert.equal(result[1]!.wires.every(wire => wire.headers['x-api-key'] === syntheticKey), true)
  assert.equal(f.pool.snapshot().keys.every(key => key.status === 'ready'), true)
})

test('canceling official retry backoff has the same outcome for both providers', { timeout: 5000 }, async t => {
  const f = await fixture(t, (_wire, _response, incoming) => { incoming.socket.destroy() })
  const actor = await officialRetry(f.ctx)
  const results: Array<{ chunks: StreamChunk[]; retryEvents: unknown[] }> = []
  for (const provider of [OFFICIAL, PROVIDER]) {
    const run = actor()
    const controller = new AbortController()
    const prepared = await f.ctx.llm.prepareCall({ provider, model: 'deepseek-flash' }, controller.signal)
    assert.ok(prepared.retryPolicy.mode === 'normal')
    const policy: ResolvedNormalRetryPolicy = { ...prepared.retryPolicy, maxRetries: 2, initialDelayMs: 1000, maxDelayMs: 1000, jitterRatio: 0 }
    const chunks = await collect(f.ctx.llm.stream(markAgentLoopRequest(options(provider, controller.signal))))
    const pending = run.dispatch.waterfall('agent/request-error', {
      provider, turn: 1, step: 1, failure: failure(chunks), retryPolicy: policy, signal: controller.signal,
    }, async () => undefined)
    const deadline = performance.now() + 500
    while (!run.events.some(event => event.type === 'llm/retry')) {
      if (performance.now() >= deadline) throw new Error('Official retry did not schedule the transient failure')
      await pause(1)
    }
    controller.abort(new Error('Synthetic backoff cancellation'))
    assert.equal(await pending, undefined)
    assert.equal(run.events.some(event => event.type === 'llm/retry-started'), false)
    results.push({ chunks, retryEvents: run.events.map(event => ({
      type: event.type, retry: event.data.retry, maxRetries: event.data.maxRetries, delayMs: event.data.delayMs, failure: event.data.failure,
    })) })
  }
  assert.deepEqual(results[1], results[0])
  assert.equal(f.wires.length, 2, 'Both providers send only their initial request when backoff is canceled')
  assert.deepEqual(f.wires[1], f.wires[0])
  assert.equal(f.pool.snapshot().keys.every(key => key.status === 'ready'), true)
})
