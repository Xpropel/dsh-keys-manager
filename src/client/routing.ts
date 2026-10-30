/** Model-route inspection and explicit switches through Harness's official APIs. */
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'

export const POOL_PROVIDER = 'deepseek-key-pool'
export interface RouteSelection { provider: string; model: string; reasoningEffort?: string }
export interface RoutingModel { provider: string; id: string; efforts: string[]; defaultEffort?: string }
export interface RoutingCatalog { default: RouteSelection; models: RoutingModel[] }
export type CurrentRoute =
  | { kind: 'none' | 'ambiguous' | 'unavailable' | 'subagent' }
  | { kind: 'available'; sessionId: string; selection: RouteSelection | null }
export interface RoutingSessionSource {
  getSnapshot(): CurrentRoute
  subscribe(listener: () => void): () => void
  refresh(sessionId: string): Promise<void>
}
export type RoutingIssue = 'READ_FAILED' | 'NO_CURRENT' | 'SESSION_CHANGED' | 'MODEL_UNAVAILABLE'
  | 'EFFORT_UNSUPPORTED' | 'CONFLICT' | 'WRITE_FAILED' | 'VERIFY_FAILED'
export interface RoutingState {
  status: 'loading' | 'ready' | 'error'
  catalog: RoutingCatalog | null
  current: CurrentRoute
  busy: 'current' | 'default' | null
  issue: RoutingIssue | null
  success: 'current' | 'default' | null
}
class RoutingError extends Error {
  constructor(readonly issue: RoutingIssue) { super(issue) }
}
type Connection = Pick<ConnectionHandle, 'rpc'>
type Sessions = Pick<ISessions, 'list' | 'binding' | 'subagentAddress' | 'refreshProjections'>

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RoutingError('READ_FAILED')
  return value as Record<string, unknown>
}
function nonempty(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 512) throw new RoutingError('READ_FAILED')
  return value
}
export function parseRouteSelection(value: unknown): RouteSelection {
  const row = object(value)
  return {
    provider: nonempty(row.provider), model: nonempty(row.model),
    ...(row.reasoningEffort === undefined ? {} : { reasoningEffort: nonempty(row.reasoningEffort) }),
  }
}
export function parseRoutingCatalog(value: unknown): RoutingCatalog {
  const data = object(value)
  if (!Array.isArray(data.groups)) throw new RoutingError('READ_FAILED')
  return {
    default: parseRouteSelection(data.default),
    models: data.groups.flatMap(group => {
      const row = object(group)
      const provider = nonempty(row.id)
      if (!Array.isArray(row.models)) throw new RoutingError('READ_FAILED')
      return row.models.map(value => {
        const model = object(value)
        const reasoning = model.reasoning === undefined ? undefined : object(model.reasoning)
        if (reasoning && !Array.isArray(reasoning.efforts)) throw new RoutingError('READ_FAILED')
        return {
          provider, id: nonempty(model.id),
          efforts: reasoning ? (reasoning.efforts as unknown[]).map(effort => nonempty(object(effort).id)) : [],
          ...(reasoning?.defaultEffort === undefined ? {} : { defaultEffort: nonempty(reasoning.defaultEffort) }),
        }
      })
    }),
  }
}
export function sameRoute(a: RouteSelection, b: RouteSelection): boolean {
  return a.provider === b.provider && a.model === b.model && a.reasoningEffort === b.reasoningEffort
}

/** Preserve the same model id and its effective effort; never guess another model. */
export function poolTarget(selection: RouteSelection, catalog: RoutingCatalog): RouteSelection {
  const target = catalog.models.find(model => model.provider === POOL_PROVIDER && model.id === selection.model)
  if (!target) throw new RoutingError('MODEL_UNAVAILABLE')
  const origin = catalog.models.find(model => model.provider === selection.provider && model.id === selection.model)
  const effort = selection.reasoningEffort ?? origin?.defaultEffort
  if (effort !== undefined && !target.efforts.includes(effort)) throw new RoutingError('EFFORT_UNSUPPORTED')
  return { provider: POOL_PROVIDER, model: selection.model, ...(effort === undefined ? {} : { reasoningEffort: effort }) }
}

