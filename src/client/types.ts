/** Only the redacted Host types cross into the browser bundle. */
export type { KeySnapshot as KeyView, PoolSnapshot as PoolView } from '../types.ts'
import type { PoolSnapshot } from '../types.ts'

export type PoolAction = 'snapshot' | 'importKeys' | 'remove' | 'setEnabled' | 'setActive' | 'reorder' | 'refresh' | 'updateSettings'
export type PoolRequest = (action: PoolAction, payload?: Record<string, unknown>, signal?: AbortSignal) => Promise<PoolSnapshot>
