import { useEffect, useSyncExternalStore } from 'react'
import { POOL_PROVIDER, poolTarget, type RouteSelection, type RoutingController, type RoutingIssue } from './routing.ts'

const copy = {
  zh: {
    title: '模型连接状态', current: '当前会话', default: '新会话默认', connected: '已接入 Key 池', bypass: '未经过 Key 池',
    loading: '正在读取…', none: '尚未识别当前会话', ambiguous: '存在多个主会话，暂不修改', unavailable: '会话状态尚未就绪',
    subagent: '子代理会话需由其父会话管理', switchCurrent: '当前会话切到 Key 池', setDefault: '设为默认', refresh: '刷新状态',
    working: '正在保存…', modelUnavailable: 'Key 池没有同名模型，请使用 Harness 模型选择器。',
    effortUnsupported: 'Key 池不支持当前推理级别，请使用 Harness 模型选择器。',
    hint: '添加 Key 后还需要让模型请求经过 Key 池。这里保留原模型与推理级别，切换从下一次请求生效。',
    currentSaved: '已确认当前会话接入 Key 池。默认模型以此处显示的状态为准。', defaultSaved: '已确认新会话默认使用 Key 池；其他已有会话保持原选择。',
    errors: {
      READ_FAILED: '暂时无法读取模型连接状态，请刷新重试。', NO_CURRENT: '尚未唯一识别当前会话，请先打开目标会话。',
      SESSION_CHANGED: '当前会话或模型已发生变化，请刷新状态后确认。', MODEL_UNAVAILABLE: 'Key 池没有同名模型，未进行切换。',
      EFFORT_UNSUPPORTED: '无法保留当前推理级别，未进行切换。', CONFLICT: '默认模型设置已被其他操作修改，请刷新后重试。',
      WRITE_FAILED: '操作未完成，请检查模型配置或连接后重试。', VERIFY_FAILED: '保存结果尚未确认，请刷新状态；不要重复提交。',
    } satisfies Record<RoutingIssue, string>,
  },
  en: {
    title: 'Model connection', current: 'Current conversation', default: 'New conversation default', connected: 'Using Key Pool', bypass: 'Bypassing Key Pool',
    loading: 'Loading…', none: 'No current conversation', ambiguous: 'Multiple main conversations; changes disabled', unavailable: 'Conversation state is not ready',
    subagent: 'Manage this subagent through its parent', switchCurrent: 'Use Key Pool here', setDefault: 'Make default', refresh: 'Refresh status',
    working: 'Saving…', modelUnavailable: 'Key Pool has no matching model. Use the Harness model selector.',
    effortUnsupported: 'The current reasoning level is unsupported. Use the Harness model selector.',
    hint: 'Adding keys does not change model routing. These actions keep the model and reasoning level and take effect on the next request.',
    currentSaved: 'This conversation is confirmed to use Key Pool. The default is shown separately.', defaultSaved: 'New conversations now default to Key Pool. Existing conversations keep their selections.',
    errors: {
      READ_FAILED: 'Unable to read model routing. Refresh to retry.', NO_CURRENT: 'Open the intended conversation before switching.',
      SESSION_CHANGED: 'The current conversation or model changed. Refresh and review.', MODEL_UNAVAILABLE: 'No matching Key Pool model; no switch was made.',
      EFFORT_UNSUPPORTED: 'The reasoning level cannot be preserved; no switch was made.', CONFLICT: 'Another operation changed the default. Refresh and retry.',
      WRITE_FAILED: 'The operation did not complete. Check the configuration and connection.', VERIFY_FAILED: 'The saved result is unconfirmed. Refresh before submitting again.',
    } satisfies Record<RoutingIssue, string>,
  },
}

