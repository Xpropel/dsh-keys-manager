import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { keyListScrollTop, keyListViewportHeight, keyListWindow } from './keyListPosition.ts'

const useClientLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

interface MeasuredList {
  rows: HTMLTableRowElement[]
  headerHeight: number
  start: number
  active: number
  widthChanged: boolean
}

/** Keep balance polling independent from the user's scroll position. */
export function useKeyListViewport(ids: readonly string[], activeId: string | null) {
  const ref = useRef<HTMLDivElement | null>(null)
  const latest = useRef({ ids, activeId })
  latest.current = { ids, activeId }
  const collapsedHeights = useRef(new Map<string, number>())
  const previousWidth = useRef<number | null>(null)
  const currentHeight = useRef<number | null>(null)
  const lastPlacement = useRef<{ element: HTMLDivElement; activeId: string | null } | null>(null)
  const anchored = useRef(false)
  const programmaticScrollTop = useRef<number | null>(null)
  const order = ids.join('\u0000')

  const measure = useCallback((allowGrow: boolean): MeasuredList | null => {
    const viewport = ref.current
    if (!viewport) return null
    const rows = Array.from(viewport.querySelectorAll<HTMLTableRowElement>('tbody tr[data-key-id]'))
    if (!rows.length) return null
    const width = viewport.clientWidth
    const widthChanged = previousWidth.current === null || Math.abs(previousWidth.current - width) > 0.5
    if (widthChanged) collapsedHeights.current.clear()
    previousWidth.current = width
    const present = new Set(rows.map(row => row.dataset.keyId!))
    for (const id of collapsedHeights.current.keys()) if (!present.has(id)) collapsedHeights.current.delete(id)
    for (const row of rows) {
      const id = row.dataset.keyId!
      const opened = Array.from(row.querySelectorAll<HTMLDetailsElement>('details[open]'))
      if (opened.length === 0) {
        collapsedHeights.current.set(id, row.getBoundingClientRect().height)
      } else if (!collapsedHeights.current.has(id)) {
        // During a width change, deduct expanded content instead of treating it
        // as a new row baseline. Other cells can only make this underestimate.
        const expansion = Math.max(...opened.map(details => Math.max(0,
          details.getBoundingClientRect().height - (details.querySelector('summary')?.getBoundingClientRect().height ?? 0))))
        collapsedHeights.current.set(id, Math.max(1, row.getBoundingClientRect().height - expansion))
      }
    }
    const window = keyListWindow(latest.current.ids, latest.current.activeId)
    const headerHeight = viewport.querySelector('thead')?.getBoundingClientRect().height ?? 0
    const allHeights = rows.map(row => collapsedHeights.current.get(row.dataset.keyId!) ?? 1)
    const targetHeight = keyListViewportHeight(allHeights.slice(window.start, window.end), allHeights, headerHeight)
    // Content changes may reduce the cap, but opening details never expands it.
    const height = allowGrow || widthChanged || currentHeight.current === null
      ? targetHeight : Math.min(currentHeight.current, targetHeight)
    if (height > 0 && (height !== currentHeight.current || viewport.style.getPropertyValue('--dskp-list-height') !== `${height}px`)) {
      currentHeight.current = height
      viewport.style.setProperty('--dskp-list-height', `${height}px`)
    }
    return { rows, headerHeight, start: window.start, active: window.active, widthChanged }
  }, [])

  const locateCurrent = useCallback(() => {
    const viewport = ref.current
    const measured = measure(true)
    if (!viewport || !measured) return
    const first = measured.rows[measured.start]
    if (!first) return
    const rowTop = (row: HTMLTableRowElement) => row.getBoundingClientRect().top
      - viewport.getBoundingClientRect().top + viewport.scrollTop
    const active = measured.rows[measured.active]
    anchored.current = true
    viewport.scrollTop = active ? keyListScrollTop({
      previousTop: rowTop(first), activeTop: rowTop(active), headerHeight: measured.headerHeight,
      previousCollapsedHeight: collapsedHeights.current.get(first.dataset.keyId!) ?? 0,
      activeCollapsedHeight: collapsedHeights.current.get(active.dataset.keyId!) ?? 0,
      viewportHeight: viewport.clientHeight,
    }) : Math.max(0, rowTop(first) - measured.headerHeight)
    // Keep the clamped value until another user scroll occurs: browsers may
    // deliver more than one asynchronous scroll event for programmatic work.
    programmaticScrollTop.current = viewport.scrollTop
  }, [measure])

  useClientLayoutEffect(() => {
    const viewport = ref.current
    if (!viewport) return
    const previous = lastPlacement.current
    if (previous === null || previous.element !== viewport || previous.activeId !== activeId) locateCurrent()
    else measure(true)
    lastPlacement.current = { element: viewport, activeId }
    const leaveAnchor = () => { anchored.current = false }
    const onScroll = () => {
      // Narrow-to-wide layout can clamp scrollTop before ResizeObserver runs.
      // That geometry change is not a request to leave the current-key anchor.
      if (previousWidth.current !== null && Math.abs(viewport.clientWidth - previousWidth.current) > 0.5) return
      if (programmaticScrollTop.current === null || Math.abs(viewport.scrollTop - programmaticScrollTop.current) > 1) leaveAnchor()
    }
    const onPointerDown = (event: PointerEvent) => {
      const bounds = viewport.getBoundingClientRect()
      const scrollbarWidth = viewport.offsetWidth - viewport.clientWidth
      const scrollbarHeight = viewport.offsetHeight - viewport.clientHeight
      if (event.target === viewport
        || (scrollbarWidth > 0 && event.clientX >= bounds.right - scrollbarWidth)
        || (scrollbarHeight > 0 && event.clientY >= bounds.bottom - scrollbarHeight)) leaveAnchor()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target === viewport && ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) leaveAnchor()
    }
    viewport.addEventListener('wheel', leaveAnchor, { passive: true })
    viewport.addEventListener('touchmove', leaveAnchor, { passive: true })
    viewport.addEventListener('pointerdown', onPointerDown, { passive: true })
    viewport.addEventListener('keydown', onKeyDown)
    viewport.addEventListener('scroll', onScroll, { passive: true })
    let disposed = false
    let frame: number | undefined
    const observer = new ResizeObserver(() => {
      if (disposed || frame !== undefined) return
      frame = requestAnimationFrame(() => {
        frame = undefined
        if (!disposed) {
          const wasAnchored = anchored.current
          const measured = measure(false)
          if (wasAnchored && measured?.widthChanged) locateCurrent()
        }
      })
    })
    observer.observe(viewport)
    const table = viewport.querySelector('table')
    if (table) observer.observe(table)
    return () => {
      disposed = true
      observer.disconnect()
      if (frame !== undefined) cancelAnimationFrame(frame)
      viewport.removeEventListener('wheel', leaveAnchor)
      viewport.removeEventListener('touchmove', leaveAnchor)
      viewport.removeEventListener('pointerdown', onPointerDown)
      viewport.removeEventListener('keydown', onKeyDown)
      viewport.removeEventListener('scroll', onScroll)
    }
    // Reordering only remeasures. Balance values, labels, and error text also
    // never pull someone away from the row they are inspecting.
  }, [activeId, order, locateCurrent, measure])

  return { ref, locateCurrent, hasCurrent: activeId !== null && ids.includes(activeId) }
}
