import { createHash, randomUUID } from 'node:crypto'
import { createFileConversationArchiveStore } from './conversation-archive-store.js'

const SCHEMA = 'bailing.agent-conversation-outbox.v1'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const KEY = /^conn_[0-9a-f]{32}$/
const KINDS = new Set(['turn_start', 'user_message', 'assistant_message', 'run_link', 'turn_end'])
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const fail = (code = 'ARCHIVE_INVALID') => Object.assign(new Error(`Conversation archive unavailable (${code})`), { code })

function eventPayload(value) {
  const copy = structuredClone(value)
  if (!copy || !KINDS.has(copy.kind) || typeof copy.client_turn_id !== 'string' || !copy.client_turn_id || copy.client_turn_id.length > 256 ||
    Object.keys(copy).some((key) => !['kind', 'client_turn_id', 'content', 'run_id', 'member_session_id', 'status'].includes(key))) throw fail()
  const message = ['user_message', 'assistant_message'].includes(copy.kind)
  // Preserve over-limit visible text locally. The SDK rejects a message above
  // its remote limit; silently truncating it would fabricate a full transcript.
  if (message ? typeof copy.content !== 'string' : Object.hasOwn(copy, 'content')) throw fail('ARCHIVE_MESSAGE_INVALID')
  if (copy.kind === 'run_link' ? !UUID.test(copy.run_id ?? '') || !UUID.test(copy.member_session_id ?? '')
    : Object.hasOwn(copy, 'run_id') || Object.hasOwn(copy, 'member_session_id')) throw fail()
  if (copy.kind === 'turn_end' ? !['completed', 'failed', 'cancelled'].includes(copy.status) : Object.hasOwn(copy, 'status')) throw fail()
  return copy
}

function contextSnapshot(value) {
  const copy = structuredClone(value)
  if (typeof copy?.clientConversationId !== 'string' || !copy.clientConversationId || copy.clientConversationId.length > 256 ||
    !copy.binding || typeof copy.binding.hubUrl !== 'string' || typeof copy.binding.clientAppId !== 'string' || typeof copy.binding.workspace !== 'string' ||
    !Array.isArray(copy.members) || !copy.members.length || copy.members.length > 64 ||
    Object.keys(copy).some((key) => !['clientConversationId', 'binding', 'members'].includes(key)) ||
    Object.keys(copy.binding).some((key) => !['hubUrl', 'clientAppId', 'workspace'].includes(key))) throw fail('ARCHIVE_MEMBERS_INVALID')
  const keys = new Set()
  const identities = new Set()
  for (const member of copy.members) {
    if (!KEY.test(member?.connectionKey ?? '') || keys.has(member.connectionKey) || !UUID.test(member.expectedSessionId ?? '') ||
      identities.has(member.expectedSessionId) || member.workspace !== copy.binding.workspace || typeof member.label !== 'string' || member.label.length > 128 ||
      Object.keys(member).some((key) => !['connectionKey', 'workspace', 'expectedSessionId', 'label'].includes(key))) throw fail('ARCHIVE_MEMBERS_INVALID')
    keys.add(member.connectionKey)
    identities.add(member.expectedSessionId)
  }
  return copy
}

