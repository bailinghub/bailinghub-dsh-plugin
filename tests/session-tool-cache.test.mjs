import test from 'node:test'
import assert from 'node:assert/strict'
import { SessionToolCache } from '../lib/session-tool-cache.js'

const tool = (name, properties = {}) => ({ name, description: `Use ${name}`, parameters: {
  type: 'object', properties: { product_id: { type: 'string' } }, required: ['product_id'],
}, scope: ['products:read'], risk: 'low', approvalRequired: false, readonly: true, idempotent: true, ...properties })
const merge = (cache, targetKey, tools, capabilityRevision = 'revision-1') => cache.merge(targetKey, { capabilityRevision, tools })
const names = (cache, targetKey) => cache.get(targetKey)?.tools.map((item) => item.name) ?? []

test('caches only a normalized complete declaration, never prior execution state', () => {
  const cache = new SessionToolCache()
  const original = tool('product_query', {
    run: { id: 'old-run' }, context: { business: 'old context' }, credentials: { secret: 'fixture-secret' },
    arguments: { product_id: '123' }, results: { stock: 1 }, unknown: 'ignored',
  })
  merge(cache, 'trusted:A', [original])
  const saved = cache.get('trusted:A')
  assert.deepEqual(saved.tools, [tool('product_query')])
  original.parameters.properties.product_id.type = 'number'
  assert.equal(saved.tools[0].parameters.properties.product_id.type, 'string')
  assert.throws(() => { saved.tools[0].parameters.properties.product_id.type = 'boolean' }, TypeError)
  assert.throws(() => saved.tools.push(tool('another')), TypeError)
  assert.equal(cache.get('trusted:A').tools[0].parameters.properties.product_id.type, 'string')
  assert.equal(cache.view().toolCount, 1)
})

test('partial search responses merge and an empty response does not erase earlier tools', () => {
  const cache = new SessionToolCache()
  merge(cache, 'A', [tool('product_query')])
  merge(cache, 'A', [tool('product_create')])
  merge(cache, 'A', [])
  assert.deepEqual(names(cache, 'A'), ['product_query', 'product_create'])
})

test('separates target identities, sessions, and complete declarations for the same tool name', () => {
  const first = new SessionToolCache()
  const second = new SessionToolCache()
  merge(first, 'system-1:A', [tool('query', { description: 'Store A products' })])
  merge(first, 'system-1:B', [tool('query', { description: 'Store B products' })])
  merge(first, 'system-2:D', [tool('query', { description: 'Inventory D' })])
  assert.equal(first.view().toolCount, 3)
  assert.equal(first.get('system-2:D').tools[0].description, 'Inventory D')
  assert.equal(second.get('system-1:A'), null)
})

test('global LRU respects actual touches but get and repeated search do not renew tools', () => {
  const cache = new SessionToolCache({ maxTools: 3 })
  merge(cache, 'A', [tool('first'), tool('second')])
  merge(cache, 'B', [tool('third')])
  cache.get('A')
  merge(cache, 'A', [tool('first')])
  assert.equal(cache.touch('A', 'second'), true)
  assert.equal(cache.touch('missing', 'none'), false)
  const added = merge(cache, 'B', [tool('fourth')])
  assert.deepEqual(added.evicted, [{ targetKey: 'A', name: 'first' }])
  assert.deepEqual(names(cache, 'A'), ['second'])
  assert.deepEqual(names(cache, 'B'), ['third', 'fourth'])
})

test('default limit retains at most 64 target-tool pairs across systems', () => {
  const cache = new SessionToolCache()
  merge(cache, 'A', Array.from({ length: 40 }, (_, i) => tool(`a_${i}`)))
  const result = merge(cache, 'B', Array.from({ length: 40 }, (_, i) => tool(`b_${i}`)))
  assert.equal(cache.view().toolCount, 64)
  assert.equal(result.evicted.length, 16)
  assert.equal(names(cache, 'A')[0], 'a_16')
  assert.equal(names(cache, 'B').length, 40)
})

test('canonical JSON key ordering does not create a false conflict', () => {
  const cache = new SessionToolCache()
  merge(cache, 'A', [tool('query')])
  const same = tool('query')
  same.parameters = { required: ['product_id'], properties: { product_id: { type: 'string' } }, type: 'object' }
  const result = merge(cache, 'A', [same])
  assert.deepEqual(result.conflicts, [])
  assert.equal(result.tools.length, 1)
})

