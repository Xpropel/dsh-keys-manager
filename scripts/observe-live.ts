/** Read-only observer for an explicitly selected isolated real-API test home. */
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { parseBalance } from '../src/balance.ts'
import type { PoolMetadata } from '../src/types.ts'

const testHome = process.env.KEY_POOL_TEST_HOME
if (!testHome || !testHome.startsWith('/tmp/dsh-key-pool-')) {
  throw new Error('Set KEY_POOL_TEST_HOME to the explicitly authorized isolated test directory.')
}
const ctx = new Context()
await ctx.plugin(LocalCredentialProvider, { path: join(testHome, '.credentials.yaml'), watch: false })
try {
  const metadata = JSON.parse(await readFile(join(testHome, 'plugins/deepseek-key-pool/state.json'), 'utf8')) as PoolMetadata
  const keys = metadata.keys.filter(key => /^真实测试 [ABC]$/.test(key.label))
  const balances = []
  for (const entry of keys) {
    const hit = await ctx.credentials.resolve(credentialRef(entry.credentialRef))
    if (!hit) { balances.push({ label: entry.label, error: 'credential unavailable' }); continue }
    try {
      const response = await fetch('https://api.deepseek.com/user/balance', {
        headers: { Authorization: `Bearer ${hit.value}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(12_000), redirect: 'error',
      })
      const result = response.ok ? parseBalance(await response.json()) : null
      balances.push({ label: entry.label, httpStatus: response.status,
        actualCny: result?.balanceCny ?? null, actualAvailable: result?.available ?? null,
        cachedCny: entry.balanceCny, poolStatus: entry.status, enabled: entry.enabled,
        lastError: entry.lastError,
      })
    } catch { balances.push({ label: entry.label, error: 'balance query failed' }) }
  }
  const observation = { observedAt: new Date().toISOString(),
    activeKey: metadata.keys.find(key => key.id === metadata.activeId)?.label ?? null,
    settings: metadata.settings, balances,
  }
  const directory = resolve('artifacts')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'latest-live-observation.json'), `${JSON.stringify(observation, null, 2)}\n`)
  await appendFile(join(directory, 'live-observations.jsonl'), `${JSON.stringify(observation)}\n`)
  console.log(JSON.stringify(observation, null, 2))
} finally { await ctx.fiber.dispose() }
