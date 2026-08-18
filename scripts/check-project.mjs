import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'
import process from 'node:process'

const root = new URL('../', import.meta.url)
const rootPath = fileURLToPath(root)
const packageJson = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
const packageLock = JSON.parse(await readFile(new URL('package-lock.json', root), 'utf8'))
const patch = await readFile(new URL('cordis.patch.yml', root), 'utf8')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

assert(packageJson.name === 'dsh-bailinghub', 'unexpected npm package name')
assert(
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(packageJson.version),
  'package version must be valid SemVer',
)
assert(packageLock.version === packageJson.version, 'package-lock version must match package version')
assert(
  packageLock.packages?.['']?.version === packageJson.version,
  'package-lock root version must match package version',
)
assert(packageJson.dsh?.bundle?.patch === './cordis.patch.yml', 'missing dsh.bundle.patch')
assert(packageJson.publishConfig?.access === 'public', 'package must publish as public')
assert(packageJson.publishConfig?.provenance === true, 'npm provenance must remain enabled')
assert(packageJson.dependencies === undefined, 'bundle must have no production dependencies')
assert(packageJson.optionalDependencies === undefined, 'bundle must have no optional dependencies')
for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
  assert(packageJson.scripts?.[hook] === undefined, `forbidden install hook: ${hook}`)
}

for (const expected of [
  "name: '@deepseek-ai/dsh-mcp-client'",
  'serverName: bailinghub',
  'transport: stdio',
  'command: npx',
  "args: ['-y', '--package=bailinghub-mcp-server@0.1.1', 'bailinghub-mcp-server']",
  'BAILINGHUB_BASE_URL: !!js process.env.BAILINGHUB_BASE_URL',
  'BAILINGHUB_CLIENT_TOKEN: !!js process.env.BAILINGHUB_CLIENT_TOKEN',
  'BAILINGHUB_ROUTE: !!js process.env.BAILINGHUB_ROUTE',
  'toolCallTimeoutMs: 90000',
  'failOnStartupError: true',
]) {
  assert(patch.includes(expected), `bundle patch missing: ${expected}`)
}

for (const forbidden of ['subject:', 'approval:', 'adminToken:', 'executorToken:', 'callbackUrl:']) {
  assert(!patch.includes(forbidden), `model-controlled boundary leaked into patch: ${forbidden}`)
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
  /BAILINGHUB_CLIENT_TOKEN\s*=\s*['\"]?(?!replace-with-)[A-Za-z0-9._-]{20,}/,
]
for (const file of await collectFiles(rootPath)) {
  const text = await readFile(file, 'utf8').catch(() => '')
  for (const pattern of secretPatterns) {
    assert(!pattern.test(text), `possible credential in ${relative(rootPath, file)}`)
  }
}

process.stdout.write('project contract: PASS\n')
