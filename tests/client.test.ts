import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection/client'
import { KeyPoolPanel, displayBalance, importBatchProblem, parseImport } from '../src/client/Panel.tsx'
import { createClientRequest, parseSnapshot, PoolRequestError } from '../src/client/request.ts'
import { ActiveKeySummary, BalanceValue, ConsumptionValue, StatisticsDetails, PoolBalanceCard, PoolConsumptionCard } from '../src/client/Statistics.tsx'
import { clockLabel, dateLabel, timeLabel } from '../src/client/format.ts'
import { translateZh } from '../src/client/locales.ts'
import { DEFAULT_PAGE_SIZE, PAGE_SIZES, clampPage, filterKeys, keyDisplayName, keyPage, moveToTopIds, pageCountOf, pageOfKey } from '../src/client/keyListPosition.ts'
import type { PoolSnapshot } from '../src/types.ts'
import type { KeyView } from '../src/client/types.ts'

function snapshot(): PoolSnapshot {
  return {
    activeId: 'primary',
    settings: { autoSwitch: true, refreshIntervalSeconds: 300 },
    keys: [{
      id: 'primary', label: '工作', maskedKey: 'key…1234', enabled: true,
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

function manyKeys(count: number): KeyView[] {
  const base = snapshot().keys[0]!
  return Array.from({ length: count }, (_, index) => ({
    ...base,
    id: `key-${index + 1}`,
    label: index % 3 === 0 ? '' : `账户 ${index + 1}`,
    maskedKey: `…${String(index + 1).padStart(4, '0')}`,
    status: index % 5 === 0 ? 'unknown' as const : 'ready' as const,
  }))
}

// Import-parser fixtures need the sk- shape at runtime; build them dynamically so no key literal sits in the source.
const fakeKey = (name: string) => 'sk-' + name

function replyWith(result: ConnectionRpcResult<unknown>) {
  return createClientRequest({ rpc: { call: async () => result } })
}

test('bulk paste accepts plain keys, named keys, Windows newlines, and blank lines', () => {
  const result = parseImport(`  ${fakeKey('synthetic_first')}  \r\n\r\n  备用账户 | ${fakeKey('synthetic-second')}  \r\n`)
  assert.deepEqual(result, [
    { key: fakeKey('synthetic_first') },
    { label: '备用账户', key: fakeKey('synthetic-second') },
  ])
})

test('empty and malformed imports report a fixed error without echoing pasted secrets', () => {
  const synthetic = fakeKey('synthetic-sensitive-key')
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
    assert.throws(() => parseImport(`工作${newline}账户 | ${fakeKey('synthetic-key')}`), /^Error: INVALID_IMPORT$/)
  }
})

test('the paste parser handles a 200-key batch without truncating or reordering it', () => {
  const input = Array.from({ length: 200 }, (_, index) => `Key ${index + 1} | ${fakeKey(`synthetic-${index}`)}`)
  const result = parseImport(input.join('\n'))
  assert.equal(result.length, 200)
  assert.deepEqual(result[0], { label: 'Key 1', key: fakeKey('synthetic-0') })
  assert.deepEqual(result[199], { label: 'Key 200', key: fakeKey('synthetic-199') })
  assert.equal(importBatchProblem(result), null)
})

test('the 1-200 batch limit is enforced before any request leaves the browser', () => {
  const batch = (size: number) => Array.from({ length: size }, (_, index) => ({ key: fakeKey(`synthetic-${index}`) }))
  assert.equal(importBatchProblem([]), 'empty')
  assert.equal(importBatchProblem(batch(1)), null)
  assert.equal(importBatchProblem(batch(200)), null)
  assert.equal(importBatchProblem(batch(201)), 'limit')
})

test('displayed CNY balances preserve long integers, tiny fractions, and trailing zeroes', () => {
  assert.equal(displayBalance('12345678901234567890.000100'), '12,345,678,901,234,567,890.000100')
  assert.equal(displayBalance('0.00000000000000000100'), '0.00000000000000000100')
  assert.equal(displayBalance('-12345.6700'), '-12,345.6700')
  assert.equal(displayBalance('0.00'), '0.00')
})

test('snapshot parsing retains the public state and strips unknown secret-bearing fields', () => {
  const expected = snapshot()
  const secret = 'test-secret-private-value'
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
  assert.equal(parsed.importSummary, undefined)
})

test('import replies expose the optional added/duplicate counters', () => {
  const parsed = parseSnapshot({ ...snapshot(), importSummary: { added: 3, duplicates: 2 } })
  assert.deepEqual(parsed.importSummary, { added: 3, duplicates: 2 })
  assert.equal(JSON.stringify(parsed).includes('secret'), false)
  assert.equal(translateZh('importSummary', { added: 3, duplicates: 2 }), '已导入 3 枚，跳过重复 2 枚。')
})

test('malformed import counters fail the reply instead of rendering NaN', () => {
  for (const importSummary of [
    null,
    { added: 3 },
    { added: '3', duplicates: 2 },
    { added: 3, duplicates: -1 },
    { added: 1.5, duplicates: 0 },
    { added: Number.NaN, duplicates: 0 },
    [],
  ]) {
    assert.throws(() => parseSnapshot({ ...snapshot(), importSummary }), /^Error: INVALID_POOL_RESPONSE$/)
  }
})

test('snapshot parsing keeps an event key label for the history table', () => {
  const supplied = snapshot()
  supplied.events = [{ id: 'event-9', at: 1_792_672_000_000, kind: 'exhausted', message: '演示 Key A：余额不足。', keyLabel: '演示 Key A' }]
  const parsed = parseSnapshot(supplied)
  assert.equal(parsed.events[0]!.keyLabel, '演示 Key A')
  const unlabeled = snapshot()
  assert.equal(parseSnapshot(unlabeled).events[0]!.keyLabel, undefined)
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
  const raw = 'provider body containing test-credential-secret'
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
  assert.equal(html.includes('key…1234'), false)
})

test('the page owns the single h1, so the embedded panel hides its own section title', () => {
  const html = renderToStaticMarkup(createElement(KeyPoolPanel, {
    request: async () => snapshot(), showTitle: false,
  }))
  assert.equal(html.includes('<h1'), false)
  assert.match(html, /<h2[^>]*class="dskp-visually-hidden"[^>]*>DeepSeek Key 池<\/h2>/)
  assert.equal(html.includes('class="dskp-heading"'), false)
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
  assert.match(html, /仅合计已启用、已确认可用的人民币余额/)
})

test('the pool card explains excluded keys so a partial total is not mistaken for a bug', () => {
  const ready = { ...snapshot().keys[0]!, balanceCny: '11.9000' }
  const exhausted = { ...ready, id: 'spent', status: 'exhausted' as const, balanceCny: '0.0000' }
  const invalid = { ...ready, id: 'bad', status: 'invalid' as const, balanceCny: null }
  const disabled = { ...ready, id: 'off', enabled: false, status: 'ready' as const, balanceCny: '2.0000' }
  const html = renderToStaticMarkup(createElement(PoolBalanceCard, { keys: [ready, exhausted, invalid, disabled], t: translateZh }))
  assert.match(html, /其余 2 枚已确认不可用，不计入总额/)
  assert.match(html, /另有 1 枚已停用，不计入总额/)
  assert.match(html, /已计入 1 \/ 3 枚启用 Key/)
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

test('the pool consumption card reveals historical usage outside the current key and shows its measurement rule', () => {
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
  assert.match(html, /不按账户去重/)
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

test('search filters by label, masked key, and the status copy the user reads', () => {
  const keys = manyKeys(30)
  keys[0]!.label = 'Work Account'
  keys[0]!.maskedKey = 'sk-…ZZZ9'
  const label = filterKeys(keys, 'work', entry => translateZh(entry.enabled ? entry.status : 'disabled'))
  assert.deepEqual(label.map(entry => entry.id), ['key-1'])
  const masked = filterKeys(keys, 'zzz9', () => '')
  assert.deepEqual(masked.map(entry => entry.id), ['key-1'])
  const status = filterKeys(keys, '待查询', entry => translateZh(entry.enabled ? entry.status : 'disabled'))
  assert.ok(status.length > 0)
  assert.ok(status.every(entry => entry.status === 'unknown'))
  assert.equal(filterKeys(keys, '   ', () => '').length, 30)
  assert.equal(filterKeys(keys, 'no-such-label', () => '').length, 0)
  assert.notEqual(filterKeys(keys, '   ', () => ''), keys)
})

test('pagination keeps the DOM row count at the page size for a 249-key pool', () => {
  const keys = manyKeys(249)
  const first = keyPage(keys, 0, DEFAULT_PAGE_SIZE)
  assert.equal(DEFAULT_PAGE_SIZE, 20)
  assert.deepEqual(PAGE_SIZES, [20, 50, 100])
  assert.equal(first.items.length, 20)
  assert.equal(pageCountOf(249, 20), 13)
  const last = keyPage(keys, 12, 20)
  assert.equal(last.page, 12)
  assert.equal(last.items.length, 9)
  assert.equal(last.items[0]!.id, 'key-241')
  assert.equal(last.items.at(-1)!.id, 'key-249')
  const hundred = keyPage(keys, 2, 100)
  assert.equal(hundred.items.length, 49)
  assert.equal(hundred.pageCount, 3)
  // A stale index (e.g. after filtering or removal) clamps into range instead of crashing.
  assert.equal(keyPage(keys, 99, 20).page, 12)
  assert.equal(clampPage(99, 249, 20), 12)
  assert.equal(clampPage(-2, 249, 20), 0)
  const empty = keyPage([], 5, 20)
  assert.deepEqual({ page: empty.page, pageCount: empty.pageCount, items: empty.items }, { page: 0, pageCount: 1, items: [] })
})

test('locating the current key picks the page that holds it', () => {
  const keys = manyKeys(249)
  assert.equal(pageOfKey(keys, 'key-1', 20), 0)
  assert.equal(pageOfKey(keys, 'key-20', 20), 0)
  assert.equal(pageOfKey(keys, 'key-21', 20), 1)
  assert.equal(pageOfKey(keys, 'key-249', 50), 4)
  assert.equal(pageOfKey(keys, null, 20), 0)
  assert.equal(pageOfKey(keys, 'removed', 20), 0)
})

test('pinning a key rewrites the priority order without disturbing the others', () => {
  const ids = ['a', 'b', 'c', 'd']
  assert.deepEqual(moveToTopIds(ids, 'c'), ['c', 'a', 'b', 'd'])
  assert.deepEqual(moveToTopIds(ids, 'd'), ['d', 'a', 'b', 'c'])
  assert.deepEqual(ids, ['a', 'b', 'c', 'd'])
  assert.equal(moveToTopIds(ids, 'a'), null)
  assert.equal(moveToTopIds(ids, 'missing'), null)
  const pinned = moveToTopIds(Array.from({ length: 249 }, (_, index) => `key-${index + 1}`), 'key-249')!
  assert.equal(pinned.length, 249)
  assert.equal(pinned[0], 'key-249')
  assert.equal(new Set(pinned).size, 249)
})

test('timestamps include the year and follow the caller locale', () => {
  const value = Date.UTC(2024, 0, 2, 3, 4, 5)
  assert.match(timeLabel(value, 'zh-CN'), /2024/)
  assert.match(timeLabel(value), /2024/)
  assert.match(dateLabel(value, 'zh-CN'), /2024/)
  assert.match(clockLabel(value, 'zh-CN'), /\d{2}:\d{2}:\d{2}/)
  assert.notEqual(timeLabel(value, 'zh-CN'), timeLabel(value, 'en-US'))
})

test('an unnamed key falls back to the shared unnamed copy in every action label', () => {
  const entry = { ...snapshot().keys[0]!, label: '   ' }
  assert.equal(keyDisplayName(entry, '未命名 Key'), '未命名 Key')
  assert.equal(keyDisplayName({ ...entry, label: '工作' }, '未命名 Key'), '工作')
})
