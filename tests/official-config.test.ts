import assert from 'node:assert/strict'
import test from 'node:test'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import type { LlmConfigurableProvider, LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { ConfigEditor } from '@deepseek-ai/dsh-config-editor'
import type { SettingsForms } from '@deepseek-ai/dsh-settings'
import * as OfficialApiKey from '@deepseek-ai/dsh-llm-deepseek-api-key'
import { createLaunchEnvironmentSnapshot, launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { createOfficialConnectionSource } from '../src/official-config.ts'

const turn = async () => { await new Promise<void>(resolve => setImmediate(resolve)) }
const config = (input: OfficialApiKey.Options = {}) => {
  const result = OfficialApiKey.Config['~standard'].validate(input)
  if ('then' in result || result.issues) throw new Error('Invalid official test configuration')
  return result.value as OfficialApiKey.Config
}
const expected = (input: OfficialApiKey.Options, ctx: Context) => OfficialApiKey.resolveAdapterOptions(
  OfficialApiKey.plainOptions(config(input)), launchEnvironmentOf(ctx),
)
const route = (ns = 'official-renamed') => ({
  provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: ns, settingsPath: [],
}) satisfies LlmConfigurableProvider

function fixture(input: OfficialApiKey.Options = {}) {
  const ctx = new Context()
  // A separate owner event bus proves subscriptions reach the official fiber,
  // rather than accidentally relying only on a root/global volatile event.
  let owner = new Context()
  let fiber = { ctx: owner, config: config(input), state: 2 } as Fiber
  let entry = { options: { id: 'official-renamed', name: '@deepseek-ai/dsh-llm-deepseek-api-key' }, disabled: false, fiber } as Entry
  let entries: Entry[] = [entry]
  let directory: LlmConfigurableProvider[] = [route()]
  ctx.provide('llm', { listConfigurableProviders: () => directory } as LlmRuntime)
  ctx.provide('configEditor', { entries: () => entries } as ConfigEditor)
  const source = createOfficialConnectionSource(ctx)
  return {
    ctx, source,
    get owner() { return owner }, get fiber() { return fiber }, get entry() { return entry },
    set(input: OfficialApiKey.Options) { fiber.config = config(input) },
    directory(value: LlmConfigurableProvider[]) { directory = value },
    entries(value: Entry[]) { entries = value },
    remount(input: OfficialApiKey.Options) {
      owner = new Context()
      fiber = { ctx: owner, config: config(input), state: 1 } as Fiber
      entry = { options: { id: 'official-renamed', name: '@deepseek-ai/dsh-llm-deepseek-api-key' }, disabled: false, fiber } as Entry
      entries = [entry]
    },
  }
}

test('SDK defaults are resolved through the official Config schema, including both context limits', () => {
  const ctx = new Context()
  const actual = createOfficialConnectionSource(ctx).get()
  assert.deepEqual(actual, expected({}, ctx))
  assert.equal(actual.defaultContextWindow, 1_000_000)
  assert.equal(actual.models.find(item => item.id === 'deepseek-flash')!.contextWindow, 1_048_576)
})

test('the test override uses official normalization and the launch environment without reading product settings', () => {
  const ctx = new Context()
  const env = createLaunchEnvironmentSnapshot([{ source: 'process', values: { DEEPSEEK_BASE_URL: 'https://example.invalid/anthropic' } }])
  ctx.provide('launchEnvironment', env)
  ctx.provide('configEditor', { entries() { throw new Error('must not read') } } as unknown as ConfigEditor)
  let current: OfficialApiKey.Options = { maxTokens: 321, modelsTimeoutMs: 789 }
  const source = createOfficialConnectionSource(ctx, () => current)
  assert.deepEqual(source.get(), expected(current, ctx))
  current = { maxTokens: 654, streamIdleTimeoutMs: 12345 }
  assert.deepEqual(source.get(), expected(current, ctx))
})

test('a renamed registered namespace shares all validated official live configuration and its environment', () => {
  const input: OfficialApiKey.Options = {
    maxTokens: 23456, thinking: 'enabled', reasoningEffort: 'high', defaultContextWindow: 43210,
    modelsTimeoutMs: 3456, modelsMaxAgeMs: 45678, streamIdleTimeoutMs: 34567,
    maxRequestFilesBytes: 140000000, maxInlineRequestImageBytes: 22000000,
    maxImagesPerRequest: 700, filesApiTimeoutMs: 12345, fileExpiresAfterSeconds: 72000,
    fileRefreshMarginSeconds: 7200, fileQuotaCleanupBatch: 80, apiKeyEnv: 'MY_OFFICIAL_REF',
    retryPolicy: { mode: 'normal', maxRetries: 9, backoff: { initialDelayMs: 123, maxDelayMs: 4567, jitterRatio: 0 } },
  }
  const f = fixture(input)
  f.owner.provide('launchEnvironment', createLaunchEnvironmentSnapshot([
    { source: 'process', values: { DEEPSEEK_BASE_URL: 'https://official-owner.invalid/anthropic' } },
  ]))
  assert.deepEqual(f.source.get(), expected(input, f.owner))
  const next = { ...input, maxTokens: 7654, retryPolicy: { mode: 'always' as const } }
  f.set(next)
  assert.deepEqual(f.source.get(), expected(next, f.owner))
  assert.equal(f.entry.options.config, undefined)
})

test('schema-validated LOADING entries are readable before provider-directory registration', () => {
  const f = fixture({ maxTokens: 345 })
  f.directory([])
  f.fiber.state = 1
  assert.equal(f.source.get().maxTokens, 345)
})

test('Cordis 4.1 reads accepted live settings even when the raw edit differs or is absent', async () => {
  const f = fixture()
  let effective = config({ maxTokens: 417 })
  f.fiber.config = { maxTokens: -1 }
  Object.defineProperty(f.fiber, 'effectiveConfig', { get: () => effective })
  assert.equal(f.source.get().maxTokens, 417)
  const seen: number[] = []
  const unsubscribe = f.source.subscribe(() => seen.push(f.source.get().maxTokens))
  try {
    f.fiber.config = undefined
    effective = config({ maxTokens: 912 })
    f.owner.emit('loader/volatile-update', [['maxTokens']])
    await turn()
    assert.deepEqual(seen, [912])
  } finally { unsubscribe() }
})

test('Cordis 4.1 never substitutes raw input while live settings are unavailable', () => {
  const f = fixture({ maxTokens: 500 })
  Object.defineProperty(f.fiber, 'effectiveConfig', { value: undefined })
  assert.throws(() => f.source.get(), { code: 'KEY_POOL_CONFIG_UNAVAILABLE' })
})

test('a mounted provider reads exactly the configuration the installed Cordis delivered to apply', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  let received: OfficialApiKey.ResolvedDeepSeekOptions | undefined
  const fiber = ctx.plugin({
    name: 'mounted-official-config-test',
    Config: OfficialApiKey.Config,
    apply(owner: Context, effective: OfficialApiKey.Config) {
      received = OfficialApiKey.resolveAdapterOptions(OfficialApiKey.plainOptions(effective), launchEnvironmentOf(owner))
    },
  }, { maxTokens: 1749 })
  await fiber
  const entry = { options: { id: 'official-renamed', name: '@deepseek-ai/dsh-llm-deepseek-api-key' }, disabled: false, fiber } satisfies Pick<Entry, 'options' | 'disabled' | 'fiber'>
  ctx.provide('configEditor', { entries: () => [entry] } as unknown as ConfigEditor)
  assert.equal(received?.maxTokens, 1749)
  assert.deepEqual(createOfficialConnectionSource(ctx).get(), received)
})

test('loader entries supply the public fallback when ConfigEditor omits an official row', () => {
  const f = fixture({ maxTokens: 678 })
  const entry = f.entry
  f.entries([])
  f.ctx.provide('loader', { *entries() { yield entry } } as never)
  assert.equal(f.source.get().maxTokens, 678)
})

test('SettingsForms plain values can supply a known namespace without Loader entries', () => {
  const ctx = new Context()
  const input: OfficialApiKey.Options = { maxTokens: 9876, retryPolicy: { mode: 'normal', maxRetries: 7 } }
  ctx.provide('llm', { listConfigurableProviders: () => [route('host-only')] } as unknown as LlmRuntime)
  ctx.provide('settings', { describe: () => [{ ns: 'host-only', value: input }] } as unknown as SettingsForms)
  assert.deepEqual(createOfficialConnectionSource(ctx).get(), expected(input, ctx))
})

test('an existing disabled, missing, or invalid live official configuration never silently becomes defaults', () => {
  const f = fixture({ maxTokens: 600 })
  assert.equal(f.source.get().maxTokens, 600)
  Object.defineProperty(f.entry, 'disabled', { value: true, configurable: true })
  assert.throws(() => f.source.get(), { code: 'KEY_POOL_CONFIG_UNAVAILABLE' })
  Object.defineProperty(f.entry, 'disabled', { value: false, configurable: true })
  f.fiber.config = undefined
  assert.throws(() => f.source.get(), { code: 'KEY_POOL_CONFIG_UNAVAILABLE' })
  f.directory([]); f.entries([])
  assert.throws(() => f.source.get(), { code: 'KEY_POOL_CONFIG_UNAVAILABLE' })
  const host = new Context()
  host.provide('configEditor', { entries: () => [] } as unknown as ConfigEditor)
  assert.throws(() => createOfficialConnectionSource(host).get(), { code: 'KEY_POOL_CONFIG_UNAVAILABLE' })
})

test('configuration-reader failures use a fixed safe error and never expose its raw text', () => {
  const ctx = new Context()
  const source = createOfficialConnectionSource(ctx, () => { throw new Error('synthetic-private-configuration') })
  assert.throws(() => source.get(), error => {
    assert.equal((error as { code: string }).code, 'KEY_POOL_CONFIG_UNAVAILABLE')
    assert.equal(String(error).includes('synthetic-private-configuration'), false)
    return true
  })
})

test('scoped official volatile changes notify once and re-read the new retry policy', async () => {
  const f = fixture({ retryPolicy: { mode: 'normal', maxRetries: 2 } })
  const seen: number[] = []
  const release = f.source.subscribe(() => {
    const policy = f.source.get().retryPolicy
    if (policy.mode === 'normal') seen.push(policy.maxRetries)
    f.ctx.emit('llm/adapters-updated')
  })
  f.set({ retryPolicy: { mode: 'normal', maxRetries: 8 } })
  f.owner.emit('loader/volatile-update', [['retryPolicy']])
  await turn(); await turn()
  assert.deepEqual(seen, [8])
  f.owner.emit('loader/volatile-update', [['retryPolicy']])
  await turn()
  assert.deepEqual(seen, [8])
  release()
  f.set({ retryPolicy: { mode: 'normal', maxRetries: 10 } })
  f.owner.emit('loader/volatile-update', [['retryPolicy']])
  await turn()
  assert.deepEqual(seen, [8])
})

test('remounts rebind the official owner and removal/reappearance notify availability', async () => {
  const f = fixture({ maxTokens: 100 })
  const changes: Array<number | 'unavailable'> = []
  const release = f.source.subscribe(() => {
    try { changes.push(f.source.get().maxTokens) } catch { changes.push('unavailable') }
  })
  const oldOwner = f.owner
  f.remount({ maxTokens: 200 })
  f.ctx.emit('llm/adapters-updated')
  await turn()
  f.set({ maxTokens: 300 })
  oldOwner.emit('loader/volatile-update', [['maxTokens']])
  await turn()
  assert.deepEqual(changes, [200])
  f.owner.emit('loader/volatile-update', [['maxTokens']])
  await turn()
  f.directory([]); f.entries([])
  f.ctx.emit('app-boot/config-reload')
  await turn()
  f.directory([route()]); f.remount({ maxTokens: 400 })
  f.ctx.emit('loader/config-update')
  await turn()
  assert.deepEqual(changes, [200, 300, 'unavailable', 400])
  release()
})

test('an official source appearing after subscription replaces SDK defaults', async () => {
  const ctx = new Context()
  const source = createOfficialConnectionSource(ctx)
  const seen: number[] = []
  const release = source.subscribe(() => seen.push(source.get().maxTokens))
  const owner = new Context()
  const entry = { options: { id: 'late', name: '@deepseek-ai/dsh-llm-deepseek-api-key' }, disabled: false,
    fiber: { ctx: owner, config: config({ maxTokens: 123 }), state: 2 } } as Entry
  ctx.provide('llm', { listConfigurableProviders: () => [route('late')] } as unknown as LlmRuntime)
  ctx.provide('configEditor', { entries: () => [entry] } as ConfigEditor)
  await turn()
  assert.deepEqual(seen, [123])
  release()
})

test('settings-read notifications do not recursively schedule forever or duplicate changes', async () => {
  const ctx = new Context()
  let maxTokens = 100
  let reads = 0
  ctx.provide('llm', { listConfigurableProviders: () => [route()] } as unknown as LlmRuntime)
  ctx.provide('settings', { describe() {
    reads++
    ctx.emit('settings/document-updated', 'official-renamed' as never, reads)
    return [{ ns: 'official-renamed', value: { maxTokens } }]
  } } as unknown as SettingsForms)
  const source = createOfficialConnectionSource(ctx)
  let notified = 0
  const release = source.subscribe(() => { notified++; source.get() })
  maxTokens = 200
  ctx.emit('settings/document-updated', 'official-renamed' as never, 9)
  await turn(); await turn()
  assert.equal(notified, 1)
  assert.ok(reads < 6)
  release()
})
