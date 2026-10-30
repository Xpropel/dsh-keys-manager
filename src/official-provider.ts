/** Official API-key route orchestration; only credential selection belongs to the pool. */
import type { Context } from '@deepseek-ai/cordis'
import { APP_IDENTITY } from '@deepseek-ai/dsh-llm'
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

/**
 * Mirrors the small public wiring in rc.5's official API-key plugin. Catalog
 * decoding, capability negotiation, admission, cache scope, and transport are
 * all the official implementations, not local approximations of their rules.
 */
export function registerOfficialPoolTransport(
  ctx: Context,
  provider: string,
  source: OfficialConnectionSource,
  credentials: {
    present(connection: ResolvedDeepSeekOptions): Promise<string | undefined>
    resolveAuth(connection: ResolvedDeepSeekOptions): Promise<DeepSeekRequestAuth>
  },
): void {
  const listings = new ModelListingCache({
    credential: async () => credentials.present(source.get()),
    load: (url, key, signal) => requestModelListing(url, { 'x-api-key': key }, signal),
    now: () => Date.now(),
    info: message => console.error('[deepseek-key-pool]', message),
    warn: message => console.warn('[deepseek-key-pool]', message),
  })
  let reportedListing: ModelListing | undefined
  const connectionOf = (connection: ResolvedDeepSeekOptions, view: ListingView | undefined) => {
    if (view === undefined) return { ...connection, offered: connection.models, refusals: new Map<string, CatalogRefusal>() }
    const catalog = resolveListedCatalog({
      listing: view.listing?.entries, supported: connection.models, overrides: {},
      routeMaxTokens: connection.maxTokens, clientVersion: APP_IDENTITY.version,
    })
    if (view.listing !== reportedListing) {
      reportedListing = view.listing
      for (const problem of catalog.problems) console.warn('[deepseek-key-pool]', problem)
    }
    return { ...connection, models: catalog.resolution, offered: catalog.offered, refusals: catalog.refusals }
  }
  registerDeepSeekProvider(ctx, provider, {
    providerName: 'DeepSeek Key Pool',
    options: () => {
      const connection = source.get()
      return connectionOf(connection, connection.listing === undefined ? undefined : listings.current())
    },
    connect: async signal => {
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
      return view.authenticated ? connectionOf(connection, view).offered.map(model => catalogModelInfo(route, model)) : []
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
  ctx.effect(() => () => { release(); listings.dispose() }, 'key-pool: official model listing')
}