function validateRecord(record, sessionId, context) {
  if (!record || record.schema !== SCHEMA || record.sessionId !== sessionId || !Number.isSafeInteger(record.revision) || record.revision < 1 ||
    !UUID.test(record.clientArchiveId ?? '') || digest(contextSnapshot(record.context)) !== digest(context) ||
    !Number.isSafeInteger(record.acknowledged) || record.acknowledged < 0 || !Array.isArray(record.events) || record.acknowledged > record.events.length ||
    record.conversationId !== null && !UUID.test(record.conversationId ?? '') ||
    Object.keys(record).some((key) => !['schema', 'sessionId', 'revision', 'clientArchiveId', 'context', 'acknowledged', 'conversationId', 'events', 'syncState'].includes(key)) ||
    !['pending', 'synced', 'unsupported'].includes(record.syncState)) throw fail('ARCHIVE_BINDING_CHANGED')
  const sources = new Set()
  const ids = new Set()
  const turns = new Map()
  for (const [index, item] of record.events.entries()) {
    const { event_id: id, sequence, ...payload } = item?.event ?? {}
    const checked = eventPayload(payload)
    if (Object.keys(item).some((key) => !['source', 'hash', 'event'].includes(key)) || !/^[a-f0-9]{64}$/.test(item.source ?? '') || sources.has(item.source) ||
      !UUID.test(id ?? '') || ids.has(id) || sequence !== index + 1 || item.hash !== digest(checked)) throw fail('ARCHIVE_INVALID')
    if (checked.kind === 'run_link' && !context.members.some((member) => member.expectedSessionId === checked.member_session_id)) throw fail('ARCHIVE_MEMBERS_INVALID')
    const phase = turns.get(checked.client_turn_id)
    if (checked.kind === 'turn_start' ? phase !== undefined
      : checked.kind === 'run_link' ? !['started', 'ended'].includes(phase) : phase !== 'started') throw fail('ARCHIVE_EVENT_ORDER')
    if (checked.kind === 'turn_start') turns.set(checked.client_turn_id, 'started')
    if (checked.kind === 'turn_end') turns.set(checked.client_turn_id, 'ended')
    sources.add(item.source)
    ids.add(id)
  }
  return structuredClone(record)
}

/** One durable visible transcript, independent from per-authorization business runs. */
export class ConversationOutbox {
  constructor({ store = createFileConversationArchiveStore() } = {}) {
    if (typeof store?.load !== 'function' || typeof store?.save !== 'function') throw fail('ARCHIVE_STORE_INVALID')
    this.store = store
    this.entries = new Map()
  }

  serialize(entry, action) {
    const promise = (entry.queue ?? Promise.resolve()).then(action)
    entry.queue = promise.catch(() => {})
    return promise
  }

  async load(entry) {
    if (entry.record) return entry.record
    const saved = await this.store.load(entry.sessionId)
    if (saved) entry.record = validateRecord(saved, entry.sessionId, entry.context)
    else {
      const record = {
        schema: SCHEMA, sessionId: entry.sessionId, revision: 1, clientArchiveId: randomUUID(), context: entry.context,
        acknowledged: 0, conversationId: null, events: [], syncState: 'pending',
      }
      await this.store.save(entry.sessionId, record, null)
      entry.record = structuredClone(record)
    }
    return entry.record
  }

  open(sessionId, value) {
    const context = contextSnapshot(value)
    let entry = this.entries.get(sessionId)
    if (entry && digest(entry.context) !== digest(context)) throw fail('ARCHIVE_BINDING_CHANGED')
    if (!entry) {
      entry = { sessionId, context, pending: [], status: 'pending' }
      this.entries.set(sessionId, entry)
    }
    return this.serialize(entry, async () => {
      try { await this.load(entry); entry.status = entry.pending.length ? 'storage_error' : entry.record.syncState; return this.status(sessionId) }
      catch (error) { entry.status = 'storage_error'; throw error }
    })
  }

  async save(entry, values) {
    const previous = entry.record
    const record = validateRecord({ ...previous, ...values, revision: previous.revision + 1 }, entry.sessionId, entry.context)
    await this.store.save(entry.sessionId, record, previous.revision)
    entry.record = record
  }

  append(sessionId, source, payload) {
    const entry = this.entries.get(sessionId)
    if (!entry) throw fail('ARCHIVE_NOT_OPEN')
    // Capture before awaits; never retain mutable host messages or model chunks.
    const item = { source: digest(String(source)), payload: eventPayload(payload) }
    entry.pending.push(item)
    return this.serialize(entry, () => this.persistPending(entry))
  }

  async persistPending(entry) {
    try {
      await this.load(entry)
      const count = entry.pending.length
      const events = structuredClone(entry.record.events)
      for (const pending of entry.pending.slice(0, count)) {
        const hash = digest(pending.payload)
        const existing = events.find((event) => event.source === pending.source)
        if (existing) {
          if (existing.hash !== hash) throw fail('ARCHIVE_EVENT_CONFLICT')
          continue
        }
        events.push({ source: pending.source, hash, event: { event_id: randomUUID(), sequence: events.length + 1, ...pending.payload } })
      }
      if (events.length !== entry.record.events.length) await this.save(entry, { events, syncState: 'pending' })
      entry.pending.splice(0, count)
      entry.status = entry.record.syncState
      return this.status(entry.sessionId)
    } catch (error) { entry.status = 'storage_error'; throw error }
  }

