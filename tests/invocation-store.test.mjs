import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { createFileInvocationStore, createMemoryInvocationStore } from '../lib/invocation-store.js'

const executeFile = promisify(execFile)
const moduleUrl = new URL('../lib/invocation-store.js', import.meta.url).href
const hash = (sessionId) => createHash('sha256').update(sessionId).digest('hex')
const entry = (overrides = {}) => ({
  invocationId: 'invocation-1',
  runId: 'run-1',
  agentSessionId: 'agent-session-1',
  connectionKey: `conn_${'1'.repeat(32)}`,
  authorization_ref: 'auth-reference-1',
  binding: { hubUrl: 'https://hub.example.com', clientAppId: 'example-client', workspace: 'demo' },
  toolName: 'catalog_update',
  args_hash: 'a'.repeat(64),
  ...overrides,
})
const record = (sessionId, revision = 1, entries = [entry()]) => ({
  schema: 'bailing.agent-invocations.v1', sessionId, revision, entries,
})

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'bailinghub-invocation-store-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'invocations')
  return { root, directory, store: createFileInvocationStore({ directory }) }
}

function errorCode(code) {
  return (error) => {
    assert.equal(error.code, code)
    assert.equal(error.message.includes('bailinghub-invocation-store-'), false)
    assert.equal(error.message.includes('never-persist'), false)
    return true
  }
}

test('persists original execution metadata across store recreation and isolates sessions', async (t) => {
  const { directory, store } = await fixture(t)
  assert.equal(await store.load('session-a'), null)
  await assert.rejects(lstat(directory), { code: 'ENOENT' })
  const original = record('session-a')
  assert.deepEqual(await store.save('session-a', original, null), original)
  const reopened = createFileInvocationStore({ directory })
  assert.deepEqual(await reopened.load('session-a'), original)
  assert.equal(await reopened.load('session-b'), null)
  const updated = record('session-a', 2, [entry({ state: 'completed' })])
  await reopened.save('session-a', updated, 1)
  assert.deepEqual(await store.load('session-a'), updated)
  const files = await readdir(directory)
  assert.deepEqual(files, [`${hash('session-a')}.json`])
  if (process.platform !== 'win32') {
    assert.equal((await lstat(directory)).mode & 0o777, 0o700)
    assert.equal((await lstat(join(directory, files[0]))).mode & 0o777, 0o600)
  }
})

test('digest filenames cannot escape the store through a path-shaped session identity', async (t) => {
  const { root, directory, store } = await fixture(t)
  const sessionId = '../../escaped/session\\name.json'
  await store.save(sessionId, record(sessionId), null)
  assert.deepEqual(await readdir(directory), [`${hash(sessionId)}.json`])
  assert.deepEqual(await readdir(root), ['invocations'])
  assert.equal((await store.load(sessionId)).sessionId, sessionId)
})

test('default DSH directory keeps invocation metadata separate from scope and archive records', async (t) => {
  const { root } = await fixture(t)
  const previous = process.env.DSH_HOME
  let store
  try {
    process.env.DSH_HOME = root
    store = createFileInvocationStore()
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
  await store.save('default-location', record('default-location'), null)
  const base = join(root, 'plugins', 'dsh-bailinghub')
  assert.deepEqual(await readdir(base), ['invocation-records'])
  const path = join(base, 'invocation-records', `${hash('default-location')}.json`)
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), record('default-location'))
})

test('multiple file-store instances allow exactly one CAS winner', async (t) => {
  const { directory, store } = await fixture(t)
  await store.save('race', record('race'), null)
  const other = createFileInvocationStore({ directory })
  const results = await Promise.allSettled([
    store.save('race', record('race', 2, [entry({ state: 'pending' })]), 1),
    other.save('race', record('race', 2, [entry({ state: 'completed' })]), 1),
  ])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'INVOCATION_STORE_CONFLICT')
  assert.deepEqual(await other.load('race'), results.find((result) => result.status === 'fulfilled').value)
  await assert.rejects(other.save('race', record('race'), null), errorCode('INVOCATION_STORE_CONFLICT'))
})