const styles = `
.dskp-routing { color:var(--dsw-alias-label-primary,#20252f); background:var(--dsw-alias-settings-card-fill,#fff); border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.2)); border-radius:12px; padding:17px 20px; margin-bottom:18px; font-family:inherit; font-size:12px; }
.dskp-routing h3 { margin:0; font-size:14px; font-weight:650; }
.dskp-routing-head { display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:12px; }
.dskp-routing-row { display:grid; grid-template-columns:110px minmax(0,1fr) auto; gap:14px; align-items:center; padding:11px 0; border-top:1px solid rgba(127,127,127,.12); }
.dskp-routing-route { margin-top:5px; font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; opacity:.65; overflow-wrap:anywhere; }
.dskp-routing-pill { display:inline-block; border-radius:5px; padding:3px 7px; font-size:11px; }
.dskp-routing-ok { color:#13835e; background:rgba(20,155,112,.08); }
.dskp-routing-warning { color:#a76616; background:rgba(194,128,36,.1); }
.dskp-routing button { font:inherit; border:1px solid rgba(127,127,127,.23); border-radius:7px; padding:7px 11px; color:inherit; background:transparent; cursor:pointer; }
.dskp-routing button:disabled { opacity:.45; cursor:default; }
.dskp-routing button:focus-visible { outline:2px solid #5879dd; outline-offset:2px; }
.dskp-routing-hint { margin:10px 0 0; font-size:11px; line-height:1.7; opacity:.65; }
.dskp-routing-feedback { margin:10px 0 0; font-size:12px; line-height:1.6; }
.dskp-routing-error { color:#bc4545; }
@media(max-width:650px) { .dskp-routing { padding:15px; } .dskp-routing-row { grid-template-columns:1fr auto; gap:8px; } .dskp-routing-label { grid-column:1/-1; font-weight:600; } }
`

function routeText(selection: RouteSelection): string {
  return `${selection.provider} / ${selection.model}${selection.reasoningEffort ? ` · ${selection.reasoningEffort}` : ''}`
}

/** Visible route state makes the required provider choice explicit. */
export function RoutingStatus({ controller, language = 'zh' }: { controller: RoutingController; language?: 'zh' | 'en' }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const t = copy[language]
  useEffect(() => {
    void controller.refresh()
    const timer = setInterval(() => { void controller.refresh() }, 15_000)
    const focus = () => { void controller.refresh() }
    window.addEventListener('focus', focus)
    return () => { clearInterval(timer); window.removeEventListener('focus', focus) }
  }, [controller])
  const selection = state.current.kind === 'available' ? state.current.selection ?? state.catalog?.default : undefined
  const eligible = (selection: RouteSelection | undefined): boolean => {
    if (!selection || !state.catalog || state.status !== 'ready') return false
    try { poolTarget(selection, state.catalog); return true } catch { return false }
  }
  const detail = (selection: RouteSelection | undefined) => {
    if (!selection || !state.catalog) return null
    try { poolTarget(selection, state.catalog); return null }
    catch { return <p className="dskp-routing-hint">{state.catalog.models.some(model => model.provider === POOL_PROVIDER && model.id === selection.model) ? t.effortUnsupported : t.modelUnavailable}</p> }
  }
  const renderRoute = (selection: RouteSelection | undefined, fallback: string) => selection
    ? <><span className={`dskp-routing-pill ${selection.provider === POOL_PROVIDER ? 'dskp-routing-ok' : 'dskp-routing-warning'}`}>{selection.provider === POOL_PROVIDER ? t.connected : t.bypass}</span><div className="dskp-routing-route">{routeText(selection)}</div></>
    : <span>{fallback}</span>
  const currentFallback = state.current.kind === 'available' ? t.loading : t[state.current.kind]
  return <section className="dskp-routing" aria-label={t.title}>
    <style>{styles}</style>
    <div className="dskp-routing-head"><h3>{t.title}</h3><button type="button" disabled={!!state.busy} onClick={() => { void controller.refresh() }}>{t.refresh}</button></div>
    <div className="dskp-routing-row">
      <div className="dskp-routing-label">{t.current}</div>
      <div>{renderRoute(selection, currentFallback)}{detail(selection)}</div>
      <button type="button" disabled={!!state.busy || selection?.provider === POOL_PROVIDER || !eligible(selection)} onClick={() => { void controller.switchCurrent() }}>{state.busy === 'current' ? t.working : t.switchCurrent}</button>
    </div>
    <div className="dskp-routing-row">
      <div className="dskp-routing-label">{t.default}</div>
      <div>{renderRoute(state.catalog?.default, t.loading)}{detail(state.catalog?.default)}</div>
      <button type="button" disabled={!!state.busy || state.catalog?.default.provider === POOL_PROVIDER || !eligible(state.catalog?.default)} onClick={() => { void controller.setDefault() }}>{state.busy === 'default' ? t.working : t.setDefault}</button>
    </div>
    <p className="dskp-routing-hint">{t.hint}</p>
    {state.issue ? <p role="alert" className="dskp-routing-feedback dskp-routing-error">{t.errors[state.issue]}</p>
      : state.success ? <p role="status" className="dskp-routing-feedback">{state.success === 'current' ? t.currentSaved : t.defaultSaved}</p> : null}
  </section>
}
