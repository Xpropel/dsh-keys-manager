/** Owner-only Key Pool operations carried by Harness's existing IPC/Web gateway. */
import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { PoolError, type KeyPool, type PoolErrorCode } from './pool.ts'
import type { PoolSnapshot } from './types.ts'
import type {} from '@deepseek-ai/dsh-llm'

export const KEY_POOL_ENDPOINT = 'deepseekKeyPool/request'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'key-pool/validation': { reason: 'INVALID_INPUT' }
    'key-pool/operation': { reason: PoolErrorCode }
    'key-pool/forbidden': { reason: 'OWNER_REQUIRED' }
    'key-pool/internal': { reason: 'INTERNAL' }
  }
}

/** Validation messages contain field descriptions only, never user-supplied values. */
export class BridgeInputError extends Error {}

function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BridgeInputError('请求参数格式不正确。')
  }
  if (Object.keys(value).some(key => !allowed.includes(key))) {
    throw new BridgeInputError('请求包含不支持的参数。')
  }
  return value as Record<string, unknown>
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 100 || !/^[a-zA-Z0-9_-]+$/.test(value)) {
    throw new BridgeInputError('Key 标识不正确，请刷新列表。')
  }
  return value
}

/** Dispatch a validated request without exposing storage or provider error details. */
export async function dispatchPoolRequest(pool: KeyPool, action: unknown, payload: unknown): Promise<PoolSnapshot> {
  switch (action) {
    case 'snapshot': {
      object(payload, [])
      break
    }
    case 'importKeys': {
      const data = object(payload, ['keys'])
      if (!Array.isArray(data.keys) || data.keys.length < 1 || data.keys.length > 200) {
        throw new BridgeInputError('每次请输入 1 至 200 个 Key。')
      }
      const keys = data.keys.map(value => {
        const row = object(value, ['label', 'key'])
        if (typeof row.key !== 'string' || row.key.length > 512) {
          throw new BridgeInputError('Key 格式不正确。')
        }
        if (row.label !== undefined && (typeof row.label !== 'string' || row.label.length > 100)) {
          throw new BridgeInputError('名称最多为 100 个字符。')
        }
        return { key: row.key, ...(row.label === undefined ? {} : { label: row.label as string }) }
      })
      const imported = await pool.importKeys(keys)
      // Establish only new keys' baselines promptly; importing stays responsive.
      void pool.scheduleRefresh(imported.addedIds).catch(() => undefined)
      break
    }
    case 'remove': {
      const data = object(payload, ['id'])
      await pool.remove(identifier(data.id))
      break
    }
    case 'setActive': {
      const data = object(payload, ['id'])
      await pool.setActive(identifier(data.id))
      break
    }
    case 'setEnabled': {
      const data = object(payload, ['id', 'enabled'])
      if (typeof data.enabled !== 'boolean') throw new BridgeInputError('启用状态必须为布尔值。')
      await pool.setEnabled(identifier(data.id), data.enabled)
      break
    }
    case 'reorder': {
      const data = object(payload, ['ids'])
      if (!Array.isArray(data.ids) || data.ids.length > 10_000) throw new BridgeInputError('顺序列表格式不正确。')
      await pool.reorder(data.ids.map(identifier))
      break
    }
    case 'refresh': {
      const data = object(payload, ['id'])
      await pool.refresh(data.id === undefined ? undefined : identifier(data.id))
      break
    }
    case 'updateSettings': {
      const data = object(payload, ['autoSwitch', 'refreshIntervalSeconds'])
      if (data.autoSwitch !== undefined && typeof data.autoSwitch !== 'boolean') {
        throw new BridgeInputError('自动切换设置必须为布尔值。')
      }
      if (data.refreshIntervalSeconds !== undefined && (typeof data.refreshIntervalSeconds !== 'number' || !Number.isInteger(data.refreshIntervalSeconds))) {
        throw new BridgeInputError('刷新间隔必须为整数秒。')
      }
      await pool.updateSettings({
        ...(data.autoSwitch === undefined ? {} : { autoSwitch: data.autoSwitch as boolean }),
        ...(data.refreshIntervalSeconds === undefined ? {} : { refreshIntervalSeconds: data.refreshIntervalSeconds as number }),
      })
      break
    }
    default:
      throw new BridgeInputError('不支持此操作，请刷新插件页面。')
  }
  return pool.snapshot()
}

/** Service exported through Typert's documented source-marker dispatch. */
export class KeyPoolRemote extends TypertRemoteService {
  constructor(ctx: Context, private readonly pool: KeyPool) {
    super(ctx, 'deepseekKeyPool')
  }

  /** Both arguments deliberately retain their names in the unminified Host bundle. */
  @Remote
  async request(action: unknown, payload: unknown): Promise<PoolSnapshot> {
    const invocation = this.ctx.invocation
    if (invocation?.peer.principal.kind !== 'owner') {
      throw new RemoteError('key-pool/forbidden', '仅当前 Harness 的所有者可以管理 API Key。', { reason: 'OWNER_REQUIRED' })
    }
    try {
      invocation.signal.throwIfAborted()
      return await dispatchPoolRequest(this.pool, action, payload)
    } catch (error) {
      if (error instanceof BridgeInputError) {
        throw new RemoteError('key-pool/validation', error.message, { reason: 'INVALID_INPUT' })
      }
      if (error instanceof PoolError) {
        throw new RemoteError('key-pool/operation', error.message, { reason: error.code })
      }
      // Never echo a fetch response, credential-store value, or filesystem error.
      throw new RemoteError('key-pool/internal', '操作未完成，请检查 Key 和插件状态后重试。', { reason: 'INTERNAL' })
    } finally {
      // A removal can commit its metadata before credential cleanup reports a failure.
      if (action !== 'snapshot') this.ctx.emit('llm/adapters-updated')
    }
  }
}

/** Register one Host service; Cordis removes its endpoint when the plugin unloads. */
export function registerBridge(ctx: Context, pool: KeyPool): KeyPoolRemote {
  return new KeyPoolRemote(ctx, pool)
}
