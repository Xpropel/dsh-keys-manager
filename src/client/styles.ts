/** Scoped styles use the desktop theme tokens and work in the standalone preview. */
export const panelStyles = `
.dskp { --kp-text:var(--dsw-alias-label-primary,#18212f); --kp-muted:var(--dsw-alias-label-tertiary,#7a8492); --kp-fill:var(--dsw-alias-settings-card-fill,#fff); --kp-line:var(--dsw-alias-border-l3,#e7eaf0); --kp-hover:var(--dsw-alias-interactive-bg-hover,#f5f7fa); --kp-blue:#4268e8; color:var(--kp-text); font:13px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; width:100%; min-width:0; margin-top:28px; container-type:inline-size; }
.dskp * { box-sizing:border-box; }
.dskp h2,.dskp h3,.dskp p { margin:0; }
.dskp button,.dskp input,.dskp textarea { font:inherit; }
.dskp button { cursor:pointer; }
.dskp button:disabled { opacity:.42; cursor:not-allowed; }
.dskp button:focus-visible,.dskp input:focus-visible,.dskp textarea:focus-visible { outline:2px solid var(--kp-blue); outline-offset:3px; }
.dskp svg { width:16px; height:16px; flex:none; }
.dskp-header { display:flex; align-items:flex-start; justify-content:space-between; gap:18px; margin-bottom:20px; }
.dskp-heading { display:flex; align-items:center; gap:10px; }
.dskp-logo { width:34px; height:34px; border-radius:10px; color:var(--kp-blue); background:rgba(66,104,232,.09); display:grid; place-items:center; }
.dskp-logo svg { width:20px; height:20px; }
.dskp h2 { font-size:19px; line-height:1.35; font-weight:650; letter-spacing:-.3px; }
.dskp-subtitle { color:var(--kp-muted); font-size:12px; margin-top:7px !important; }
.dskp-header-actions,.dskp-inline { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.dskp-button { display:inline-flex; justify-content:center; align-items:center; gap:7px; border:1px solid var(--kp-line); border-radius:8px; background:var(--kp-fill); color:var(--kp-text); padding:7px 11px; min-height:34px; white-space:nowrap; }
.dskp-button:hover:not(:disabled),.dskp-icon-button:hover:not(:disabled) { background:var(--kp-hover); }
.dskp-button.primary { color:white; background:var(--kp-blue); border-color:var(--kp-blue); }
.dskp-button.primary:hover:not(:disabled) { background:#355bd8; }
.dskp-button.danger { color:#c54444; border-color:rgba(197,68,68,.2); }
.dskp-button.small { min-height:28px; padding:3px 8px; font-size:11px; }
.dskp-icon-button { width:26px; height:25px; border:0; border-radius:5px; background:transparent; color:var(--kp-muted); display:inline-flex; justify-content:center; align-items:center; }
.dskp-stats { display:grid; grid-template-columns:1fr 1fr 1.6fr; border:1px solid var(--kp-line); border-radius:12px; background:var(--kp-fill); overflow:hidden; margin-bottom:16px; }
.dskp-stat { padding:15px 18px; min-width:0; }
.dskp-stat + .dskp-stat { border-left:1px solid var(--kp-line); }
.dskp-stat-label { color:var(--kp-muted); font-size:11px; }
.dskp-stat-value { display:block; font-size:23px; font-weight:620; line-height:1.3; margin-top:6px; letter-spacing:-.4px; }
.dskp-stat-current { font-size:14px; line-height:1.55; margin-top:8px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dskp-pool-summary { border:1px solid rgba(66,104,232,.23); border-radius:13px; background:var(--kp-fill); padding:19px 20px 16px; margin-bottom:16px; box-shadow:inset 3px 0 0 rgba(66,104,232,.7); }
.dskp-pool-overview { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; margin-bottom:16px; }
.dskp-pool-overview > .dskp-pool-summary { margin-bottom:0; min-width:0; }
.dskp-pool-consumption { border-color:var(--kp-line); box-shadow:inset 3px 0 0 #8493aa; }
.dskp-pool-consumption .dskp-pool-total-row .dskp-metric-amount { color:var(--kp-text); }
.dskp-pool-heading { display:flex; align-items:center; gap:8px; }
.dskp-pool-heading h3 { font-size:12px; font-weight:600; }
.dskp-pool-currency { font-size:9px; padding:1px 5px; border-radius:4px; color:var(--kp-blue); background:rgba(66,104,232,.08); }
.dskp-pool-total-row { display:flex; align-items:baseline; justify-content:space-between; gap:12px 20px; flex-wrap:wrap; margin:10px 0 11px; }
.dskp-pool-total-row .dskp-metric-amount { font-size:32px !important; color:var(--kp-blue); min-width:0; }
.dskp-pool-coverage { color:var(--kp-muted); font-size:11px; }
.dskp-pool-incomplete { display:flex; flex-wrap:wrap; gap:3px 10px; font-size:11px; margin:0 0 9px; color:var(--dsw-alias-state-warn-label,#a46e25); }
.dskp-pool-incomplete strong { font-weight:500; }
.dskp-pool-snapshot,.dskp-pool-rule { font-size:10px; color:var(--kp-muted); line-height:1.6; }
.dskp-pool-missing { font-size:10px; color:var(--dsw-alias-state-warn-label,#a46e25); margin-bottom:7px !important; }
.dskp-pool-method { border-top:1px solid var(--kp-line); margin-top:9px !important; padding-top:8px; font-size:10px; line-height:1.6; color:var(--kp-muted); }
.dskp-pool-snapshot:empty { display:none; }
.dskp-active-summary { border:1px solid var(--kp-line); border-radius:13px; background:var(--kp-fill); overflow:hidden; margin-bottom:20px; }
.dskp-active-heading { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; padding:17px 20px 14px; }
.dskp-active-name { font-size:15px; font-weight:600; margin-top:4px; overflow-wrap:anywhere; }
.dskp-current-metrics { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); border-top:1px solid var(--kp-line); background:rgba(66,104,232,.025); }
.dskp-current-metric { padding:18px 20px; min-width:0; }
.dskp-current-metric + .dskp-current-metric { border-left:1px solid var(--kp-line); }
.dskp-metric-label { display:flex; align-items:center; gap:7px; font-size:11px; color:var(--kp-muted); margin-bottom:8px; }
.dskp-metric-label > span { font-size:9px; border:1px solid var(--kp-line); border-radius:4px; padding:0 4px; }
.dskp-metric-amount { font-size:26px !important; font-weight:600 !important; line-height:1.3; letter-spacing:-.5px; max-width:none !important; white-space:normal !important; overflow-wrap:anywhere; font-variant-numeric:tabular-nums; }
.dskp-metric-amount .dskp-currency-symbol { font-size:17px; font-weight:450; color:var(--kp-muted); }
.dskp-current-metric .dskp-time { margin-top:7px; font-size:10px; white-space:normal; }
.dskp-active-detail { display:flex; align-items:flex-start; justify-content:space-between; flex-wrap:wrap; gap:8px 18px; padding:10px 20px; border-top:1px solid var(--kp-line); }
.dskp-active-detail .dskp-statistics-details { flex:1; min-width:190px; margin:0; }
.dskp-active-detail .dskp-statistics-details dl { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); column-gap:24px; }
.dskp-active-error { color:var(--kp-muted); font-size:10px; padding-top:1px; }
.dskp-active-empty { color:var(--kp-muted); font-size:11px; padding:11px 20px; }
.dskp-list-heading { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px 16px; color:var(--kp-muted); font-size:11px; padding:0 2px; margin:0 0 9px; }
.dskp-list-hint { font-size:10px; margin-top:3px !important; }
.dskp-balance-source { color:var(--kp-muted); font-size:10px; margin-top:5px; }
.dskp-mobile-label { display:none; }
.dskp-statistics-details { margin-top:6px; font-size:10px; }
.dskp-statistics-details summary { color:var(--kp-blue); cursor:pointer; width:fit-content; list-style-position:inside; }
.dskp-statistics-details summary:focus-visible { outline:2px solid var(--kp-blue); outline-offset:3px; border-radius:3px; }
.dskp-statistics-details dl { margin:8px 0 1px; min-width:150px; }
.dskp-statistics-details dl > div { padding:4px 0; }
.dskp-statistics-details dt { color:var(--kp-muted); font-size:9px; }
.dskp-statistics-details dd { margin:2px 0 0; font:10px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; overflow-wrap:anywhere; }
.dskp-statistics-details p { color:var(--kp-muted); font-size:10px; margin-top:6px; }
.dskp-status { display:inline-flex; align-items:center; gap:6px; font-size:11px; white-space:nowrap; color:var(--kp-muted); }
.dskp-status::before { content:''; width:6px; height:6px; border-radius:50%; background:currentColor; flex:none; }
.dskp-status.ready { color:#278864; }.dskp-status.exhausted { color:#b47929; }.dskp-status.invalid,.dskp-status.error { color:#c15c5c; }
.dskp-mode { margin:7px 0 0 44px; }
.dskp-card { border:1px solid var(--kp-line); border-radius:12px; background:var(--kp-fill); overflow:hidden; }
.dskp-table-wrap { width:100%; height:var(--dskp-list-height,auto); max-height:var(--dskp-list-height,460px); overflow:auto; scrollbar-gutter:stable; scrollbar-width:thin; scrollbar-color:#a6afbf var(--kp-hover); overflow-anchor:none; overscroll-behavior:contain; }
.dskp-table-wrap:focus-visible { outline:2px solid var(--kp-blue); outline-offset:-2px; }
.dskp-table-wrap::-webkit-scrollbar { width:10px; height:10px; }
.dskp-table-wrap::-webkit-scrollbar-track { background:var(--kp-hover); }
.dskp-table-wrap::-webkit-scrollbar-thumb { background:#a6afbf; border:2px solid var(--kp-hover); border-radius:8px; }
.dskp-table-wrap::-webkit-scrollbar-thumb:hover { background:#7e8a9e; }
.dskp-table { border-collapse:collapse; text-align:left; width:100%; font-size:12px; }
.dskp-table th { position:sticky; top:0; z-index:1; background:var(--kp-fill); color:var(--kp-muted); font-size:10px; font-weight:500; padding:10px 12px; white-space:nowrap; border-bottom:1px solid var(--kp-line); box-shadow:0 1px 0 var(--kp-line); }
.dskp-table td { padding:14px 12px; border-bottom:1px solid var(--kp-line); vertical-align:middle; }
.dskp-table tr:last-child td { border-bottom:0; }
.dskp-table th:first-child,.dskp-table td:first-child { padding-left:16px; }
.dskp-table tr.is-current { background:rgba(66,104,232,.035); }
.dskp-key-name { font-weight:600; max-width:160px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dskp-key-id { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:10px; color:var(--kp-muted); margin-top:4px; white-space:nowrap; }
.dskp-tag { font-size:9px; background:rgba(66,104,232,.09); color:var(--kp-blue); padding:1px 5px; border-radius:4px; font-weight:500; }
.dskp-amount { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; white-space:normal; overflow-wrap:anywhere; font-weight:550; max-width:190px; }
.dskp-time { color:var(--kp-muted); font-size:9px; white-space:nowrap; margin-top:4px; }
.dskp-row-actions { display:flex; align-items:center; justify-content:flex-end; flex-wrap:wrap; gap:4px; min-width:148px; }
.dskp-order { display:flex; align-items:center; gap:3px; white-space:nowrap; color:var(--kp-muted); }
.dskp-note { color:var(--kp-muted); font-size:11px; display:flex; align-items:flex-start; gap:7px; margin:11px 2px 0; }
.dskp-note svg { width:13px; height:13px; margin-top:2px; }
.dskp-empty { padding:34px 22px; text-align:center; }
.dskp-empty-icon { color:#8194c3; width:42px; height:42px; display:grid; place-items:center; border-radius:12px; background:rgba(66,104,232,.065); margin:0 auto 12px; }
.dskp-empty-icon svg { width:23px; height:23px; }
.dskp-empty h3 { font-size:14px; font-weight:600; }.dskp-empty p { color:var(--kp-muted); margin:6px auto 16px; max-width:390px; font-size:12px; }
.dskp-settings { margin-top:25px; }
.dskp-section-head { display:flex; align-items:center; justify-content:space-between; gap:14px; margin-bottom:10px; }
.dskp h3 { font-size:13px; font-weight:600; }
.dskp-section-head p { color:var(--kp-muted); font-size:11px; margin-top:3px; }
.dskp-setting-row { display:flex; align-items:center; justify-content:space-between; gap:20px; padding:15px 17px; }
.dskp-setting-row + .dskp-setting-row { border-top:1px solid var(--kp-line); }
.dskp-setting-label { font-size:12px; font-weight:500; }.dskp-setting-hint { color:var(--kp-muted); font-size:11px; margin-top:3px !important; }
.dskp-switch { flex:none; display:block; width:34px; height:20px; padding:2px; border:0; border-radius:999px; background:#bbc1cc; transition:background .15s; }
.dskp-switch span { display:block; width:16px; height:16px; border-radius:50%; background:white; box-shadow:0 1px 2px rgba(0,0,0,.12); transition:transform .15s; }
.dskp-switch[aria-checked=true] { background:var(--kp-blue); }.dskp-switch[aria-checked=true] span { transform:translateX(14px); }
.dskp-number { width:100px; border:1px solid var(--kp-line); border-radius:7px; padding:7px 9px; color:var(--kp-text); background:var(--kp-fill); text-align:right; }
.dskp-history { margin-top:25px; }.dskp-history-body { padding:13px 17px; }.dskp-history-empty { color:var(--kp-muted); font-size:11px; padding:3px 0; }
.dskp-history-body:has(.dskp-event-table) { padding:0; overflow:hidden; }.dskp-event-table th { padding:6px 12px; }.dskp-event-table td { padding:5px 12px; line-height:1.4; }.dskp-event-time { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px; white-space:nowrap; }
.dskp-import { padding:19px; margin-bottom:16px; border-color:rgba(66,104,232,.3); }.dskp-import p { color:var(--kp-muted); font-size:11px; margin-top:4px; }
.dskp-input { display:block; margin:14px 0 9px; width:100%; min-height:112px; resize:vertical; border:1px solid var(--kp-line); border-radius:8px; padding:11px 12px; color:var(--kp-text); background:var(--kp-fill); font:12px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace !important; }
.dskp-import-footer { display:flex; justify-content:flex-end; gap:8px; margin-top:15px; }
.dskp-feedback-slot { min-height:36px; margin-bottom:13px; }.dskp-feedback { border-radius:8px; padding:9px 12px; font-size:12px; background:rgba(39,136,100,.07); color:#278864; }.dskp-feedback.error { background:rgba(193,92,92,.07); color:#c15c5c; }
.dskp-confirm { display:flex; gap:16px; align-items:center; justify-content:space-between; border:1px solid rgba(193,92,92,.25); border-radius:9px; padding:14px; margin-bottom:14px; background:var(--kp-fill); }.dskp-confirm p { font-size:11px; color:var(--kp-muted); margin-top:4px; }
.dskp-spin { animation:dskp-spin 1s linear infinite; transform-origin:center; } @keyframes dskp-spin { to { transform:rotate(360deg); } }
@media (prefers-reduced-motion:reduce) { .dskp-spin { animation:none; }.dskp-switch,.dskp-switch span { transition:none; } }
@container (max-width:900px) {
  .dskp-header { flex-direction:column; gap:12px; }
  .dskp-header-actions { align-self:flex-start; }
  .dskp-confirm { flex-direction:column; align-items:stretch; }
  .dskp-table-wrap { overflow:auto; }
  .dskp-table,.dskp-table tbody { display:block; }
  .dskp-table thead { display:none; }
  .dskp-table tbody tr { display:grid; grid-template-columns:48px minmax(0,1fr) minmax(0,1fr); padding:14px 14px 10px; gap:8px 12px; border-bottom:1px solid var(--kp-line); }
  .dskp-table tbody tr:last-child { border-bottom:0; }
  .dskp-table td,.dskp-table td:first-child { display:block; padding:0; border:0; min-width:0; }
  .dskp-table td:nth-child(1) { grid-column:1; grid-row:1/4; }
  .dskp-table td:nth-child(2) { grid-column:2/4; grid-row:1; }
  .dskp-table td:nth-child(3) { grid-column:2; grid-row:3; padding-top:4px; }
  .dskp-table td:nth-child(4) { grid-column:3; grid-row:3; padding-top:4px; }
  .dskp-table td:nth-child(5) { grid-column:2/4; grid-row:2; }
  .dskp-table td:nth-child(6) { grid-column:1/-1; grid-row:4; padding-top:8px; margin-top:5px; border-top:1px solid var(--kp-line); }
  .dskp-order { display:block; }.dskp-order > div { margin-left:-6px; display:flex; }
  .dskp-row-actions { min-width:0; gap:8px; }
  .dskp-key-name { max-width:100%; }
  .dskp-time { white-space:normal; }
  .dskp-amount { max-width:none; overflow-wrap:anywhere; white-space:normal; }
  .dskp-mobile-label { display:block; color:var(--kp-muted); font-size:10px; margin-bottom:4px; }
  .dskp-statistics-details dl { min-width:0; }
}
@container (max-width:380px) {
  .dskp-stats { grid-template-columns:1fr 1fr; }
  .dskp-stat:last-child { grid-column:1/-1; border-left:0; border-top:1px solid var(--kp-line); }
  .dskp-setting-row { gap:12px; padding:13px; }
  .dskp-number { width:76px; }
  .dskp-pool-summary { padding:16px 14px; }
  .dskp-pool-total-row .dskp-metric-amount { font-size:27px !important; }
  .dskp-active-heading { padding:14px; }
  .dskp-current-metric { padding:15px 13px; }
  .dskp-metric-label { gap:5px; font-size:10px; }
  .dskp-metric-amount { font-size:21px !important; }
  .dskp-active-detail { padding:10px 14px; }
  .dskp-active-detail .dskp-statistics-details dl { grid-template-columns:1fr; }
  .dskp-table tbody tr { grid-template-columns:40px minmax(0,1fr) minmax(0,1fr); gap:7px; padding:13px 11px 9px; }
}
@container (max-width:760px) { .dskp-pool-overview { grid-template-columns:minmax(0,1fr); } }
`