test('independent Node processes cannot overwrite each other at the same revision', async (t) => {
  const { directory, store } = await fixture(t)
  await store.save('process-race', record('process-race'), null)
  const run = (state) => executeFile(process.execPath, ['--input-type=module', '-e', `
    import { createFileInvocationStore } from ${JSON.stringify(moduleUrl)}
    const store = createFileInvocationStore({ directory: ${JSON.stringify(directory)} })
    try {
      const saved = await store.save('process-race', ${JSON.stringify(record('process-race', 2, [entry({ state })]))}, 1)
      process.stdout.write(JSON.stringify({ ok: true, saved }))
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, code: error.code }))
    }
  `])
  const outcomes = (await Promise.all([run('pending'), run('completed')])).map((result) => JSON.parse(result.stdout))
  assert.equal(outcomes.filter((outcome) => outcome.ok).length, 1)
  assert.equal(outcomes.find((outcome) => !outcome.ok).code, 'INVOCATION_STORE_CONFLICT')
  assert.deepEqual(await store.load('process-race'), outcomes.find((outcome) => outcome.ok).saved)
})

test('restrictive umask does not leave a successfully saved record unreadable', async (t) => {
  const { directory, store } = await fixture(t)
  await mkdir(directory, { mode: 0o700 })
  await executeFile(process.execPath, ['--input-type=module', '-e', `
    import { createFileInvocationStore } from ${JSON.stringify(moduleUrl)}
    process.umask(0o277)
    const store = createFileInvocationStore({ directory: ${JSON.stringify(directory)} })
    await store.save('umask', ${JSON.stringify(record('umask'))}, null)
  `])
  assert.deepEqual(await store.load('umask'), record('umask'))
})

test('8 MiB boundary is readable and oversized writes preserve original recovery metadata', async (t) => {
  const { store } = await fixture(t)
  const boundary = record('boundary', 1, [entry({ marker: '' })])
  boundary.entries[0].marker = 'x'.repeat(8 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(boundary)))
  assert.equal(Buffer.byteLength(JSON.stringify(boundary)), 8 * 1024 * 1024)
  await store.save('boundary', boundary, null)
  assert.deepEqual(await store.load('boundary'), boundary)
  const oversized = record('boundary', 2, [entry({ marker: `${boundary.entries[0].marker}x` })])
  await assert.rejects(store.save('boundary', oversized, 1), errorCode('INVOCATION_STORE_UNAVAILABLE'))
  assert.deepEqual(await store.load('boundary'), boundary)
})

test('corrupt, wrong-session and invalid UTF-8 records are never treated as missing', async (t) => {
  const { directory, store } = await fixture(t)
  await mkdir(directory, { mode: 0o700 })
  const path = join(directory, `${hash('damaged')}.json`)
  const invalidUtf8 = Buffer.concat([
    Buffer.from('{"schema":"'), Buffer.from([0xff]), Buffer.from('"}'),
  ])
  const invalid = [
    '{broken', JSON.stringify(record('different-session')), JSON.stringify(record('damaged', 0)),
    JSON.stringify({ ...record('damaged'), schema: 'bailing.agent-session-scope.v1' }),
    JSON.stringify({ ...record('damaged'), entries: {} }), invalidUtf8,
    JSON.stringify(record('damaged', 1, [entry({ arguments: { marker: 'never-persist' } })])),
  ]
  for (const contents of invalid) {
    await writeFile(path, contents, { mode: 0o600 })
    await assert.rejects(store.load('damaged'), errorCode('INVOCATION_STORE_UNAVAILABLE'))
    await assert.rejects(store.save('damaged', record('damaged'), null), errorCode('INVOCATION_STORE_UNAVAILABLE'))
    assert.deepEqual(await readFile(path), Buffer.from(contents))
    assert.deepEqual(await readdir(directory), [`${hash('damaged')}.json`])
  }
})

test('symlink, hardlink and non-regular records cannot redirect loads or saves', async (t) => {
  const { root, directory, store } = await fixture(t)
  await mkdir(directory, { mode: 0o700 })
  const target = join(root, 'outside.json')
  const contents = JSON.stringify(record('unsafe'))
  await writeFile(target, contents, { mode: 0o600 })
  const path = join(directory, `${hash('unsafe')}.json`)
  for (const create of [() => symlink(target, path), () => link(target, path), () => mkdir(path)]) {
    await create()
    await assert.rejects(store.load('unsafe'), errorCode('INVOCATION_STORE_UNAVAILABLE'))
    await assert.rejects(store.save('unsafe', record('unsafe'), null), errorCode('INVOCATION_STORE_UNAVAILABLE'))
    assert.equal(await readFile(target, 'utf8'), contents)
    await rm(path, { recursive: true })
  }
})