test('same-revision conflicts quarantine a name through eviction and repeated discovery', () => {
  const cache = new SessionToolCache({ maxTools: 2 })
  merge(cache, 'A', [tool('query'), tool('create')])
  const conflict = merge(cache, 'A', [tool('query', { readonly: false })])
  assert.deepEqual(conflict.conflicts, ['query'])
  assert.deepEqual(names(cache, 'A'), ['create'])
  merge(cache, 'B', [tool('other'), tool('another')])
  assert.deepEqual(names(cache, 'A'), [])
  const replay = merge(cache, 'A', [tool('query')])
  assert.deepEqual(replay.conflicts, ['query'])
  assert.deepEqual(replay.skipped, [{ name: 'query', reason: 'declaration_conflict' }])
  assert.deepEqual(replay.tools, [])
})

test('a new authoritative revision resets only its target declarations and quarantine', () => {
  const cache = new SessionToolCache()
  merge(cache, 'A', [tool('query')])
  merge(cache, 'A', [tool('query', { readonly: false })])
  merge(cache, 'B', [tool('other')])
  const result = merge(cache, 'A', [tool('query', { readonly: false })], 'revision-2')
  assert.equal(result.revisionChanged, true)
  assert.deepEqual(result.conflicts, [])
  assert.equal(result.tools[0].readonly, false)
  assert.deepEqual(names(cache, 'B'), ['other'])
})

test('invalidate clears reusable tools but preserves revision and name conflicts for rediscovery', () => {
  const cache = new SessionToolCache()
  merge(cache, 'A', [tool('query'), tool('create')])
  merge(cache, 'A', [tool('query', { description: 'Conflicting query' })])
  merge(cache, 'B', [tool('other')])
  assert.equal(cache.invalidate('missing'), false)
  assert.equal(cache.invalidate('A'), true)
  assert.deepEqual(cache.get('A'), {
    capabilityRevision: 'revision-1', tools: [], conflicts: ['query'], quarantined: false,
  })
  assert.deepEqual(names(cache, 'B'), ['other'])
  const rediscovered = merge(cache, 'A', [tool('query'), tool('create')])
  assert.deepEqual(rediscovered.tools, [tool('create')])
  assert.deepEqual(rediscovered.skipped, [{ name: 'query', reason: 'declaration_conflict' }])
  assert.equal(cache.invalidate('A'), true)
  assert.equal(cache.invalidate('A'), true)
})

test('invalidate cannot clear a whole-revision quarantine', () => {
  const cache = new SessionToolCache({ maxTools: 1 })
  for (const name of ['first', 'second']) {
    merge(cache, 'A', [tool(name)])
    merge(cache, 'A', [tool(name, { description: 'Different declaration' })])
  }
  assert.equal(cache.get('A').quarantined, true)
  assert.equal(cache.invalidate('A'), true)
  assert.equal(cache.get('A').capabilityRevision, 'revision-1')
  assert.equal(cache.get('A').quarantined, true)
  assert.deepEqual(merge(cache, 'A', [tool('first')]).tools, [])
  assert.deepEqual(merge(cache, 'A', [tool('first')], 'revision-2').tools, [tool('first')])
})

test('too many conflict tombstones quarantine the whole revision without forgetting safety state', () => {
  const cache = new SessionToolCache({ maxTools: 1 })
  for (const name of ['first', 'second']) {
    merge(cache, 'A', [tool(name)])
    merge(cache, 'A', [tool(name, { description: 'Different declaration' })])
  }
  assert.equal(cache.get('A').quarantined, true)
  assert.deepEqual(merge(cache, 'A', [tool('first')]).tools, [])
  assert.deepEqual(merge(cache, 'A', [tool('third')]).skipped, [{ name: 'third', reason: 'declaration_conflict' }])
  const changed = merge(cache, 'A', [tool('first')], 'revision-2')
  assert.equal(changed.quarantined, false)
  assert.deepEqual(changed.tools, [tool('first')])
})

