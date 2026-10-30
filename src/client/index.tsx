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
export const inject = ['slots', 'locale', 'connection', 'layout', 'sessions']

type PageProps = PropsRuntime<'main'> & PropsLocale<typeof NS> & { request: PoolRequest; routing: RoutingController; getLanguage: () => 'zh' | 'en' }

/** Independent main-column page selected by the application sidebar. */
export function KeyPoolPage({ request, routing, getLanguage, t }: PageProps) {
  return <div style={{ height: '100%', minHeight: 0, overflow: 'auto', width: '100%' }}><div style={{ maxWidth: 1120, margin: '0 auto', padding: '16px 32px 48px' }}><RoutingStatus controller={routing} language={getLanguage()}/><KeyPoolPanel request={request} t={t}/></div></div>
}

function KeyPoolIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="8.5" cy="8.5" r="4.5"/><path d="m12 12 8 8m-4-4 3-3m-1 5 3-3"/></svg>
}

function SettingsShortcut({ t, open }: PropsLocale<typeof NS> & { open: () => void }) {
  return <div className="dskp"><style>{panelStyles}</style><div className="dskp-card dskp-setting-row"><div><h3>{t('title')}</h3><p className="dskp-setting-hint">{t('footerHint')}</p></div><button className="dskp-button" onClick={open}>{t('openPage')}</button></div></div>
}

/** Register the native sidebar entry, its full management page, and a Models shortcut. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'deepseek-key-pool: dictionaries')
  const t = ctx.locale.bind(NS)
  const request = createClientRequest(ctx.connection)
  const routing = createRoutingController(ctx.connection, ctx.sessions)
  const getLanguage = (): 'zh' | 'en' => ctx.locale.getLocale().active.startsWith('zh') ? 'zh' : 'en'
  ctx.effect(() => () => routing.dispose(), 'deepseek-key-pool: routing status')
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: PANEL_ID, locale: NS, inject: () => ({ request, routing, getLanguage }),
  }, KeyPoolPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: PANEL_ID, order: 15, locale: NS, label: () => t('nav'),
  }, KeyPoolIcon))
  ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
    name: 'settings.models.footer', id: 'deepseek-key-pool', order: 20, locale: NS,
    inject: () => ({ open: () => { ctx.layout.selectPanel(PANEL_ID) } }),
  }, SettingsShortcut))
}