test('symlink, non-directory and permissive storage roots fail closed', async (t) => {
  const { root, directory } = await fixture(t)
  const target = join(root, 'actual')
  await mkdir(target, { mode: 0o700 })
  await symlink(target, directory, 'dir')
  const store = createFileInvocationStore({ directory })
  await assert.rejects(store.load('unsafe-root'), errorCode('INVOCATION_STORE_UNAVAILABLE'))
  await assert.rejects(store.save('unsafe-root', record('unsafe-root'), null), errorCode('INVOCATION_STORE_UNAVAILABLE'))
  assert.deepEqual(await readdir(target), [])
  await rm(directory)
  await writeFile(directory, 'not a directory', { mode: 0o600 })
  await assert.rejects(store.save('unsafe-root', record('unsafe-root'), null), errorCode('INVOCATION_STORE_UNAVAILABLE'))
  assert.equal(await readFile(directory, 'utf8'), 'not a directory')
  if (process.platform !== 'win32') {
    await rm(directory)
    await mkdir(directory, { mode: 0o755 })
    await assert.rejects(store.load('unsafe-root'), errorCode('INVOCATION_STORE_UNAVAILABLE'))
    await assert.rejects(store.save('unsafe-root', record('unsafe-root'), null), errorCode('INVOCATION_STORE_UNAVAILABLE'))
    assert.deepEqual(await readdir(directory), [])
  }
})

test('occupied locks time out without stale-lock guesses or deleting another process lock', { timeout: 5_000 }, async (t) => {
  const { directory, store } = await fixture(t)
  await mkdir(directory, { mode: 0o700 })
  const path = join(directory, `${hash('locked')}.lock`)
  await writeFile(path, 'another process owns this lock', { mode: 0o600 })
  const before = await lstat(path)
  await assert.rejects(store.save('locked', record('locked'), null), errorCode('INVOCATION_STORE_CONFLICT'))
  assert.equal((await lstat(path)).ino, before.ino)
  assert.equal(await readFile(path, 'utf8'), 'another process owns this lock')
  assert.equal(await store.load('locked'), null)
  assert.deepEqual(await readdir(directory), [`${hash('locked')}.lock`])
})

test('unsafe lock files and permissive records are rejected without leaking filesystem details', async (t) => {
  const { root, directory, store } = await fixture(t)
  await mkdir(directory, { mode: 0o700 })
  const outside = join(root, 'outside-lock')
  await writeFile(outside, 'untouched', { mode: 0o600 })
  await symlink(outside, join(directory, `${hash('unsafe-lock')}.lock`))
  await assert.rejects(store.save('unsafe-lock', record('unsafe-lock'), null), errorCode('INVOCATION_STORE_UNAVAILABLE'))
  assert.equal(await readFile(outside, 'utf8'), 'untouched')
  if (process.platform !== 'win32') {
    await store.save('permissions', record('permissions'), null)
    await chmod(join(directory, `${hash('permissions')}.json`), 0o644)
    await assert.rejects(store.load('permissions'), errorCode('INVOCATION_STORE_UNAVAILABLE'))
    await assert.rejects(store.save('permissions', record('permissions', 2), 1), errorCode('INVOCATION_STORE_UNAVAILABLE'))
  }
})

