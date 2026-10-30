import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection/client'
import { KeyPoolPanel, displayBalance, parseImport } from '../src/client/Panel.tsx'
import { createClientRequest, parseSnapshot, PoolRequestError } from '../src/client/request.ts'
import { ActiveKeySummary, BalanceValue, ConsumptionValue, StatisticsDetails, PoolBalanceCard, PoolConsumptionCard } from '../src/client/Statistics.tsx'
import { timeLabel } from '../src/client/format.ts'
import { translateZh } from '../src/client/locales.ts'
import { keyListScrollTop, keyListViewportHeight, keyListWindow } from '../src/client/keyListPosition.ts'
import type { PoolSnapshot } from '../src/types.ts'

function snapshot(): PoolSnapshot {
  return {
    activeId: 'primary',
    settings: { autoSwitch: true, refreshIntervalSeconds: 300 },
    keys: [{
      id: 'primary', label: '工作', maskedKey: 'sk-…1234', enabled: true,
      status: 'ready', balanceCny: '12345678901234567890.000100',
      balanceObservationSource: 'api', balanceObservedAt: 1_792_672_000_000,
      lastCheckedAt: 1_792_672_000_000, lastError: null,
      statistics: {
        initialBalanceCny: '12345678901234567890.000500', lastObservedCny: '12345678901234567890.000100',
        totalConsumedCny: '0.000400', totalAddedCny: '0', startedAt: 1_792_671_000_000,
        updatedAt: 1_792_672_000_000, lastObservationSource: 'api',
      },
    }],
    events: [{ id: 'event-1', at: 1_792_672_000_000, kind: 'switch', message: '已选择工作 Key。' }],
  }
}

function replyWith(result: ConnectionRpcResult<unknown>) {
  return createClientRequest({ rpc: { call: async () => result } })
}

test('bulk paste accepts plain keys, named keys, Windows newlines, and blank lines', () => {
  const result = parseImport('  sk-synthetic_first  \r\n\r\n  备用账户 | sk-synthetic-second  \r\n')
  assert.deepEqual(result, [
    { key: 'sk-synthetic_first' },
    { label: '备用账户', key: 'sk-synthetic-second' },
  ])
})

test('empty and malformed imports report a fixed error without echoing pasted secrets', () => {
  const synthetic = 'sk-synthetic-sensitive-key'
  for (const input of ['', ' \r\n\t ', 'not-a-key', `label | ${synthetic} | extra`, `${synthetic} trailing`, `label | ${synthetic}?`]) {
    assert.throws(() => parseImport(input), error => {
      assert.ok(error instanceof Error)
      assert.equal(error.message, 'INVALID_IMPORT')
      assert.equal(String(error).includes(synthetic), false)
      return true
    })
  }
})

test('a label split over pasted lines cannot silently join another key', () => {
  for (const newline of ['\n', '\r\n']) {
    assert.throws(() => parseImport(`工作${newline}账户 | sk-synthetic-key`), /^Error: INVALID_IMPORT$/)
  }
})

test('the paste parser handles a 200-key batch without truncating or reordering it', () => {
  const input = Array.from({ length: 200 }, (_, index) => `Key ${index + 1} | sk-synthetic-${index}`)
  const result = parseImport(input.join('\n'))
  assert.equal(result.length, 200)
  assert.deepEqual(result[0], { label: 'Key 1', key: 'sk-synthetic-0' })
  assert.deepEqual(result[199], { label: 'Key 200', key: 'sk-synthetic-199' })
})

test('displayed CNY balances preserve long integers, tiny fractions, and trailing zeroes', () => {
  assert.equal(displayBalance('12345678901234567890.000100'), '12,345,678,901,234,567,890.000100')
  assert.equal(displayBalance('0.00000000000000000100'), '0.00000000000000000100')
  assert.equal(displayBalance('-12345.6700'), '-12,345.6700')
  assert.equal(displayBalance('0.00'), '0.00')
})

test('snapshot parsing retains the public state and strips unknown secret-bearing fields', () => {
  const expected = snapshot()
  const secret = 'sk-synthetic-private-value'
  const supplied = {
    ...expected, secret,
    settings: { ...expected.settings, privateToken: secret },
    keys: expected.keys.map(key => ({
      ...key, apiKey: secret, credentialRef: 'PRIVATE_KEY_REF',
      statistics: { ...key.statistics, privatePayload: secret },
    })),
    events: expected.events.map(event => ({ ...event, authorization: secret })),
  }
  const parsed = parseSnapshot(supplied)
  assert.deepEqual(parsed, expected)
  assert.equal(JSON.stringify(parsed).includes(secret), false)
  assert.equal(JSON.stringify(parsed).includes('credentialRef'), false)
  assert.equal(parsed.keys[0]!.balanceCny, '12345678901234567890.000100')
})

