import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { createFileSessionScopeStore, createMemorySessionScopeStore } from '../lib/session-scope-store.js'

const executeFile = promisify(execFile)
const moduleUrl = new URL('../lib/session-scope-store.js', import.meta.url).href
const hash = (sessionId) => createHash('sha256').update(sessionId).digest('hex')
const record = (sessionId, revision = 1, overrides = {}) => ({
  schema: 'bailing.agent-session-scope.v1',
  sessionId,
  revision,
  state: 'ready',
  locked: false,
  binding: { hubUrl: 'https://hub.example.com', clientAppId: 'dsh_client', workspace: 'demo' },
  authorizations: [{ connectionKey: `conn_${'1'.repeat(32)}`, label: 'Store A' }],
  ...overrides,
})

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'bailinghub-scope-store-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'scopes')
  return { root, directory, store: createFileSessionScopeStore({ directory }) }
}

function errorCode(code) {
  return (error) => {
    assert.equal(error.code, code)
    assert.equal(error.message.includes('bailinghub-scope-store-'), false)
    return true
  }
}

test('persists explicit empty scope and frozen selections across store recreation', async (t) => {
  const { directory, store } = await fixture(t)
  assert.equal(await store.load('session-a'), null)
  await assert.rejects(lstat(directory), { code: 'ENOENT' })
  const empty = record('session-a', 1, { authorizations: [] })
  assert.deepEqual(await store.save('session-a', empty, null), empty)
  const reopened = createFileSessionScopeStore({ directory })
  assert.deepEqual(await reopened.load('session-a'), empty)
  const frozen = record('session-a', 2, { locked: true })
  await reopened.save('session-a', frozen, 1)
  assert.deepEqual(await store.load('session-a'), frozen)
  assert.equal(await store.load('missing'), null)
  const files = await readdir(directory)
  assert.deepEqual(files, [`${hash('session-a')}.json`])
  if (process.platform !== 'win32') {
    assert.equal((await lstat(directory)).mode & 0o777, 0o700)
    assert.equal((await lstat(join(directory, files[0]))).mode & 0o777, 0o600)
  }
})

test('uses a fixed digest filename even when session identity looks like a filesystem path', async (t) => {
  const { root, directory, store } = await fixture(t)
  const sessionId = '../../escaped/session\\name.json'
  await store.save(sessionId, record(sessionId), null)
  assert.deepEqual(await readdir(directory), [`${hash(sessionId)}.json`])
  assert.deepEqual(await readdir(root), ['scopes'])
  assert.equal((await store.load(sessionId)).sessionId, sessionId)
})

test('default directory honors a temporary DSH_HOME without touching an existing user home', async (t) => {
  const { root } = await fixture(t)
  const previous = process.env.DSH_HOME
  let store
  try {
    process.env.DSH_HOME = root
    store = createFileSessionScopeStore()
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
  await store.save('default-location', record('default-location'), null)
  const path = join(root, 'plugins', 'dsh-bailinghub', 'session-scopes', `${hash('default-location')}.json`)
  assert.equal(JSON.parse(await readFile(path, 'utf8')).sessionId, 'default-location')
})

test('multiple file-store instances cannot both win the same revision or recreate an existing record', async (t) => {
  const { directory, store } = await fixture(t)
  await store.save('race', record('race'), null)
  const other = createFileSessionScopeStore({ directory })
  const results = await Promise.allSettled([
    store.save('race', record('race', 2, { locked: true }), 1),
    other.save('race', record('race', 2, { authorizations: [] }), 1),
  ])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'SCOPE_STORE_CONFLICT')
  assert.deepEqual(await other.load('race'), results.find((result) => result.status === 'fulfilled').value)
  await assert.rejects(other.save('race', record('race'), null), errorCode('SCOPE_STORE_CONFLICT'))
})

