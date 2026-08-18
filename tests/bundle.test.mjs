import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')
const readmeZh = await readFile(new URL('../README.zh-CN.md', import.meta.url), 'utf8')

test('is an installable DSH configuration bundle with no runtime package code', () => {
  assert.deepEqual(packageJson.dsh, { bundle: { patch: './cordis.patch.yml' } })
  assert.equal(packageJson.dependencies, undefined)
  assert.equal(packageJson.main, undefined)
  assert.equal(packageJson.exports, undefined)
})

test('pins the generic BailingHub MCP server behind the DSH in-box MCP client', () => {
  assert.match(patch, /name: '@deepseek-ai\/dsh-mcp-client'/)
  assert.match(patch, /args: \['-y', '--package=bailinghub-mcp-server@0\.1\.1', 'bailinghub-mcp-server'\]/)
  assert.match(patch, /serverName: bailinghub/)
  assert.match(patch, /failOnStartupError: true/)
})

test('keeps route and credentials outside model-controlled arguments', () => {
  assert.match(patch, /BAILINGHUB_CLIENT_TOKEN: !!js process\.env\.BAILINGHUB_CLIENT_TOKEN/)
  assert.match(patch, /BAILINGHUB_ROUTE: !!js process\.env\.BAILINGHUB_ROUTE/)
  assert.doesNotMatch(patch, /subject:|approval:|adminToken:|executorToken:|callbackUrl:/)
})

test('documents all three discovered tools and the independent-integration boundary', () => {
  for (const tool of [
    'mcp__bailinghub__submit_governed_job',
    'mcp__bailinghub__get_governed_job',
    'mcp__bailinghub__wait_for_governed_job',
  ]) {
    assert.ok(readme.includes(tool), `English README missing ${tool}`)
    assert.ok(readmeZh.includes(tool), `Chinese README missing ${tool}`)
  }
  assert.match(readme, /independent community integration/i)
  assert.match(readmeZh, /独立社区集成/)
})