test('mismatched snapshot versions or field types fail before reaching the panel', () => {
  const valid = snapshot()
  const invalid: unknown[] = [
    null,
    { ...valid, keys: {} },
    { ...valid, settings: { autoSwitch: 'true', refreshIntervalSeconds: 300 } },
    { ...valid, keys: [{ ...valid.keys[0], status: 'not-a-real-status' }] },
    { ...valid, keys: [{ ...valid.keys[0], lastCheckedAt: Number.NaN }] },
    { ...valid, keys: [{ ...valid.keys[0], balanceObservationSource: 'guessed' }] },
    { ...valid, keys: [{ ...valid.keys[0], balanceObservedAt: Number.NaN }] },
    { ...valid, keys: [{ ...valid.keys[0], statistics: undefined }] },
    { ...valid, keys: [{ ...valid.keys[0], statistics: { ...valid.keys[0]!.statistics, totalConsumedCny: 0.25 } }] },
    { ...valid, keys: [{ ...valid.keys[0], statistics: { ...valid.keys[0]!.statistics, totalAddedCny: 'NaN' } }] },
    { ...valid, events: [{ ...valid.events[0], kind: 'not-a-real-event' }] },
  ]
  for (const value of invalid) assert.throws(() => parseSnapshot(value), /^Error: INVALID_POOL_RESPONSE$/)
})

test('client requests use the authenticated Harness RPC envelope and forward cancellation', async () => {
  const state = snapshot()
  const calls: unknown[][] = []
  const request = createClientRequest({ rpc: { call: async (...args) => {
    calls.push(args)
    return { ok: true, value: state }
  } } })
  const controller = new AbortController()
  assert.deepEqual(await request('setActive', { id: 'primary' }, controller.signal), state)
  assert.deepEqual(calls[0], ['/api', 'deepseekKeyPool/request', {
    args: { action: 'setActive', payload: { id: 'primary' } },
  }, controller.signal])
  await request('snapshot')
  assert.deepEqual(calls[1], ['/api', 'deepseekKeyPool/request', { args: { action: 'snapshot', payload: {} } }, undefined])
})

test('only the four explicit key-pool failure codes preserve the safe Host explanation', async () => {
  for (const code of ['key-pool/validation', 'key-pool/operation', 'key-pool/forbidden', 'key-pool/internal']) {
    const request = replyWith({ ok: false, error: { code, message: '请先启用该 Key。', details: {} } })
    await assert.rejects(request('setActive', { id: 'primary' }), error => {
      assert.ok(error instanceof PoolRequestError)
      assert.equal(error.message, '请先启用该 Key。')
      return true
    })
  }
})

test('other RPC failures hide their raw message even when their code shares the prefix', async () => {
  const raw = 'provider body containing sk-synthetic-secret'
  for (const code of ['gateway/internal', 'key-pool/unexpected', 'key-pool/internal-extra']) {
    const request = replyWith({ ok: false, error: { code, message: raw, details: { raw } } })
    await assert.rejects(request('snapshot'), error => {
      assert.ok(error instanceof Error)
      assert.equal(error instanceof PoolRequestError, false)
      assert.equal(error.message, 'KEY_POOL_REQUEST_FAILED')
      assert.equal(String(error).includes(raw), false)
      return true
    })
  }
})

test('the panel first renders a loading state without inventing balances or making render-time calls', () => {
  let calls = 0
  const html = renderToStaticMarkup(createElement(KeyPoolPanel, {
    request: async () => { calls++; return snapshot() },
  }))
  assert.equal(calls, 0)
  assert.match(html, /正在读取 Key 池/)
  assert.equal(html.includes('12345678901234567890.000100'), false)
  assert.equal(html.includes('sk-…1234'), false)
})

test('current-key summary displays remaining credit and exact cumulative consumption', () => {
  const entry = snapshot().keys[0]!
  const html = renderToStaticMarkup(createElement(ActiveKeySummary, { entry, t: translateZh }))
  assert.match(html, /当前 Key/)
  assert.match(html, /剩余总额度/)
  assert.match(html, /累计消耗/)
  assert.match(html, /12,345,678,901,234,567,890\.000100/)
  assert.match(html, /0\.000400/)
  assert.match(html, /CNY/)
})

