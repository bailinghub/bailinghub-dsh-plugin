import assert from 'node:assert/strict'
import test from 'node:test'

import { SessionScopeCoordinator } from '../lib/session-scope.js'
import { createMemorySessionScopeStore } from '../lib/session-scope-store.js'

const A = `conn_${'a'.repeat(32)}`
const B = `conn_${'b'.repeat(32)}`
const C = `conn_${'c'.repeat(32)}`
const binding = { hubUrl: 'https://hub.example.com', clientAppId: 'scope_test', workspace: 'demo' }
const ids = new Map([[A, '123e4567-e89b-42d3-a456-426614179001'], [B, '123e4567-e89b-42d3-a456-426614179002']])

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

async function fixture() {
  const store = createMemorySessionScopeStore()
  const calls = []
  const server = { registry: [A, B, C].map((connectionKey) => ({ ...binding, connectionKey, state: 'authorized' })), beforeStatus: async () => {} }
  const transport = {
    async connectionsList() { return { currentConnectionKey: C, connections: structuredClone(server.registry) } },
    async status({ connectionKey }) {
      calls.push(connectionKey)
      const override = await server.beforeStatus(connectionKey)
      return override ?? { state: 'authorized', connectionKey, workspace: binding.workspace, sessionId: ids.get(connectionKey) }
    },
  }
  const create = () => new SessionScopeCoordinator({
    store, getTransport: async () => transport, normalizeConfig: (value) => ({ ...value, valid: Boolean(value.hubUrl && value.clientAppId && value.workspace) }), sanitize: String,
  })
  const first = create()
  await first.set('same-session', { connectionKeys: [A, B] })
  await first.begin('same-session')
  calls.length = 0
  return { store, server, calls, create, coordinator: create(), original: await store.load('same-session') }
}

for (const method of ['get', 'restore', 'begin']) {
  test(`${method} recovers a transient authorization failure on the same coordinator without rewriting scope`, async () => {
    const f = await fixture()
    f.server.beforeStatus = async () => { throw new TypeError('fetch failed') }
    for (let attempt = 0; attempt < 3; attempt++) {
      assert.equal((await f.coordinator[method]('same-session')).mode, 'blocked')
      assert.throws(() => f.coordinator.assertCurrent('same-session'))
      assert.deepEqual(await f.store.load('same-session'), f.original)
    }
    f.calls.length = 0
    f.server.beforeStatus = async () => {}
    const recovered = await f.coordinator[method]('same-session')
    assert.equal(recovered.mode, 'business')
    assert.deepEqual(recovered.authorizations.map((item) => item.connectionKey), [A, B])
    assert.deepEqual(f.calls, [A, B])
    assert.deepEqual(await f.store.load('same-session'), f.original)
    f.coordinator.assertCurrent('same-session')
  })
}

test('partial revalidation never opens the dispatch gate and overlapping retries share the same whole-member proof', async () => {
  const f = await fixture()
  const inspecting = deferred(), release = deferred()
  f.server.beforeStatus = async (key) => { if (key === B) { inspecting.resolve(); await release.promise } }
  const restoring = f.coordinator.restore('same-session')
  await inspecting.promise
  assert.throws(() => f.coordinator.assertCurrent('same-session'))
  const reading = f.coordinator.get('same-session')
  await new Promise((resolve) => setImmediate(resolve))
  assert.throws(() => f.coordinator.assertCurrent('same-session'))
  release.resolve()
  assert.equal((await restoring).mode, 'business')
  assert.equal((await reading).mode, 'business')
  assert.deepEqual(f.calls, [A, B])
})

for (const invalidate of [() => undefined, () => new Error('temporary status failure')]) {
  test(`an in-flight success cannot clear a newer ${invalidate() ? 'temporary' : 'terminal'} invalidation`, async () => {
    const f = await fixture()
    const inspecting = deferred(), release = deferred()
    f.server.beforeStatus = async (key) => { if (key === B) { inspecting.resolve(); await release.promise } }
    const restoring = f.coordinator.restore('same-session')
    await inspecting.promise
    const error = invalidate()
    f.coordinator.invalidate('same-session', error)
    release.resolve()
    assert.equal((await restoring).mode, 'blocked')
    assert.throws(() => f.coordinator.assertCurrent('same-session'))
    f.server.beforeStatus = async () => {}
    assert.equal((await f.coordinator.restore('same-session')).mode, error ? 'business' : 'blocked')
  })
}

test('a scope CAS change during a network probe remains terminal after network recovery', async () => {
  const f = await fixture()
  const inspecting = deferred(), release = deferred()
  f.server.beforeStatus = async (key) => { if (key === B) { inspecting.resolve(); await release.promise } }
  const restoring = f.coordinator.restore('same-session')
  await inspecting.promise
  await f.store.save('same-session', { ...f.original, revision: f.original.revision + 1 }, f.original.revision)
  release.resolve()
  assert.equal((await restoring).mode, 'blocked')
  f.server.beforeStatus = async () => {}
  assert.equal((await f.coordinator.restore('same-session')).mode, 'blocked')
})

for (const response of [{}, { state: 'authorized' }, { state: 'unavailable' },
  { connectionKey: B, workspace: binding.workspace },
  { state: 'unavailable', connectionKey: A, workspace: 'other' }]) {
  test(`an incomplete status ${JSON.stringify(response)} remains closed but can be verified again`, async () => {
    const f = await fixture()
    f.server.beforeStatus = async () => response
    assert.equal((await f.coordinator.restore('same-session')).mode, 'blocked')
    f.server.beforeStatus = async () => {}
    assert.equal((await f.coordinator.restore('same-session')).mode, 'business')
  })
}

for (const change of [
  () => ({ state: 'logged_out', connectionKey: B, workspace: binding.workspace }),
  () => ({ state: 'authorized', connectionKey: B, workspace: binding.workspace, sessionId: ids.get(A) }),
  () => { throw Object.assign(new Error('authorization rejected'), { name: 'AgentAuthHttpError', statusCode: 403 }) },
]) {
  test('confirmed authorization loss or replacement remains blocked even if a later probe could succeed', async () => {
    const f = await fixture()
    f.server.beforeStatus = async (key) => key === B ? change() : undefined
    assert.equal((await f.coordinator.restore('same-session')).mode, 'blocked')
    const checked = f.calls.length
    f.server.beforeStatus = async () => {}
    assert.equal((await f.coordinator.restore('same-session')).mode, 'blocked')
    assert.equal(f.calls.length, checked)
    assert.deepEqual(await f.store.load('same-session'), f.original)
  })
}
