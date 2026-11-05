/** Only the redacted Host types cross into the browser bundle. */
export type { KeySnapshot as KeyView, ImportSummary } from '../types.ts'
import type { PoolSnapshot } from '../types.ts'

/**
 * Redacted snapshot plus the optional per-request import counter. The Host adds
 * `importSummary` only to import replies; older Hosts omit it entirely.
 */
export type PoolView = PoolSnapshot

export type PoolAction = 'snapshot' | 'importKeys' | 'remove' | 'setEnabled' | 'setActive' | 'reorder' | 'refresh' | 'updateSettings'
export type PoolRequest = (action: PoolAction, payload?: Record<string, unknown>, signal?: AbortSignal) => Promise<PoolView>