test('separate Node processes serialize competing CAS writes with one winner', async (t) => {
  const { directory, store } = await fixture(t)
  await store.save('process-race', record('process-race'), null)
  const run = (locked) => executeFile(process.execPath, ['--input-type=module', '-e', `
    import { createFileSessionScopeStore } from ${JSON.stringify(moduleUrl)}
    const store = createFileSessionScopeStore({ directory: ${JSON.stringify(directory)} })
    try {
      const saved = await store.save('process-race', ${JSON.stringify(record('process-race', 2, { locked }))}, 1)
      process.stdout.write(JSON.stringify({ ok: true, saved }))
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, code: error.code }))
    }
  `])
  const outcomes = (await Promise.all([run(true), run(false)])).map((result) => JSON.parse(result.stdout))
  assert.equal(outcomes.filter((outcome) => outcome.ok).length, 1)
  assert.equal(outcomes.find((outcome) => !outcome.ok).code, 'SCOPE_STORE_CONFLICT')
  assert.deepEqual(await store.load('process-race'), outcomes.find((outcome) => outcome.ok).saved)
})

test('restrictive process umask cannot create an unreadable successfully saved scope', async (t) => {
  const { directory, store } = await fixture(t)
  await mkdir(directory, { mode: 0o700 })
  await executeFile(process.execPath, ['--input-type=module', '-e', `
    import { createFileSessionScopeStore } from ${JSON.stringify(moduleUrl)}
    process.umask(0o277)
    const store = createFileSessionScopeStore({ directory: ${JSON.stringify(directory)} })
    await store.save('umask', ${JSON.stringify(record('umask'))}, null)
  `])
  assert.deepEqual(await store.load('umask'), record('umask'))
  if (process.platform !== 'win32') assert.equal((await lstat(join(directory, `${hash('umask')}.json`))).mode & 0o777, 0o600)
})

test('accepted maximum-size records remain readable and oversized saves preserve the previous revision', async (t) => {
  const { store } = await fixture(t)
  const boundary = record('size-boundary', 1, { padding: '' })
  boundary.padding = 'x'.repeat(256 * 1024 - Buffer.byteLength(JSON.stringify(boundary)))
  assert.equal(Buffer.byteLength(JSON.stringify(boundary)), 256 * 1024)
  await store.save('size-boundary', boundary, null)
  assert.deepEqual(await store.load('size-boundary'), boundary)
  await assert.rejects(store.save('size-boundary', { ...boundary, revision: 2, padding: `${boundary.padding}x` }, 1),
    errorCode('SCOPE_STORE_UNAVAILABLE'))
  assert.deepEqual(await store.load('size-boundary'), boundary)
})

test('corrupt and mismatched files fail closed and cannot be overwritten as missing', async (t) => {
  const { directory, store } = await fixture(t)
  await mkdir(directory, { mode: 0o700 })
  const path = join(directory, `${hash('damaged')}.json`)
  const invalidUtf8 = Buffer.concat([
    Buffer.from(`${JSON.stringify(record('damaged')).slice(0, -1)},"padding":"`), Buffer.from([0xff]), Buffer.from('"}'),
  ])
  for (const contents of ['{broken', JSON.stringify(record('different-session')), JSON.stringify(record('damaged', 0)), invalidUtf8]) {
    await writeFile(path, contents, { mode: 0o600 })
    await assert.rejects(store.load('damaged'), errorCode('SCOPE_STORE_UNAVAILABLE'))
    await assert.rejects(store.save('damaged', record('damaged'), null), errorCode('SCOPE_STORE_UNAVAILABLE'))
    assert.deepEqual(await readFile(path), Buffer.from(contents))
    assert.deepEqual(await readdir(directory), [`${hash('damaged')}.json`])
  }
})

test('refuses symlink, hardlink and non-regular scope files without modifying their targets', async (t) => {
  const { root, directory, store } = await fixture(t)
  await mkdir(directory, { mode: 0o700 })
  const target = join(root, 'outside.json')
  const contents = JSON.stringify(record('unsafe'))
  await writeFile(target, contents, { mode: 0o600 })
  const path = join(directory, `${hash('unsafe')}.json`)
  for (const create of [() => symlink(target, path), () => link(target, path), () => mkdir(path)]) {
    await create()
    await assert.rejects(store.load('unsafe'), errorCode('SCOPE_STORE_UNAVAILABLE'))
    await assert.rejects(store.save('unsafe', record('unsafe'), null), errorCode('SCOPE_STORE_UNAVAILABLE'))
    assert.equal(await readFile(target, 'utf8'), contents)
    await rm(path, { recursive: true })
  }
})

