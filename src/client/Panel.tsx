import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { panelStyles } from './styles.ts'
import { translateZh, type KeyPoolCopyKey, type Translate } from './locales.ts'
import type { KeyView, PoolAction, PoolRequest, PoolView } from './types.ts'
import { PoolRequestError } from './request.ts'
import { clockLabel, dateLabel, timeLabel } from './format.ts'
import { ActiveKeySummary, BalanceValue, ConsumptionValue, PoolBalanceCard, PoolConsumptionCard } from './Statistics.tsx'
import { useKeyListViewport } from './useKeyListViewport.ts'
import { DEFAULT_PAGE_SIZE, PAGE_SIZES, filterKeys, keyDisplayName, keyPage, moveToTopIds } from './keyListPosition.ts'

export { displayBalance } from './format.ts'

export const IMPORT_MAX = 200

type IconName = 'key' | 'plus' | 'refresh' | 'up' | 'down' | 'top' | 'info' | 'history' | 'close'

function Icon({ name, spinning = false }: { name: IconName; spinning?: boolean }) {
  const paths: Record<IconName, ReactNode> = {
    key: <><circle cx="8.5" cy="8.5" r="4.5"/><path d="m12 12 8 8m-4-4 3-3m-1 5 3-3"/></>,
    plus: <path d="M12 5v14M5 12h14"/>,
    refresh: <><path d="M20 10a8 8 0 0 0-14-5L3 8m0-5v5h5M4 14a8 8 0 0 0 14 5l3-3m0 5v-5h-5"/></>,
    up: <path d="m6 14 6-6 6 6"/>,
    down: <path d="m6 10 6 6 6-6"/>,
    top: <><path d="M5 4h14"/><path d="M12 20V8m0 0-5 5m5-5 5 5"/></>,
    info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-11v1"/></>,
    history: <><path d="M3 10a9 9 0 1 1 1 7M3 4v6h6M12 7v5l3 2"/></>,
    close: <path d="M6 6l12 12M18 6 6 18"/>,
  }
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={spinning ? 'dskp-spin' : undefined}>{paths[name]}</svg>
}

/** Parse transient import text without including key material in any diagnostic. */
export function parseImport(text: string): { label?: string; key: string }[] {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  if (lines.length === 0) throw new Error('INVALID_IMPORT')
  return lines.map(line => {
    const parts = line.split('|').map(part => part.trim())
    const key = parts.at(-1) ?? ''
    if (parts.length > 2 || !/^sk-[A-Za-z0-9_-]+$/.test(key)) throw new Error('INVALID_IMPORT')
    const label = parts.length === 2 ? parts[0] : undefined
    return { key, ...(label ? { label } : {}) }
  })
}

/** Batch bounds are checked before any request leaves the browser. */
export function importBatchProblem(rows: readonly unknown[]): 'empty' | 'limit' | null {
  if (rows.length === 0) return 'empty'
  if (rows.length > IMPORT_MAX) return 'limit'
  return null
}

const EVENT_KIND_KEYS = { switch: 'eventSwitch', exhausted: 'eventExhausted', invalid: 'eventInvalid', recovered: 'eventRecovered' } as const

interface Feedback {
  key: KeyPoolCopyKey
  params?: Record<string, string | number>
  error?: boolean
  detail?: string
}

export interface KeyPoolPanelProps {
  request: PoolRequest
  t?: Translate
  /** Application locale for timestamps; undefined follows the runtime default. */
  locale?: string
  /** The surrounding page owns the h1; nested usage hides the duplicate title. */
  showTitle?: boolean
}

