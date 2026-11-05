import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { APP_IDENTITY, LlmRuntime } from '@deepseek-ai/dsh-llm'
import * as DeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import { resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek-api-key'
import { registerOfficialPoolTransport } from '../src/official-provider.ts'

test('the installed SDK owns its listing lifecycle, badge handling and cancellation on unload', { timeout: 3000 }, async t => {
  const managed = typeof Reflect.get(DeepSeek, 'createModelListingCache') === 'function'
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  const route = 'listing-compat-test'
  const connection = resolveAdapterOptions({ modelsMaxAgeMs: 25, modelsTimeoutMs: 2000 })
  assert.ok(connection.listing)
  let calls = 0, releases = 0
  let secondSignal: AbortSignal | null | undefined
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, connection.listing!.url)
    assert.equal(new Headers(init.headers).get('x-api-key'), 'synthetic-catalog-test')
    if (++calls === 1) return Response.json({ data: [{
      id: 'deepseek-flash', name: 'Listed Flash', input_modalities: ['text'],
      api_capabilities: { anthropic_messages: {} },
      client_metadata: { [APP_IDENTITY.product]: { badge: { text: { en: 'Beta' }, tone: 'neutral' } } },
    }] })
    secondSignal = init.signal
    assert.ok(secondSignal)
    await new Promise<void>((_, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
    })
    throw new Error('aborted fetch cannot resolve')
  })
  const fiber = ctx.plugin({ name: route, inject: ['llm'], apply(child: Context) {
    registerOfficialPoolTransport(child, route, {
      get: () => connection, subscribe: () => () => { releases++ },
    }, { present: async () => 'synthetic-catalog-test', resolveAuth: async () => { throw new Error('model generation is outside this test') } })
  } })
  await fiber
  const notifications: string[] = []
  ctx.events.on('llm/models-updated', (provider: string) => notifications.push(provider))
  const models = await ctx.llm.listModels(route)
  assert.equal(models[0]?.name, 'Listed Flash')
  assert.deepEqual(notifications, managed ? [route] : [])
  const badge = Reflect.get(models[0]!, 'badge')
  if (managed) assert.deepEqual(badge, { text: { en: 'Beta' }, tone: 'neutral' })
  else assert.equal(badge, undefined)
  const deadline = Date.now() + 1000
  if (!managed) {
    // Legacy SDK has no refresh timer. A stale read returns last-known-good and
    // starts a background refresh; the current SDK starts it by itself.
    await delay(55)
    assert.equal(calls, 1)
    assert.equal((await ctx.llm.listModels(route))[0]?.name, 'Listed Flash')
  }
  while (!secondSignal && Date.now() < deadline) await delay(5)
  assert.ok(secondSignal, 'Expected an in-flight catalog refresh')
  assert.equal(secondSignal.aborted, false)
  await fiber.dispose()
  assert.equal(secondSignal.aborted, true)
  assert.equal(releases, 1)
  await delay(35)
  assert.equal(calls, 2, 'Unloading the provider must stop further refreshes')
})