test('refuses symlink and non-directory storage roots', async (t) => {
  const { root, directory } = await fixture(t)
  const target = join(root, 'actual')
  await mkdir(target, { mode: 0o700 })
  await symlink(target, directory, 'dir')
  const store = createFileSessionScopeStore({ directory })
  await assert.rejects(store.load('unsafe-root'), errorCode('SCOPE_STORE_UNAVAILABLE'))
  await assert.rejects(store.save('unsafe-root', record('unsafe-root'), null), errorCode('SCOPE_STORE_UNAVAILABLE'))
  assert.deepEqual(await readdir(target), [])
  await rm(directory)
  await writeFile(directory, 'not a directory', { mode: 0o600 })
  await assert.rejects(store.save('unsafe-root', record('unsafe-root'), null), errorCode('SCOPE_STORE_UNAVAILABLE'))
  assert.equal(await readFile(directory, 'utf8'), 'not a directory')
})

test('an occupied lock times out without deleting it or reporting a successful save', { timeout: 5_000 }, async (t) => {
  const { directory, store } = await fixture(t)
  await mkdir(directory, { mode: 0o700 })
  const lockPath = join(directory, `${hash('locked')}.lock`)
  await writeFile(lockPath, 'another process owns this lock', { mode: 0o600 })
  const before = await lstat(lockPath)
  await assert.rejects(store.save('locked', record('locked'), null), errorCode('SCOPE_STORE_CONFLICT'))
  assert.equal((await lstat(lockPath)).ino, before.ino)
  assert.equal(await readFile(lockPath, 'utf8'), 'another process owns this lock')
  assert.equal(await store.load('locked'), null)
  assert.deepEqual(await readdir(directory), [`${hash('locked')}.lock`])
})

test('rejects unsafe lock files and permissive scope files', async (t) => {
  const { root, directory, store } = await fixture(t)
  await mkdir(directory, { mode: 0o700 })
  const outside = join(root, 'outside-lock')
  await writeFile(outside, 'untouched', { mode: 0o600 })
  await symlink(outside, join(directory, `${hash('unsafe-lock')}.lock`))
  await assert.rejects(store.save('unsafe-lock', record('unsafe-lock'), null), errorCode('SCOPE_STORE_UNAVAILABLE'))
  assert.equal(await readFile(outside, 'utf8'), 'untouched')
  if (process.platform !== 'win32') {
    await store.save('permissions', record('permissions'), null)
    await chmod(join(directory, `${hash('permissions')}.json`), 0o644)
    await assert.rejects(store.load('permissions'), errorCode('SCOPE_STORE_UNAVAILABLE'))
  }
})

for (const kind of ['memory', 'file']) {
  test(`${kind} store validates monotonic revisions, refuses credential fields and detaches caller data`, async (t) => {
    const store = kind === 'memory' ? createMemorySessionScopeStore() : (await fixture(t)).store
    assert.equal(await store.load('snapshot'), null)
    await assert.rejects(store.save('snapshot', record('snapshot', 2), null), errorCode('SCOPE_STORE_UNAVAILABLE'))
    await assert.rejects(store.save('snapshot', record('wrong-id'), null), errorCode('SCOPE_STORE_UNAVAILABLE'))
    for (const key of ['access_token', 'refreshToken', 'password']) {
      await assert.rejects(store.save('snapshot', record('snapshot', 1, { nested: { [key]: 'never-persist' } }), null), errorCode('SCOPE_STORE_UNAVAILABLE'))
    }
    const input = record('snapshot')
    const output = await store.save('snapshot', input, null)
    input.authorizations.length = 0
    output.authorizations.length = 0
    assert.equal((await store.load('snapshot')).authorizations.length, 1)
    const loaded = await store.load('snapshot')
    loaded.authorizations.length = 0
    assert.equal((await store.load('snapshot')).authorizations.length, 1)
    await assert.rejects(store.save('snapshot', record('snapshot'), null), errorCode('SCOPE_STORE_CONFLICT'))
    await store.save('snapshot', record('snapshot', 2, { authorizations: [] }), 1)
    await assert.rejects(store.save('snapshot', record('snapshot', 2), 1), errorCode('SCOPE_STORE_CONFLICT'))
  })
}

test('memory scope store is explicitly ephemeral and keeps independent host instances isolated', async () => {
  const first = createMemorySessionScopeStore()
  await first.save('ephemeral', record('ephemeral'), null)
  assert.equal(await createMemorySessionScopeStore().load('ephemeral'), null)
})
