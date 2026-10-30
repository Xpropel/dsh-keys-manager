import assert from 'node:assert/strict'
import { after, before, test, type TestContext } from 'node:test'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmFailure, StreamChunk } from '@deepseek-ai/dsh-llm'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { KeyPool } from '../src/pool.ts'
import { PROVIDER, ROTATE_CODE, registerPoolProvider, rotateUnstartedStream } from '../src/provider.ts'
import type { PoolMetadata } from '../src/types.ts'

const keyA = 'sk-integration-secret-aaaaaaaa'
const keyB = 'sk-integration-secret-bbbbbbbb'
const keyC = 'sk-integration-secret-cccccccc'
let dshTestDirectory: string
let previousDshHome: string | undefined

before(async () => {
  previousDshHome = process.env.DSH_HOME
  dshTestDirectory = await mkdtemp(join(tmpdir(), 'key-pool-provider-test-'))
  process.env.DSH_HOME = dshTestDirectory
})

after(async () => {
  if (previousDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousDshHome
  await rm(dshTestDirectory, { recursive: true, force: true })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}

function errorResponse(response: ServerResponse, status: number, key: string): void {
  response.writeHead(status, { 'content-type': 'application/json', 'retry-after': '0.01', 'request-id': 'synthetic-provider-request' })
  response.end(JSON.stringify({ error: {
    type: status === 401 ? 'authentication_error' : status === 402 ? 'insufficient_quota' : status === 429 ? 'rate_limit_error' : 'api_error',
    message: `Synthetic upstream error reflecting credential: ${key}`,
  } }))
}

function frame(event: Record<string, unknown>): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}

function startText(response: ServerResponse, text: string): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.write(': keep-alive\n\n')
  response.write(frame({ type: 'message_start', message: {
    id: 'message-test', type: 'message', role: 'assistant', model: 'deepseek-flash', content: [],
    usage: { input_tokens: 2, output_tokens: 0 },
  } }))
  response.write(frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
  response.write(frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }))
}

function successResponse(response: ServerResponse, text = '备用 Key 成功'): void {
  startText(response, text)
  response.write(frame({ type: 'content_block_stop', index: 0 }))
  response.write(frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }))
  response.end(frame({ type: 'message_stop' }))
}

type RecordedRequest = { key: string; path: string; body: Record<string, unknown> }
type Handler = (request: RecordedRequest, response: ServerResponse, incoming: IncomingMessage) => void | Promise<void>

