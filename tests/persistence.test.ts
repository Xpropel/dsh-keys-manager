import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { createCredentialStore, createMetadataStore } from '../src/persistence.ts'
import { KeyPool } from '../src/pool.ts'
import type { LegacyPoolMetadata, PoolMetadata } from '../src/types.ts'

const empty: PoolMetadata = { version: 2, keys: [], activeId: null, settings: { autoSwitch: true, refreshIntervalSeconds: 0 } }

test('metadata writes are private, atomic, and load after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-key-pool-store-'))
  try {
    const file = join(directory, 'plugin', 'state.json')
    const store = createMetadataStore(file)
    assert.equal(await store.load(), undefined)
    await store.save(empty)
    assert.deepEqual(await createMetadataStore(file).load(), empty)
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('a second running instance cannot silently overwrite changed metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-key-pool-conflict-'))
  try {
    const file = join(directory, 'state.json')
    const first = createMetadataStore(file)
    const second = createMetadataStore(file)
    await first.load()
    await second.load()
    await first.save(empty)
    await assert.rejects(second.save({ ...empty, settings: { autoSwitch: false, refreshIntervalSeconds: 0 } }), /另一实例修改/)
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), empty)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('corrupt metadata is preserved and rejected without echoing its contents', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-key-pool-corrupt-'))
  try {
    const file = join(directory, 'state.json')
    await writeFile(file, 'test-credential-sensitive-not-json')
    await assert.rejects(createMetadataStore(file).load(), error => {
      assert.match(String(error), /格式损坏/)
      assert.equal(String(error).includes('test-credential-sensitive'), false)
      return true
    })
    assert.equal(await readFile(file, 'utf8'), 'test-credential-sensitive-not-json')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('metadata saves recover a lock left by an exited process', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-key-pool-stale-'))
  try {
    const file = join(directory, 'state.json')
    const store = createMetadataStore(file)
    await store.load()
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'])
    const exitedPid = child.pid
    await once(child, 'exit')
    assert.ok(exitedPid)
    await writeFile(`${file}.lock`, `${exitedPid}\n`)
    await store.save(empty)
    assert.deepEqual(await createMetadataStore(file).load(), empty)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('credential adapter round-trips through the real Harness credential provider', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-key-pool-credentials-'))
  const ctx = new Context()
  try {
    await ctx.plugin(LocalCredentialProvider, { path: join(directory, '.credentials.yaml'), watch: false })
    const credentials = createCredentialStore(ctx.credentials)
    const ref = 'DSH_KEY_POOL_SYNTHETIC_TEST'
    assert.equal(await credentials.resolve(ref), undefined)
    await credentials.set(ref, 'test-credential-first-value')
    assert.equal(await credentials.resolve(ref), 'test-credential-first-value')
    await credentials.set(ref, 'test-credential-second-value')
    assert.equal(await credentials.resolve(ref), 'test-credential-second-value')
    await credentials.unset(ref)
    assert.equal(await credentials.resolve(ref), undefined)
  } finally {
    await ctx.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('oversized metadata cannot replace a readable configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-key-pool-capacity-'))
  try {
    const file = join(directory, 'state.json')
    const store = createMetadataStore(file)
    await store.load()
    await store.save(empty)
    const oversized: PoolMetadata = { ...empty, keys: [{
      id: 'synthetic', credentialRef: 'DSH_KEY_POOL_SYNTHETIC', label: '中'.repeat(700_000),
      maskedKey: '••••', enabled: true, status: 'unknown', balanceCny: null,
      balanceObservationSource: null, balanceObservedAt: null,
      lastCheckedAt: null, lastError: null,
      statistics: {
        initialBalanceCny: null, lastObservedCny: null, totalConsumedCny: '0', totalAddedCny: '0',
        startedAt: null, updatedAt: null, lastObservationSource: null,
      },
    }] }
    await assert.rejects(store.save(oversized), /容量上限/)
    assert.deepEqual(await createMetadataStore(file).load(), empty)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('a failed reload cannot authorize overwriting a corrupted file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-key-pool-reload-'))
  try {
    const file = join(directory, 'state.json')
    const store = createMetadataStore(file)
    await store.load()
    await store.save(empty)
    await writeFile(file, 'broken-json')
    await assert.rejects(store.load(), /格式损坏/)
    await assert.rejects(store.save(empty), /尚未初始化/)
    assert.equal(await readFile(file, 'utf8'), 'broken-json')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('legacy files migrate without inventing history and observation time survives a failed check and restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-key-pool-migration-'))
  const file = join(directory, 'state.json')
  let current: KeyPool | undefined
  const legacy: LegacyPoolMetadata = {
    version: 1, activeId: 'legacy-key', settings: { autoSwitch: true, refreshIntervalSeconds: 0 },
    keys: [{
      id: 'legacy-key', credentialRef: 'DSH_KEY_POOL_LEGACY', label: '旧版 Key',
      maskedKey: 'tes••••test', enabled: true, status: 'error', balanceCny: '12.50',
      lastCheckedAt: 1000, lastError: '最近一次查询失败。',
    }],
  }
  let now = 2000
  let amount = '8.50'
  let fail = false
  const credentials = {
    resolve: async () => 'test-credential-migration-key',
    set: async () => { throw new Error('Migration must not replace credentials') },
    unset: async () => { throw new Error('Migration must not delete credentials') },
  }
  const create = () => new KeyPool({
    credentials, metadata: createMetadataStore(file), now: () => now,
    fetch: async () => {
      if (fail) throw new Error('synthetic network failure')
      return Response.json({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: amount }] })
    },
  })
  try {
    const original = JSON.stringify(legacy, null, 2)
    await writeFile(file, original)
    assert.deepEqual(await createMetadataStore(file).load(), legacy)
    assert.equal(await readFile(file, 'utf8'), original)
    current = create()
    await current.init()
    const before = current.snapshot().keys[0]!
    assert.equal(before.balanceCny, '12.50')
    assert.equal(before.balanceObservedAt, null)
    assert.equal(before.statistics.initialBalanceCny, null)
    assert.equal(before.statistics.totalConsumedCny, '0')

    await current.refresh('legacy-key')
    const baseline = current.snapshot().keys[0]!
    assert.equal(baseline.statistics.initialBalanceCny, '8.50')
    assert.equal(baseline.statistics.totalConsumedCny, '0')
    assert.equal(baseline.balanceObservedAt, 2000)
    assert.equal(baseline.statistics.startedAt, 2000)
    const persisted = await createMetadataStore(file).load()
    assert.equal(persisted?.version, 2)
    assert.equal(persisted?.keys[0]?.credentialRef, 'DSH_KEY_POOL_LEGACY')

    now = 3000
    fail = true
    await current.refresh('legacy-key')
    assert.equal(current.snapshot().keys[0]!.lastCheckedAt, 3000)
    assert.equal(current.snapshot().keys[0]!.balanceObservedAt, 2000)
    current.stop()

    current = create()
    await current.init()
    assert.equal(current.snapshot().keys[0]!.lastCheckedAt, 3000)
    assert.equal(current.snapshot().keys[0]!.balanceObservedAt, 2000)
    now = 4000
    fail = false
    amount = '7.25'
    await current.refresh('legacy-key')
    const resumed = current.snapshot().keys[0]!
    assert.equal(resumed.statistics.initialBalanceCny, '8.50')
    assert.equal(resumed.statistics.totalConsumedCny, '1.25')
    assert.equal(resumed.statistics.totalAddedCny, '0')
    assert.equal(resumed.balanceObservedAt, 4000)
    assert.equal(resumed.statistics.startedAt, 2000)
  } finally {
    current?.stop()
    await rm(directory, { recursive: true, force: true })
  }
})

test('a successful load refreshes a private state.json.bak recovery copy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-key-pool-backup-'))
  try {
    const file = join(directory, 'plugin', 'state.json')
    const store = createMetadataStore(file)
    await store.load()
    await store.save(empty)
    assert.deepEqual(await createMetadataStore(file).load(), empty)
    const backup = await readFile(`${file}.bak`, 'utf8')
    assert.deepEqual(JSON.parse(backup), empty)
    if (process.platform !== 'win32') assert.equal((await stat(`${file}.bak`)).mode & 0o777, 0o600)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('a corrupt load names both files and preserves the damage and the previous backup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-key-pool-backup-corrupt-'))
  try {
    const file = join(directory, 'plugin', 'state.json')
    const store = createMetadataStore(file)
    await store.load()
    await store.save(empty)
    await createMetadataStore(file).load()
    const backupBefore = await readFile(`${file}.bak`)
    await writeFile(file, 'broken-json')
    await assert.rejects(createMetadataStore(file).load(), (error: unknown) => {
      const message = String(error)
      assert.ok(message.includes(file), 'the damaged file path must be reported')
      assert.ok(message.includes(`${file}.bak`), 'the recovery backup path must be reported')
      assert.match(message, /恢复/)
      assert.equal(message.includes('broken-json'), false)
      return true
    })
    assert.equal(await readFile(file, 'utf8'), 'broken-json')
    assert.deepEqual(await readFile(`${file}.bak`), backupBefore)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
