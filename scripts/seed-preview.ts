/** Synthetic balance history for visual QA in a brand-new isolated Harness home. */
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
let amount: string | null = '10.0000'
const pool = new KeyPool({
  credentials: createCredentialStore(ctx.credentials), metadata: createMetadataStore(file),
  fetch: async () => new Response(JSON.stringify({
    is_available: amount !== null,
    balance_infos: amount === null ? [] : [{ currency: 'CNY', total_balance: amount }],
  })),
})
try {
  await pool.init()
  await pool.updateSettings({ refreshIntervalSeconds: 0 })
  const { addedIds: ids } = await pool.importKeys([
    { label: '演示 Key A', key: 'test-credential-preview-key-aaaa' },
    { label: '演示 Key B', key: 'test-credential-preview-key-bbbb' },
    { label: '演示 Key C', key: 'test-credential-preview-key-cccc' },
  ])
  for (const value of ['10.0000', '7.2000', '12.2000', '11.9000']) { amount = value; await pool.refresh(ids[0]) }
  amount = '8.3000'; await pool.refresh(ids[1])
  amount = '0.0200'; await pool.refresh(ids[2]); amount = null; await pool.refresh(ids[2])
  console.log('Created synthetic UI fixture: A 11.9000 remaining, 3.1000 consumed, 5.0000 added.')
} finally { pool.stop(); await ctx.fiber.dispose() }