test('new or migrated keys show pending statistics without inventing historical zero consumption', () => {
  const entry = snapshot().keys[0]!
  entry.statistics = {
    initialBalanceCny: null, lastObservedCny: null, totalConsumedCny: '0', totalAddedCny: '0',
    startedAt: null, updatedAt: null, lastObservationSource: null,
  }
  const html = renderToStaticMarkup(createElement(ConsumptionValue, { entry, t: translateZh, details: true }))
  assert.match(html, /待首次有效查询/)
  assert.match(html, /不补算历史消耗/)
  assert.equal(html.includes('¥'), false)
  entry.balanceObservedAt = null
  const cached = renderToStaticMarkup(createElement(BalanceValue, { entry, t: translateZh }))
  assert.match(cached, /12,345,678,901,234,567,890\.000100/)
  assert.match(cached, /已保存余额，等待更新/)
  assert.equal(cached.includes('查询于'), false)
})

test('derived zero carries an explicit unavailable-balance caption, while an API numeric zero does not', () => {
  const entry = snapshot().keys[0]!
  entry.balanceCny = null
  entry.balanceObservationSource = 'unavailable-zero'
  entry.statistics.lastObservedCny = '0'
  entry.statistics.lastObservationSource = 'unavailable-zero'
  const derived = renderToStaticMarkup(createElement(BalanceValue, { entry, t: translateZh }))
  assert.match(derived, /0\.00/)
  assert.match(derived, /接口当前无可用余额/)
  entry.balanceCny = '0.00'
  entry.balanceObservationSource = 'api'
  const exact = renderToStaticMarkup(createElement(BalanceValue, { entry, t: translateZh }))
  assert.match(exact, /0\.00/)
  assert.equal(exact.includes('接口当前无可用余额'), false)
})

test('a later response without CNY cannot reuse an older derived zero as the current amount', () => {
  const entry = snapshot().keys[0]!
  entry.balanceCny = null
  entry.balanceObservationSource = null
  entry.balanceObservedAt = null
  entry.statistics.lastObservedCny = '0'
  entry.statistics.lastObservationSource = 'unavailable-zero'
  // Same timestamps deliberately rule out using time equality as an evidence type.
  entry.statistics.updatedAt = entry.lastCheckedAt
  const html = renderToStaticMarkup(createElement(BalanceValue, { entry, t: translateZh }))
  assert.match(html, /暂无 CNY 余额/)
  assert.equal(html.includes('¥'), false)
  assert.equal(html.includes('接口当前无可用余额'), false)
  const consumption = renderToStaticMarkup(createElement(ConsumptionValue, { entry, t: translateZh }))
  assert.match(consumption, /0\.000400/)
  assert.match(consumption, /截至/)
})

test('failed-check time does not make a retained amount look freshly observed', () => {
  const entry = snapshot().keys[0]!
  entry.lastCheckedAt = entry.balanceObservedAt! + 86_400_000
  entry.lastError = '余额查询失败，请稍后重试。'
  const html = renderToStaticMarkup(createElement(BalanceValue, { entry, t: translateZh }))
  assert.ok(html.includes(timeLabel(entry.balanceObservedAt!)))
  assert.equal(html.includes(timeLabel(entry.lastCheckedAt)), false)
  const details = renderToStaticMarkup(createElement(StatisticsDetails, { entry, t: translateZh }))
  assert.match(details, /首次记录余额/)
  assert.match(details, /累计余额增加/)
  assert.ok(details.includes(timeLabel(entry.statistics.startedAt!)))
  assert.ok(details.includes(timeLabel(entry.statistics.updatedAt!)))
})

test('the pool card shows a subtotal with coverage when an enabled key has no confirmed balance', () => {
  const ready = { ...snapshot().keys[0]!, balanceCny: '11.9000' }
  const unknown = { ...ready, id: 'unknown', status: 'unknown' as const, balanceCny: null, balanceObservationSource: null, balanceObservedAt: null }
  const html = renderToStaticMarkup(createElement(PoolBalanceCard, { keys: [ready, unknown], t: translateZh }))
  assert.match(html, /号池可用余额合计/)
  assert.match(html, /11\.9000/)
  assert.match(html, /已计入 1 \/ 2 枚启用 Key/)
  assert.match(html, /已知余额小计，尚非完整总额/)
  assert.match(html, /1 枚启用 Key 的余额未确认/)
  assert.match(html, /最近查询快照/)
})

test('the pool card distinguishes entirely unknown balances from a confirmed empty pool', () => {
  const unknown = { ...snapshot().keys[0]!, status: 'error' as const }
  const pending = renderToStaticMarkup(createElement(PoolBalanceCard, { keys: [unknown], t: translateZh }))
  assert.match(pending, /尚无可确认的余额数据/)
  assert.equal(pending.includes('¥'), false)
  const empty = renderToStaticMarkup(createElement(PoolBalanceCard, { keys: [], t: translateZh }))
  assert.match(empty, /已计入 0 \/ 0 枚启用 Key/)
  assert.match(empty, /当前没有启用的 Key/)
  assert.ok(empty.includes('¥'))
  assert.match(empty, /0\.00/)
  const preciseZero = { ...snapshot().keys[0]!, balanceCny: '0.0000' }
  const confirmed = renderToStaticMarkup(createElement(PoolBalanceCard, { keys: [preciseZero], t: translateZh }))
  assert.match(confirmed, /0\.0000/)
})