async function setup(t: TestContext, handler: Handler, keys = [keyA, keyB]) {
  const calls: RecordedRequest[] = []
  const balanceCalls: string[] = []
  const trace: Array<{ kind: 'balance' | 'model'; key: string }> = []
  let balanceHandler = async (_key: string): Promise<Response> => Response.json({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '1.00' }] })
  const handlerErrors: unknown[] = []
  const server = createServer((incoming, response) => {
    void (async () => {
      let body = ''
      for await (const chunk of incoming) body += chunk
      const call = {
        key: String(incoming.headers['x-api-key'] ?? ''), path: incoming.url ?? '',
        body: JSON.parse(body) as Record<string, unknown>,
      }
      calls.push(call)
      trace.push({ kind: 'model', key: call.key })
      if (calls.length > 30) { errorResponse(response, 500, 'retry-limit'); return }
      await handler(call, response, incoming)
    })().catch(error => {
      handlerErrors.push(error)
      if (!response.headersSent) response.writeHead(500)
      response.end('mock handler failed')
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const credentials = new Map<string, string>()
  let saved: PoolMetadata | undefined
  let failSave = false
  const pool = new KeyPool({
    credentials: {
      resolve: async ref => credentials.get(ref),
      set: async (ref, key) => { credentials.set(ref, key) },
      unset: async ref => { credentials.delete(ref) },
    },
    metadata: {
      load: async () => saved,
      save: async value => { if (failSave) throw Error('synthetic metadata write failure'); saved = structuredClone(value) },
    },
    fetch: async (_url, init) => {
      const key = new Headers(init?.headers).get('authorization')!.slice('Bearer '.length)
      balanceCalls.push(key)
      trace.push({ kind: 'balance', key })
      return balanceHandler(key)
    },
  }, { baselineTimeoutMs: 100, afterRequestDelayMs: 10, minimumRefreshIntervalMs: 20 })
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
  const { addedIds } = keys.length
    ? await pool.importKeys(keys.map((key, index) => ({ key, label: `测试 Key ${index + 1}` })))
    : { addedIds: [] }
  await ctx.plugin(LlmRuntime)
  const fiber = ctx.plugin({
    name: 'test-pool-provider', inject: ['llm'],
    apply(child: Context) { registerPoolProvider(child, pool, { baseURL: `http://127.0.0.1:${address.port}` }) },
  })
  await fiber
  return {
    ctx, pool, calls, balanceCalls, trace, addedIds, fiber,
    setSaveFailure(value: boolean) { failSave = value },
    setBalanceHandler(handler: (key: string) => Promise<Response>) { balanceHandler = handler },
  }
}

async function until(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error('Timed out waiting for mock state')
    await pause(2)
  }
}

function request(): GenerateOptions {
  return {
    provider: PROVIDER, model: 'deepseek-flash', maxTokens: 16,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  }
}

// This recovery seam only keys its bounded retry budget by Agent identity.
// The tests dispatch the real Cordis waterfall without constructing the full session/tool runtime.
function agentIdentity(): Agent { return {} as Agent }

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const result: StreamChunk[] = []
  for await (const chunk of stream) result.push(chunk)
  return result
}

function terminalFailure(chunks: StreamChunk[]): LlmFailure {
  const finish = chunks.at(-1)
  assert.ok(finish?.type === 'finish' && finish.reason.kind === 'error', JSON.stringify(chunks))
  return finish.reason.failure
}

function assertRedacted(value: unknown): void {
  const serialized = JSON.stringify(value)
  for (const key of [keyA, keyB, keyC]) assert.equal(serialized.includes(key), false, 'A raw credential entered failure output')
}

test('real Harness Messages transport rotates HTTP 402 from A to B and preserves the request', { timeout: 5000 }, async t => {
  const fixture = await setup(t, (call, response) => {
    if (call.key === keyA) errorResponse(response, 402, keyA)
    else successResponse(response)
  })
  const chunks = await collect(fixture.ctx.llm.stream(request()))
  assert.deepEqual(fixture.calls.map(call => call.key), [keyA, keyB])
  assert.equal(fixture.calls[0]!.path.endsWith('/messages'), true)
  assert.deepEqual(fixture.calls[0]!.body, fixture.calls[1]!.body)
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text), ['备用 Key 成功'])
  assert.equal(chunks.at(-1)?.type, 'finish')
  assert.equal(fixture.pool.snapshot().keys[0]!.status, 'exhausted')
  assert.equal(fixture.pool.snapshot().activeId, fixture.addedIds[1])
  assertRedacted(chunks)
  // The official adapter creates its id only under the isolated test home.
  assert.match(await readFile(join(dshTestDirectory, '.anonymous-user-id'), 'utf8'), /^[a-f0-9-]+\s*$/)
})

test('all keys failing terminate after one attempt per key without exposing upstream errors', { timeout: 5000 }, async t => {
  const fixture = await setup(t, (call, response) => errorResponse(response, 402, call.key), [keyA, keyB, keyC])
  const chunks = await collect(fixture.ctx.llm.stream(request()))
  assert.deepEqual(fixture.calls.map(call => call.key), [keyA, keyB, keyC])
  assert.equal(terminalFailure(chunks).code, ROTATE_CODE)
  assert.match(terminalFailure(chunks).message, /所有已启用 Key 均不可用于当前请求/)
  assert.doesNotMatch(terminalFailure(chunks).message, /将尝试/)
  assert.equal(fixture.pool.snapshot().keys.every(key => key.status === 'exhausted'), true)
  assertRedacted(chunks)
})