for (const kind of ['memory', 'file']) {
  const makeStore = async (t) => kind === 'memory' ? createMemoryInvocationStore() : (await fixture(t)).store

  test(`${kind} store requires exact schema, session, entries and monotonic CAS revisions`, async (t) => {
    const store = await makeStore(t)
    for (const invalid of [
      record('wrong-id'), record('snapshot', 0), record('snapshot', 1.5), record('snapshot', 2),
      { ...record('snapshot'), entries: null }, { ...record('snapshot'), schema: 'unknown' },
      { ...record('snapshot'), unexpected: true },
    ]) await assert.rejects(store.save('snapshot', invalid, null), errorCode('INVOCATION_STORE_UNAVAILABLE'))
    await store.save('snapshot', record('snapshot'), null)
    await assert.rejects(store.save('snapshot', record('snapshot'), null), errorCode('INVOCATION_STORE_CONFLICT'))
    for (const revision of [undefined, 0, -1, 1.5, '1']) {
      await assert.rejects(store.save('snapshot', record('snapshot', 2), revision), errorCode('INVOCATION_STORE_UNAVAILABLE'))
    }
    await store.save('snapshot', record('snapshot', 2, []), 1)
    await assert.rejects(store.save('snapshot', record('snapshot', 2), 1), errorCode('INVOCATION_STORE_CONFLICT'))
    assert.deepEqual(await store.load('snapshot'), record('snapshot', 2, []))
  })

  test(`${kind} store refuses credential and raw payload fields but preserves metadata and tool names`, async (t) => {
    const store = await makeStore(t)
    for (const key of [
      'token', 'tokens', 'access_token', 'refreshToken', 'PASSWORD', 'credentials', 'credential',
      'client-secret', 'authorization', 'api_key', 'secret', 'args', 'arguments', 'content',
      'contents', 'body', 'prompt', 'messages',
    ]) {
      const invalid = record('payload', 1, [entry({ nested: { [key]: 'never-persist' } })])
      await assert.rejects(store.save('payload', invalid, null), errorCode('INVOCATION_STORE_UNAVAILABLE'))
    }
    const metadata = record('payload', 1, [entry({ toolName: 'content', toolId: 'arguments', contentHash: 'b'.repeat(64) })])
    await store.save('payload', metadata, null)
    assert.deepEqual(await store.load('payload'), metadata)
  })

  test(`${kind} store rejects non-JSON structures without evaluating accessors`, async (t) => {
    const store = await makeStore(t)
    const cycle = {}; cycle.loop = cycle
    const sparse = []; sparse[1] = 'hole'
    const extended = []; extended.extra = true
    const hidden = Object.defineProperty({}, 'hidden', { value: true })
    const getter = Object.defineProperty({}, 'getter', { enumerable: true, get() { throw new Error('accessor evaluated') } })
    const symbol = { [Symbol('hidden')]: true }
    const polluted = JSON.parse('{"__proto__":{"polluted":true}}')
    const proxy = new Proxy({}, { ownKeys() { throw new Error('proxy trap evaluated') } })
    const revoked = Proxy.revocable({}, {}); revoked.revoke()
    const deep = {}; let cursor = deep
    for (let index = 0; index < 140; index++) { cursor.next = {}; cursor = cursor.next }
    for (const value of [undefined, () => {}, NaN, Infinity, -0, 1n, new Date(), Buffer.from('x'), cycle,
      sparse, extended, hidden, getter, symbol, polluted, proxy, revoked.proxy, { constructor: 'value' }, deep]) {
      await assert.rejects(store.save('json', record('json', 1, [entry({ metadata: value })]), null), errorCode('INVOCATION_STORE_UNAVAILABLE'))
    }
    assert.equal(await store.load('json'), null)
  })

  test(`${kind} store detaches inputs, save results and load results from stored state`, async (t) => {
    const store = await makeStore(t)
    const original = record('snapshot')
    const input = record('snapshot')
    const saved = await store.save('snapshot', input, null)
    input.entries[0].binding.workspace = 'changed-input'
    saved.entries.length = 0
    const loaded = await store.load('snapshot')
    assert.deepEqual(loaded, original)
    loaded.entries[0].binding.workspace = 'changed-loaded'
    assert.deepEqual(await store.load('snapshot'), original)
  })
}

test('memory stores are explicitly ephemeral and independent', async () => {
  const first = createMemoryInvocationStore()
  await first.save('ephemeral', record('ephemeral'), null)
  assert.equal(await createMemoryInvocationStore().load('ephemeral'), null)
})

test('invalid store directories and session identities return stable sanitized errors', async (t) => {
  for (const directory of ['', ' ', null, 42]) {
    assert.throws(() => createFileInvocationStore({ directory }), errorCode('INVOCATION_STORE_UNAVAILABLE'))
  }
  const { store } = await fixture(t)
  for (const target of [store, createMemoryInvocationStore()]) {
    for (const sessionId of ['', null, 42, 'x'.repeat(4_097)]) {
      await assert.rejects(target.load(sessionId), errorCode('INVOCATION_STORE_UNAVAILABLE'))
      await assert.rejects(target.save(sessionId, record(sessionId), null), errorCode('INVOCATION_STORE_UNAVAILABLE'))
    }
  }
})