/** Observe only the unique main-view Session; no history loading or arbitrary Session selection. */
export function createRoutingSessionSource(sessions: Sessions): RoutingSessionSource {
  const rows = () => Object.values(sessions.list.getSnapshot().byId).filter(row => (row.retainedBy.mainView ?? 0) > 0)
  const face = () => {
    try {
      const current = rows()
      if (current.length !== 1 || sessions.subagentAddress(current[0]!.id) !== undefined) return undefined
      return sessions.binding(current[0]!.id)?.session.projections.faceOf('modelSelection')
    } catch { return undefined }
  }
  return {
    getSnapshot() {
      try {
        const current = rows()
        if (current.length === 0) return { kind: sessions.list.getSnapshot().phase === 'pending' ? 'unavailable' : 'none' }
        if (current.length !== 1) return { kind: 'ambiguous' }
        const row = current[0]!
        if (sessions.subagentAddress(row.id) !== undefined) return { kind: 'subagent' }
        const projection = face()?.getSnapshot()
        if (projection === undefined) return { kind: 'unavailable' }
        const next = object(projection).next
        return { kind: 'available', sessionId: row.id, selection: next === null ? null : parseRouteSelection(next) }
      } catch { return { kind: 'unavailable' } }
    },
    subscribe(listener) {
      let activeFace = face()
      let releaseFace = activeFace?.subscribe(listener)
      const releaseList = sessions.list.subscribe(() => {
        const next = face()
        if (next !== activeFace) {
          releaseFace?.()
          activeFace = next
          releaseFace = next?.subscribe(listener)
        }
        listener()
      })
      return () => { releaseList(); releaseFace?.() }
    },
    async refresh(sessionId) {
      const row = Object.values(sessions.list.getSnapshot().byId).find(row => row.id === sessionId)
      if (!row) throw new RoutingError('SESSION_CHANGED')
      await sessions.refreshProjections(row.id)
    },
  }
}

/** One page controller. Reading never changes routes; only the two explicit actions write. */
export class RoutingController {
  private state: RoutingState
  private readonly listeners = new Set<() => void>()
  private readonly lifetime = new AbortController()
  private readonly releaseSource: () => void
  private revision = 0
  private disposed = false

