import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { evaluatePluginCompatibility } from '@deepseek-ai/dsh-app-boot'

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
// Future versions exercise the real admission rule, not a claim that their APIs have been tested.
// 0.2.2-rc.1 is the installed desktop runtime this release was reviewed against.
const versions = [
  '0.2.1-rc.2', '0.2.1-rc.3', '0.2.1-rc.5', '0.2.1-rc.99', '0.2.1',
  '0.2.2-beta.1', '0.2.2-rc.1', '0.3.0', '1.0.0-alpha.1', '2.0.0',
]

test('official Harness admission no longer rejects the pool just because the runtime version changed', () => {
  const previous = { ...manifest, engines: { ...manifest.engines, dsh: '0.2.1-rc.3' } }
  assert.deepEqual(evaluatePluginCompatibility(previous, {}, '0.2.1-rc.5')?.requirements,
    { 'engines.dsh': '0.2.1-rc.3' }, 'Reproduce the upgrade rejection with the old requirement')
  for (const version of versions) {
    assert.equal(evaluatePluginCompatibility(manifest, {}, version), undefined, version)
  }
})

test('the official peer fallback also accepts different stable and prerelease host versions without exemptions', () => {
  const { dsh: _dsh, ...engines } = manifest.engines
  const usingPeers = { ...manifest, engines }
  for (const version of versions) {
    assert.equal(evaluatePluginCompatibility(usingPeers, {}, version), undefined, version)
  }
})

test('the 0.2.2-rc.1 host seams stay feature-detected instead of version-gated', () => {
  // Reviewed against the installed runtime:
  // - dsh-llm still exposes `llm/stream` as a Cordis waterfall and the agent
  //   recovery event keeps its `{ kind: 'retry' }` contract.
  // - dsh-llm-deepseek still calls resolveAuth before its onRequestError-protected
  //   request body, which is why quota mapping stays in the auth hook.
  // - Cordis 4.1 gives every listener a single-use next() and exposes validated
  //   settings as fiber.effectiveConfig; official-config.ts feature-detects that
  //   field and keeps the 4.0.5 raw-config fallback (official-config.test.ts).
  // - createModelListingCache is imported through Reflect so older SDKs still load
  //   (listing-compat.test.ts).
  assert.equal(evaluatePluginCompatibility(manifest, {}, '0.2.2-rc.1'), undefined)
  assert.equal(manifest.engines.dsh, '*', 'A hard version range would re-introduce the upgrade rejection')
})
