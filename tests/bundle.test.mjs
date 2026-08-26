import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const candidatePatch = await readFile(new URL('../cordis.agent-client.patch.yml', import.meta.url), 'utf8')
const legacyPatch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

test('is a non-publishable native vNext Cordis plugin candidate', () => {
  assert.equal(packageJson.private, true)
  assert.equal(packageJson.version, '0.2.0-agent-client.0')
  assert.equal(packageJson.main, 'lib/index.js')
  assert.equal(packageJson.exports, './lib/index.js')
  assert.deepEqual(packageJson.dsh, { bundle: { patch: './cordis.agent-client.patch.yml' } })
  assert.equal(packageJson.dependencies['@deepseek-ai/schemastery'], '^3.18.1')
  assert.equal(packageJson.peerDependencies['bailinghub-mcp-server'], '>=0.2.0')
})

test('candidate configuration contains only Hub-owned public routing fields', () => {
  for (const field of ['hubUrl', 'clientAppId', 'workspace', 'connectionName']) {
    assert.match(candidatePatch, new RegExp(`${field}:`))
  }
  assert.doesNotMatch(
    candidatePatch,
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