/** Interactive settings panel. Inject request to use the same UI in a standalone preview. */
export function KeyPoolPanel({ request, t = translateZh, locale, showTitle = true }: KeyPoolPanelProps) {
  const [snapshot, setSnapshot] = useState<PoolView | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [deleting, setDeleting] = useState<KeyView | null>(null)
  const [search, setSearch] = useState('')
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE)
  const [pageIndex, setPageIndex] = useState(0)
  const [revealTick, setRevealTick] = useState(0)
  const [autoSwitch, setAutoSwitch] = useState(true)
  const [interval, setIntervalValue] = useState('300')
  const [dirty, setDirty] = useState(false)
  const dirtyRef = useRef(false)
  const pendingRef = useRef(false)
  const generation = useRef(0)
  const lifetime = useRef<AbortController | null>(null)
  const revealId = useRef<string | null>(null)
  const confirmRef = useRef<HTMLButtonElement | null>(null)
  const deleteTrigger = useRef<HTMLButtonElement | null>(null)
  const focusedDelete = useRef<KeyView | null>(null)
  const id = useId()
  const keyList = useKeyListViewport()
  const { ref: listRef, rowRef: listRowRef, reveal: revealRow } = keyList
  const keys = snapshot?.keys ?? []
  const statusLabel = (entry: KeyView) => t(entry.enabled ? entry.status : 'disabled')
  const filteredKeys = useMemo(() => filterKeys(keys, search, statusLabel), [keys, search, t])
  const page = keyPage(filteredKeys, pageIndex, pageSize)
  const globalIndex = useMemo(() => new Map(keys.map((key, index) => [key.id, index])), [keys])
  const active = snapshot?.keys.find(key => key.id === snapshot.activeId)
  const readyCount = snapshot?.keys.filter(key => key.enabled && key.status === 'ready').length ?? 0
  const events = snapshot?.events ?? []
  const hasCurrent = snapshot !== null && snapshot.activeId !== null && keys.some(key => key.id === snapshot.activeId)
  const searching = search.trim() !== ''

  const adopt = (value: PoolView) => {
    setSnapshot(value)
    setLoadFailed(false)
    if (!dirtyRef.current) {
      setAutoSwitch(value.settings.autoSwitch)
      setIntervalValue(String(value.settings.refreshIntervalSeconds))
    }
  }

  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    const read = async () => {
      if (pendingRef.current || controller.signal.aborted) return
      const revision = ++generation.current
      try {
        const value = await request('snapshot', {}, controller.signal)
        if (!controller.signal.aborted && revision === generation.current) adopt(value)
      } catch (_error) {
        if (!controller.signal.aborted && revision === generation.current) setLoadFailed(true)
      }
    }
    void read()
    // The Host owns actual API polling; this only reads already-redacted local state.
    const timer = globalThis.setInterval(() => {
      if (document.visibilityState === 'visible') void read()
    }, 10_000)
    return () => {
      controller.abort()
      globalThis.clearInterval(timer)
      generation.current++
    }
  }, [request])

  /** Pull one row into view, switching to its page when filtering or reordering moved it. */
  useEffect(() => {
    const target = revealId.current
    if (target === null) return
    revealId.current = null
    const index = filteredKeys.findIndex(key => key.id === target)
    if (index >= 0) {
      const targetPage = Math.floor(index / pageSize)
      if (targetPage !== page.page) {
        revealId.current = target
        setPageIndex(targetPage)
        return
      }
    }
    revealRow(target)
  }, [revealTick, snapshot, page.page, pageSize, filteredKeys, revealRow])

  /** Opening the confirmation moves focus to the confirm button; Escape cancels. */
  useEffect(() => {
    if (deleting === null) {
      const previous = focusedDelete.current
      focusedDelete.current = null
      if (previous === null) return
      const trigger = deleteTrigger.current
      if (trigger?.isConnected) trigger.focus()
      else listRef.current?.focus()
      return
    }
    focusedDelete.current = deleting
    confirmRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setDeleting(null)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [deleting, listRef])

  const mutate = async (action: PoolAction, payload: Record<string, unknown> = {}, success?: KeyPoolCopyKey): Promise<PoolView | null> => {
    if (pendingRef.current) return null
    pendingRef.current = true
    const revision = ++generation.current
    setBusy(`${action}:${typeof payload.id === 'string' ? payload.id : ''}`)
    setFeedback(null)
    try {
      const value = await request(action, payload, lifetime.current?.signal)
      if (lifetime.current?.signal.aborted || revision !== generation.current) return null
      adopt(value)
      if (success !== undefined) setFeedback({ key: success })
      return value
    } catch (error) {
      if (!lifetime.current?.signal.aborted && revision === generation.current) {
        setFeedback({ key: 'operationFailed', error: true, ...(error instanceof PoolRequestError ? { detail: error.message } : {}) })
        // A host mutation can commit metadata before a later cleanup fails.
        // Read back authoritative state instead of implying the operation rolled back.
        try {
          const current = await request('snapshot', {}, lifetime.current?.signal)
          if (!lifetime.current?.signal.aborted && revision === generation.current) adopt(current)
        } catch (_refreshError) {
          if (!lifetime.current?.signal.aborted) setLoadFailed(true)
        }
      }
      return null
    } finally {
      pendingRef.current = false
      if (!lifetime.current?.signal.aborted) setBusy(null)
    }
  }

  const reload = async () => {
    if (pendingRef.current) return
    pendingRef.current = true
    const revision = ++generation.current
    setBusy('snapshot:')
    try {
      const value = await request('snapshot', {}, lifetime.current?.signal)
      if (!lifetime.current?.signal.aborted && revision === generation.current) adopt(value)
    } catch (_error) {
      if (!lifetime.current?.signal.aborted) setLoadFailed(true)
    } finally {
      pendingRef.current = false
      if (!lifetime.current?.signal.aborted) setBusy(null)
    }
  }

  const toggleImport = () => {
    if (importOpen) setImportText('')
    setImportOpen(open => !open)
  }

  const importKeys = async () => {
    let rows: { label?: string; key: string }[]
    try { rows = parseImport(importText) }
    catch (_error) { setFeedback({ key: 'importInvalid', error: true }); return }
    const problem = importBatchProblem(rows)
    if (problem === 'limit') { setFeedback({ key: 'importLimit', params: { count: rows.length }, error: true }); return }
    if (problem === 'empty') { setFeedback({ key: 'importInvalid', error: true }); return }
    const value = await mutate('importKeys', { keys: rows }, 'importSuccess')
    if (value !== null) {
      if (value.importSummary !== undefined) {
        setFeedback({ key: 'importSummary', params: { added: value.importSummary.added, duplicates: value.importSummary.duplicates } })
      }
      setImportText('')
      setImportOpen(false)
    }
  }

  const saveSettings = async () => {
    const seconds = Number(interval)
    if (interval.trim() === '' || !Number.isInteger(seconds) || (seconds !== 0 && (seconds < 30 || seconds > 86400))) {
      setFeedback({ key: 'intervalInvalid', error: true })
      return
    }
    if (await mutate('updateSettings', { autoSwitch, refreshIntervalSeconds: seconds }, 'saved') !== null) {
      dirtyRef.current = false
      setDirty(false)
      setIntervalValue(String(seconds))
    }
  }

  const reorder = (index: number, direction: -1 | 1) => {
    if (!snapshot) return
    const ids = snapshot.keys.map(key => key.id)
    const moving = ids[index]
    const other = ids[index + direction]
    if (!moving || !other) return
    ids[index] = other
    ids[index + direction] = moving
    void mutate('reorder', { ids }, 'updated').then(value => {
      if (value === null) return
      revealId.current = moving
      setRevealTick(tick => tick + 1)
    })
  }

  const pinToTop = (keyId: string) => {
    const ids = keys.map(key => key.id)
    const next = moveToTopIds(ids, keyId)
    if (next === null) return
    void mutate('reorder', { ids: next }, 'updated').then(value => {
      if (value === null) return
      revealId.current = keyId
      setRevealTick(tick => tick + 1)
    })
  }

  const locateCurrent = () => {
    if (!hasCurrent || snapshot?.activeId == null) return
    if (searching) setSearch('')
    const index = searching ? keys.findIndex(key => key.id === snapshot.activeId) : filteredKeys.findIndex(key => key.id === snapshot.activeId)
    setPageIndex(index < 0 ? 0 : Math.floor(index / pageSize))
    revealId.current = snapshot.activeId
    setRevealTick(tick => tick + 1)
  }

  const rowName = (entry: KeyView) => keyDisplayName(entry, t('unnamed'))

  return <section className="dskp" aria-labelledby={`${id}-title`}>
    <style>{panelStyles}</style>
    <header className="dskp-header">
      {showTitle ? <div>
        <div className="dskp-heading"><span className="dskp-logo"><Icon name="key"/></span><h2 id={`${id}-title`}>{t('title')}</h2></div>
        {snapshot && <div className={`dskp-status dskp-mode ${snapshot.settings.autoSwitch ? 'ready' : ''}`}>{t(snapshot.settings.autoSwitch ? 'automatic' : 'manual')}</div>}
      </div> : <div><h2 id={`${id}-title`} className="dskp-visually-hidden">{t('title')}</h2>{snapshot && <div className={`dskp-status dskp-mode ${snapshot.settings.autoSwitch ? 'ready' : ''}`}>{t(snapshot.settings.autoSwitch ? 'automatic' : 'manual')}</div>}</div>}
      <div className="dskp-header-actions">
        <button type="button" className="dskp-button" disabled={!!busy || !snapshot?.keys.length} onClick={() => { void mutate('refresh') }}><Icon name="refresh" spinning={busy === 'refresh:'}/>{t(busy === 'refresh:' ? 'refreshing' : 'refresh')}</button>
        <button type="button" className="dskp-button primary" aria-expanded={importOpen} disabled={!!busy || !snapshot} onClick={toggleImport}><Icon name="plus"/>{t('import')}</button>
      </div>
    </header>

    <div className="dskp-feedback-slot">{feedback && <div role={feedback.error ? 'alert' : 'status'} className={`dskp-feedback${feedback.error ? ' error' : ''}`}>
      <span>{feedback.detail ?? t(feedback.key, feedback.params)}</span>
      <button className="dskp-icon-button" type="button" aria-label={t('dismiss')} title={t('dismiss')} onClick={() => setFeedback(null)}><Icon name="close"/></button>
    </div>}</div>
    {loadFailed && snapshot !== null && <div role="alert" className="dskp-feedback error">{t('loadFailed')} <button className="dskp-button small" type="button" disabled={!!busy} onClick={() => { void reload() }}>{t('retry')}</button></div>}

    {importOpen && <form className="dskp-card dskp-import" onSubmit={event => { event.preventDefault(); void importKeys() }}>
      <h3><label htmlFor={`${id}-import`}>{t('importTitle')}</label></h3><p id={`${id}-import-description`}>{t('importDescription')}</p>
      <textarea id={`${id}-import`} className="dskp-input" value={importText} onChange={event => setImportText(event.target.value)} placeholder={t('importPlaceholder')} spellCheck={false} autoComplete="off" autoCorrect="off" autoCapitalize="off" aria-describedby={`${id}-import-description`} disabled={!!busy} autoFocus/>
      <p>{t('importPrivacy')}</p>
      <div className="dskp-import-footer"><button className="dskp-button" type="button" disabled={!!busy} onClick={toggleImport}>{t('cancel')}</button><button className="dskp-button primary" type="submit" disabled={!!busy || !importText.trim()}>{t('importSubmit')}</button></div>
    </form>}

    {deleting && <div className="dskp-confirm" role="alertdialog" aria-modal="true" aria-labelledby={`${id}-delete-title`} aria-describedby={`${id}-delete-description`}>
      <div><h3 id={`${id}-delete-title`}>{t('removeTitle')}</h3><p id={`${id}-delete-description`}>{t('removeDescription', { name: rowName(deleting), maskedKey: deleting.maskedKey })}</p>{deleting.id === snapshot?.activeId && <p className="dskp-confirm-warning">{t('removeActiveWarning')}</p>}</div>
      <div className="dskp-inline"><button className="dskp-button" type="button" disabled={!!busy} onClick={() => setDeleting(null)}>{t('cancel')}</button><button ref={confirmRef} className="dskp-button danger" type="button" disabled={!!busy} onClick={() => { void mutate('remove', { id: deleting.id }, 'removed').then(value => { if (value !== null) setDeleting(null) }) }}>{t('confirmRemove')}</button></div>
    </div>}

    {!snapshot ? <div className="dskp-card dskp-empty" role="status">{t(loadFailed ? 'loadFailed' : 'loading')}{loadFailed && <div><button className="dskp-button small" type="button" disabled={!!busy} onClick={() => { void reload() }}>{t('retry')}</button></div>}</div> : <>
      <div className="dskp-pool-overview"><PoolBalanceCard keys={snapshot.keys} t={t} locale={locale}/><PoolConsumptionCard keys={snapshot.keys} t={t} locale={locale}/></div>
      <ActiveKeySummary entry={active} t={t} locale={locale}/>

      <div className="dskp-list-heading"><div><span>{searching ? t('keysSummaryFiltered', { shown: filteredKeys.length, count: snapshot.keys.length, ready: readyCount }) : t('keysSummary', { count: snapshot.keys.length, ready: readyCount })}</span><p className="dskp-list-hint">{t('keyListScrollHint')}</p></div><button className="dskp-button small" type="button" disabled={!hasCurrent || !!busy} aria-controls={`${id}-key-list`} onClick={locateCurrent}>{t('locateCurrent')}</button></div>

      <div className="dskp-card">
        {!snapshot.keys.length ? <div className="dskp-empty"><span className="dskp-empty-icon"><Icon name="key"/></span><h3>{t('emptyTitle')}</h3><p>{t('emptyDescription')}</p><button className="dskp-button primary" type="button" onClick={() => setImportOpen(true)}><Icon name="plus"/>{t('import')}</button></div> : <>
          <div className="dskp-list-toolbar">
            <label className="dskp-search"><span className="dskp-visually-hidden">{t('searchLabel')}</span><input type="search" value={search} placeholder={t('searchPlaceholder')} aria-label={t('searchLabel')} onChange={event => { setSearch(event.target.value); setPageIndex(0) }} disabled={!!busy}/></label>
            <label className="dskp-page-size"><span>{t('pageSizeLabel')}</span><select value={pageSize} aria-label={t('pageSizeLabel')} onChange={event => { setPageSize(Number(event.target.value)); setPageIndex(0) }}>{PAGE_SIZES.map(size => <option key={size} value={size}>{t('pageSizeOption', { size })}</option>)}</select></label>
            <nav className="dskp-pager" aria-label={t('pageStatus', { page: page.page + 1, pages: page.pageCount })}>
              <button className="dskp-button small" type="button" disabled={page.page === 0} onClick={() => setPageIndex(page.page - 1)}>{t('previousPage')}</button>
              <span className="dskp-page-status" aria-live="polite">{t('pageStatus', { page: page.page + 1, pages: page.pageCount })}</span>
              <button className="dskp-button small" type="button" disabled={page.page >= page.pageCount - 1} onClick={() => setPageIndex(page.page + 1)}>{t('nextPage')}</button>
            </nav>
          </div>
          <p className="dskp-list-note">{t('orderHint')} {t('balanceHint')}</p>
          {filteredKeys.length === 0 ? <div className="dskp-empty dskp-search-empty" role="status"><p>{t('searchEmpty')}</p><button className="dskp-button small" type="button" onClick={() => { setSearch(''); setPageIndex(0) }}>{t('clearSearch')}</button></div>
            : <div className="dskp-table-wrap" ref={listRef} id={`${id}-key-list`} tabIndex={0} role="region" aria-label={t('keyListRegion')} aria-describedby={`${id}-list-hint`}><table className="dskp-table">
              <caption className="dskp-visually-hidden" id={`${id}-list-hint`}>{t('keyListScrollHint')}</caption>
              <thead><tr><th scope="col">{t('priority')}</th><th scope="col">{t('name')}</th><th scope="col">{t('balance')}</th><th scope="col">{t('consumed')}</th><th scope="col">{t('state')}</th><th scope="col" style={{ textAlign: 'right' }}>{t('actions')}</th></tr></thead>
              <tbody>{page.items.map(key => {
                const index = globalIndex.get(key.id) ?? 0
                const name = rowName(key)
                return <tr key={key.id} data-key-id={key.id} ref={element => listRowRef(key.id, element)} className={key.id === snapshot.activeId ? 'is-current' : undefined}>
                  <td><div className="dskp-order"><span>{String(index + 1).padStart(2, '0')}</span><div>
                    <button className="dskp-icon-button" type="button" disabled={!!busy || index === 0 || searching} aria-label={t('moveUp', { name })} title={t('moveUp', { name })} onClick={() => reorder(index, -1)}><Icon name="up"/></button>
                    <button className="dskp-icon-button" type="button" disabled={!!busy || index === snapshot.keys.length - 1 || searching} aria-label={t('moveDown', { name })} title={t('moveDown', { name })} onClick={() => reorder(index, 1)}><Icon name="down"/></button>
                  </div></div></td>
                  <td><div className="dskp-inline" style={{ gap: 5 }}><span className="dskp-key-name" title={key.label || t('unnamed')}>{key.label || t('unnamed')}</span>{key.id === snapshot.activeId && <span className="dskp-tag">{t('active')}</span>}</div><div className="dskp-key-id">{key.maskedKey}</div></td>
                  <td><div className="dskp-mobile-label">{t('balance')}</div><BalanceValue entry={key} t={t} locale={locale}/></td>
                  <td><div className="dskp-mobile-label">{t('consumed')}</div><ConsumptionValue entry={key} t={t} locale={locale} details/></td>
                  <td><span className={`dskp-status ${key.enabled ? key.status : ''}`} title={[key.lastError, key.lastCheckedAt === null ? null : t('lastCheckAttempt', { time: timeLabel(key.lastCheckedAt, locale) })].filter(Boolean).join('\n') || undefined}>{t(key.enabled ? key.status : 'disabled')}</span>{key.lastError !== null && <div className="dskp-time" title={key.lastError}>{key.lastError}</div>}</td>
                  <td><div className="dskp-row-actions">
                    <button className="dskp-icon-button" type="button" title={t('moveToTop', { name })} aria-label={t('moveToTop', { name })} disabled={!!busy || index === 0} onClick={() => pinToTop(key.id)}><Icon name="top"/></button>
                    <button className="dskp-icon-button" type="button" title={t('refreshOne')} aria-label={`${t('refreshOne')} ${name}`} disabled={!!busy} onClick={() => { void mutate('refresh', { id: key.id }) }}><Icon name="refresh" spinning={busy === `refresh:${key.id}`}/></button>
                    <button className="dskp-button small" type="button" disabled={!!busy || key.id === snapshot.activeId || !key.enabled || key.status === 'invalid' || key.status === 'exhausted'} onClick={() => { void mutate('setActive', { id: key.id }, 'switched') }}>{t(key.id === snapshot.activeId ? 'active' : 'setActive')}</button>
                    <button className="dskp-button small" type="button" disabled={!!busy} onClick={() => { void mutate('setEnabled', { id: key.id, enabled: !key.enabled }) }}>{t(key.enabled ? 'disable' : 'enable')}</button>
                    <button className="dskp-button small danger" type="button" disabled={!!busy} onClick={event => { deleteTrigger.current = event.currentTarget; setDeleting(key) }}>{t('remove')}</button>
                  </div></td>
                </tr>
              })}</tbody>
            </table></div>}
        </>}
      </div>
      <section className="dskp-settings" aria-labelledby={`${id}-policy`}>
        <div className="dskp-section-head"><div><h3 id={`${id}-policy`}>{t('settingsTitle')}</h3><p>{t('settingsDescription')}</p></div><button className="dskp-button small" type="button" disabled={!!busy || !dirty} onClick={() => { void saveSettings() }}>{t('saveSettings')}</button></div>
        <div className="dskp-card">
          <div className="dskp-setting-row"><div><div className="dskp-setting-label" id={`${id}-auto`}>{t('autoSwitchLabel')}</div><p className="dskp-setting-hint">{t('autoSwitchHint')}</p></div><button className="dskp-switch" type="button" role="switch" aria-checked={autoSwitch} aria-labelledby={`${id}-auto`} disabled={!!busy} onClick={() => { setAutoSwitch(value => !value); dirtyRef.current = true; setDirty(true) }}><span/></button></div>
          <div className="dskp-setting-row"><div><label htmlFor={`${id}-interval`} className="dskp-setting-label">{t('intervalLabel')}</label><p className="dskp-setting-hint">{t('intervalHint')}</p></div><input id={`${id}-interval`} className="dskp-number" type="number" min="0" max="86400" step="1" inputMode="numeric" value={interval} disabled={!!busy} onChange={event => { setIntervalValue(event.target.value); dirtyRef.current = true; setDirty(true) }}/></div>
        </div>
      </section>

      <section className="dskp-history" aria-labelledby={`${id}-history`}>
        <div className="dskp-section-head"><div><h3 id={`${id}-history`}>{t('history')}</h3><p>{t('historyHint')}</p></div><Icon name="history"/></div>
        <div className="dskp-card dskp-history-body">{events.length === 0 ? <p className="dskp-history-empty">{t('historyEmpty')}</p> : <table className="dskp-table dskp-event-table">
          <thead><tr><th scope="col">{t('eventDate')}</th><th scope="col">{t('eventTime')}</th><th scope="col">{t('eventAction')}</th><th scope="col">{t('eventKey')}</th><th scope="col">{t('eventDetail')}</th></tr></thead>
          <tbody>{events.slice(-12).reverse().map(event => <tr key={event.id}>
            <td className="dskp-event-time">{dateLabel(event.at, locale)}</td>
            <td className="dskp-event-time">{clockLabel(event.at, locale)}</td>
            <td>{t(EVENT_KIND_KEYS[event.kind])}</td>
            <td><span className="dskp-key-name">{event.keyLabel ?? '—'}</span></td>
            <td>{event.message}</td>
          </tr>)}</tbody>
        </table>}</div>
      </section>
    </>}
  </section>
}
