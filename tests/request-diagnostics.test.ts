import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { createRequestDiagnostics, type RequestDiagnosticInput } from '../src/request-diagnostics.ts'

function input(overrides: Partial<RequestDiagnosticInput> = {}): RequestDiagnosticInput {
  return {
    requestId: randomUUID(), sessionId: `session-${randomUUID()}`, keyId: randomUUID(),
    model: 'deepseek-flash', phase: 'before-output', code: 'TRANSPORT', errorType: 'TypeError',
    networkCode: 'UND_ERR_SOCKET', elapsedMs: 125.5, receivedChunks: 0, ...overrides,
  }
}

async function fixture(run: (file: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-request-diagnostics-'))
  try { await run(join(directory, 'plugin', 'request-errors.json')) }
  finally { await rm(directory, { recursive: true, force: true }) }
}

async function entries(file: string): Promise<Array<Record<string, unknown>>> {
  const document = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(document.version, 1)
  return document.entries
}

test('diagnostics persist only the newest 100 entries in a private file across writer restarts', async () => {
  await fixture(async file => {
    const store = createRequestDiagnostics(file)
    const batch = Array.from({ length: 250 }, (_, elapsedMs) => input({ elapsedMs }))
    for (const entry of batch) assert.equal(store.record(entry), undefined)
    await store.flush()
    assert.deepEqual((await entries(file)).map(row => row.requestId), batch.slice(-100).map(row => row.requestId))
    if (process.platform !== 'win32') {
      assert.equal((await stat(file)).mode & 0o777, 0o600)
      assert.equal((await stat(dirname(file))).mode & 0o777, 0o700)
    }
    const restarted = createRequestDiagnostics(file)
    const newest = input({ phase: 'during-stream', receivedChunks: 25 })
    restarted.record(newest)
    await restarted.flush()
    const saved = await entries(file)
    assert.equal(saved.length, 100)
    assert.equal(saved[0]!.requestId, batch[151]!.requestId)
    assert.equal(saved.at(-1)!.requestId, newest.requestId)
    assert.equal(saved.at(-1)!.elapsedMs, 125)
    assert.equal(saved.at(-1)!.receivedChunks, 25)
  })
})

test('independent diagnostic writers merge under the official file lock without losing entries', async () => {
  await fixture(async file => {
    const first = createRequestDiagnostics(file)
    const second = createRequestDiagnostics(file)
    const expected = Array.from({ length: 40 }, () => input())
    for (let i = 0; i < expected.length; i++) (i % 2 ? first : second).record(expected[i]!)
    await Promise.all([first.flush(), second.flush()])
    assert.deepEqual(new Set((await entries(file)).map(row => row.requestId)), new Set(expected.map(row => row.requestId)))
  })
})

test('diagnostics never serialize unknown strings, error objects, getters, or caller mutations', async () => {
  await fixture(async file => {
    const secret = 'test-credential-sensitive-diagnostic-value'
    const store = createRequestDiagnostics(file)
    let getterCalls = 0
    const hostile = {
      ...input(), requestId: secret, sessionId: secret, keyId: secret, model: secret,
      code: secret, errorType: secret, networkCode: secret, status: Infinity,
      elapsedMs: -2, receivedChunks: NaN,
      message: secret, stack: secret, cause: new Error(secret), headers: { authorization: secret },
      toJSON() { throw new Error('The caller object must never be serialized') },
    }
    Object.defineProperty(hostile, 'phase', { get() { getterCalls++; throw new Error(secret) } })
    assert.doesNotThrow(() => store.record(hostile))
    const copied = input({ status: 503 })
    store.record(copied)
    const expectedId = copied.requestId
    copied.requestId = secret
    copied.networkCode = secret
    await store.flush()
    const contents = await readFile(file, 'utf8')
    assert.equal(contents.includes(secret), false)
    assert.equal(getterCalls, 0)
    const saved = await entries(file)
    assert.deepEqual(Object.keys(saved[0]!).sort(), ['at', 'code', 'errorType', 'model', 'phase'])
    assert.equal(saved[0]!.code, 'UNKNOWN')
    assert.equal(saved[0]!.errorType, 'Unknown')
    assert.equal(saved[0]!.phase, 'unknown')
    assert.equal(saved[1]!.requestId, expectedId)
    assert.equal(saved[1]!.networkCode, 'UND_ERR_SOCKET')
    assert.equal(saved[1]!.status, 503)
  })
})

test('old diagnostic records are re-filtered before a subsequent atomic commit', async () => {
  await fixture(async file => {
    const secret = 'test-credential-old-file-untrusted-value'
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify({ version: 1, entries: [{
      ...input(), at: 1, code: secret, networkCode: secret, errorType: secret,
      message: secret, prompt: secret, rawResponse: secret,
    }] }), { mode: 0o644 })
    const store = createRequestDiagnostics(file)
    store.record(input())
    await store.flush()
    assert.equal((await readFile(file, 'utf8')).includes(secret), false)
    assert.equal((await entries(file)).length, 2)
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600)
  })
})