  constructor(private readonly connection: Connection, private readonly sessions: RoutingSessionSource) {
    this.state = { status: 'loading', catalog: null, current: sessions.getSnapshot(), busy: null, issue: null, success: null }
    this.releaseSource = sessions.subscribe(() => this.set({ current: sessions.getSnapshot() }))
  }
  getSnapshot = (): RoutingState => this.state
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private set(patch: Partial<RoutingState>): void {
    if (this.disposed) return
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
  private async call(endpoint: string, args: Record<string, unknown>): Promise<unknown> {
    this.lifetime.signal.throwIfAborted()
    const result = await this.connection.rpc.call('/api', endpoint, { args }, this.lifetime.signal)
    this.lifetime.signal.throwIfAborted()
    if (!result.ok) throw new RoutingError(result.error.code === 'settings/conflict' ? 'CONFLICT' : 'WRITE_FAILED')
    return result.value
  }
  private async catalog(): Promise<RoutingCatalog> { return parseRoutingCatalog(await this.call('session/modelCatalog', {})) }

  async refresh(): Promise<void> {
    if (this.disposed || this.state.busy) return
    const revision = ++this.revision
    try {
      const catalog = await this.catalog()
      if (revision !== this.revision) return
      this.set({ status: 'ready', catalog, current: this.sessions.getSnapshot(), issue: null, success: null })
    } catch {
      if (revision === this.revision) this.set({ status: 'error', issue: 'READ_FAILED' })
    }
  }

  private async wait(): Promise<void> {
    const signal = this.lifetime.signal
    signal.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(new RoutingError('VERIFY_FAILED')) }
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, 150)
      signal.addEventListener('abort', abort, { once: true })
    })
  }

  async switchCurrent(): Promise<void> {
    if (this.disposed || this.state.busy) return
    const captured = this.sessions.getSnapshot()
    if (captured.kind !== 'available' || !this.state.catalog) { this.set({ issue: 'NO_CURRENT', success: null }); return }
    const original = captured.selection ?? this.state.catalog.default
    ++this.revision
    this.set({ busy: 'current', issue: null, success: null })
    try {
      const catalog = await this.catalog()
      const live = this.sessions.getSnapshot()
      if (live.kind !== 'available' || live.sessionId !== captured.sessionId || !sameRoute(live.selection ?? catalog.default, original)) {
        throw new RoutingError('SESSION_CHANGED')
      }
      const target = poolTarget(original, catalog)
      const response = object(await this.call('session/selectModel', { request: { sessionId: captured.sessionId, ...target } }))
      const selected = parseRouteSelection(response.selected)
      if (selected.provider !== target.provider || selected.model !== target.model
        || (target.reasoningEffort !== undefined && target.reasoningEffort !== selected.reasoningEffort)) throw new RoutingError('VERIFY_FAILED')
      let verified = false
      for (let attempt = 0; attempt < 4; attempt++) {
        await this.sessions.refresh(captured.sessionId)
        const current = this.sessions.getSnapshot()
        if (current.kind !== 'available' || current.sessionId !== captured.sessionId) throw new RoutingError('SESSION_CHANGED')
        if (current.selection && sameRoute(current.selection, selected)) { verified = true; break }
        await this.wait()
      }
      if (!verified) throw new RoutingError('VERIFY_FAILED')
      // selectModel saves the default in the background; display the read-back result only.
      this.set({ catalog: await this.catalog(), current: this.sessions.getSnapshot(), status: 'ready', success: 'current' })
    } catch (error) {
      this.set({ issue: error instanceof RoutingError ? error.issue : 'WRITE_FAILED' })
    } finally { this.set({ busy: null }) }
  }

  async setDefault(): Promise<void> {
    if (this.disposed || this.state.busy || !this.state.catalog) return
    const original = this.state.catalog.default
    ++this.revision
    this.set({ busy: 'default', issue: null, success: null })
    try {
      const catalog = await this.catalog()
      if (!sameRoute(catalog.default, original)) throw new RoutingError('CONFLICT')
      const target = poolTarget(original, catalog)
      const description = object(await this.call('settings/describe', {}))
      if (description.writable !== true || !Array.isArray(description.namespaces)) throw new RoutingError('WRITE_FAILED')
      const namespace = description.namespaces.map(object).find(row => row.ns === 'agent-default-model')
      if (!namespace || !Number.isSafeInteger(namespace.revision) || !sameRoute(parseRouteSelection(namespace.value), original)) {
        throw new RoutingError('CONFLICT')
      }
      await this.call('settings/update', { ns: 'agent-default-model', patch: target, expectedRevision: namespace.revision })
      let result: RoutingCatalog | undefined
      for (let attempt = 0; attempt < 4; attempt++) {
        result = await this.catalog()
        if (sameRoute(result.default, target)) break
        result = undefined
        await this.wait()
      }
      if (!result) throw new RoutingError('VERIFY_FAILED')
      this.set({ status: 'ready', catalog: result, current: this.sessions.getSnapshot(), success: 'default' })
    } catch (error) {
      this.set({ issue: error instanceof RoutingError ? error.issue : 'WRITE_FAILED' })
    } finally { this.set({ busy: null }) }
  }

  dispose(): void {
    this.disposed = true
    this.revision++
    this.lifetime.abort()
    this.releaseSource()
    this.listeners.clear()
  }
}

export function createRoutingController(connection: Connection, sessions: Sessions): RoutingController {
  return new RoutingController(connection, createRoutingSessionSource(sessions))
}
