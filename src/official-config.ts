/** Read the official API-key provider's live settings without owning or rewriting them. */
import type { Context } from '@deepseek-ai/cordis'
import { LlmError } from '@deepseek-ai/dsh-llm'
import * as OfficialApiKey from '@deepseek-ai/dsh-llm-deepseek-api-key'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-config-editor'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-app-boot'

const OFFICIAL_PROVIDER = 'deepseek-official'
const OFFICIAL_MODULE = '@deepseek-ai/dsh-llm-deepseek-api-key'
const UNAVAILABLE = '官方 DeepSeek API 提供方的配置暂不可用，请检查该提供方是否已启用。'

export interface OfficialConnectionSource {
  get(): OfficialApiKey.ResolvedDeepSeekOptions
  subscribe(listener: () => void): () => void
}

interface Snapshot {
  options: OfficialApiKey.ResolvedDeepSeekOptions
  owner?: Context
  identity: object | string
}

/** Resolve defaults through the actual official schema, including its volatile defaults. */
function normalized(input: OfficialApiKey.Options): OfficialApiKey.Options {
  const result = OfficialApiKey.Config['~standard'].validate(input)
  if ('then' in result || result.issues) throw unavailable()
  return OfficialApiKey.plainOptions(result.value as OfficialApiKey.Config)
}

function section(value: unknown, path: readonly string[]): unknown {
  for (const key of path) {
    if (value === null || typeof value !== 'object') return undefined
    value = Reflect.get(value, key)
  }
  return value
}

function unavailable(): LlmError {
  return new LlmError(UNAVAILABLE, 'KEY_POOL_CONFIG_UNAVAILABLE')
}

/**
 * Prefer the registered official route's namespace and its validated live Config.
 * The override is for isolated transport tests, not a second production configuration.
 */