test('autoSwitch=false surfaces a sanitized 402 without trying the available backup', { timeout: 5000 }, async t => {
  const fixture = await setup(t, (call, response) => errorResponse(response, 402, call.key))
  await fixture.pool.updateSettings({ autoSwitch: false })
  const chunks = await collect(fixture.ctx.llm.stream(request()))
  assert.deepEqual(fixture.calls.map(call => call.key), [keyA])
  assert.equal(terminalFailure(chunks).status, 402)
  assert.match(terminalFailure(chunks).message, /自动切换已关闭/)
  assert.equal(fixture.pool.snapshot().activeId, fixture.addedIds[0])
  assert.equal(fixture.pool.snapshot().keys[1]!.status, 'unknown')
  assertRedacted(chunks)
})

for (const [status, code] of [[401, 'AUTH'], [429, 'RATE_LIMIT'], [500, 'SERVER']] as const) {
  test(`HTTP ${status} retains the official response and facts without rotating keys`, { timeout: 5000 }, async t => {
    const fixture = await setup(t, (call, response) => errorResponse(response, status, call.key))
    const chunks = await collect(fixture.ctx.llm.stream(request()))
    assert.deepEqual(fixture.calls.map(call => call.key), [keyA])
    assert.deepEqual(terminalFailure(chunks), {
      message: `Synthetic upstream error reflecting credential: ${keyA}`,
      code, status, providerRetryAfterMs: 10, requestId: 'synthetic-provider-request',
    })
    assert.equal(fixture.pool.snapshot().activeId, fixture.addedIds[0])
    assert.equal(fixture.pool.snapshot().keys[0]!.status, 'ready')
    assert.equal(fixture.pool.snapshot().keys[1]!.status, 'unknown')
    // The ordinary response belongs to the official transport. Only the private
    // plugin diagnostic journal must drop reflected error text and credentials.
    await fixture.fiber.dispose()
    const diagnostics = JSON.parse(await readFile(join(dshTestDirectory, 'plugins/deepseek-key-pool/request-errors.json'), 'utf8'))
    const entry = diagnostics.entries.find((item: { keyId: string }) => item.keyId === fixture.addedIds[0])
    assert.ok(entry)
    assert.equal(entry.code, code)
    assertRedacted(diagnostics)
  })
}

test('a concurrent late 402 affects its exact leased key while a late 401 remains untouched', { timeout: 5000 }, async t => {
  const startedA = deferred<ServerResponse>()
  const startedB = deferred<ServerResponse>()
  const fixture = await setup(t, (call, response) => {
    if (call.key === keyA) startedA.resolve(response)
    else if (call.key === keyB) startedB.resolve(response)
    else successResponse(response, 'C')
  }, [keyA, keyB, keyC])
  const first = collect(fixture.ctx.llm.stream(request()))
  const responseA = await startedA.promise
  await fixture.pool.setActive(fixture.addedIds[1]!)
  const second = collect(fixture.ctx.llm.stream(request()))
  const responseB = await startedB.promise
  // Simulate the user selecting C while both prior credentials still have requests in flight.
  await fixture.pool.setActive(fixture.addedIds[2]!)
  errorResponse(responseB, 402, keyB)
  const secondResult = await second
  errorResponse(responseA, 401, keyA)
  const firstResult = await first
  assert.equal(fixture.pool.snapshot().keys[0]!.status, 'ready')
  assert.equal(fixture.pool.snapshot().keys[1]!.status, 'exhausted')
  assert.equal(fixture.pool.snapshot().keys[2]!.status, 'ready')
  assert.equal(fixture.pool.snapshot().activeId, fixture.addedIds[2])
  assert.deepEqual(fixture.calls.map(call => call.key), [keyA, keyB, keyC])
  assert.equal(terminalFailure(firstResult).code, 'AUTH')
  assert.equal(terminalFailure(firstResult).status, 401)
  assertRedacted(secondResult)
})

test('metadata failure during 402 handling still replaces the original provider error safely', { timeout: 5000 }, async t => {
  const fixture = await setup(t, (call, response) => errorResponse(response, 402, call.key))
  fixture.setSaveFailure(true)
  const chunks = await collect(fixture.ctx.llm.stream(request()))
  assert.equal(fixture.calls.length, 1)
  terminalFailure(chunks)
  assertRedacted(chunks)
})

