import { useEffect, useId, useSyncExternalStore } from 'react'
import { POOL_PROVIDER, poolTarget, type CurrentRoute, type RouteSelection, type RoutingController, type RoutingIssue } from './routing.ts'
import { translateZh, type KeyPoolCopyKey, type Translate } from './locales.ts'

/** Every routing string lives in the panel's locale namespace. */
const CURRENT_FALLBACK_KEYS: Record<Exclude<CurrentRoute['kind'], 'available'>, KeyPoolCopyKey> = {
  none: 'routeNone', ambiguous: 'routeAmbiguous', unavailable: 'routeUnavailable', subagent: 'routeSubagent',
}

const ISSUE_KEYS: Record<RoutingIssue, KeyPoolCopyKey> = {
  READ_FAILED: 'routeErrorReadFailed',
  NO_CURRENT: 'routeErrorNoCurrent',
  SESSION_CHANGED: 'routeErrorSessionChanged',
  MODEL_UNAVAILABLE: 'routeErrorModelUnavailable',
  EFFORT_UNSUPPORTED: 'routeErrorEffortUnsupported',
  CONFLICT: 'routeErrorConflict',
  WRITE_FAILED: 'routeErrorWriteFailed',
  VERIFY_FAILED: 'routeErrorVerifyFailed',
}

const styles = `
.dskp-routing { color:var(--dsw-alias-label-primary,#20252f); background:var(--dsw-alias-bg-layer-2,#fff); border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2)); border-radius:12px; padding:17px 20px; margin-bottom:18px; font:12px/1.55 var(--dsw-font-family,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif); }
.dskp-routing h2 { margin:0; font-size:14px; font-weight:650; }
.dskp-routing-head { display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:12px; }
.dskp-routing-row { display:grid; grid-template-columns:110px minmax(0,1fr) auto; gap:14px; align-items:center; padding:11px 0; border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.14)); }
.dskp-routing-route { margin-top:5px; font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--dsw-alias-label-secondary,#68707d); overflow-wrap:anywhere; }
.dskp-routing-pill { display:inline-block; border-radius:5px; padding:3px 7px; font-size:11px; }
.dskp-routing-ok { color:var(--dsw-alias-state-success-primary,#13835e); background:color-mix(in srgb, var(--dsw-alias-state-success-primary,#13835e) 9%, transparent); }
.dskp-routing-warning { color:var(--dsw-alias-state-warn-primary,#a76616); background:color-mix(in srgb, var(--dsw-alias-state-warn-primary,#a76616) 11%, transparent); }
.dskp-routing button { font:inherit; border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.23)); border-radius:7px; padding:7px 11px; color:inherit; background:var(--dsw-alias-bg-layer-1,#fff); cursor:pointer; }
.dskp-routing button:hover:not(:disabled) { background:color-mix(in srgb, var(--dsw-alias-label-secondary,#68707d) 8%, transparent); }
.dskp-routing button:disabled { opacity:.45; cursor:default; }
.dskp-routing button:focus-visible { outline:2px solid var(--dsw-alias-brand-primary,#4268e8); outline-offset:2px; }
.dskp-routing-hint { margin:10px 0 0; font-size:11px; line-height:1.7; color:var(--dsw-alias-label-secondary,#68707d); }
.dskp-routing-feedback { margin:10px 0 0; font-size:12px; line-height:1.6; }
.dskp-routing-error { color:var(--dsw-alias-state-error-primary,#bc4545); }
@media(max-width:650px) { .dskp-routing { padding:15px; } .dskp-routing-row { grid-template-columns:1fr auto; gap:8px; } .dskp-routing-label { grid-column:1/-1; font-weight:600; } }
`

function routeText(selection: RouteSelection): string {
  return `${selection.provider} / ${selection.model}${selection.reasoningEffort ? ` · ${selection.reasoningEffort}` : ''}`
}

/** Visible route state makes the required provider choice explicit. */
export function RoutingStatus({ controller, t = translateZh }: { controller: RoutingController; t?: Translate }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const titleId = useId()
  useEffect(() => {
    void controller.refresh()
    // Poll only while the page is visible; a background window keeps the last verified state.
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void controller.refresh()
    }, 15_000)
    const focus = () => { void controller.refresh() }
    window.addEventListener('focus', focus)
    return () => { clearInterval(timer); window.removeEventListener('focus', focus) }
  }, [controller])
  const selection = state.current.kind === 'available' ? state.current.selection ?? state.catalog?.default : undefined
  const eligible = (candidate: RouteSelection | undefined): boolean => {
    if (!candidate || !state.catalog || state.status !== 'ready') return false
    try { poolTarget(candidate, state.catalog); return true } catch { return false }
  }
  const detail = (candidate: RouteSelection | undefined) => {
    if (!candidate || !state.catalog) return null
    try { poolTarget(candidate, state.catalog); return null }
    catch { return <p className="dskp-routing-hint">{state.catalog.models.some(model => model.provider === POOL_PROVIDER && model.id === candidate.model) ? t('routeEffortUnsupported') : t('routeModelUnavailable')}</p> }
  }
  const renderRoute = (candidate: RouteSelection | undefined, fallback: string) => candidate
    ? <><span className={`dskp-routing-pill ${candidate.provider === POOL_PROVIDER ? 'dskp-routing-ok' : 'dskp-routing-warning'}`}>{candidate.provider === POOL_PROVIDER ? t('routeConnected') : t('routeBypass')}</span><div className="dskp-routing-route">{routeText(candidate)}</div></>
    : <span>{fallback}</span>
  const currentFallback = state.current.kind === 'available'
    ? t('routeLoading') : t(CURRENT_FALLBACK_KEYS[state.current.kind])
  return <section className="dskp-routing" aria-labelledby={titleId}>
    <style>{styles}</style>
    <div className="dskp-routing-head"><h2 id={titleId}>{t('routeTitle')}</h2><button type="button" disabled={!!state.busy} onClick={() => { void controller.refresh() }}>{t('routeRefresh')}</button></div>
    <div className="dskp-routing-row">
      <div className="dskp-routing-label">{t('routeCurrent')}</div>
      <div>{renderRoute(selection, currentFallback)}{detail(selection)}</div>
      <button type="button" disabled={!!state.busy || selection?.provider === POOL_PROVIDER || !eligible(selection)} onClick={() => { void controller.switchCurrent() }}>{state.busy === 'current' ? t('routeWorking') : t('routeSwitchCurrent')}</button>
    </div>
    <div className="dskp-routing-row">
      <div className="dskp-routing-label">{t('routeDefault')}</div>
      <div>{renderRoute(state.catalog?.default, t('routeLoading'))}{detail(state.catalog?.default)}</div>
      <button type="button" disabled={!!state.busy || state.catalog?.default.provider === POOL_PROVIDER || !eligible(state.catalog?.default)} onClick={() => { void controller.setDefault() }}>{state.busy === 'default' ? t('routeWorking') : t('routeSetDefault')}</button>
    </div>
    <p className="dskp-routing-hint">{t('routeInlineHint')}</p>
    {state.issue ? <p role="alert" className="dskp-routing-feedback dskp-routing-error">{t(ISSUE_KEYS[state.issue])}</p>
      : state.success ? <p role="status" className="dskp-routing-feedback">{state.success === 'current' ? t('routeCurrentSaved') : t('routeDefaultSaved')}</p> : null}
  </section>
}
