import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-credentials'
import { KeyPool } from './pool.ts'
import { createCredentialStore, createMetadataStore } from './persistence.ts'
import { registerBridge } from './bridge.ts'
import { registerPoolProvider } from './provider.ts'

export const name = 'deepseek-key-pool'
export const inject = ['llm', 'credentials']
export const Config = z.object({})

/** The plugin owns its pool, provider route, RPC service and background refresh lifetime. */
export async function apply(ctx: Context): Promise<void> {
  const pool = new KeyPool({
    credentials: createCredentialStore(ctx.credentials),
    metadata: createMetadataStore(),
  })
  ctx.effect(() => () => pool.stop(), 'key-pool: stop refresh and abort pending checks')
  await pool.init()
  registerBridge(ctx, pool)
  registerPoolProvider(ctx, pool)
}
