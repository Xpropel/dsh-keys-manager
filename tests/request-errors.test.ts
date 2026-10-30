import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyNativeRequestError, safeRequestErrorType } from '../src/request-errors.ts'

const secret = 'synthetic-secret-never-log-this'
const systemError = (code: string) => Object.assign(new Error(secret), { code })

test('native fetch cause codes retain transport classification without carrying error text', () => {
  for (const code of ['UND_ERR_SOCKET', 'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'ERR_STREAM_PREMATURE_CLOSE', 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH']) {
    const original = new TypeError(secret, { cause: systemError(code) })
    const mapped = classifyNativeRequestError(original)
    assert.equal(mapped.code, 'TRANSPORT')
    assert.equal(mapped.networkCode, code)
    assert.equal(mapped.errorType, 'TypeError')
    assert.equal(JSON.stringify(mapped).includes(secret), false)
    assert.equal('cause' in mapped, false)
  }
})

test('connection and body timeouts are distinct from cancellation', () => {
  for (const code of ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']) {
    assert.equal(classifyNativeRequestError(new TypeError(secret, { cause: systemError(code) })).code, 'TIMEOUT')
  }
  assert.equal(classifyNativeRequestError(new DOMException(secret, 'TimeoutError')).code, 'TIMEOUT')
  assert.equal(classifyNativeRequestError(new DOMException(secret, 'AbortError')).code, 'ABORTED')
  for (const code of ['ABORT_ERR', 'UND_ERR_ABORT', 'UND_ERR_ABORTED']) {
    assert.equal(classifyNativeRequestError(systemError(code)).code, 'ABORTED')
  }
  const controller = new AbortController()
  controller.abort(secret)
  assert.equal(classifyNativeRequestError(systemError('ECONNRESET'), controller.signal).code, 'ABORTED')
})

test('certificate failures are actionable without becoming retryable transport failures', () => {
  for (const code of ['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']) {
    const mapped = classifyNativeRequestError(new TypeError(secret, { cause: systemError(code) }))
    assert.equal(mapped.code, 'KEY_POOL_TLS_ERROR')
    assert.equal(mapped.networkCode, code)
    assert.match(mapped.message, /证书/)
  }
})

test('generic TypeError, messages and broad undici prefixes are not network evidence', () => {
  for (const original of [
    new TypeError('fetch failed'), new TypeError('terminated'), new RangeError('timeout'),
    systemError('UND_ERR_INVALID_ARG'), systemError('UND_ERR_REQ_CONTENT_LENGTH_MISMATCH'),
    systemError('UND_ERR_HEADERS_OVERFLOW'), systemError('UND_ERR_DESTROYED'), systemError('UND_ERR_CLOSED'),
    systemError('UND_ERR_SOCKET_' + secret), { name: 'AbortError', message: secret }, secret, null,
  ]) {
    const mapped = classifyNativeRequestError(original)
    assert.equal(mapped.code, 'KEY_POOL_REQUEST_ERROR')
    assert.equal(mapped.networkCode, undefined)
    assert.doesNotMatch(mapped.message, /网络/)
    assert.equal(JSON.stringify(mapped).includes(secret), false)
  }
})

test('multi-address network aggregates are classified but mixed local errors are not retried', () => {
  const wrapped = new TypeError(secret, { cause: new AggregateError([systemError('ECONNREFUSED'), systemError('ENETUNREACH')], secret) })
  assert.equal(classifyNativeRequestError(wrapped).code, 'TRANSPORT')
  assert.equal(classifyNativeRequestError(new AggregateError([systemError('ETIMEDOUT'), systemError('ECONNRESET')])).code, 'TRANSPORT')
  assert.equal(classifyNativeRequestError(new AggregateError([systemError('ECONNRESET'), new TypeError(secret)])).code, 'KEY_POOL_REQUEST_ERROR')
  assert.equal(classifyNativeRequestError(new AggregateError(Array.from({ length: 9 }, () => systemError('ECONNRESET')))).code, 'KEY_POOL_REQUEST_ERROR')
  assert.equal(classifyNativeRequestError(new AggregateError([systemError('ECONNRESET')], secret, { cause: new Error(secret) })).code, 'KEY_POOL_REQUEST_ERROR')
})

test('cause traversal is bounded and never invokes getters, iterators or proxy traps', () => {
  let touched = 0
  const object = Object.defineProperties({}, Object.fromEntries(['code', 'cause', 'errors', 'message', 'stack', 'name'].map(key => [key, { get() { touched++; throw new Error(secret) } }])))
  assert.equal(classifyNativeRequestError(object).code, 'KEY_POOL_REQUEST_ERROR')
  const array = [systemError('ECONNRESET')]
  Object.defineProperty(array, '0', { get() { touched++; throw new Error(secret) } })
  assert.equal(classifyNativeRequestError(new AggregateError([]), undefined).code, 'KEY_POOL_REQUEST_ERROR')
  assert.equal(classifyNativeRequestError({ errors: array }).code, 'KEY_POOL_REQUEST_ERROR')
  const proxy = new Proxy({}, { get() { touched++; throw new Error(secret) }, getOwnPropertyDescriptor() { touched++; throw new Error(secret) }, getPrototypeOf() { touched++; throw new Error(secret) } })
  assert.equal(classifyNativeRequestError(proxy).code, 'KEY_POOL_REQUEST_ERROR')
  const hiddenProxy = Object.create(new Proxy(Error.prototype, { getPrototypeOf() { touched++; throw new Error(secret) } }))
  assert.equal(classifyNativeRequestError(hiddenProxy).code, 'KEY_POOL_REQUEST_ERROR')
  const cycle: { cause?: unknown } = {}; cycle.cause = cycle
  assert.equal(classifyNativeRequestError(cycle).code, 'KEY_POOL_REQUEST_ERROR')
  let deep: unknown = systemError('ECONNRESET')
  for (let i = 0; i < 100; i++) deep = { cause: deep }
  assert.equal(classifyNativeRequestError(deep).code, 'KEY_POOL_REQUEST_ERROR')
  assert.equal(touched, 0)
})

test('diagnostic names come from known native types, not error.name', () => {
  const error = new Error(secret); error.name = secret
  assert.equal(safeRequestErrorType(error), 'Error')
  assert.equal(safeRequestErrorType(new TypeError(secret)), 'TypeError')
  assert.equal(safeRequestErrorType(new DOMException(secret, 'SecurityError')), 'DOMException')
  const dom = new DOMException(secret, 'TimeoutError')
  Object.defineProperty(dom, 'name', { get() { throw new Error(secret) } })
  assert.equal(classifyNativeRequestError(dom).code, 'TIMEOUT')
})
