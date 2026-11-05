/** Private, atomic metadata persistence and Harness-owned credential references. */
import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { credentialRef, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { CredentialStore, MetadataStore, PoolMetadata, StoredPoolMetadata } from './types.ts'

const MAX_METADATA_BYTES = 2_000_000

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

function digest(text: string | undefined): string | undefined {
  return text === undefined ? undefined : createHash('sha256').update(text).digest('hex')
}

/** Metadata contains labels, refs, balances, and settings only; never secret values. */
class FileMetadataStore implements MetadataStore {
  private revision: string | undefined
  private loaded = false

  constructor(private readonly filePath: string) {}

  private async read(): Promise<string | undefined> {
    try {
      const contents = await readFile(this.filePath, 'utf8')
      if (Buffer.byteLength(contents, 'utf8') > MAX_METADATA_BYTES) throw new Error('Key 池数据文件过大，未读取。')
      return contents
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined
      throw new Error('无法读取 Key 池数据文件。')
    }
  }

  private get backupPath(): string { return `${this.filePath}.bak` }

  /** A recovery copy is best-effort: failing to write it must never block a successful load. */
  private async writeBackup(contents: string): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
      await writeFileAtomic(this.backupPath, contents, { mode: 0o600, dirMode: 0o700 })
    } catch { /* Recovery convenience only; the authoritative file is already intact. */ }
  }

  async load(): Promise<StoredPoolMetadata | undefined> {
    this.loaded = false
    const contents = await this.read()
    if (contents === undefined) {
      this.revision = undefined
      this.loaded = true
      return undefined
    }
    let parsed: unknown
    try { parsed = JSON.parse(contents) }
    catch {
      // Never overwrite the damaged file or a previously good backup with unparsable contents.
      throw new Error(`Key 池数据文件格式损坏（${this.filePath}）；原文件已保留，可从备份 ${this.backupPath} 恢复：请先移走损坏文件再重新加载。`)
    }
    this.revision = digest(contents)
    this.loaded = true
    await this.writeBackup(contents)
    // The domain validates the complete schema before using or writing this value.
    return parsed as StoredPoolMetadata
  }

  async save(metadata: PoolMetadata): Promise<void> {
    if (!this.loaded) throw new Error('Key 池数据尚未初始化。')
    const encoded = `${JSON.stringify(metadata, null, 2)}\n`
    if (Buffer.byteLength(encoded, 'utf8') > MAX_METADATA_BYTES) {
      throw new Error('Key 池数据已达到容量上限，请减少 Key 数量后重试。')
    }
    const directory = dirname(this.filePath)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await withFileLock(this.filePath, async () => {
      const current = await this.read()
      if (digest(current) !== this.revision) {
        throw new Error('另一实例修改了 Key 池数据；请重新加载插件后重试。')
      }
      await writeFileAtomic(this.filePath, encoded, { mode: 0o600, dirMode: 0o700 })
      this.revision = digest(encoded)
    }, { waitMs: 3000 })
  }
}

/** Default state lives beside Harness credentials, but in the plugin's own directory. */
export function createMetadataStore(filePath = join(resolveDshHome(), 'plugins', 'deepseek-key-pool', 'state.json')): MetadataStore {
  return new FileMetadataStore(filePath)
}

/** Resolve current secret values per request; leave all secret persistence to Harness. */
export function createCredentialStore(credentials: CredentialProvider): CredentialStore {
  return {
    async resolve(ref) { return (await credentials.resolve(credentialRef(ref)))?.value },
    async set(ref, value) { await credentials.set(credentialRef(ref), value) },
    async unset(ref) { await credentials.unset(credentialRef(ref)) },
  }
}