test('the pool consumption card reveals historical usage outside the current key and shows coverage', () => {
  const current = snapshot().keys[0]!
  current.statistics.totalConsumedCny = '0'
  const previous = { ...current, id: 'spent', enabled: false, status: 'exhausted' as const, statistics: { ...current.statistics, totalConsumedCny: '8.3750' } }
  const pending = { ...current, id: 'new', statistics: {
    initialBalanceCny: null, lastObservedCny: null, totalConsumedCny: '0', totalAddedCny: '0',
    startedAt: null, updatedAt: null, lastObservationSource: null,
  } }
  const html = renderToStaticMarkup(createElement(PoolConsumptionCard, { keys: [current, previous, pending], t: translateZh }))
  assert.match(html, /号池累计消耗/)
  assert.match(html, /8\.3750/)
  assert.match(html, /统计覆盖 2 \/ 3 枚 Key/)
  assert.match(html, /1 枚尚未开始统计/)
  assert.match(html, /包含停用、耗尽 Key/)
  assert.match(html, /非精确账单/)
})

test('the pool consumption card distinguishes no baseline from a measured zero', () => {
  const key = snapshot().keys[0]!
  key.statistics = {
    initialBalanceCny: null, lastObservedCny: null, totalConsumedCny: '0', totalAddedCny: '0',
    startedAt: null, updatedAt: null, lastObservationSource: null,
  }
  const pending = renderToStaticMarkup(createElement(PoolConsumptionCard, { keys: [key], t: translateZh }))
  assert.match(pending, /等待首次有效余额记录/)
  assert.equal(pending.includes('¥'), false)
  key.statistics.startedAt = 1000
  key.statistics.initialBalanceCny = '10.00'
  key.statistics.updatedAt = 1000
  const zero = renderToStaticMarkup(createElement(PoolConsumptionCard, { keys: [key], t: translateZh }))
  assert.match(zero, /0\.00/)
  assert.match(zero, /统计覆盖 1 \/ 1 枚 Key/)
})

test('the key list window keeps priority neighbors around the active key without reordering', () => {
  const ids = Array.from({ length: 248 }, (_, index) => `key-${index + 1}`)
  const original = [...ids]
  const window = keyListWindow(ids, 'key-137')
  assert.deepEqual(ids.slice(window.start, window.end), ['key-136', 'key-137', 'key-138', 'key-139'])
  assert.equal(window.active, 136)
  assert.deepEqual(ids, original)
})

test('first and tail keys retain a second-row position when a previous key exists', () => {
  const ids = Array.from({ length: 248 }, (_, index) => `key-${index + 1}`)
  assert.deepEqual(keyListWindow(ids, 'key-1'), { start: 0, end: 4, active: 0 })
  assert.deepEqual(keyListWindow(ids, 'key-2'), { start: 0, end: 4, active: 1 })
  assert.deepEqual(keyListWindow(ids, 'key-247'), { start: 245, end: 248, active: 246 })
  assert.deepEqual(keyListWindow(ids, 'key-248'), { start: 246, end: 248, active: 247 })
  assert.deepEqual(keyListWindow(['one'], 'one'), { start: 0, end: 1, active: 0 })
  assert.deepEqual(keyListWindow([], null), { start: 0, end: 0, active: -1 })
  assert.deepEqual(keyListWindow(ids, 'removed-key'), { start: 0, end: 4, active: -1 })
})

test('a tall-error window cannot expose five short rows, and tail windows need no fake rows', () => {
  assert.equal(keyListViewportHeight([160, 160, 160, 160], [80, 160, 160, 160, 160], 36), 356)
  assert.equal(keyListViewportHeight([80, 80], [80, 160, 80], 36), 196)
  assert.equal(keyListViewportHeight([180, 180, 180, 180], [180, 180, 180, 180], 0), 720)
  assert.equal(keyListViewportHeight([], [], 36), 0)
})

test('locating the active key keeps it visible when the previous row has expanded details', () => {
  const normal = { previousTop: 100, activeTop: 180, previousCollapsedHeight: 80, activeCollapsedHeight: 80, headerHeight: 36, viewportHeight: 356 }
  assert.equal(keyListScrollTop(normal), 64)
  const expanded = { ...normal, activeTop: 700 }
  const top = keyListScrollTop(expanded)
  assert.equal(top, 584)
  assert.equal(expanded.activeTop - top - expanded.headerHeight, 80)
  assert.equal(keyListScrollTop({ ...normal, previousTop: 36, activeTop: 36 }), 0)
})