test('a partial SSE quota error without HTTP 402 remains official and never replays on B', { timeout: 5000 }, async t => {
  const fixture = await setup(t, (call, response) => {
    startText(response, '已输出部分内容')
    response.end(frame({ type: 'error', error: { type: 'insufficient_quota', message: `insufficient balance ${call.key}` } }))
  })
  const chunks = await collect(fixture.ctx.llm.stream(request()))
  assert.deepEqual(fixture.calls.map(call => call.key), [keyA])
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text), ['已输出部分内容'])
  assert.deepEqual(terminalFailure(chunks), { code: 'QUOTA', message: `insufficient balance ${keyA}` })
  assert.equal(fixture.pool.snapshot().keys[0]!.status, 'ready')
  assert.equal(fixture.pool.snapshot().activeId, fixture.addedIds[0])
})

test('the raw stream guard never retries a rotation failure after handing out a chunk', async t => {
  const fixture = await setup(t, (_call, response) => successResponse(response))
  let attempts = 0
  const expected: StreamChunk[] = [
    { type: 'text-delta', index: 0, text: 'partial' },
    { type: 'finish', reason: { kind: 'error', failure: { code: ROTATE_CODE, status: 402, message: 'safe error' } } },
  ]
  const result = await collect(rotateUnstartedStream(fixture.pool, request(), async function* () {
    attempts++
    yield* expected
  }))
  assert.equal(attempts, 1)
  assert.deepEqual(result, expected)
})

test('agent-marked requests recover through agent/request-error instead of hidden stream retries', { timeout: 5000 }, async t => {
  const fixture = await setup(t, (call, response) => {
    if (call.key === keyA) errorResponse(response, 402, keyA)
    else successResponse(response, 'agent recovered')
  })
  const chunks = await collect(fixture.ctx.llm.stream(markAgentLoopRequest(request())))
  const failure = terminalFailure(chunks)
  assert.equal(failure.code, ROTATE_CODE)
  assert.deepEqual(fixture.calls.map(call => call.key), [keyA])
  const agent = agentIdentity()
  const payload = {
    agent, provider: PROVIDER, turn: 1, step: 1, failure, retryPolicy: undefined,
    signal: new AbortController().signal,
  }
  let delegated = 0
  const next = async () => { delegated++; return undefined }
  assert.deepEqual(await fixture.ctx.waterfall('agent/request-error', payload, next), { kind: 'retry' })
  const recovered = await collect(fixture.ctx.llm.stream(markAgentLoopRequest(request())))
  assert.deepEqual(fixture.calls.map(call => call.key), [keyA, keyB])
  assert.deepEqual(recovered.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text), ['agent recovered'])
  // The same step cannot consume an unbounded recovery budget, even if keys are replenished.
  await fixture.pool.refresh()
  assert.equal(await fixture.ctx.waterfall('agent/request-error', payload, next), undefined)
  assert.equal(delegated, 0)
  assert.deepEqual(await fixture.ctx.waterfall('agent/request-error', { ...payload, step: 2 }, next), { kind: 'retry' })
  assert.deepEqual(await fixture.ctx.waterfall('agent/request-error', { ...payload, agent: agentIdentity() }, next), { kind: 'retry' })
  assertRedacted(chunks)
})

test('agent recovery delegates unrelated failures and does not retry after provider disposal', { timeout: 5000 }, async t => {
  const fixture = await setup(t, (_call, response) => successResponse(response))
  const payload = {
    agent: agentIdentity(), provider: PROVIDER, turn: 1, step: 1,
    failure: { code: 'SERVER', status: 500, message: 'safe error' },
    retryPolicy: undefined, signal: new AbortController().signal,
  }
  let delegated = 0
  const next = async () => { delegated++; return undefined }
  assert.equal(await fixture.ctx.waterfall('agent/request-error', payload, next), undefined)
  assert.equal(delegated, 1)
  await fixture.fiber.dispose()
  assert.equal(await fixture.ctx.waterfall('agent/request-error', {
    ...payload, failure: { code: ROTATE_CODE, status: 402, message: 'safe error' },
  }, next), undefined)
  assert.equal(delegated, 2)
})

