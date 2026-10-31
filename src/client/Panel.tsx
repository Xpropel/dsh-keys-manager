import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { panelStyles } from './styles.ts'
import { translateZh, type KeyPoolCopyKey, type Translate } from './locales.ts'
import type { KeyView, PoolAction, PoolRequest, PoolView } from './types.ts'
import { PoolRequestError } from './request.ts'
import { timeLabel } from './format.ts'
import { ActiveKeySummary, BalanceValue, ConsumptionValue, PoolBalanceCard, PoolConsumptionCard } from './Statistics.tsx'
import { useKeyListViewport } from './useKeyListViewport.ts'

export { displayBalance } from './format.ts'

type IconName = 'key' | 'plus' | 'refresh' | 'up' | 'down' | 'info' | 'history'

function Icon({ name, spinning = false }: { name: IconName; spinning?: boolean }) {
  const paths: Record<IconName, ReactNode> = {
    key: <><circle cx="8.5" cy="8.5" r="4.5"/><path d="m12 12 8 8m-4-4 3-3m-1 5 3-3"/></>,
    plus: <path d="M12 5v14M5 12h14"/>,
    refresh: <><path d="M20 10a8 8 0 0 0-14-5L3 8m0-5v5h5M4 14a8 8 0 0 0 14 5l3-3m0 5v-5h-5"/></>,
    up: <path d="m6 14 6-6 6 6"/>,
    down: <path d="m6 10 6 6 6-6"/>,
    info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-11v1"/></>,
    history: <><path d="M3 10a9 9 0 1 1 1 7M3 4v6h6M12 7v5l3 2"/></>,
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

export interface KeyPoolPanelProps {
  request: PoolRequest
  t?: Translate
}

/** Interactive settings panel. Inject request to use the same UI in a standalone preview. */
export function KeyPoolPanel({ request, t = translateZh }: KeyPoolPanelProps) {
  const [snapshot, setSnapshot] = useState<PoolView | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [feedback, setFeedback] = useState<{ key: KeyPoolCopyKey; error?: boolean; detail?: string } | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [deleting, setDeleting] = useState<KeyView | null>(null)
  const [autoSwitch, setAutoSwitch] = useState(true)
  const [interval, setIntervalValue] = useState('300')
  const [dirty, setDirty] = useState(false)
  const dirtyRef = useRef(false)
  const pendingRef = useRef(false)
  const generation = useRef(0)
  const lifetime = useRef<AbortController | null>(null)
  const id = useId()
  const keyList = useKeyListViewport(snapshot?.keys.map(key => key.id) ?? [], snapshot?.activeId ?? null)

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

  const mutate = async (action: PoolAction, payload: Record<string, unknown> = {}, success: KeyPoolCopyKey = 'updated'): Promise<boolean> => {
    if (pendingRef.current) return false
    pendingRef.current = true
    const revision = ++generation.current
    setBusy(`${action}:${typeof payload.id === 'string' ? payload.id : ''}`)
    setFeedback(null)
    try {
      const value = await request(action, payload, lifetime.current?.signal)
      if (lifetime.current?.signal.aborted || revision !== generation.current) return false
      adopt(value)
      setFeedback({ key: success })
      return true
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
      return false
    } finally {
      pendingRef.current = false
      if (!lifetime.current?.signal.aborted) setBusy(null)
    }
  }

  const importKeys = async () => {
    let keys: { label?: string; key: string }[]
    try { keys = parseImport(importText) }
    catch (_error) { setFeedback({ key: 'importInvalid', error: true }); return }
    if (await mutate('importKeys', { keys }, 'importSuccess')) {
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
    if (await mutate('updateSettings', { autoSwitch, refreshIntervalSeconds: seconds }, 'saved')) {
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
    void mutate('reorder', { ids })
  }

  const active = snapshot?.keys.find(key => key.id === snapshot.activeId)
  const readyCount = snapshot?.keys.filter(key => key.enabled && key.status === 'ready').length ?? 0
  const events = snapshot?.events ?? []

  return <section className="dskp" aria-labelledby={`${id}-title`}>
    <style>{panelStyles}</style>
    <header className="dskp-header">
      <div>
        <div className="dskp-heading"><span className="dskp-logo"><Icon name="key"/></span><h2 id={`${id}-title`}>{t('title')}</h2></div>
        <p className="dskp-subtitle">{t('subtitle')}</p>
        {snapshot && <div className={`dskp-status dskp-mode ${snapshot.settings.autoSwitch ? 'ready' : ''}`}>{t(snapshot.settings.autoSwitch ? 'automatic' : 'manual')}</div>}
      </div>
      <div className="dskp-header-actions">
        <button type="button" className="dskp-button" disabled={!!busy || !snapshot?.keys.length} onClick={() => { void mutate('refresh') }}><Icon name="refresh" spinning={busy === 'refresh:'}/>{t(busy === 'refresh:' ? 'refreshing' : 'refresh')}</button>
        <button type="button" className="dskp-button primary" disabled={!!busy || !snapshot} onClick={() => setImportOpen(open => !open)}><Icon name="plus"/>{t('import')}</button>
      </div>
    </header>

    <p className="dskp-note" style={{ marginBottom: 16 }}><Icon name="info"/><span>{t('routeHint')}</span></p>

    <div className="dskp-feedback-slot">{feedback && <div role={feedback.error ? 'alert' : 'status'} className={`dskp-feedback${feedback.error ? ' error' : ''}`}>{feedback.detail ?? t(feedback.key)}</div>}</div>
    {loadFailed && <div role="alert" className="dskp-feedback error">{t('loadFailed')} <button className="dskp-button small" disabled={!!busy} onClick={() => { void mutate('snapshot') }}>{t('retry')}</button></div>}

    {importOpen && <form className="dskp-card dskp-import" onSubmit={event => { event.preventDefault(); void importKeys() }}>
      <h3><label htmlFor={`${id}-import`}>{t('importTitle')}</label></h3><p id={`${id}-import-description`}>{t('importDescription')}</p>
      <textarea id={`${id}-import`} className="dskp-input" value={importText} onChange={event => setImportText(event.target.value)} placeholder={t('importPlaceholder')} spellCheck={false} autoComplete="off" autoCorrect="off" autoCapitalize="off" aria-describedby={`${id}-import-description`} disabled={!!busy} autoFocus/>
      <p>{t('importPrivacy')}</p>
      <div className="dskp-import-footer"><button className="dskp-button" type="button" disabled={!!busy} onClick={() => { setImportOpen(false); setImportText('') }}>{t('cancel')}</button><button className="dskp-button primary" type="submit" disabled={!!busy || !importText.trim()}>{t('importSubmit')}</button></div>
    </form>}

    {deleting && <div className="dskp-confirm" role="alertdialog" aria-labelledby={`${id}-delete-title`} aria-describedby={`${id}-delete-description`}>
      <div><h3 id={`${id}-delete-title`}>{t('removeTitle')}</h3><p id={`${id}-delete-description`}>{t('removeDescription', { name: deleting.label || t('unnamed') })}</p></div>
      <div className="dskp-inline"><button className="dskp-button" disabled={!!busy} onClick={() => setDeleting(null)}>{t('cancel')}</button><button className="dskp-button danger" disabled={!!busy} onClick={() => { void mutate('remove', { id: deleting.id }, 'removed').then(ok => { if (ok) setDeleting(null) }) }}>{t('confirmRemove')}</button></div>
    </div>}

    {!snapshot ? <div className="dskp-card dskp-empty" role="status">{t(loadFailed ? 'loadFailed' : 'loading')}</div> : <>
      <div className="dskp-pool-overview"><PoolBalanceCard keys={snapshot.keys} t={t}/><PoolConsumptionCard keys={snapshot.keys} t={t}/></div>
      <ActiveKeySummary entry={active} t={t}/>
      <div className="dskp-list-heading"><div><span>{t('keysSummary', { count: snapshot.keys.length, ready: readyCount })}</span>{snapshot.keys.length > 0 && <p id={`${id}-list-hint`} className="dskp-list-hint">{t('keyListScrollHint')}</p>}</div><button className="dskp-button small" type="button" disabled={!keyList.hasCurrent} aria-controls={`${id}-key-list`} onClick={keyList.locateCurrent}>{t('locateCurrent')}</button></div>

      <div className="dskp-card">
        {!snapshot.keys.length ? <div className="dskp-empty"><span className="dskp-empty-icon"><Icon name="key"/></span><h3>{t('emptyTitle')}</h3><p>{t('emptyDescription')}</p><button className="dskp-button primary" onClick={() => setImportOpen(true)}><Icon name="plus"/>{t('import')}</button></div> : <div className="dskp-table-wrap" ref={keyList.ref} id={`${id}-key-list`} tabIndex={0} role="region" aria-label={t('keyListRegion')} aria-describedby={`${id}-list-hint`}><table className="dskp-table">
          <thead><tr><th scope="col">{t('priority')}</th><th scope="col">{t('name')}</th><th scope="col">{t('balance')}</th><th scope="col">{t('consumed')}</th><th scope="col">{t('state')}</th><th scope="col" style={{ textAlign: 'right' }}>{t('actions')}</th></tr></thead>
          <tbody>{snapshot.keys.map((key, index) => <tr key={key.id} data-key-id={key.id} className={key.id === snapshot.activeId ? 'is-current' : undefined}>
            <td><div className="dskp-order"><span>{String(index + 1).padStart(2, '0')}</span><div><button className="dskp-icon-button" disabled={!!busy || index === 0} aria-label={t('moveUp', { name: key.label })} title={t('moveUp', { name: key.label })} onClick={() => reorder(index, -1)}><Icon name="up"/></button><button className="dskp-icon-button" disabled={!!busy || index === snapshot.keys.length - 1} aria-label={t('moveDown', { name: key.label })} title={t('moveDown', { name: key.label })} onClick={() => reorder(index, 1)}><Icon name="down"/></button></div></div></td>
            <td><div className="dskp-inline" style={{ gap: 5 }}><span className="dskp-key-name" title={key.label}>{key.label || t('unnamed')}</span>{key.id === snapshot.activeId && <span className="dskp-tag">{t('active')}</span>}</div><div className="dskp-key-id">{key.maskedKey}</div></td>
            <td><div className="dskp-mobile-label">{t('balance')}</div><BalanceValue entry={key} t={t}/></td>
            <td><div className="dskp-mobile-label">{t('consumed')}</div><ConsumptionValue entry={key} t={t} details/></td>
            <td><span className={`dskp-status ${key.enabled ? key.status : ''}`} title={[key.lastError, key.lastCheckedAt === null ? null : t('lastCheckAttempt', { time: timeLabel(key.lastCheckedAt) })].filter(Boolean).join('\n') || undefined}>{t(key.enabled ? key.status : 'disabled')}</span>{key.lastError !== null && <div className="dskp-time" title={key.lastError}>{key.lastError}</div>}</td>
            <td><div className="dskp-row-actions">
              <button className="dskp-icon-button" title={t('refreshOne')} aria-label={`${t('refreshOne')} ${key.label}`} disabled={!!busy} onClick={() => { void mutate('refresh', { id: key.id }) }}><Icon name="refresh" spinning={busy === `refresh:${key.id}`}/></button>
              <button className="dskp-button small" disabled={!!busy || key.id === snapshot.activeId || !key.enabled || key.status === 'invalid' || key.status === 'exhausted'} onClick={() => { void mutate('setActive', { id: key.id }, 'switched') }}>{t(key.id === snapshot.activeId ? 'active' : 'setActive')}</button>
              <button className="dskp-button small" disabled={!!busy} onClick={() => { void mutate('setEnabled', { id: key.id, enabled: !key.enabled }) }}>{t(key.enabled ? 'disable' : 'enable')}</button>
              <button className="dskp-button small danger" disabled={!!busy} onClick={() => setDeleting(key)}>{t('remove')}</button>
            </div></td>
          </tr>)}</tbody>
        </table></div>}
      </div>
      {snapshot.keys.length > 1 && <p className="dskp-note">{t('orderHint')}</p>}
      <p className="dskp-note"><Icon name="info"/><span>{t('balanceHint')}</span></p>
      <p className="dskp-note"><Icon name="info"/><span>{t('statisticsHint')}</span></p>

      <section className="dskp-settings" aria-labelledby={`${id}-policy`}>
        <div className="dskp-section-head"><div><h3 id={`${id}-policy`}>{t('settingsTitle')}</h3><p>{t('settingsDescription')}</p></div><button className="dskp-button small" disabled={!!busy || !dirty} onClick={() => { void saveSettings() }}>{t('saveSettings')}</button></div>
        <div className="dskp-card">
          <div className="dskp-setting-row"><div><div className="dskp-setting-label" id={`${id}-auto`}>{t('autoSwitchLabel')}</div><p className="dskp-setting-hint">{t('autoSwitchHint')}</p></div><button className="dskp-switch" type="button" role="switch" aria-checked={autoSwitch} aria-labelledby={`${id}-auto`} disabled={!!busy} onClick={() => { setAutoSwitch(value => !value); dirtyRef.current = true; setDirty(true) }}><span/></button></div>
          <div className="dskp-setting-row"><div><label htmlFor={`${id}-interval`} className="dskp-setting-label">{t('intervalLabel')}</label><p id={`${id}-interval-hint`} className="dskp-setting-hint">{t('intervalHint')}</p></div><input id={`${id}-interval`} className="dskp-number" type="number" min="0" max="86400" step="1" inputMode="numeric" value={interval} aria-describedby={`${id}-interval-hint`} disabled={!!busy} onChange={event => { setIntervalValue(event.target.value); dirtyRef.current = true; setDirty(true) }}/></div>
        </div>
      </section>

      <section className="dskp-history" aria-labelledby={`${id}-history`}>
        <div className="dskp-section-head"><div><h3 id={`${id}-history`}>{t('history')}</h3><p>{t('historyHint')}</p></div><Icon name="history"/></div>
        <div className="dskp-card dskp-history-body">{events.length === 0 ? <p className="dskp-history-empty">{t('historyEmpty')}</p> : events.slice(-12).reverse().map(event => <div className="dskp-event" key={event.id}><time dateTime={new Date(event.at).toISOString()}>{timeLabel(event.at)}</time><span>{event.message}</span></div>)}</div>
      </section>
    </>}
  </section>
}
