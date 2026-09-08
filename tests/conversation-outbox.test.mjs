import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ConversationOutbox } from '../lib/conversation-outbox.js'
import { createFileConversationArchiveStore, createMemoryConversationArchiveStore } from '../lib/conversation-archive-store.js'
import { createLazySdkTransport } from '../lib/transport.js'
import { createMockTransport } from './helpers/mock-host.mjs'

const SESSION = '123e4567-e89b-42d3-a456-426614179001'
const REMOTE = '123e4567-e89b-42d3-a456-426614179002'
const context = () => ({
  clientConversationId: 'dsh.conversation.same-legacy-correlation',
  binding: { hubUrl: 'https://hub.example.com', clientAppId: 'dsh_client', workspace: 'demo' },
  members: [{ connectionKey: `conn_${'1'.repeat(32)}`, expectedSessionId: SESSION, workspace: 'demo', label: 'Store A' }],
})
const event = (kind, extra = {}) => ({ kind, client_turn_id: 'dsh.turn.one', ...extra })
const ack = (sequence) => ({ schema: 'bailing.agent-conversation-audit-ack.v1', conversation_id: REMOTE, last_sequence: sequence })

async function setup(t, file = false) {
  const directory = file ? await mkdtemp(join(tmpdir(), 'bailinghub-archive-')) : undefined
  if (directory) t.after(() => rm(directory, { recursive: true, force: true }))
  const store = file ? createFileConversationArchiveStore({ directory }) : createMemoryConversationArchiveStore()
  const outbox = new ConversationOutbox({ store })
  await outbox.open('local-session', context())
  await outbox.append('local-session', 'start', event('turn_start'))
  return { directory, store, outbox }
}

test('archive file preserves random identity, exact payload and frozen members across a failed sync and restart', async (t) => {
  const { directory, store, outbox } = await setup(t, true)
  await outbox.append('local-session', 'u1', event('user_message', { content: 'Compare Store A and Store B.' }))
  const record = await store.load('local-session')
  assert.match(record.clientArchiveId, /^[a-f0-9-]{36}$/)
  let sent
  assert.equal((await outbox.sync('local-session', async (input) => { sent = structuredClone(input); throw new Error('offline') })).state, 'pending')
  const restored = new ConversationOutbox({ store: createFileConversationArchiveStore({ directory }) })
  await restored.open('local-session', context())
  assert.equal((await restored.sync('local-session', async (input, options) => {
    assert.deepEqual(input, sent)
    assert.deepEqual(options.members, context().members)
    return ack(2)
  })).state, 'synced')
  assert.equal((await store.load('local-session')).clientArchiveId, record.clientArchiveId)
  if (process.platform !== 'win32') assert.equal((await stat(directory)).mode & 0o777, 0o700)
  const files = await readdir(directory)
  assert.equal(files.length, 1)
  if (process.platform !== 'win32') assert.equal((await stat(join(directory, files[0]))).mode & 0o777, 0o600)
  assert.equal(JSON.parse(await readFile(join(directory, files[0]), 'utf8')).events.length, 2)
  const another = new ConversationOutbox({ store: createMemoryConversationArchiveStore() })
  await another.open('local-session', context())
  assert.notEqual(another.entries.get('local-session').record.clientArchiveId, record.clientArchiveId)
})

test('append snapshots before awaits and deduplicates stable source ids without changing event ids', async (t) => {
  const { store, outbox } = await setup(t)
  const payload = event('user_message', { content: 'original' })
  const promise = outbox.append('local-session', 'u1', payload)
  payload.content = 'mutated'
  await promise
  const before = await store.load('local-session')
  await outbox.append('local-session', 'u1', event('user_message', { content: 'original' }))
  assert.deepEqual((await store.load('local-session')).events, before.events)
  await assert.rejects(outbox.append('local-session', 'u1', event('user_message', { content: 'changed' })), { code: 'ARCHIVE_EVENT_CONFLICT' })
  assert.equal((await outbox.sync('local-session', async () => assert.fail('conflicting local event must not upload'))).state, 'storage_error')
})

test('frozen membership and binding cannot be replaced on restart', async (t) => {
  const { store } = await setup(t)
  const changed = context()
  changed.members[0].expectedSessionId = REMOTE
  await assert.rejects(new ConversationOutbox({ store }).open('local-session', changed), { code: 'ARCHIVE_BINDING_CHANGED' })
  const hostChanged = context()
  hostChanged.binding.hubUrl = 'https://another.example.com'
  await assert.rejects(new ConversationOutbox({ store }).open('local-session', hostChanged), { code: 'ARCHIVE_BINDING_CHANGED' })
})

test('ambiguous acknowledgement retries identical ids and payload without dropping pending events', async (t) => {
  const { outbox } = await setup(t)
  let original
  await outbox.sync('local-session', async (input) => { original = input; throw new Error('response lost after server accepted') })
  assert.equal((await outbox.sync('local-session', async (input) => { assert.deepEqual(input, original); return ack(1) })).state, 'synced')
  await outbox.append('local-session', 'end', event('turn_end', { status: 'completed' }))
  assert.equal((await outbox.sync('local-session', async () => ack(99))).state, 'pending')
  assert.equal(outbox.status('local-session').acknowledgedSequence, 1)
})

