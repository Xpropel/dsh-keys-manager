/** Best-effort request diagnostics: bounded, private, and restricted to safe fields. */
import { mkdir, open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

const MAX_ENTRIES = 100
const MAX_FILE_BYTES = 128_000
const LOCK_WAIT_MS = 250
const FLUSH_WAIT_MS = 1000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SESSION_ID = /^(?:session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const FAILURE_CODES = new Set([
  'TRANSPORT', 'TIMEOUT', 'ABORTED', 'RATE_LIMIT', 'SERVER', 'AUTH', 'QUOTA',
  'INVALID_REQUEST', 'CONTEXT_WINDOW_EXCEEDED', 'IMAGE_OFFLOAD_REQUIRED',
  'EMPTY_RESPONSE', 'STREAM_CLOSED', 'MALFORMED_RESPONSE',
  'KEY_POOL_REQUEST_ERROR', 'KEY_POOL_TLS_ERROR', 'KEY_POOL_ROTATE',
  'KEY_POOL_STATE_ERROR', 'KEY_POOL_UNAVAILABLE',
  'KEY_POOL_CONFIG_UNAVAILABLE', 'INVALID_CREDENTIAL', 'KEY_POOL_ROTATION_LIMIT', 'KEY_POOL_KEY_INVALID',
  'UNKNOWN',
])
/** Retain only the bounded HTTP_<three digits> shape; every other free-form code stays UNKNOWN. */
const HTTP_FAILURE_CODE = /^HTTP_[0-9]{3}$/
const ERROR_TYPES = new Set([
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'DOMException',
  'AbortError', 'TimeoutError', 'LlmError', 'Unknown',
])
const NETWORK_CODES = new Set([
  'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ENETUNREACH',
  'EHOSTUNREACH', 'ENETDOWN', 'EHOSTDOWN', 'EAI_AGAIN', 'ENOTFOUND',
  'ERR_STREAM_PREMATURE_CLOSE', 'UND_ERR_SOCKET', 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH',
  'ABORT_ERR', 'UND_ERR_ABORT', 'UND_ERR_ABORTED',
  'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
])

/** Raw messages, errors, headers and payloads deliberately have no place in this API. */
export interface RequestDiagnosticInput {
  requestId?: string
  sessionId?: string
  keyId?: string
  model?: string
  phase: 'before-output' | 'during-stream'
  code: string
  errorType: string
  networkCode?: string
  status?: number
  elapsedMs?: number
  receivedChunks?: number
}

export interface RequestDiagnostics {
  /** Returns immediately. A full queue drops its oldest uncommitted entries. */
  record(input: RequestDiagnosticInput): void
  /** Best-effort drain, bounded so plugin disposal cannot wait on diagnostics indefinitely. */
  flush(): Promise<void>
}

interface SafeEntry {
  at: number
  requestId?: string
  sessionId?: string
  keyId?: string
  model: 'deepseek-flash' | 'deepseek-v4-pro' | 'other'
  phase: 'before-output' | 'during-stream' | 'unknown'
  code: string
  errorType: string
  networkCode?: string
  status?: number
  elapsedMs?: number
  receivedChunks?: number
}

/** Never execute getters/toJSON on caller-controlled values, even for allowed fields. */
function own(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') return undefined
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor && 'value' in descriptor ? descriptor.value : undefined
  } catch { return undefined }
}

function identifier(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === 'string' && pattern.test(value) ? value.toLowerCase() : undefined
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
    ? Math.floor(value) : undefined
}

function allow(value: unknown, choices: Set<string>, fallback: string): string {
  return typeof value === 'string' && choices.has(value) ? value : fallback
}

/** Codes are an allow-list plus one bounded HTTP-shape exception; no arbitrary text reaches disk. */
function failureCode(value: unknown): string {
  if (typeof value !== 'string') return 'UNKNOWN'
  return FAILURE_CODES.has(value) || HTTP_FAILURE_CODE.test(value) ? value : 'UNKNOWN'
}

/** Re-applied when reading disk: older or externally added fields cannot survive a rewrite. */
function sanitize(input: unknown, at: number): SafeEntry {
  const model = own(input, 'model')
  const phase = own(input, 'phase')
  const requestId = identifier(own(input, 'requestId'), UUID)
  const sessionId = identifier(own(input, 'sessionId'), SESSION_ID)
  const keyId = identifier(own(input, 'keyId'), UUID)
  const networkCode = allow(own(input, 'networkCode'), NETWORK_CODES, '')
  const status = own(input, 'status')
  const elapsedMs = count(own(input, 'elapsedMs'))
  const receivedChunks = count(own(input, 'receivedChunks'))
  return {
    at,
    ...(requestId === undefined ? {} : { requestId }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(keyId === undefined ? {} : { keyId }),
    model: model === 'deepseek-flash' || model === 'deepseek-v4-pro' ? model : 'other',
    phase: phase === 'before-output' || phase === 'during-stream' ? phase : 'unknown',
    code: failureCode(own(input, 'code')),
    errorType: allow(own(input, 'errorType'), ERROR_TYPES, 'Unknown'),
    ...(networkCode ? { networkCode } : {}),
    ...(typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}),
    ...(elapsedMs === undefined ? {} : { elapsedMs }),
    ...(receivedChunks === undefined ? {} : { receivedChunks }),
  }
}

/** Use a fixed-size buffer; a pre-existing oversized or growing file cannot cause an unbounded read. */
async function readEntries(file: string): Promise<SafeEntry[]> {
  let handle
  try { handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)) }
  catch (error) {
    if (own(error, 'code') === 'ENOENT') return []
    throw error
  }
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile() || metadata.size > MAX_FILE_BYTES) throw new Error('Diagnostic file is unreadable.')
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, null)
      if (result.bytesRead === 0) break
      length += result.bytesRead
    }
    if (length > MAX_FILE_BYTES) throw new Error('Diagnostic file is too large.')
    const parsed: unknown = JSON.parse(buffer.toString('utf8', 0, length))
    const entries = own(parsed, 'entries')
    if (own(parsed, 'version') !== 1 || !Array.isArray(entries)) throw new Error('Diagnostic file has an unsupported format.')
    const safe: SafeEntry[] = []
    for (const entry of entries.slice(-MAX_ENTRIES)) {
      const at = count(own(entry, 'at'))
      if (at === undefined) throw new Error('Diagnostic entry has no valid timestamp.')
      safe.push(sanitize(entry, at))
    }
    return safe
  } finally { await handle.close() }
}

