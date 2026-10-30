/** Diagnostic inspection only; never substitutes an error or decides model-request retries. */
import { types as nodeTypes } from 'node:util'

export type NativeFailureCode = 'TRANSPORT' | 'TIMEOUT' | 'ABORTED' | 'KEY_POOL_TLS_ERROR' | 'KEY_POOL_REQUEST_ERROR'
export interface NativeRequestFailure {
  code: NativeFailureCode
  message: string
  errorType: string
  networkCode?: string
}

const transportCodes = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH',
  'ENETDOWN', 'EHOSTDOWN', 'EAI_AGAIN', 'ENOTFOUND', 'ERR_STREAM_PREMATURE_CLOSE',
  'UND_ERR_SOCKET', 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH',
])
const timeoutCodes = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'])
const abortCodes = new Set(['ABORT_ERR', 'UND_ERR_ABORT', 'UND_ERR_ABORTED'])
const tlsCodes = new Set([
  'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
])
const messages: Record<NativeFailureCode, string> = {
  TRANSPORT: '与 DeepSeek 的连接中断或暂时无法建立连接。',
  TIMEOUT: 'DeepSeek 请求连接或响应等待超时。',
  ABORTED: '模型请求已取消。',
  KEY_POOL_TLS_ERROR: '与 DeepSeek 的安全连接验证失败，请检查系统时间和证书配置。',
  KEY_POOL_REQUEST_ERROR: '模型请求处理发生异常，请查看插件的脱敏诊断记录。',
}
const domName = Object.getOwnPropertyDescriptor(DOMException.prototype, 'name')?.get

function inspectable(value: unknown): value is object {
  return value !== null && typeof value === 'object' && !nodeTypes.isProxy(value)
}

function ownData(value: object, field: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, field)
  return descriptor && 'value' in descriptor ? descriptor.value : undefined
}

/** Unlike instanceof, this does not invoke a Proxy hidden anywhere in the prototype chain. */
export function hasSafePrototype(value: unknown, prototype: object): boolean {
  try {
    let current = value
    for (let depth = 0; depth < 8 && inspectable(current); depth++) {
      current = Object.getPrototypeOf(current)
      if (!inspectable(current)) return false
      if (current === prototype) return true
    }
  } catch { /* Unknown objects are not evidence of a trusted error class. */ }
  return false
}

function nativeDomName(value: object): string | undefined {
  if (!hasSafePrototype(value, DOMException.prototype)) return undefined
  try { return domName?.call(value) }
  catch { return undefined }
}

/** Diagnostic type is an enum; an arbitrary error.name never reaches disk or the UI. */
export function safeRequestErrorType(value: unknown): string {
  if (!inspectable(value)) return 'Unknown'
  const dom = nativeDomName(value)
  if (dom !== undefined) return dom === 'AbortError' || dom === 'TimeoutError' ? dom : 'DOMException'
  if (hasSafePrototype(value, TypeError.prototype)) return 'TypeError'
  if (hasSafePrototype(value, RangeError.prototype)) return 'RangeError'
  if (hasSafePrototype(value, SyntaxError.prototype)) return 'SyntaxError'
  if (hasSafePrototype(value, Error.prototype)) return 'Error'
  return 'Unknown'
}

type KnownFailure = { code: Exclude<NativeFailureCode, 'KEY_POOL_REQUEST_ERROR'>; networkCode?: string }

/** Extract a bounded diagnostic category; the official adapter alone decides the actual failure and retry policy. */
export function classifyNativeRequestError(error: unknown, signal?: AbortSignal): NativeRequestFailure {
  const errorType = safeRequestErrorType(error)
  if (signal?.aborted) return { code: 'ABORTED', message: messages.ABORTED, errorType }
  const seen = new Set<object>()
  let visited = 0
  const visit = (value: unknown, depth: number): KnownFailure | undefined => {
    if (!inspectable(value) || depth > 6 || visited >= 32 || seen.has(value)) return undefined
    seen.add(value); visited++
    const code = ownData(value, 'code')
    if (typeof code === 'string') {
      if (timeoutCodes.has(code)) return { code: 'TIMEOUT', networkCode: code }
      if (transportCodes.has(code)) return { code: 'TRANSPORT', networkCode: code }
      if (abortCodes.has(code)) return { code: 'ABORTED', networkCode: code }
      if (tlsCodes.has(code)) return { code: 'KEY_POOL_TLS_ERROR', networkCode: code }
    }
    const dom = nativeDomName(value)
    if (dom === 'TimeoutError') return { code: 'TIMEOUT' }
    if (dom === 'AbortError') return { code: 'ABORTED' }
    const cause = ownData(value, 'cause')
    // An explicit cause takes precedence over aggregate members. An unrelated cause
    // cannot be hidden by a network-looking member and accidentally enable retries.
    if (cause !== undefined) return visit(cause, depth + 1)
    // Node's multi-address connect can wrap several system errors. Mixed or truncated
    // aggregates remain unknown, rather than retrying an unrelated local exception.
    const errors = ownData(value, 'errors')
    if (!inspectable(errors) || !Array.isArray(errors)) return undefined
    const length = ownData(errors, 'length')
    if (typeof length !== 'number' || length < 1 || length > 8) return undefined
    const failures: KnownFailure[] = []
    for (let index = 0; index < length; index++) {
      const failure = visit(ownData(errors, String(index)), depth + 1)
      if (!failure) return undefined
      failures.push(failure)
    }
    const first = failures[0]!
    if (failures.every(failure => failure.code === first.code)) return first
    if (failures.every(failure => failure.code === 'TRANSPORT' || failure.code === 'TIMEOUT')) {
      return failures.find(failure => failure.code === 'TRANSPORT')!
    }
    return undefined
  }
  let failure: KnownFailure | undefined
  try { failure = visit(error, 0) } catch { /* Diagnostics must never replace the original failure with an inspection error. */ }
  const code = failure?.code ?? 'KEY_POOL_REQUEST_ERROR'
  return { code, message: messages[code], errorType, ...(failure?.networkCode ? { networkCode: failure.networkCode } : {}) }
}