test('future timestamps in an old log cannot prevent newer diagnostics from entering the retention window', async () => {
  await fixture(async file => {
    await mkdir(dirname(file), { recursive: true })
    const old = Array.from({ length: 100 }, () => ({ ...input(), at: Number.MAX_SAFE_INTEGER }))
    await writeFile(file, JSON.stringify({ version: 1, entries: old }))
    const store = createRequestDiagnostics(file)
    const newest = input()
    store.record(newest)
    await store.flush()
    const saved = await entries(file)
    assert.equal(saved.length, 100)
    assert.equal(saved.at(-1)!.requestId, newest.requestId)
    assert.equal(saved[0]!.requestId, old[1]!.requestId)
  })
})

test('corrupt and oversized diagnostic files are preserved and do not affect request handling', async () => {
  for (const contents of ['not-json', JSON.stringify({ version: 2, entries: [] }), 'x'.repeat(200_000)]) {
    await fixture(async file => {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, contents)
      const store = createRequestDiagnostics(file)
      assert.doesNotThrow(() => store.record(input()))
      await assert.doesNotReject(store.flush())
      assert.equal(await readFile(file, 'utf8'), contents)
    })
  }
})

test('a failed diagnostic write is best-effort and a later writable destination can recover', async () => {
  await fixture(async file => {
    const parent = dirname(file)
    await writeFile(parent, 'synthetic path obstruction')
    const store = createRequestDiagnostics(file)
    assert.doesNotThrow(() => store.record(input()))
    await assert.doesNotReject(store.flush())
    assert.equal(await readFile(parent, 'utf8'), 'synthetic path obstruction')
    await rm(parent)
    const recovered = input()
    store.record(recovered)
    await store.flush()
    assert.equal((await entries(file))[0]!.requestId, recovered.requestId)
  })
})

test('a diagnostic path that is a symlink is preserved without reading or changing its target', { skip: process.platform === 'win32' }, async () => {
  await fixture(async file => {
    await mkdir(dirname(file), { recursive: true })
    const target = join(dirname(file), 'unrelated.json')
    const contents = JSON.stringify({ version: 1, entries: [{ ...input(), at: 1, message: 'synthetic-private-data' }] })
    await writeFile(target, contents)
    await symlink(target, file)
    const store = createRequestDiagnostics(file)
    store.record(input())
    await store.flush()
    assert.equal(await readFile(file, 'utf8'), contents)
    assert.equal(await readFile(target, 'utf8'), contents)
  })
})

test('a contended log cannot block record or keep plugin disposal waiting indefinitely', { timeout: 4000 }, async () => {
  await fixture(async file => {
    await mkdir(dirname(file), { recursive: true })
    let release!: () => void
    let acquired!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const ready = new Promise<void>(resolve => { acquired = resolve })
    const lock = withFileLock(file, async () => { acquired(); await gate })
    await ready
    const store = createRequestDiagnostics(file)
    try {
      assert.equal(store.record(input()), undefined)
      const startedAt = performance.now()
      await store.flush()
      assert.ok(performance.now() - startedAt < 1500)
      await assert.rejects(readFile(file), { code: 'ENOENT' })
    } finally { release(); await lock }
    const next = input()
    store.record(next)
    await store.flush()
    assert.equal((await entries(file))[0]!.requestId, next.requestId)
  })
})

test('new pool failure codes are persisted while free-form and malformed codes stay UNKNOWN', async () => {
  await fixture(async file => {
    const store = createRequestDiagnostics(file)
    const accepted = [
      'KEY_POOL_CONFIG_UNAVAILABLE', 'INVALID_CREDENTIAL', 'KEY_POOL_ROTATION_LIMIT', 'KEY_POOL_KEY_INVALID', 'HTTP_402',
    ]
    const rejected = ['HTTP_99', 'HTTP_1000', 'HTTP_503x', 'http_402', 'HTTP_', 'KEY_POOL_NOT_A_CODE', 'AUTH_']
    for (const code of accepted) store.record(input({ code }))
    for (const code of rejected) store.record(input({ code }))
    await store.flush()
    const saved = await entries(file)
    assert.deepEqual(saved.slice(0, accepted.length).map(row => row.code), accepted)
    assert.deepEqual(saved.slice(accepted.length).map(row => row.code), rejected.map(() => 'UNKNOWN'))
  })
})

test('existing files keep only allow-listed codes when they are rewritten', async () => {
  await fixture(async file => {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify({ version: 1, entries: [{
      ...input(), at: 1, code: 'HTTP_429', errorType: 'LlmError',
    }, {
      ...input(), at: 2, code: 'HTTP_4290', errorType: 'LlmError',
    }] }))
    const store = createRequestDiagnostics(file)
    store.record(input({ code: 'KEY_POOL_ROTATION_LIMIT' }))
    await store.flush()
    const saved = await entries(file)
    assert.deepEqual(saved.map(row => row.code), ['HTTP_429', 'UNKNOWN', 'KEY_POOL_ROTATION_LIMIT'])
  })
})
