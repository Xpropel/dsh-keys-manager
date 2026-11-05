/** Official API-key route orchestration; only credential selection belongs to the pool. */
import type { Context } from '@deepseek-ai/cordis'
import { APP_IDENTITY } from '@deepseek-ai/dsh-llm'
import * as DeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import {
  ModelListingCache, catalogModelInfo, refuseListedModel, registerDeepSeekProvider,
  requestModelListing, resolveListedCatalog,
  type CatalogRefusal, type DeepSeekRequestAuth, type ListingView, type ModelListing,
} from '@deepseek-ai/dsh-llm-deepseek'
import type { ResolvedDeepSeekOptions } from '@deepseek-ai/dsh-llm-deepseek-api-key'

export interface OfficialConnectionSource {
  get(): ResolvedDeepSeekOptions
  subscribe(listener: () => void): () => void
}

type ListingAuth = (connection: ResolvedDeepSeekOptions) => Promise<string | undefined>
export type PoolConnection = ResolvedDeepSeekOptions & {
  offered: ResolvedDeepSeekOptions['models']
  refusals: ReadonlyMap<string, CatalogRefusal>
  badges?: ReadonlyMap<string, unknown>
}
type ListingCacheRoute = Pick<ModelListingCache, 'current' | 'view' | 'invalidate'>
type HostListingHooks = {
  settings(): ResolvedDeepSeekOptions['listing']
  credential(url: string): Promise<string | undefined>
  load(url: string, key: string, signal: AbortSignal): ReturnType<typeof requestModelListing>
}
type HostCacheFactory = (ctx: Context, owner: string, provider: string, hooks: HostListingHooks) => ListingCacheRoute

/** The newer host owns automatic refresh, model-change notifications and disposal. */
function createPoolListingCache(ctx: Context, provider: string, source: OfficialConnectionSource, present: ListingAuth): ListingCacheRoute {
  const hooks: HostListingHooks = {
    settings: () => source.get().listing,
    credential: () => present(source.get()),
    load: (url, key, signal) => requestModelListing(url, { 'x-api-key': key }, signal),
  }
  // Optional export: a static named import would prevent the plugin from loading on older hosts.
  const factory: unknown = Reflect.get(DeepSeek, 'createModelListingCache')
  if (typeof factory === 'function') return (factory as HostCacheFactory)(ctx, 'deepseek-key-pool', provider, hooks)
  const cache = new ModelListingCache({
    ...hooks,
    now: () => Date.now(),
    info: message => console.error('[deepseek-key-pool]', message),
    warn: message => console.warn('[deepseek-key-pool]', message),
  } as ConstructorParameters<typeof ModelListingCache>[0])
  ctx.effect(() => () => cache.dispose(), 'key-pool: model listing')
  return cache
}

// Badge payloads are opaque here: the same installed SDK validates, creates and consumes them.
const describeListedModel = catalogModelInfo as (route: string, model: Parameters<typeof catalogModelInfo>[1], badge?: unknown) => ReturnType<typeof catalogModelInfo>

/**
 * Mirrors the public wiring in the official API-key plugin. Catalog
 * decoding, capability negotiation, admission, cache scope, and transport are
 * all the official implementations, not local approximations of their rules.
 */
export function registerOfficialPoolTransport(
  ctx: Context,
  provider: string,
  source: OfficialConnectionSource,
  credentials: {
    present(connection: ResolvedDeepSeekOptions): Promise<string | undefined>
    resolveAuth(connection: PoolConnection): Promise<DeepSeekRequestAuth>
    rotationConnection?(): PoolConnection | undefined
  },
): void {
  const listings = createPoolListingCache(ctx, provider, source, credentials.present)
  let reportedListing: ModelListing | undefined
  const connectionOf = (connection: ResolvedDeepSeekOptions, view: ListingView | undefined): PoolConnection => {
    if (view === undefined) return { ...connection, offered: connection.models, refusals: new Map<string, CatalogRefusal>(), badges: undefined }
    const catalog = resolveListedCatalog({
      listing: view.listing?.entries, supported: connection.models, overrides: {},
      routeMaxTokens: connection.maxTokens, clientVersion: APP_IDENTITY.version,
    })
    if (view.listing !== reportedListing) {
      reportedListing = view.listing
      for (const problem of catalog.problems) console.warn('[deepseek-key-pool]', problem)
    }
    const badges = (catalog as { badges?: ReadonlyMap<string, unknown> }).badges
    return { ...connection, models: catalog.resolution, offered: catalog.offered, refusals: catalog.refusals, badges }
  }
  registerDeepSeekProvider(ctx, provider, {
    providerName: 'DeepSeek Key Pool',
    options: () => {
      const connection = source.get()
      return connectionOf(connection, connection.listing === undefined ? undefined : listings.current())
    },
    connect: async signal => {
      const pinned = credentials.rotationConnection?.()
      if (pinned) return pinned
      const connection = source.get()
      if (connection.listing === undefined) return connectionOf(connection, undefined)
      let view: ListingView
      try { view = await listings.view(connection.listing, signal) }
      catch (error) {
        if (signal?.aborted === true) throw error
        return connectionOf(connection, undefined)
      }
      return connectionOf(connection, view)
    },
    resolveAuth: credentials.resolveAuth,
    admit: (connection, model) => { refuseListedModel(model, connection.refusals.get(model)) },
    discoverModels: async route => {
      const connection = source.get()
      if (connection.listing === undefined) {
        if (await credentials.present(connection) === undefined) return []
        return connection.models.map(model => catalogModelInfo(route, model))
      }
      const view = await listings.view(connection.listing)
      if (!view.authenticated) return []
      const { offered, badges } = connectionOf(connection, view)
      return offered.map(model => describeListedModel(route, model, badges?.get(model.id)))
    },
  })
  let following = source.get().listing !== undefined
  const release = source.subscribe(() => {
    let next: boolean
    try { next = source.get().listing !== undefined }
    catch { return }
    if (next !== following) listings.invalidate()
    following = next
    // The shared official registration listens to its owning fiber. Forward the
    // source's live update so captured retry policies use the same generation.
    ctx.emit('loader/volatile-update', [])
  })
  ctx.effect(() => release, 'key-pool: unsubscribe from official configuration')
}
