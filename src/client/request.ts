import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { KeyStatus, PoolEvent } from '../types.ts'
import type { ImportSummary, PoolRequest, PoolView } from './types.ts'
import { isDecimalString } from '../money.ts'

export class PoolRequestError extends Error {
  constructor(message: string) { super(message); this.name = 'PoolRequestError' }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('INVALID_POOL_RESPONSE')
  return value as Record<string, unknown>
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('INVALID_POOL_RESPONSE')
  return value
}
function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('INVALID_POOL_RESPONSE')
  return value
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('INVALID_POOL_RESPONSE')
  return value
}
function observationSource(value: unknown): 'api' | 'unavailable-zero' | null {
  if (value !== null && value !== 'api' && value !== 'unavailable-zero') throw new Error('INVALID_POOL_RESPONSE')
  return value
}
function money(value: unknown): string {
  if (!isDecimalString(value)) throw new Error('INVALID_POOL_RESPONSE')
  return value
}

/** Counters are optional: older Hosts omit them, and a malformed pair fails the reply. */
function importSummary(value: unknown): ImportSummary | undefined {
  if (value === undefined) return undefined
  const summary = record(value)
  const added = number(summary.added)
  const duplicates = number(summary.duplicates)
  if (!Number.isInteger(added) || added < 0 || !Number.isInteger(duplicates) || duplicates < 0) throw new Error('INVALID_POOL_RESPONSE')
  return { added, duplicates }
}

/** Reject a mismatched RPC version before rendering or caching its state. */
export function parseSnapshot(value: unknown): PoolView {
  const data = record(value)
  const settings = record(data.settings)
  if (!Array.isArray(data.keys) || !Array.isArray(data.events)) throw new Error('INVALID_POOL_RESPONSE')
  const imported = importSummary(data.importSummary)
  return {
    activeId: data.activeId === null ? null : text(data.activeId),
    settings: { autoSwitch: boolean(settings.autoSwitch), refreshIntervalSeconds: number(settings.refreshIntervalSeconds) },
    keys: data.keys.map(value => {
      const key = record(value)
      const statistics = record(key.statistics)
      const status = text(key.status)
      if (!['unknown', 'ready', 'exhausted', 'invalid', 'error'].includes(status)) throw new Error('INVALID_POOL_RESPONSE')
      return {
        id: text(key.id), label: text(key.label), maskedKey: text(key.maskedKey), enabled: boolean(key.enabled),
        status: status as KeyStatus,
        balanceCny: key.balanceCny === null ? null : money(key.balanceCny),
        ...(key.balances === undefined ? {} : {
          balances: (Array.isArray(key.balances) ? key.balances : (() => { throw new Error('INVALID_POOL_RESPONSE') })())
            .map(item => {
              const balance = record(item)
              return { currency: text(balance.currency), amount: money(balance.amount) }
            }),
        }),
        balanceObservationSource: observationSource(key.balanceObservationSource),
        balanceObservedAt: key.balanceObservedAt === null ? null : number(key.balanceObservedAt),
        lastCheckedAt: key.lastCheckedAt === null ? null : number(key.lastCheckedAt),
        lastError: key.lastError === null ? null : text(key.lastError),
        statistics: {
          initialBalanceCny: statistics.initialBalanceCny === null ? null : money(statistics.initialBalanceCny),
          lastObservedCny: statistics.lastObservedCny === null ? null : money(statistics.lastObservedCny),
          totalConsumedCny: money(statistics.totalConsumedCny),
          totalAddedCny: money(statistics.totalAddedCny),
          startedAt: statistics.startedAt === null ? null : number(statistics.startedAt),
          updatedAt: statistics.updatedAt === null ? null : number(statistics.updatedAt),
          lastObservationSource: observationSource(statistics.lastObservationSource),
        },
      }
    }),
    ...(imported === undefined ? {} : { importSummary: imported }),
    events: data.events.map(value => {
      const event = record(value)
      const kind = text(event.kind)
      if (!['switch', 'exhausted', 'invalid', 'recovered'].includes(kind)) throw new Error('INVALID_POOL_RESPONSE')
      return {
        id: text(event.id), at: number(event.at), kind: kind as PoolEvent['kind'], message: text(event.message),
        ...(event.keyLabel === undefined ? {} : { keyLabel: text(event.keyLabel) }),
      }
    }),
  }
}

/** Use the authenticated Harness carrier for both Desktop IPC and Web sessions. */
export function createClientRequest(connection: Pick<ConnectionHandle, 'rpc'>): PoolRequest {
  return async (action, payload = {}, signal) => {
    const result = await connection.rpc.call('/api', 'deepseekKeyPool/request', { args: { action, payload } }, signal)
    if (!result.ok) {
      if (['key-pool/validation', 'key-pool/operation', 'key-pool/forbidden', 'key-pool/internal'].includes(result.error.code)) {
        throw new PoolRequestError(result.error.message)
      }
      throw new Error('KEY_POOL_REQUEST_FAILED')
    }
    return parseSnapshot(result.value)
  }
}