export function createOfficialConnectionSource(
  ctx: Context,
  overrideOptions?: () => OfficialApiKey.Options,
): OfficialConnectionSource {
  let knownNamespace: string | undefined
  let knownOfficialSource = false
  let lastPath: readonly string[] = []
  const listeners = new Set<() => void>()
  const identities = new WeakMap<object, number>()
  let nextIdentity = 1
  let lastFingerprint: string | undefined
  let scheduled = false
  let inspecting = false
  let owner: Context | undefined
  let releaseOwner: (() => unknown) | undefined
  let releases: Array<() => unknown> = []

  const read = (): Snapshot => {
    if (overrideOptions) return {
      options: OfficialApiKey.resolveAdapterOptions(normalized(overrideOptions()), launchEnvironmentOf(ctx)),
      identity: 'override',
    }

    const llm = ctx.get('llm')
    const route = llm?.listConfigurableProviders().find(item => item.provider === OFFICIAL_PROVIDER)
    if (route) {
      knownOfficialSource = true
      knownNamespace = route.settingsNs
      lastPath = route.settingsPath
    }

    const editor = ctx.get('configEditor')
    const loader = ctx.get('loader')
    const settings = ctx.get('settings')
    const entries = [...new Set<Entry>([
      ...(editor?.entries() ?? []),
      ...(loader ? [...loader.entries()] : []),
    ])]
    let selected = knownNamespace === undefined ? undefined
      : entries.find(entry => entry.options.id === knownNamespace)

    if (!selected && knownNamespace === undefined) {
      const official = entries.filter(entry => entry.options.name === OFFICIAL_MODULE
        || entry.options.name === 'llm-deepseek-api-key')
      if (official.length > 1) throw unavailable()
      if (official.length === 1) {
        selected = official[0]!
        knownNamespace = selected.options.id
        knownOfficialSource = true
      }
    }

    if (selected) {
      knownOfficialSource = true
      const fiber = selected.fiber
      // LOADING already owns a schema-validated Config; waiting for ACTIVE here can
      // miss the provider's registration event during the same startup turn.
      if (selected.disabled || !fiber || (fiber.state !== 1 && fiber.state !== 2)) throw unavailable()
      // Cordis 4.1 keeps raw input in config. Read the same validated live
      // values its plugin received, including the volatile settings references.
      const liveConfig = 'effectiveConfig' in fiber ? fiber.effectiveConfig : fiber.config
      const config = section(liveConfig, lastPath)
      if (config === undefined || config === null) throw unavailable()
      return {
        options: OfficialApiKey.resolveAdapterOptions(
          OfficialApiKey.plainOptions(config as OfficialApiKey.Config), launchEnvironmentOf(fiber.ctx),
        ),
        owner: fiber.ctx,
        identity: fiber,
      }
    }

    if (knownNamespace !== undefined) {
      // Some supported hosts expose SettingsForms but not editable Loader entries.
      const descriptor = settings?.describe({ redactSecrets: true }).find(item => item.ns === knownNamespace)
      if (!descriptor) throw unavailable()
      const value = section(descriptor.value, lastPath)
      if (value === null || typeof value !== 'object') throw unavailable()
      return {
        options: OfficialApiKey.resolveAdapterOptions(normalized(value as OfficialApiKey.Options), launchEnvironmentOf(ctx)),
        identity: `settings:${knownNamespace}`,
      }
    }

    // SDK-only consumers have no configured official instance to follow. A product
    // host with a configuration directory must not silently use unrelated defaults.
    if (knownOfficialSource || editor || loader || settings) throw unavailable()
    return {
      options: OfficialApiKey.resolveAdapterOptions(normalized({}), launchEnvironmentOf(ctx)),
      identity: 'sdk-defaults',
    }
  }

  const get = (): OfficialApiKey.ResolvedDeepSeekOptions => {
    try { return read().options }
    catch { throw unavailable() }
  }

  const identityOf = (value: object | string): string | number => {
    if (typeof value === 'string') return value
    let id = identities.get(value)
    if (id === undefined) { id = nextIdentity++; identities.set(value, id) }
    return id
  }

  const inspect = (): { fingerprint: string; owner?: Context } => {
    inspecting = true
    try {
      const current = read()
      return {
        fingerprint: JSON.stringify([identityOf(current.identity), knownNamespace, current.options]),
        ...(current.owner ? { owner: current.owner } : {}),
      }
    } catch {
      return { fingerprint: JSON.stringify(['unavailable', knownNamespace]) }
    } finally { inspecting = false }
  }

  const bindOwner = (next: Context | undefined): void => {
    if (owner === next) return
    releaseOwner?.(); releaseOwner = undefined
    owner = next
    if (next) {
      // Volatile commits are deliberately scoped to the official fiber. Bind there
      // as well as the global lifecycle watches, and rebind after every remount.
      try { releaseOwner = next.on('loader/volatile-update', schedule) } catch { /* Remount races are observed globally. */ }
    }
  }

  function schedule(): void {
    if (scheduled || inspecting || listeners.size === 0) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      if (listeners.size === 0) return
      const current = inspect()
      bindOwner(current.owner)
      if (current.fingerprint === lastFingerprint) return
      lastFingerprint = current.fingerprint
      // Commit the observation before callbacks; a callback may publish adapter
      // changes or read settings, both of which can synchronously emit more events.
      for (const listener of [...listeners]) {
        try { listener() } catch { /* Observers cannot prevent other observers from seeing a live change. */ }
      }
    })
  }

  const start = (): void => {
    const global = { global: true }
    releases = [
      ctx.on('loader/volatile-update', schedule, global),
      ctx.on('loader/config-update', schedule, global),
      ctx.on('loader/entry-init', schedule, global),
      ctx.on('loader/partial-dispose', schedule, global),
      ctx.on('settings/document-updated', schedule, global),
      ctx.on('llm/adapters-updated', schedule, global),
      // Both service availability and plugin remounts can precede a route event.
      ctx.on('internal/service', schedule, global),
      ctx.on('internal/status', schedule, global),
    ]
    // The event is supplied by product hosts but absent in small SDK compositions.
    releases.push(ctx.on('app-boot/config-reload', schedule, global))
    const current = inspect()
    lastFingerprint = current.fingerprint
    bindOwner(current.owner)
  }

  return {
    get,
    subscribe(listener) {
      const first = listeners.size === 0
      listeners.add(listener)
      if (first) start()
      let active = true
      return () => {
        if (!active) return
        active = false
        listeners.delete(listener)
        if (listeners.size === 0) {
          for (const release of releases) release()
          releases = []
          bindOwner(undefined)
          lastFingerprint = undefined
        }
      }
    },
  }
}
