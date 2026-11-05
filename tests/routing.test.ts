import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { RoutingController, poolTarget, parseRoutingCatalog, type CurrentRoute, type RouteSelection, type RoutingSessionSource } from '../src/client/routing.ts'
import { RoutingStatus } from '../src/client/Routing.tsx'
import { en, type Translate } from '../src/client/locales.ts'

const original: RouteSelection = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' }
const target: RouteSelection = { ...original, provider: 'deepseek-key-pool' }
const translateEn: Translate = (key, params) => en[key].replace(/\{(\w+)\}/g, (match, name: string) => String(params?.[name] ?? match))

function fixture() {
  let defaultSelection = { ...original }
  let current: CurrentRoute = { kind: 'available', sessionId: 'session-a', selection: { ...original } }
  let pending: RouteSelection | undefined
  let revision = 7
  let poolModels = ['deepseek-flash']
  let efforts = ['high', 'max']
  let beforeCatalog: (() => void) | undefined
  let conflict = false
  let projectSelection = true
  const listeners = new Set<() => void>()
  const calls: Array<{ endpoint: string; args: Record<string, unknown> }> = []
  const source: RoutingSessionSource = {
    getSnapshot: () => current,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    async refresh() {
      if (pending && projectSelection && current.kind === 'available') {
        current = { ...current, selection: pending }
        for (const listener of listeners) listener()
      }
    },
  }
  const call: ConnectionHandle['rpc']['call'] = async (_channel, endpoint, payload) => {
    const { args } = payload as { args: Record<string, unknown> }
    calls.push({ endpoint, args })
    if (endpoint === 'session/modelCatalog') {
      beforeCatalog?.()
      return { ok: true, value: {
        default: { ...defaultSelection }, groups: [
          { id: 'deepseek-official', models: [{ id: 'deepseek-flash', reasoning: { defaultEffort: 'max', efforts: [{ id: 'high' }, { id: 'max' }] } }] },
          { id: 'deepseek-key-pool', models: poolModels.map(id => ({ id, reasoning: { efforts: efforts.map(id => ({ id })) } })) },
        ],
      } }
    }
    if (endpoint === 'settings/describe') return { ok: true, value: {
      writable: true, namespaces: [{ ns: 'agent-default-model', revision, value: { ...defaultSelection } }],
    } }
    if (endpoint === 'settings/update') {
      if (conflict) return { ok: false, error: { code: 'settings/conflict', message: 'untrusted body test-credential-do-not-print', details: {} } }
      assert.equal(args.expectedRevision, revision)
      defaultSelection = { ...(args.patch as RouteSelection) }
      revision++
      return { ok: true, value: {} }
    }
    if (endpoint === 'session/selectModel') {
      const request = args.request as RouteSelection & { sessionId: string }
      assert.equal(request.sessionId, 'session-a')
      pending = { provider: request.provider, model: request.model, reasoningEffort: request.reasoningEffort }
      return { ok: true, value: { selected: pending } }
    }
    throw new Error(`Unexpected test endpoint: ${endpoint}`)
  }
  const controller = new RoutingController({ rpc: { call } }, source)
  return {
    controller, calls,
    setCurrent(value: CurrentRoute) { current = value; for (const listener of listeners) listener() },
    setPoolModels(value: string[]) { poolModels = value },
    setEfforts(value: string[]) { efforts = value },
    setBeforeCatalog(value: () => void) { beforeCatalog = value },
    setConflict() { conflict = true },
    disableProjection() { projectSelection = false },
  }
}

test('route reads expose bypass status without changing any settings', async () => {
  const f = fixture()
  try {
    await f.controller.refresh()
    assert.equal(f.controller.getSnapshot().catalog?.default.provider, 'deepseek-official')
    assert.deepEqual(f.calls.map(call => call.endpoint), ['session/modelCatalog'])
    const html = renderToStaticMarkup(createElement(RoutingStatus, { controller: f.controller }))
    assert.match(html, /未经过 Key 池/)
    assert.match(html, /当前会话切到 Key 池/)
    assert.match(html, /设为默认/)
  } finally { f.controller.dispose() }
})

test('current conversation changes use the official API and verify the projection', async () => {
  const f = fixture()
  try {
    await f.controller.refresh()
    await f.controller.switchCurrent()
    assert.deepEqual(f.calls.find(call => call.endpoint === 'session/selectModel')?.args, { request: { sessionId: 'session-a', ...target } })
    assert.equal(f.controller.getSnapshot().success, 'current')
    assert.equal(f.controller.getSnapshot().issue, null)
    const current = f.controller.getSnapshot().current
    assert.equal(current.kind === 'available' && current.selection?.provider, 'deepseek-key-pool')
    // The official API's background default save is not assumed to have completed.
    assert.equal(f.controller.getSnapshot().catalog?.default.provider, 'deepseek-official')
  } finally { f.controller.dispose() }
})

