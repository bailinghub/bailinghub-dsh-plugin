import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { validateReleaseDependencyContract } from '../scripts/check-project.mjs'

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const nativePatch = await readFile(new URL('../cordis.agent-client.patch.yml', import.meta.url), 'utf8')
const legacyPatch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

test('is a publishable stable native Cordis plugin', () => {
  assert.notEqual(packageJson.private, true)
  assert.equal(packageJson.version, '0.2.0')
  assert.deepEqual(packageJson.publishConfig, { access: 'public', provenance: true })
  assert.equal(packageJson.main, 'lib/index.js')
  assert.equal(packageJson.exports, './lib/index.js')
  assert.deepEqual(packageJson.dsh, { bundle: { patch: './cordis.agent-client.patch.yml' } })
  assert.equal(packageJson.dependencies['@deepseek-ai/schemastery'], '^3.18.1')
  assert.equal(packageJson.dependencies['bailinghub-mcp-server'], '0.2.0')
  assert.equal(packageJson.peerDependencies?.['bailinghub-mcp-server'], undefined)
  assert.equal(packageJson.peerDependenciesMeta?.['bailinghub-mcp-server'], undefined)
})

test('native configuration contains only Hub-owned public routing fields', () => {
  for (const field of ['hubUrl', 'clientAppId', 'workspace', 'connectionName']) {
    assert.match(nativePatch, new RegExp(`${field}:`))
  }
  assert.doesNotMatch(
    nativePatch,
    /business(?:Api|Url|Domain)|auth(?:Url|Domain)|token|secret|password|credential/i,
  )
})

test('retains the public 0.1.x static MCP bundle verbatim as a separate legacy patch', () => {
  assert.match(legacyPatch, /name: '@deepseek-ai\/dsh-mcp-client'/)
  assert.match(
    legacyPatch,
    /args: \['-y', '--package=bailinghub-mcp-server@0\.1\.1', 'bailinghub-mcp-server'\]/,
  )
  assert.match(legacyPatch, /BAILINGHUB_CLIENT_TOKEN:/)
  assert.match(legacyPatch, /BAILINGHUB_ROUTE:/)
  assert.match(legacyPatch, /failOnStartupError: true/)
})

test('has no install hooks or local file dependencies', () => {
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
    assert.equal(packageJson.scripts?.[hook], undefined)
  }
  const serialized = JSON.stringify(packageJson)
  assert.equal(serialized.includes(['f', 'i', 'l', 'e', ':'].join('')), false)
  assert.doesNotMatch(serialized, /\/Users\/|\\Users\\/)
})

test('requires every publishable package to install one exact SDK version', () => {
  const publicStable = {
    ...packageJson,
    version: '0.2.0',
    private: false,
    dependencies: {
      ...packageJson.dependencies,
      'bailinghub-mcp-server': '0.2.0',
    },
  }
  delete publicStable.peerDependencies
  delete publicStable.peerDependenciesMeta
  const publicLock = {
    packages: {
      '': { dependencies: { 'bailinghub-mcp-server': '0.2.0' } },
      'node_modules/bailinghub-mcp-server': { version: '0.2.0' },
    },
  }

  assert.doesNotThrow(() => validateReleaseDependencyContract(publicStable, publicLock))
})

test('rejects public packages with ranged, optional-peer, optional, or local SDK dependencies', () => {
  const publicStable = {
    ...packageJson,
    version: '0.2.0',
    private: false,
    dependencies: { ...packageJson.dependencies },
  }

  assert.throws(
    () => validateReleaseDependencyContract({
      ...publicStable,
      dependencies: { ...publicStable.dependencies, 'bailinghub-mcp-server': '^0.2.0' },
    }),
    /exact ordinary dependency/,
  )
  assert.throws(
    () => validateReleaseDependencyContract({
      ...publicStable,
      dependencies: { ...publicStable.dependencies, 'bailinghub-mcp-server': 'file:sdk.tgz' },
    }),
    /exact ordinary dependency/,
  )
  assert.throws(
    () => validateReleaseDependencyContract({
      ...publicStable,
      dependencies: { ...publicStable.dependencies, 'bailinghub-mcp-server': '0.2.0-rc.1' },
      peerDependencies: undefined,
      peerDependenciesMeta: undefined,
    }),
    /exact stable/,
  )
  assert.throws(
    () => validateReleaseDependencyContract({
      ...publicStable,
      dependencies: { ...publicStable.dependencies, 'bailinghub-mcp-server': '0.2.0' },
      peerDependencies: { 'bailinghub-mcp-server': '>=0.2.0' },
      peerDependenciesMeta: { 'bailinghub-mcp-server': { optional: true } },
    }, {
      packages: {
        '': { dependencies: { 'bailinghub-mcp-server': '0.2.0' } },
        'node_modules/bailinghub-mcp-server': { version: '0.2.0' },
      },
    }),
    /peer dependency/,
  )
  assert.throws(
    () => validateReleaseDependencyContract({
      ...publicStable,
      dependencies: { ...publicStable.dependencies, 'bailinghub-mcp-server': '0.2.0' },
      peerDependencies: undefined,
      peerDependenciesMeta: undefined,
      optionalDependencies: { 'bailinghub-mcp-server': '0.2.0' },
    }, {
      packages: {
        '': { dependencies: { 'bailinghub-mcp-server': '0.2.0' } },
        'node_modules/bailinghub-mcp-server': { version: '0.2.0' },
      },
    }),
    /optional dependency/,
  )
})

test('keeps the current stable dependency contract valid', () => {
  const matchingLock = {
    packages: {
      '': { dependencies: { 'bailinghub-mcp-server': '0.2.0' } },
      'node_modules/bailinghub-mcp-server': { version: '0.2.0' },
    },
  }
  assert.doesNotThrow(() => validateReleaseDependencyContract(packageJson, matchingLock))
})