test('a first model request establishes its baseline first and automatically refreshes only its key after success', { timeout: 5000 }, async t => {
  const fixture = await setup(t, (_call, response) => successResponse(response), [keyA, keyB, keyC])
  let amount = '1.0000'
  fixture.setBalanceHandler(async () => {
    const result = Response.json({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: amount }] })
    amount = '0.7500'
    return result
  })
  const chunks = await collect(fixture.ctx.llm.stream(request()))
  assert.equal(chunks.at(-1)?.type, 'finish')
  assert.deepEqual(fixture.trace.slice(0, 2), [{ kind: 'balance', key: keyA }, { kind: 'model', key: keyA }])
  await until(() => fixture.pool.snapshot().keys[0]!.statistics.totalConsumedCny === '0.2500')
  assert.deepEqual(fixture.balanceCalls, [keyA, keyA])
  assert.equal(fixture.pool.snapshot().keys[0]!.statistics.initialBalanceCny, '1.0000')
  assert.equal(fixture.pool.snapshot().keys[1]!.statistics.startedAt, null)
  assert.equal(fixture.pool.snapshot().keys[2]!.statistics.startedAt, null)
})

test('baseline API failure does not block a successful model request or fabricate consumption', { timeout: 5000 }, async t => {
  const fixture = await setup(t, (_call, response) => successResponse(response))
  fixture.setBalanceHandler(async () => { throw new Error('synthetic offline balance endpoint') })
  const chunks = await collect(fixture.ctx.llm.stream(request()))
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text), ['备用 Key 成功'])
  await until(() => fixture.balanceCalls.length >= 2)
  assert.deepEqual(fixture.calls.map(call => call.key), [keyA])
  assert.equal(fixture.pool.snapshot().keys[0]!.statistics.startedAt, null)
  assert.equal(fixture.pool.snapshot().keys[0]!.statistics.totalConsumedCny, '0')
})

test('automatic post-failure checks record balances but cannot reopen a 402 loop when the API lags', { timeout: 5000 }, async t => {
  const fixture = await setup(t, (call, response) => errorResponse(response, 402, call.key))
  fixture.setBalanceHandler(async () => Response.json({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '0.10' }] }))
  const chunks = await collect(fixture.ctx.llm.stream(request()))
  assert.equal(terminalFailure(chunks).status, 402)
  await until(() => fixture.balanceCalls.length >= 4)
  await pause(10)
  assert.deepEqual(fixture.calls.map(call => call.key), [keyA, keyB])
  assert.equal(fixture.pool.snapshot().keys.every(key => key.status === 'exhausted'), true)
  assert.equal(fixture.pool.snapshot().keys.every(key => key.statistics.lastObservedCny === '0.10'), true)
  assert.equal(fixture.pool.snapshot().keys.every(key => key.statistics.totalConsumedCny === '0'), true)
  await assert.rejects(fixture.pool.acquire(), { code: 'NO_AVAILABLE_KEY' })
})

test('agent attempts schedule their used key before recovery without reviving it from stale balance availability', { timeout: 5000 }, async t => {
  const fixture = await setup(t, (call, response) => {
    if (call.key === keyA) errorResponse(response, 402, keyA)
    else successResponse(response)
  })
  const failed = await collect(fixture.ctx.llm.stream(markAgentLoopRequest(request())))
  await until(() => fixture.balanceCalls.filter(key => key === keyA).length === 2)
  assert.equal(fixture.pool.snapshot().keys[0]!.status, 'exhausted')
  const payload = {
    agent: agentIdentity(), provider: PROVIDER, turn: 1, step: 1, failure: terminalFailure(failed),
    retryPolicy: undefined, signal: new AbortController().signal,
  }
  assert.deepEqual(await fixture.ctx.waterfall('agent/request-error', payload, async () => undefined), { kind: 'retry' })
  await collect(fixture.ctx.llm.stream(markAgentLoopRequest(request())))
  await until(() => fixture.balanceCalls.filter(key => key === keyB).length === 2)
  assert.deepEqual(fixture.calls.map(call => call.key), [keyA, keyB])
  assert.equal(fixture.pool.snapshot().keys[0]!.status, 'exhausted')
})