class FileRequestDiagnostics implements RequestDiagnostics {
  private pending: SafeEntry[] = []
  private writing: Promise<void> | undefined

  constructor(private readonly file: string) {}

  record(input: RequestDiagnosticInput): void {
    // Copy safe primitives now. Later changes to an input object cannot enter a queued write.
    this.pending.push(sanitize(input, Date.now()))
    if (this.pending.length > MAX_ENTRIES) this.pending.shift()
    this.start()
  }

  private start(): void {
    if (!this.writing) {
      // The microtask also coalesces a synchronous burst into one bounded batch.
      this.writing = Promise.resolve().then(() => this.drain()).finally(() => {
        this.writing = undefined
        // A record can arrive between drain's last queue check and this finalizer.
        if (this.pending.length > 0) this.start()
      })
    }
  }

  private async drain(): Promise<void> {
    while (this.pending.length > 0) {
      const batch = this.pending.splice(0)
      try {
        await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
        await withFileLock(this.file, async () => {
          const previous = await readEntries(this.file)
          // Commit order wins over timestamps, which may move backward or have been externally edited.
          const entries = [...previous, ...batch].slice(-MAX_ENTRIES)
          await writeFileAtomic(this.file, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
        }, { waitMs: LOCK_WAIT_MS })
      } catch {
        // Storage/locking failures never replace a model result. Corrupt files are left intact.
        // This batch is dropped rather than retained forever or retried in a hot loop.
      }
    }
  }

  async flush(): Promise<void> {
    if (!this.writing) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const settled = async () => { while (this.writing) await this.writing }
      await Promise.race([settled(), new Promise<void>(resolve => { timer = setTimeout(resolve, FLUSH_WAIT_MS) })])
    } finally { if (timer) clearTimeout(timer) }
  }
}

/** No reads or writes occur until record() receives a failure. */
export function createRequestDiagnostics(filePath = join(resolveDshHome(), 'plugins', 'deepseek-key-pool', 'request-errors.json')): RequestDiagnostics {
  return new FileRequestDiagnostics(filePath)
}