test('byte budget includes metadata and UTF-8 schemas and reports bounded eviction', () => {
  const cache = new SessionToolCache({ maxBytes: 1400 })
  merge(cache, 'A', [tool('first', { description: '文'.repeat(120) })])
  const result = merge(cache, 'B', [tool('second', { description: '文'.repeat(120) }), tool('third')])
  assert.ok(cache.view().bytes <= 1400)
  assert.ok(result.evicted.length > 0)
  assert.equal(cache.view().bytes, Buffer.byteLength(JSON.stringify({ targets: cache.view().targets })))
})

test('an oversized schema is skipped without evicting other useful declarations', () => {
  const cache = new SessionToolCache({ maxBytes: 1000 })
  merge(cache, 'A', [tool('valid')])
  const result = merge(cache, 'A', [tool('oversized', { description: 'x'.repeat(3000) })])
  assert.deepEqual(result.skipped, [{ name: 'oversized', reason: 'declaration_too_large' }])
  assert.deepEqual(result.evicted, [])
  assert.deepEqual(names(cache, 'A'), ['valid'])
  assert.ok(cache.view().bytes <= 1000)
})

test('target metadata cap refuses new targets without dropping conflict tombstones', () => {
  const cache = new SessionToolCache({ maxTargets: 1 })
  merge(cache, 'A', [tool('query')])
  merge(cache, 'A', [tool('query', { description: 'conflicting' })])
  const result = merge(cache, 'B', [tool('query')])
  assert.equal(result.cached, false)
  assert.deepEqual(result.skipped, [{ name: null, reason: 'target_limit' }])
  assert.equal(cache.get('B'), null)
  assert.deepEqual(cache.get('A').conflicts, ['query'])
})

test('metadata that cannot fit is rejected without evicting useful existing tools', () => {
  const cache = new SessionToolCache({ maxBytes: 500 })
  merge(cache, 'A', [tool('query')])
  const result = merge(cache, 'x'.repeat(500), [])
  assert.equal(result.cached, false)
  assert.deepEqual(result.skipped, [{ name: null, reason: 'metadata_limit' }])
  assert.deepEqual(names(cache, 'A'), ['query'])
  assert.ok(cache.view().bytes <= 500)
  assert.equal(cache.view().targetCount, 1)
})

test('tiny byte budgets remain bounded even before any entry can fit', () => {
  const cache = new SessionToolCache({ maxBytes: 14 })
  assert.equal(cache.view().bytes, 14)
  assert.equal(merge(cache, 'A', [tool('query')]).cached, false)
  assert.equal(cache.view().bytes, 14)
  assert.equal(cache.get('A'), null)
  assert.throws(() => new SessionToolCache({ maxBytes: 13 }), TypeError)
})

test('large revision metadata cannot replace safe cache state or exceed the byte bound', () => {
  const cache = new SessionToolCache({ maxBytes: 250 })
  merge(cache, 'A', [])
  const original = cache.get('A')
  const result = merge(cache, 'A', [], 'r'.repeat(250))
  assert.equal(result.cached, false)
  assert.deepEqual(cache.get('A'), original)
  assert.ok(cache.view().bytes <= 250)
})

test('unknown revision and malformed declarations cannot silently enter the cache', () => {
  const cache = new SessionToolCache()
  assert.equal(merge(cache, 'A', [tool('query')], '').cached, false)
  assert.equal(cache.get('A'), null)
  const result = merge(cache, 'A', [{ name: 'bad', parameters: null }, tool('good')])
  assert.deepEqual(result.skipped, [{ name: null, reason: 'invalid_declaration' }])
  assert.deepEqual(names(cache, 'A'), ['good'])
  assert.throws(() => merge(cache, '', []), TypeError)
})

test('clear removes all session memory and bounds cannot be increased by configuration', () => {
  const cache = new SessionToolCache()
  merge(cache, 'A', [tool('query')])
  cache.clear()
  assert.equal(cache.get('A'), null)
  assert.equal(cache.view().toolCount, 0)
  assert.equal(cache.view().targetCount, 0)
  assert.throws(() => new SessionToolCache({ maxTools: 65 }), TypeError)
  assert.throws(() => new SessionToolCache({ maxTargets: 65 }), TypeError)
  assert.throws(() => new SessionToolCache({ maxBytes: 2 * 1024 * 1024 + 1 }), TypeError)
  assert.throws(() => { cache.maxTools = 100 }, TypeError)
})
