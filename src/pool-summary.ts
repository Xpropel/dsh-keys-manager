import { addDecimals, isDecimalString } from './money.ts'
import type { KeySnapshot } from './types.ts'

/** The evidence needed to include one key in the available CNY snapshot. */
export type PoolBalanceEntry = Pick<KeySnapshot,
  'enabled' | 'status' | 'balanceCny' | 'balanceObservationSource' | 'balanceObservedAt'>

export interface PoolBalanceSummary {
  /** Null when no amount can be included but enabled keys remain unconfirmed. */
  totalCny: string | null
  includedCount: number
  enabledCount: number
  /** Enabled keys whose current usable CNY balance cannot be confirmed. */
  missingCount: number
  /** Earliest amount observation among included keys; not the latest check attempt. */
  oldestObservedAt: number | null
}

/**
 * Sum each enabled, confirmed-ready CNY key independently with exact decimals.
 * Invalid/exhausted keys are confirmed unavailable. Unknown/error/missing-CNY
 * keys leave the total incomplete, as do migrated amounts without a timestamp.
 */
export function summarizePoolBalance(keys: readonly PoolBalanceEntry[]): PoolBalanceSummary {
  let totalCny = '0'
  let includedCount = 0
  let enabledCount = 0
  let missingCount = 0
  let oldestObservedAt: number | null = null
  for (const key of keys) {
    if (!key.enabled) continue
    enabledCount++
    if (key.status === 'invalid' || key.status === 'exhausted') continue
    if (key.status !== 'ready' || key.balanceObservationSource !== 'api'
      || key.balanceObservedAt === null || !isDecimalString(key.balanceCny)) {
      missingCount++
      continue
    }
    totalCny = addDecimals(totalCny, key.balanceCny)
    includedCount++
    if (oldestObservedAt === null || key.balanceObservedAt < oldestObservedAt) oldestObservedAt = key.balanceObservedAt
  }
  return {
    totalCny: includedCount === 0 && missingCount > 0 ? null : totalCny,
    includedCount, enabledCount, missingCount, oldestObservedAt,
  }
}

/** Historical consumption is retained even when a key is disabled or exhausted. */
export type PoolConsumptionEntry = Pick<KeySnapshot, 'statistics'>

export interface PoolConsumptionSummary {
  /** Null until at least one key has a valid baseline; never inferred from a balance. */
  totalCny: string | null
  trackedCount: number
  totalCount: number
  missingCount: number
  /** Earliest statistics cutoff among included keys, when recorded. */
  oldestUpdatedAt: number | null
}

/** Sum recorded consumption for every key still in the pool, independent of its present availability. */
export function summarizePoolConsumption(keys: readonly PoolConsumptionEntry[]): PoolConsumptionSummary {
  let totalCny = '0'
  let trackedCount = 0
  let oldestUpdatedAt: number | null = null
  for (const { statistics } of keys) {
    if (statistics.startedAt === null || statistics.initialBalanceCny === null
      || !isDecimalString(statistics.totalConsumedCny)) continue
    totalCny = addDecimals(totalCny, statistics.totalConsumedCny)
    trackedCount++
    if (statistics.updatedAt !== null && (oldestUpdatedAt === null || statistics.updatedAt < oldestUpdatedAt)) {
      oldestUpdatedAt = statistics.updatedAt
    }
  }
  return {
    totalCny: trackedCount === 0 ? null : totalCny,
    trackedCount, totalCount: keys.length, missingCount: keys.length - trackedCount, oldestUpdatedAt,
  }
}