  status(sessionId) {
    const entry = this.entries.get(sessionId)
    if (!entry) return { state: 'inactive', pendingEvents: 0 }
    return {
      state: entry.status, pendingEvents: (entry.record?.events.length ?? 0) - (entry.record?.acknowledged ?? 0),
      unsavedEvents: entry.pending.length, acknowledgedSequence: entry.record?.acknowledged ?? 0,
      ...(entry.record?.conversationId ? { conversationId: entry.record.conversationId } : {}),
    }
  }

  coverage(sessionId, expected) {
    const events = this.entries.get(sessionId)?.record?.events ?? []
    if (!Array.isArray(expected) || expected.length === 0 && events.length > 0) return { coverage: 'unverified' }
    const available = new Map()
    const signature = (event) => digest(['user_message', 'assistant_message'].includes(event.kind)
      ? { kind: event.kind, content: event.content }
      : { kind: event.kind, client_turn_id: event.client_turn_id, ...(event.status ? { status: event.status } : {}) })
    for (const { event } of events) {
      if (event.kind === 'run_link') continue
      const key = signature(event)
      available.set(key, (available.get(key) ?? 0) + 1)
    }
    let missing = 0
    for (const event of expected) {
      const key = signature(event)
      const count = available.get(key) ?? 0
      if (count) available.set(key, count - 1)
      else missing += 1
    }
    return missing ? { coverage: 'incomplete', missingVisibleEvents: missing } : { coverage: 'available_host_history_checked' }
  }

  sync(sessionId, send) {
    const entry = this.entries.get(sessionId)
    if (!entry) return Promise.resolve(this.status(sessionId))
    if (entry.syncing) return entry.syncing
    entry.syncing = (async () => {
      while (true) {
        const snapshot = await this.serialize(entry, async () => {
          await this.persistPending(entry)
          return structuredClone(entry.record)
        })
        try {
          const ack = await send({
            clientArchiveId: snapshot.clientArchiveId, clientConversationId: snapshot.context.clientConversationId,
            events: snapshot.events.slice(snapshot.acknowledged).map((item) => item.event),
          }, { members: structuredClone(snapshot.context.members) })
          if (ack?.schema !== 'bailing.agent-conversation-audit-ack.v1' || !UUID.test(ack.conversation_id ?? '') ||
            !Number.isSafeInteger(ack.last_sequence) || ack.last_sequence < snapshot.acknowledged || ack.last_sequence > snapshot.events.length ||
            snapshot.conversationId && ack.conversation_id !== snapshot.conversationId) throw fail('ARCHIVE_ACK_INVALID')
          await this.serialize(entry, async () => {
            await this.save(entry, {
              acknowledged: ack.last_sequence, conversationId: ack.conversation_id,
              syncState: ack.last_sequence === entry.record.events.length ? 'synced' : 'pending',
            })
            entry.status = entry.pending.length ? 'storage_error' : entry.record.syncState
          })
          // A final reply may arrive while an earlier batch is in flight. Drain
          // newly captured events after success, without looping on failures.
          await this.serialize(entry, () => this.persistPending(entry))
          if (ack.last_sequence === snapshot.events.length && entry.record.events.length > snapshot.events.length) continue
        } catch (error) {
          await this.serialize(entry, async () => {
            const state = error?.status === 404 || error?.statusCode === 404 || error?.code === 'ARCHIVE_UNSUPPORTED' ? 'unsupported' : 'pending'
            try { await this.save(entry, { syncState: state }); entry.status = entry.pending.length ? 'storage_error' : state }
            catch { entry.status = 'storage_error' }
          })
        }
        return this.status(sessionId)
      }
    })().catch(() => { entry.status = 'storage_error'; return this.status(sessionId) }).finally(() => { entry.syncing = undefined })
    return entry.syncing
  }

  async drain(sessionId) {
    const entry = this.entries.get(sessionId)
    await entry?.queue
    return this.status(sessionId)
  }
}
