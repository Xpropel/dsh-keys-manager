import { useCallback, useRef } from 'react'

/**
 * Row-level scroll positioning for the paginated key list. Pagination removed
 * the old fixed four-row window; only "reveal this row" remains, and it never
 * changes order or reads the network.
 */
export function useKeyListViewport() {
  const ref = useRef<HTMLDivElement | null>(null)
  const rows = useRef(new Map<string, HTMLTableRowElement>())

  const rowRef = useCallback((id: string, element: HTMLTableRowElement | null) => {
    if (element === null) rows.current.delete(id)
    else rows.current.set(id, element)
  }, [])

  /** Bring one rendered row to the nearest edge; `scroll-margin-top` clears the sticky header. */
  const reveal = useCallback((id: string) => {
    rows.current.get(id)?.scrollIntoView({ block: 'nearest' })
  }, [])

  return { ref, rowRef, reveal }
}
