import test from 'node:test'
import assert from 'node:assert/strict'
import { summarizePoolBalance, summarizePoolConsumption } from '../src/pool-summary.ts'
import type { PoolBalanceEntry, PoolConsumptionEntry } from '../src/pool-summary.ts'

function entry(overrides: Partial<PoolBalanceEntry> = {}): PoolBalanceEntry {
  return {
    enabled: true, status: 'ready', balanceCny: '10.00',
    balanceObservationSource: 'api', balanceObservedAt: 1000,
    ...overrides,
  }
}

test('pool balance adds every eligible key independently with exact decimal precision', () => {
  const result = summarizePoolBalance([
    entry({ balanceCny: '9007199254740993.000000000000000001', balanceObservedAt: 3000 }),
    entry({ balanceCny: '0.000000000000000002', balanceObservedAt: 2000 }),
    entry({ balanceCny: '10.00', balanceObservedAt: 4000 }),
    entry({ balanceCny: '10.00', balanceObservedAt: 5000 }),
  ])
  assert.deepEqual(result, {
    totalCny: '9007199254741013.000000000000000003', includedCount: 4,
    enabledCount: 4, missingCount: 0, oldestObservedAt: 2000,
  })
})

test('disabled, invalid, and exhausted keys cannot inflate the available total with old balances', () => {
  const result = summarizePoolBalance([
    entry(), entry({ enabled: false, balanceCny: '1000.00' }),
    entry({ status: 'invalid', balanceCny: '2000.00' }),
    entry({ status: 'exhausted', balanceCny: '3000.00' }),
  ])
  assert.deepEqual(result, { totalCny: '10.00', includedCount: 1, enabledCount: 3, missingCount: 0, oldestObservedAt: 1000 })
})

test('query failures, unqueried keys, and missing CNY evidence produce an explicitly partial total', () => {
  const result = summarizePoolBalance([
    entry(),
    entry({ status: 'error', balanceCny: '500.00' }),
    entry({ status: 'unknown', balanceCny: null, balanceObservationSource: null, balanceObservedAt: null }),
    entry({ balanceCny: null, balanceObservationSource: null, balanceObservedAt: null }),
    entry({ balanceObservationSource: null }),
    entry({ balanceObservedAt: null }),
  ])
  assert.deepEqual(result, { totalCny: '10.00', includedCount: 1, enabledCount: 6, missingCount: 5, oldestObservedAt: 1000 })
})

test('entirely unconfirmed balances remain unknown rather than turning into a fabricated zero', () => {
  const result = summarizePoolBalance([
    entry({ status: 'error' }), entry({ balanceObservedAt: null }),
    entry({ status: 'exhausted', balanceCny: null, balanceObservationSource: 'unavailable-zero' }),
  ])
  assert.deepEqual(result, { totalCny: null, includedCount: 0, enabledCount: 3, missingCount: 2, oldestObservedAt: null })
})

test('confirmed unavailable keys, an empty pool, and a disabled pool have a known zero', () => {
  const empty = { totalCny: '0', includedCount: 0, enabledCount: 0, missingCount: 0, oldestObservedAt: null }
  assert.deepEqual(summarizePoolBalance([]), empty)
  assert.deepEqual(summarizePoolBalance([entry({ enabled: false, status: 'unknown' })]), empty)
  assert.deepEqual(summarizePoolBalance([
    entry({ status: 'invalid' }),
    entry({ status: 'exhausted', balanceCny: null, balanceObservationSource: 'unavailable-zero' }),
  ]), { ...empty, enabledCount: 2 })
})

test('a confirmed numeric zero counts as observed data while missing CNY does not', () => {
  const result = summarizePoolBalance([
    entry({ balanceCny: '0.0000', balanceObservedAt: 0 }),
    entry({ balanceCny: null, balanceObservationSource: null, balanceObservedAt: null }),
  ])
  assert.deepEqual(result, { totalCny: '0.0000', includedCount: 1, enabledCount: 2, missingCount: 1, oldestObservedAt: 0 })
})

function consumption(value: string, updatedAt = 1000): PoolConsumptionEntry {
  return {
    statistics: {
      initialBalanceCny: '50.00', lastObservedCny: '10.00', totalConsumedCny: value, totalAddedCny: '0',
      startedAt: 100, updatedAt, lastObservationSource: 'api',
    },
  }
}

test('pool consumption includes historical usage from disabled, exhausted, invalid, and failed keys', () => {
  const keys = [
    { ...consumption('0.00', 5000), enabled: true, status: 'ready' },
    { ...consumption('1.2500', 4000), enabled: false, status: 'ready' },
    { ...consumption('2.1250', 3000), enabled: true, status: 'exhausted' },
    { ...consumption('3.5000', 2000), enabled: true, status: 'invalid' },
    { ...consumption('4.0000', 1000), enabled: true, status: 'error' },
  ]
  assert.deepEqual(summarizePoolConsumption(keys), {
    totalCny: '10.8750', trackedCount: 5, totalCount: 5, missingCount: 0, oldestUpdatedAt: 1000,
  })
})

test('pool consumption adds decimal strings beyond floating-point precision without deduplication', () => {
  const result = summarizePoolConsumption([
    consumption('9007199254740993.000000000000000001'),
    consumption('0.000000000000000002'),
    consumption('1.2500'), consumption('1.2500'),
  ])
  assert.equal(result.totalCny, '9007199254740995.500000000000000003')
  assert.equal(result.trackedCount, 4)
})

test('unstarted statistics do not turn their initialized zero string into known historical consumption', () => {
  const unstarted: PoolConsumptionEntry = { statistics: {
    initialBalanceCny: null, lastObservedCny: null, totalConsumedCny: '0', totalAddedCny: '0',
    startedAt: null, updatedAt: null, lastObservationSource: null,
  } }
  assert.deepEqual(summarizePoolConsumption([unstarted]), {
    totalCny: null, trackedCount: 0, totalCount: 1, missingCount: 1, oldestUpdatedAt: null,
  })
  assert.deepEqual(summarizePoolConsumption([]), {
    totalCny: null, trackedCount: 0, totalCount: 0, missingCount: 0, oldestUpdatedAt: null,
  })
  assert.deepEqual(summarizePoolConsumption([consumption('0'), unstarted]), {
    totalCny: '0', trackedCount: 1, totalCount: 2, missingCount: 1, oldestUpdatedAt: 1000,
  })
})

test('a large pool reports observed consumption even when its current key has spent nothing', () => {
  const keys = Array.from({ length: 248 }, (_, index) => {
    const value = index === 120 ? '1.2500' : index === 233 ? '2.5000' : '0'
    const key = consumption(value, 1000 + index)
    if (index >= 234) key.statistics = {
      initialBalanceCny: null, lastObservedCny: null, totalConsumedCny: '0', totalAddedCny: '0',
      startedAt: null, updatedAt: null, lastObservationSource: null,
    }
    return key
  })
  assert.deepEqual(summarizePoolConsumption(keys), {
    totalCny: '3.7500', trackedCount: 234, totalCount: 248, missingCount: 14, oldestUpdatedAt: 1000,
  })
})