test('concurrent requests share first-use observation and coalesce their completed-key refresh', { timeout: 5000 }, async t => {
  const gate = deferred<Response>()
  const fixture = await setup(t, (_call, response) => successResponse(response))
  fixture.setBalanceHandler(async () => fixture.balanceCalls.length === 1 ? gate.promise
    : Response.json({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '0.50' }] }))
  const first = collect(fixture.ctx.llm.stream(request()))
  const second = collect(fixture.ctx.llm.stream(request()))
  await until(() => fixture.balanceCalls.length === 1)
  assert.equal(fixture.calls.length, 0)
  gate.resolve(Response.json({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '1.00' }] }))
  await Promise.all([first, second])
  await until(() => fixture.pool.snapshot().keys[0]!.statistics.totalConsumedCny === '0.50')
  assert.deepEqual(fixture.calls.map(call => call.key), [keyA, keyA])
  assert.deepEqual(fixture.balanceCalls, [keyA, keyA])
})

test('canceling an agent request during first-use checking sends no model HTTP request', { timeout: 5000 }, async t => {
  const baseline = deferred<Response>()
  const fixture = await setup(t, (_call, response) => successResponse(response))
  fixture.setBalanceHandler(async () => baseline.promise)
  const controller = new AbortController()
  const pending = collect(fixture.ctx.llm.stream(markAgentLoopRequest({ ...request(), signal: controller.signal })))
  await until(() => fixture.balanceCalls.length === 1)
  controller.abort(new Error('synthetic request canceled'))
  const chunks = await pending
  const terminal = chunks.at(-1)
  assert.ok(terminal?.type === 'finish' && terminal.reason.kind === 'aborted')
  assert.equal(fixture.calls.length, 0)
  baseline.resolve(Response.json({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '1.00' }] }))
  await pause(2)
  assert.equal(fixture.calls.length, 0)
})

test('ending consumption of a partial model stream still schedules only the used key', { timeout: 5000 }, async t => {
  const fixture = await setup(t, (_call, response) => { startText(response, 'partial'); })
  const stream = fixture.ctx.llm.stream(request())
  for await (const chunk of stream) if (chunk.type === 'text-delta') break
  await until(() => fixture.balanceCalls.length === 2)
  assert.deepEqual(fixture.calls.map(call => call.key), [keyA])
  assert.deepEqual(fixture.balanceCalls, [keyA, keyA])
})

test('the rc.5 pool catalog uses installed official capacities and remains credential-free until dispatch', async t => {
  const fixture = await setup(t, (_call, response) => successResponse(response), [])
  assert.deepEqual(fixture.ctx.llm.listProviders(), [{ id: PROVIDER, name: 'DeepSeek Key Pool' }])
  assert.deepEqual(await fixture.ctx.llm.listModels(PROVIDER), [])
  await fixture.pool.importKeys([{ key: keyA }])
  const catalog = await fixture.ctx.llm.listModels(PROVIDER)
  assert.deepEqual(catalog.map(model => model.id), ['deepseek-flash', 'deepseek-v4-pro'])
  assert.equal(catalog.every(model => model.provider === PROVIDER), true)
  const flash = await fixture.ctx.llm.resolveModelInfo(PROVIDER, 'deepseek-flash')
  const pro = await fixture.ctx.llm.resolveModelInfo(PROVIDER, 'deepseek-v4-pro')
  assert.equal(flash.context?.contextWindow, 1_048_576)
  assert.equal(pro.context?.contextWindow, 1_048_576)
  assert.deepEqual(flash.inputModalities, ['text', 'image'])
  assert.equal(flash.systemPromptUpdate, 'in-history')
  assert.equal(flash.toolUpdate, 'addition-only')
  assert.equal(pro.inputModalities?.includes('image'), false)
  catalog[0]!.name = 'mutated caller copy'
  assert.notEqual((await fixture.ctx.llm.listModels(PROVIDER))[0]!.name, 'mutated caller copy')
  assert.equal(fixture.balanceCalls.length, 0)
  assert.equal(fixture.calls.length, 0)
})