test('late visible events are drained after the current successful in-flight batch', async (t) => {
  const { outbox } = await setup(t)
  let release
  let started
  const gate = new Promise((resolve) => { release = resolve })
  const ready = new Promise((resolve) => { started = resolve })
  const batches = []
  const pending = outbox.sync('local-session', async (input) => {
    batches.push(input)
    if (batches.length === 1) { started(); await gate }
    return ack(input.events.at(-1)?.sequence ?? 0)
  })
  await ready
  await outbox.append('local-session', 'answer', event('assistant_message', { content: 'Visible answer' }))
  await outbox.append('local-session', 'end', event('turn_end', { status: 'completed' }))
  release()
  assert.equal((await pending).state, 'synced')
  assert.deepEqual(batches.map((batch) => batch.events.map((item) => item.sequence)), [[1], [2, 3]])
})

test('temporary local save failure retains unsaved order and retry persists before upload', async (t) => {
  const memory = createMemoryConversationArchiveStore()
  let failSave = false
  const store = { load: memory.load, save: (...args) => failSave ? Promise.reject(new Error('disk full')) : memory.save(...args) }
  const outbox = new ConversationOutbox({ store })
  await outbox.open('local-session', context())
  failSave = true
  await assert.rejects(outbox.append('local-session', 'start', event('turn_start')))
  await assert.rejects(outbox.append('local-session', 'u1', event('user_message', { content: 'Retain me' })))
  assert.equal(outbox.status('local-session').unsavedEvents, 2)
  failSave = false
  assert.equal((await outbox.sync('local-session', async (input) => {
    assert.deepEqual(input.events.map((item) => item.kind), ['turn_start', 'user_message'])
    assert.equal((await memory.load('local-session')).events.length, 2)
    return ack(2)
  })).state, 'synced')
})

test('remote unsupported and oversized messages remain pending without truncation', async (t) => {
  const { store, outbox } = await setup(t)
  const content = '文'.repeat(64_001)
  await outbox.append('local-session', 'u1', event('user_message', { content }))
  assert.equal((await outbox.sync('local-session', async () => { throw { status: 404 } })).state, 'unsupported')
  assert.equal((await outbox.sync('local-session', async (input) => {
    assert.equal(input.events[1].content, content)
    throw { status: 413 }
  })).state, 'pending')
  assert.equal((await store.load('local-session')).events[1].event.content.length, 64_001)
})

test('a late network failure cannot hide an unsaved visible event after a metadata-only save succeeds', async () => {
  const memory = createMemoryConversationArchiveStore()
  let rejectEvents = false
  const store = {
    load: memory.load,
    async save(id, record, revision) {
      if (rejectEvents && record.events.length > (await memory.load(id)).events.length) throw new Error('synthetic local save failure')
      return memory.save(id, record, revision)
    },
  }
  const outbox = new ConversationOutbox({ store })
  await outbox.open('local-session', context())
  await outbox.append('local-session', 'start', event('turn_start'))
  let release, entered
  const gate = new Promise((resolve) => { release = resolve })
  const sending = new Promise((resolve) => { entered = resolve })
  const pending = outbox.sync('local-session', async () => { entered(); await gate; throw new Error('synthetic network failure') })
  await sending
  rejectEvents = true
  await assert.rejects(outbox.append('local-session', 'answer', event('assistant_message', { content: 'Synthetic final answer' })))
  const before = await memory.load('local-session')
  release()
  const failed = await pending
  assert.equal(failed.state, 'storage_error')
  assert.equal(failed.unsavedEvents, 1)
  const after = await memory.load('local-session')
  assert.equal(after.acknowledged, before.acknowledged)
  assert.deepEqual(after.events, before.events)
  rejectEvents = false
  assert.equal((await outbox.sync('local-session', async (input) => {
    assert.deepEqual(input.events.map((item) => item.sequence), [1, 2])
    return ack(2)
  })).state, 'synced')
})

test('event order and run membership are validated before persistence', async (t) => {
  const { store, outbox } = await setup(t)
  await assert.rejects(outbox.append('local-session', 'foreign-run', event('run_link', { run_id: REMOTE, member_session_id: REMOTE })), { code: 'ARCHIVE_MEMBERS_INVALID' })
  assert.equal((await store.load('local-session')).events.length, 1)
  const fresh = new ConversationOutbox({ store })
  await fresh.open('local-session', context())
  await fresh.append('local-session', 'end', event('turn_end', { status: 'cancelled' }))
  await assert.rejects(fresh.append('local-session', 'late', event('assistant_message', { content: 'after end' })), { code: 'ARCHIVE_EVENT_ORDER' })
})

test('private archive file rejects a symlink and stale concurrent writers', async (t) => {
  const { directory, store, outbox } = await setup(t, true)
  const second = new ConversationOutbox({ store })
  await second.open('local-session', context())
  await outbox.append('local-session', 'u1', event('user_message', { content: 'first writer' }))
  await assert.rejects(second.append('local-session', 'u2', event('user_message', { content: 'stale writer' })), { code: 'ARCHIVE_STORE_CONFLICT' })
  const filename = (await readdir(directory))[0]
  const path = join(directory, filename)
  const original = await readFile(path)
  await rm(path)
  const target = join(directory, 'target')
  await writeFile(target, original, { mode: 0o600 })
  await symlink(target, path)
  await assert.rejects(store.load('local-session'), { code: 'ARCHIVE_STORE_UNAVAILABLE' })
})

test('lazy SDK capability detection preserves the old required business facade', async () => {
  const original = createMockTransport()
  const transport = createLazySdkTransport({}, { importModule: async () => ({ createAgentClientTransport: () => original.transport }) })
  assert.equal(await transport.supportsConversationArchive(), false)
  await assert.rejects(transport.syncConversationArchive({}, {}), { code: 'ARCHIVE_UNSUPPORTED' })
  assert.equal((await transport.startTurn({})).schema_version, 'bailing.agent-turn-context.v1')
})