test('setting the default uses its exact revision and does not rewrite an existing conversation', async () => {
  const f = fixture()
  try {
    await f.controller.refresh()
    await f.controller.setDefault()
    assert.deepEqual(f.calls.find(call => call.endpoint === 'settings/update')?.args, {
      ns: 'agent-default-model', patch: target, expectedRevision: 7,
    })
    assert.equal(f.calls.some(call => call.endpoint === 'session/selectModel'), false)
    assert.equal(f.controller.getSnapshot().catalog?.default.provider, 'deepseek-key-pool')
    assert.equal(f.controller.getSnapshot().success, 'default')
    const current = f.controller.getSnapshot().current
    assert.equal(current.kind === 'available' && current.selection?.provider, 'deepseek-official')
  } finally { f.controller.dispose() }
})

test('a missing same-id model or unsupported effort never silently substitutes another model', async () => {
  for (const [configure, expected] of [
    [(f: ReturnType<typeof fixture>) => f.setPoolModels(['deepseek-v4-pro']), 'MODEL_UNAVAILABLE'],
    [(f: ReturnType<typeof fixture>) => f.setEfforts(['high']), 'EFFORT_UNSUPPORTED'],
  ] as const) {
    const f = fixture()
    try {
      configure(f)
      await f.controller.refresh()
      await f.controller.switchCurrent()
      assert.equal(f.controller.getSnapshot().issue, expected)
      assert.equal(f.calls.some(call => call.endpoint === 'session/selectModel'), false)
    } finally { f.controller.dispose() }
  }
})

test('ambiguous or changed main conversations cannot receive a stale click', async () => {
  const ambiguous = fixture()
  try {
    await ambiguous.controller.refresh()
    ambiguous.setCurrent({ kind: 'ambiguous' })
    await ambiguous.controller.switchCurrent()
    assert.equal(ambiguous.controller.getSnapshot().issue, 'NO_CURRENT')
    assert.equal(ambiguous.calls.some(call => call.endpoint === 'session/selectModel'), false)
  } finally { ambiguous.controller.dispose() }
  const changed = fixture()
  try {
    await changed.controller.refresh()
    changed.setBeforeCatalog(() => changed.setCurrent({ kind: 'available', sessionId: 'session-b', selection: original }))
    await changed.controller.switchCurrent()
    assert.equal(changed.controller.getSnapshot().issue, 'SESSION_CHANGED')
    assert.equal(changed.calls.some(call => call.endpoint === 'session/selectModel'), false)
  } finally { changed.controller.dispose() }
})

test('settings conflicts are fixed messages and are not automatically retried', async () => {
  const f = fixture()
  try {
    await f.controller.refresh()
    f.setConflict()
    await f.controller.setDefault()
    assert.equal(f.controller.getSnapshot().issue, 'CONFLICT')
    assert.equal(f.calls.filter(call => call.endpoint === 'settings/update').length, 1)
    const html = renderToStaticMarkup(createElement(RoutingStatus, { controller: f.controller }))
    assert.match(html, /已被其他操作修改/)
    assert.doesNotMatch(html, /test-credential-do-not-print/)
  } finally { f.controller.dispose() }
})

test('successful selectModel replies alone do not count as read-back verification', async () => {
  const f = fixture()
  try {
    await f.controller.refresh()
    f.disableProjection()
    await f.controller.switchCurrent()
    assert.equal(f.controller.getSnapshot().success, null)
    assert.equal(f.controller.getSnapshot().issue, 'VERIFY_FAILED')
    assert.equal(f.calls.filter(call => call.endpoint === 'session/selectModel').length, 1)
  } finally { f.controller.dispose() }
})

test('effective source reasoning defaults are preserved when the session has no explicit override', () => {
  const catalog = parseRoutingCatalog({ default: original, groups: [
    { id: 'deepseek-official', models: [{ id: 'deepseek-flash', reasoning: { defaultEffort: 'max', efforts: [{ id: 'max' }] } }] },
    { id: 'deepseek-key-pool', models: [{ id: 'deepseek-flash', reasoning: { efforts: [{ id: 'max' }] } }] },
  ] })
  assert.deepEqual(poolTarget({ provider: 'deepseek-official', model: 'deepseek-flash' }, catalog), target)
})

test('routing copy is owned by the locale namespace and renders in both languages', async () => {
  const f = fixture()
  try {
    await f.controller.refresh()
    const zh = renderToStaticMarkup(createElement(RoutingStatus, { controller: f.controller }))
    assert.match(zh, /<h2/)
    assert.match(zh, /模型连接状态/)
    assert.match(zh, /未经过 Key 池/)
    const english = renderToStaticMarkup(createElement(RoutingStatus, { controller: f.controller, t: translateEn }))
    assert.match(english, /Model connection/)
    assert.match(english, /Bypassing Key Pool/)
    assert.match(english, /Make default/)
    assert.doesNotMatch(english, /模型连接状态/)
  } finally { f.controller.dispose() }
})
