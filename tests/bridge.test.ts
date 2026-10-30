import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { KeyPool } from '../src/pool.ts'
import { registerBridge } from '../src/bridge.ts'
import type { PoolMetadata } from '../src/types.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    'key-pool-test-guest': { readonly kind: 'key-pool-test-guest' }
  }
}

async function setup() {
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(RemoteAccess)
  await ctx.plugin(TypertGateway)
  const keys = new Map<string, string>()
  let metadata: PoolMetadata | undefined
  const credentials = {
    resolve: async (ref: string) => keys.get(ref),
    set: async (ref: string, value: string) => { keys.set(ref, value) },
    unset: async (ref: string) => { keys.delete(ref) },
  }
  const pool = new KeyPool({
    credentials,
    metadata: { load: async () => metadata, save: async value => { metadata = structuredClone(value) } },
    fetch: async () => Response.json({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '1.00' }] }),
  })
  await pool.init()
  await pool.updateSettings({ refreshIntervalSeconds: 0 })
  const fiber = ctx.plugin({ name: 'test-key-pool', apply: (child: Context) => { registerBridge(child, pool) } })
  await fiber
  const peer = new Peer(ctx, { principal: { kind: 'owner' } })
  const call = (action: unknown, payload: unknown) => ctx.typertGateway.invoke({
    namespace: 'deepseekKeyPool', method: 'request', args: { action, payload }, peer,
  })
  const close = async () => { pool.stop(); await ctx.fiber.dispose() }
  return { ctx, pool, credentials, fiber, call, close }
}

test('real Harness Gateway discovers the ungenerated Remote and never returns imported secrets', async () => {
  const fixture = await setup()
  try {
    assert.deepEqual(await fixture.call('snapshot', {}), fixture.pool.snapshot())
    const key = 'test-credential-bridge-secret-do-not-return'
    const result = await fixture.call('importKeys', { keys: [{ label: '备用', key }] })
    assert.equal(JSON.stringify(result).includes(key), false)
    assert.equal(fixture.pool.snapshot().keys.length, 1)
    assert.equal((await fixture.pool.acquire()).key, key)
    assert.equal(JSON.stringify(result).includes('credentialRef'), false)
    await assert.rejects(fixture.call('remove', { id: '../private' }), /标识/)
    await assert.rejects(fixture.call('snapshot', { key }), /不支持的参数/)
  } finally { await fixture.close() }
})

test('Remote rejects calls without an admitted owner and withdraws with its plugin', async () => {
  const fixture = await setup()
  try {
    const service = fixture.ctx.get('deepseekKeyPool') as ReturnType<typeof registerBridge>
    await assert.rejects(service.request('snapshot', {}), /所有者/)
    const guest = new Peer(fixture.ctx, { principal: { kind: 'key-pool-test-guest' } })
    await assert.rejects(fixture.ctx.typertGateway.invoke({
      namespace: 'deepseekKeyPool', method: 'request', args: { action: 'snapshot', payload: {} }, peer: guest,
    }), /access|denied|permission|allowed/i)
    await fixture.fiber.dispose()
    await assert.rejects(fixture.call('snapshot', {}), /no active Remote|unavailable/)
  } finally { await fixture.close() }
})

test('malformed wire arguments are rejected without printing their values', async () => {
  const fixture = await setup()
  try {
    const secret = 'test-credential-sensitive-input'
    await assert.rejects(fixture.call('importKeys', { keys: [{ key: secret, unexpected: secret }] }), error => {
      assert.equal(String(error).includes(secret), false)
      assert.equal(remoteErrorOf(error)?.code, 'key-pool/validation')
      return true
    })
    await assert.rejects(fixture.call('updateSettings', { refreshIntervalSeconds: 1 }), /刷新间隔/)
  } finally { await fixture.close() }
})

test('unexpected errors are redacted while safe domain failures retain explicit codes', async () => {
  const fixture = await setup()
  try {
    await assert.rejects(fixture.call('updateSettings', { refreshIntervalSeconds: 1 }), error => {
      assert.equal(remoteErrorOf(error)?.code, 'key-pool/operation')
      assert.match(String(error), /刷新间隔/)
      return true
    })
    fixture.pool.refresh = async () => { throw new Error('raw provider body with test-credential-private-secret') }
    await assert.rejects(fixture.call('refresh', {}), error => {
      assert.equal(remoteErrorOf(error)?.code, 'key-pool/internal')
      assert.equal(String(error).includes('test-credential-private-secret'), false)
      return true
    })
  } finally { await fixture.close() }
})

test('partially committed removal publishes fresh availability and an actionable safe error', async () => {
  const fixture = await setup()
  try {
    await fixture.call('importKeys', { keys: [{ label: '待删除', key: 'test-credential-removal-key' }] })
    const id = fixture.pool.snapshot().keys[0]!.id
    let changes = 0
    fixture.ctx.on('llm/adapters-updated', () => { changes++ })
    fixture.credentials.unset = async () => { throw new Error('storage failure with test-credential-removal-key') }
    await assert.rejects(fixture.call('remove', { id }), error => {
      assert.equal(remoteErrorOf(error)?.code, 'key-pool/operation')
      assert.match(String(error), /已从列表移除/)
      assert.equal(String(error).includes('test-credential-removal-key'), false)
      return true
    })
    assert.equal(changes, 1)
    assert.equal(fixture.pool.snapshot().keys.length, 0)
  } finally { await fixture.close() }
})
