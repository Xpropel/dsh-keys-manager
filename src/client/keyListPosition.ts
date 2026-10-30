/** First visible item precedes the current key, without changing priority order. */
export function keyListWindow(ids: readonly string[], activeId: string | null): { start: number; end: number; active: number } {
  const active = activeId === null ? -1 : ids.indexOf(activeId)
  const start = active < 0 ? 0 : Math.max(0, active - 1)
  return { start, end: Math.min(ids.length, start + 4), active }
}

/** A tall error row cannot make more than four short rows fit after scrolling. */
export function keyListViewportHeight(windowHeights: readonly number[], allCollapsedHeights: readonly number[], headerHeight: number): number {
  const heights = allCollapsedHeights.filter(height => Number.isFinite(height) && height > 0)
  if (windowHeights.length === 0 || heights.length === 0) return 0
  const shortest = Math.min(...heights)
  const windowHeight = windowHeights.reduce((sum, height) => sum + height, 0)
  return Math.ceil(headerHeight + Math.min(windowHeight, 4 * shortest))
}

/** Expanded content above the active row must not push its label below the viewport. */
export function keyListScrollTop(input: {
  previousTop: number
  activeTop: number
  previousCollapsedHeight: number
  activeCollapsedHeight: number
  headerHeight: number
  viewportHeight: number
}): number {
  const contentHeight = Math.max(0, input.viewportHeight - input.headerHeight)
  const availableAbove = Math.max(0, contentHeight - Math.min(contentHeight, input.activeCollapsedHeight))
  const previousSpace = Math.min(Math.max(0, input.activeTop - input.previousTop), input.previousCollapsedHeight, availableAbove)
  return Math.max(0, input.activeTop - input.headerHeight - previousSpace)
}
