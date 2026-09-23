import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileSessionUsageStore, createMemorySessionUsageStore } from '../lib/session-usage-store.js'
const id = 'model:synthetic-session:original'
const record = revision => ({ schema: 'bailing.usage-session.v1', sessionId: id, revision,
  entries: [{ request: { metadata: { schema: 'bailing.model-request.v1', operationId: 'original', requestHash: 'a'.repeat(64) }, state: 'prepared' } }] })

test('request sidecar CAS persists exact metadata and rejects mismatched revisions', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'model-store-')); t.after(() => rm(directory, { recursive: true, force: true }))
  const store = createFileSessionUsageStore({ directory }); await store.save(id, record(1), null)
  const reopened = createFileSessionUsageStore({ directory }); assert.deepEqual(await reopened.load(id), record(1))
  await assert.rejects(reopened.save(id, record(2), null), { code: 'USAGE_STORE_UNAVAILABLE' })
  await reopened.save(id, record(2), 1)
  await assert.rejects(store.save(id, record(2), 1), { code: 'USAGE_STORE_CONFLICT' })
  assert.equal((await store.load(id)).revision, 2)
  for (const name of await readdir(directory)) assert.equal((await readFile(join(directory, name), 'utf8')).includes('bhu_s_'), false)
})

test('request store accepts only one model request metadata record and never body or credentials', async () => {
  const store = createMemorySessionUsageStore()
  for (const mutate of [r => { r.entries = [] }, r => { r.entries.push(r.entries[0]) }, r => { r.entries[0] = { turns: [] } },
    r => { r.entries[0].request.metadata.schema = 'unrelated' }, r => { r.entries[0].request.metadata.messages = [] },
    r => { r.entries[0].request.metadata.access_token = 'synthetic' }, r => { r.entries[0].request.state = 'unknown-state' }]) {
    const candidate = record(1); mutate(candidate)
    await assert.rejects(store.save(id, candidate, null), { code: 'USAGE_STORE_UNAVAILABLE' })
  }
  assert.equal(await store.load(id), null)
})
