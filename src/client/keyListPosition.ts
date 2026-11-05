import type { KeyView } from './types.ts'

/** Page sizes offered by the key-list pagination control. */
export const PAGE_SIZES = [20, 50, 100] as const
export const DEFAULT_PAGE_SIZE = 20

export interface KeyPage<T> {
  items: T[]
  /** Clamped page index that is actually rendered. */
  page: number
  pageCount: number
  /** Zero-based offset of the first item in the source list. */
  start: number
  end: number
  total: number
}

/** Case-insensitive search over the label, the masked key, and the visible status copy. */
export function filterKeys(entries: readonly KeyView[], query: string, statusLabel: (entry: KeyView) => string): KeyView[] {
  const needle = query.trim().toLocaleLowerCase()
  if (needle === '') return [...entries]
  return entries.filter(entry => {
    const label = entry.label === '' ? '' : entry.label
    return [label, entry.maskedKey, entry.status, statusLabel(entry)]
      .some(value => value.toLocaleLowerCase().includes(needle))
  })
}

/** Never render an empty page: an empty list still has page 1 / 1. */
export function pageCountOf(total: number, pageSize: number): number {
  const size = Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : DEFAULT_PAGE_SIZE
  return Math.max(1, Math.ceil(Math.max(0, total) / size))
}

/** Clamp a stale page index (e.g. after a filter or removal) into the renderable range. */
export function clampPage(page: number, total: number, pageSize: number): number {
  const count = pageCountOf(total, pageSize)
  if (!Number.isFinite(page)) return 0
  return Math.min(Math.max(0, Math.floor(page)), count - 1)
}

/** Slice exactly one page; a 249-key pool therefore never renders more than pageSize rows. */
export function keyPage<T>(entries: readonly T[], page: number, pageSize: number): KeyPage<T> {
  const count = pageCountOf(entries.length, pageSize)
  const current = Math.min(Math.max(0, Number.isFinite(page) ? Math.floor(page) : 0), count - 1)
  const start = current * pageSize
  return { items: entries.slice(start, start + pageSize), page: current, pageCount: count, start, end: Math.min(entries.length, start + pageSize), total: entries.length }
}

/** Page that currently holds the active key, or page 1 when it is absent. */
export function pageOfKey(entries: readonly { id: string }[], activeId: string | null, pageSize: number): number {
  if (activeId === null) return 0
  const index = entries.findIndex(entry => entry.id === activeId)
  return index < 0 ? 0 : Math.floor(index / pageSize)
}

/** Swap two entries while preserving every other position (visible-neighbor reorder). */
export function moveIds(ids: readonly string[], movingId: string, targetId: string): string[] | null {
  const from = ids.indexOf(movingId)
  const to = ids.indexOf(targetId)
  if (from < 0 || to < 0 || from === to) return null
  const next = [...ids]
  next[from] = targetId
  next[to] = movingId
  return next
}

/** Pin one key to the first position, keeping the rest in order; null when already first or absent. */
export function moveToTopIds(ids: readonly string[], id: string): string[] | null {
  const index = ids.indexOf(id)
  if (index <= 0) return null
  return [id, ...ids.slice(0, index), ...ids.slice(index + 1)]
}

/** Accessible name fallback shared by row action buttons and the delete confirmation. */
export function keyDisplayName(entry: KeyView, unnamed: string): string {
  return entry.label.trim() === '' ? unnamed : entry.label
}
