import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'
import process from 'node:process'

const root = new URL('../', import.meta.url)
const rootPath = fileURLToPath(root)
const packageJson = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
const packageLock = JSON.parse(await readFile(new URL('package-lock.json', root), 'utf8'))
const nativePatch = await readFile(new URL('cordis.agent-client.patch.yml', root), 'utf8')
const legacyPatch = await readFile(new URL('cordis.patch.yml', root), 'utf8')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const exactSemver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/
const exactStableSemver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

/**
 * Private source candidates may keep an optional peer while the sibling SDK is
 * tested from source. A package that can be published must instead install one
 * exact SDK version itself so a clean DSH profile never depends on ambient
 * node_modules state or package-manager-specific peer resolution.
 */
export function validateReleaseDependencyContract(manifest, lock = {}) {
  if (manifest.private === true) return

  const sdkPackage = 'bailinghub-mcp-server'
  const sdkVersion = manifest.dependencies?.[sdkPackage]
  assert(
    typeof sdkVersion === 'string' && exactSemver.test(sdkVersion),
    `public packages must declare ${sdkPackage} as an exact ordinary dependency`,
  )
  if (exactStableSemver.test(manifest.version)) {
    assert(
      exactStableSemver.test(sdkVersion),
      `stable packages must depend on an exact stable ${sdkPackage} version`,
    )
  }
  assert(
    manifest.peerDependencies?.[sdkPackage] === undefined,
    `public packages must not declare ${sdkPackage} as a peer dependency`,
  )
  assert(
    manifest.peerDependenciesMeta?.[sdkPackage] === undefined,
    `public packages must not mark ${sdkPackage} as an optional peer`,
  )
  assert(
    manifest.optionalDependencies?.[sdkPackage] === undefined,
    `public packages must not declare ${sdkPackage} as an optional dependency`,
  )
  assert(
    lock.packages?.['']?.dependencies?.[sdkPackage] === sdkVersion,
    `package-lock root must pin ${sdkPackage} to the manifest version`,
  )
  assert(
    lock.packages?.[`node_modules/${sdkPackage}`]?.version === sdkVersion,
    `package-lock must resolve the exact ${sdkPackage} version`,
  )
}

assert(packageJson.name === 'dsh-bailinghub', 'unexpected npm package name')
assert(exactSemver.test(packageJson.version), 'package version must be exact semantic version')
if (packageJson.private === true) {
  assert(packageJson.version === '0.2.0-agent-client.0', 'unexpected private candidate version')
  assert(packageJson.publishConfig === undefined, 'private candidate must not carry publish config')
  assert(packageJson.peerDependencies?.['bailinghub-mcp-server'] === '>=0.2.0', 'wrong SDK peer floor')
} else {
  assert(packageJson.publishConfig?.access === 'public', 'public package must publish as public')
  assert(packageJson.publishConfig?.provenance === true, 'public package must retain npm provenance')
}
assert(packageJson.main === 'lib/index.js', 'missing native Cordis entrypoint')
assert(packageJson.exports === './lib/index.js', 'missing native Cordis export')
assert(packageJson.dsh?.bundle?.patch === './cordis.agent-client.patch.yml', 'missing vNext bundle patch')
assert(packageJson.dependencies?.['@deepseek-ai/schemastery'], 'missing Config schema dependency')
assert(packageLock.version === packageJson.version, 'package-lock version must match package version')
assert(packageLock.packages?.['']?.version === packageJson.version, 'package-lock root version must match')
validateReleaseDependencyContract(packageJson, packageLock)
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
  assert(nativePatch.includes(expected), `native patch missing: ${expected}`)
}
for (const forbidden of ['TOKEN', 'SECRET', 'PASSWORD', 'BUSINESS_URL', 'AUTH_URL']) {
  assert(!nativePatch.includes(forbidden), `native settings leaked forbidden field: ${forbidden}`)
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
