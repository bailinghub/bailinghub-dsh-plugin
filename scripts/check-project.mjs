import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'
import process from 'node:process'

const root = new URL('../', import.meta.url)
const rootPath = fileURLToPath(root)
const packageJson = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
const packageLock = JSON.parse(await readFile(new URL('package-lock.json', root), 'utf8'))
const candidatePatch = await readFile(new URL('cordis.agent-client.patch.yml', root), 'utf8')
const legacyPatch = await readFile(new URL('cordis.patch.yml', root), 'utf8')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

assert(packageJson.name === 'dsh-bailinghub', 'unexpected npm package name')
assert(packageJson.private === true, 'vNext candidate must remain private')
assert(packageJson.version === '0.2.0-agent-client.0', 'unexpected private candidate version')
assert(packageJson.main === 'lib/index.js', 'missing native Cordis entrypoint')
assert(packageJson.exports === './lib/index.js', 'missing native Cordis export')
assert(packageJson.dsh?.bundle?.patch === './cordis.agent-client.patch.yml', 'missing vNext bundle patch')
assert(packageJson.publishConfig === undefined, 'private candidate must not carry publish config')
assert(packageJson.dependencies?.['@deepseek-ai/schemastery'], 'missing Config schema dependency')
assert(packageJson.peerDependencies?.['bailinghub-mcp-server'] === '>=0.2.0', 'wrong SDK peer floor')
assert(packageLock.version === packageJson.version, 'package-lock version must match package version')
assert(packageLock.packages?.['']?.version === packageJson.version, 'package-lock root version must match')
for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
  assert(packageJson.scripts?.[hook] === undefined, `forbidden install hook: ${hook}`)
}

for (const expected of [
  'name: dsh-bailinghub',
  'hubUrl: !!js process.env.BAILINGHUB_HUB_URL',
  'clientAppId: !!js process.env.BAILINGHUB_CLIENT_APP_ID',
  'workspace: !!js process.env.BAILINGHUB_WORKSPACE',
  'connectionName: !!js process.env.BAILINGHUB_CONNECTION_NAME',
]) {
  assert(candidatePatch.includes(expected), `candidate patch missing: ${expected}`)
}
for (const forbidden of ['TOKEN', 'SECRET', 'PASSWORD', 'BUSINESS_URL', 'AUTH_URL']) {
  assert(!candidatePatch.includes(forbidden), `candidate settings leaked forbidden field: ${forbidden}`)
}

for (const expected of [
  "name: '@deepseek-ai/dsh-mcp-client'",
  "args: ['-y', '--package=bailinghub-mcp-server@0.1.1', 'bailinghub-mcp-server']",
  'BAILINGHUB_CLIENT_TOKEN:',
  'BAILINGHUB_ROUTE:',
]) {
  assert(legacyPatch.includes(expected), `legacy 0.1.x patch changed: ${expected}`)
}

async function collectFiles(directory, files = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await collectFiles(path, files)
    else files.push(path)
  }
  return files
}

const secretPatterns = [
  /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/,
  /Authorization:\s*Bearer\s+[A-Za-z0-9._-]{16,}/,
  /(?:access|refresh|client)[_-]?token\s*[=:]\s*['"][A-Za-z0-9._-]{20,}/i,
]
for (const file of await collectFiles(rootPath)) {
  const text = await readFile(file, 'utf8').catch(() => '')
  const relativePath = relative(rootPath, file)
  const localPrefix = ['', 'Users', 'macmini', ''].join('/')
  const localDependencyPrefix = ['f', 'i', 'l', 'e', ':'].join('')
  assert(!text.includes(localPrefix), `absolute local path in ${relativePath}`)
  if (relativePath === 'package.json' || relativePath === 'package-lock.json') {
    assert(!text.includes(localDependencyPrefix), `local file dependency in ${relativePath}`)
  }
  for (const pattern of secretPatterns) {
    const finding = pattern.exec(text)?.[0]
    const documentedPlaceholder = finding?.includes('replace-with-') === true
    assert(!finding || documentedPlaceholder, `possible credential in ${relativePath}`)
  }
}

process.stdout.write('project contract: PASS\n')
