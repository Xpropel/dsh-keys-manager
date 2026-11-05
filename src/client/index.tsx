import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { KeyPoolPanel } from './Panel.tsx'
import { createClientRequest } from './request.ts'
import { NS, en, zh, type KeyPoolCopyKey } from './locales.ts'
import { panelStyles } from './styles.ts'
import type { PoolRequest } from './types.ts'
import { RoutingStatus } from './Routing.tsx'
import { createRoutingController, type RoutingController } from './routing.ts'

export { KeyPoolPanel } from './Panel.tsx'
export { createClientRequest } from './request.ts'
export type { PoolRequest } from './types.ts'

// The browser composition provides this service; its portable type is not
// globally merged by dsh-client-connection, which also has a Host face.
declare module '@deepseek-ai/cordis' {
  interface Context { connection: ConnectionHandle }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'deepseek-key-pool': KeyPoolCopyKey }
}

export const PANEL_ID = 'deepseek-key-pool' as MainPanelId
export const inject = ['slots', 'locale', 'connection', 'sessions']

type PageProps = PropsRuntime<'main'> & PropsLocale<typeof NS> & { request: PoolRequest; routing: RoutingController; getLocale: () => string }

/**
 * Independent main-column page selected by the application sidebar. The h1
 * belongs to the page (the panel title is hidden here) and time copy follows
 * the application locale.
 */
export function KeyPoolPage({ request, routing, getLocale, t }: PageProps) {
  return <div className="dskp-page"><style>{panelStyles}</style><div className="dskp-page-inner">
    <header className="dskp-page-head"><div><h1 className="dskp-page-title">{t('title')}</h1><p className="dskp-subtitle">{t('subtitle')}</p></div></header>
    <RoutingStatus controller={routing} t={t}/>
    <p className="dskp-note dskp-page-note">{t('routeHint')}</p>
    <KeyPoolPanel request={request} t={t} locale={getLocale()} showTitle={false}/>
  </div></div>
}

function KeyPoolIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="8.5" cy="8.5" r="4.5"/><path d="m12 12 8 8m-4-4 3-3m-1 5 3-3"/></svg>
}

/**
 * Register the native sidebar entry and its full management page.
 *
 * The former Settings → Models footer shortcut was removed: the settings layer
 * keeps its open/close state in a private store owned by
 * `dsh-client-ui-settings-general`, and no public client service (layout,
 * settings, slots) exposes a close action — selectPanel alone left the modal
 * covering the page. The sidebar entry is the supported entry point.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'deepseek-key-pool: dictionaries')
  const t = ctx.locale.bind(NS)
  const request = createClientRequest(ctx.connection)
  const routing = createRoutingController(ctx.connection, ctx.sessions)
  const getLocale = (): string => ctx.locale.getLocale().active
  ctx.effect(() => () => routing.dispose(), 'deepseek-key-pool: routing status')
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: PANEL_ID, locale: NS, inject: () => ({ request, routing, getLocale }),
  }, KeyPoolPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: PANEL_ID, order: 15, locale: NS, label: () => t('nav'),
  }, KeyPoolIcon))
}
