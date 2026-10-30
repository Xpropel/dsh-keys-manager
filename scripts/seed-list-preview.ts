/** Synthetic large pool for scroll/position QA; never contacts the balance API. */
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { KeyPool } from '../src/pool.ts'
import { createCredentialStore, createMetadataStore } from '../src/persistence.ts'

const directory = process.env.KEY_POOL_DEMO_HOME
if (!directory?.startsWith('/tmp/dsh-key-pool-')) throw new Error('Use a fresh /tmp/dsh-key-pool-* demo directory.')
const file = join(directory, 'plugins/deepseek-key-pool/state.json')
try { await access(file); throw new Error('A pool already exists; refusing to replace it.') }
catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }

const ctx = new Context()
await ctx.plugin(LocalCredentialProvider, { path: join(directory, '.credentials.yaml'), watch: false })
let amount = '10.0000'
const pool = new KeyPool({
  credentials: createCredentialStore(ctx.credentials), metadata: createMetadataStore(file),
  fetch: async () => new Response(JSON.stringify({
    is_available: true, balance_infos: [{ currency: 'CNY', total_balance: amount }],
  })),
})
try {
  await pool.init()
  await pool.updateSettings({ refreshIntervalSeconds: 0 })
  const entries = Array.from({ length: 248 }, (_, index) => ({
    label: `演示 Key ${String(index + 1).padStart(3, '0')}`,
    key: `sk-synthetic-list-preview-${String(index + 1).padStart(4, '0')}`,
  }))
  const first = await pool.importKeys(entries.slice(0, 200))
  const second = await pool.importKeys(entries.slice(200))
  const ids = [...first.addedIds, ...second.addedIds]
  await pool.refresh()
  amount = '8.8800'
  await pool.refresh(ids[136])
  await pool.setActive(ids[136]!)
  console.log('Created 248 synthetic keys with Key 137 active; automatic API polling is disabled.')
} finally { pool.stop(); await ctx.fiber.dispose() }
