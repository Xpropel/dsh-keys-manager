import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { evaluatePluginCompatibility } from '@deepseek-ai/dsh-app-boot'

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
// Future versions exercise the real admission rule, not a claim that their APIs have been tested.
const versions = ['0.2.1-rc.2', '0.2.1-rc.3', '0.2.1-rc.5', '0.2.1-rc.99', '0.2.1', '0.2.2-beta.1', '0.3.0', '1.0.0-alpha.1', '2.0.0']

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