test('a rc.5 prepared raw call retains its model config while rotating credentials', { timeout: 5000 }, async t => {
  const fixture = await setup(t, (call, response) => {
    if (call.key === keyA) errorResponse(response, 402, keyA)
    else successResponse(response, 'prepared call recovered')
  })
  const prepared = await fixture.ctx.llm.prepareCall({ provider: PROVIDER, model: 'deepseek-flash', maxTokens: 16 })
  assert.equal(prepared.context?.contextWindow, 1_048_576)
  assert.equal(Object.isFrozen(prepared.config), true)
  assert.equal(prepared.retryPolicy.mode, 'normal')
  if (prepared.retryPolicy.mode === 'normal') assert.equal(prepared.retryPolicy.retryableCodes.includes(ROTATE_CODE), false)
  const chunks = await collect(prepared.stream({ ...request(), ...prepared.config }))
  assert.deepEqual(fixture.calls.map(call => call.key), [keyA, keyB])
  assert.deepEqual(fixture.calls[0]!.body, fixture.calls[1]!.body)
  assert.equal(fixture.calls[1]!.body.max_tokens, 16)
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text), ['prepared call recovered'])
  assertRedacted(chunks)
})

test('prepared agent calls use the real scoped dispatcher for bounded rc.5 recovery', { timeout: 5000 }, async t => {
  const fixture = await setup(t, (call, response) => {
    if (call.key === keyA) errorResponse(response, 402, keyA)
    else successResponse(response, 'scoped agent recovered')
  })
  const actor = agentIdentity()
  const dispatch = agentEvents(fixture.ctx, actor)
  const signal = new AbortController().signal
  const config = { provider: PROVIDER, model: 'deepseek-flash', maxTokens: 16 }
  const first = await fixture.ctx.llm.prepareCall(config, signal)
  const failed = await collect(first.stream(markAgentLoopRequest({ ...request(), ...first.config, signal })))
  assert.deepEqual(fixture.calls.map(call => call.key), [keyA])
  const failure = terminalFailure(failed)
  assert.equal(failure.code, ROTATE_CODE)
  const recovery = { provider: PROVIDER, turn: 1, step: 1, failure, retryPolicy: first.retryPolicy, signal }
  assert.deepEqual(await dispatch.waterfall('agent/request-error', recovery, async () => undefined), { kind: 'retry' })
  const second = await fixture.ctx.llm.prepareCall(config, signal)
  const recovered = await collect(second.stream(markAgentLoopRequest({ ...request(), ...second.config, signal })))
  assert.deepEqual(fixture.calls.map(call => call.key), [keyA, keyB])
  assert.deepEqual(recovered.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text), ['scoped agent recovered'])
  // Even if a later balance observation replenishes keys, this same agent step has spent its budget.
  await fixture.pool.refresh()
  assert.equal(await dispatch.waterfall('agent/request-error', recovery, async () => undefined), undefined)
  assertRedacted([...failed, ...recovered])
})

test('canceling after rc.5 call preparation prevents authentication, balance queries, and model dispatch', { timeout: 5000 }, async t => {
  const fixture = await setup(t, (_call, response) => successResponse(response))
  const controller = new AbortController()
  const prepared = await fixture.ctx.llm.prepareCall({ provider: PROVIDER, model: 'deepseek-flash', maxTokens: 16 }, controller.signal)
  controller.abort(new Error('synthetic prepared call cancellation'))
  const chunks = await collect(prepared.stream(markAgentLoopRequest({ ...request(), ...prepared.config, signal: controller.signal })))
  const finish = chunks.at(-1)
  assert.ok(finish?.type === 'finish' && finish.reason.kind === 'aborted')
  assert.equal(fixture.balanceCalls.length, 0)
  assert.equal(fixture.calls.length, 0)
})
