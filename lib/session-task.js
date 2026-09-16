import { memberBinding } from './session-scope.js'
import { metadataHash, scopeFingerprint } from './invocation-journal.js'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const HASH = /^[a-f0-9]{64}$/
const SCHEMA = 'bailing.agent-session-task.v1'
const TASK_STATES = new Set(['active', 'paused', 'blocked', 'cancelled'])
const copy = value => structuredClone(value)

export function taskError(code) {
  return Object.assign(new Error('The original task binding cannot currently permit this operation.'), {
    publicCode: code,
    feedback: { schema: 'bailing.agent-feedback.v1', origin: 'dsh', operation: 'task_control', code,
      category: code.startsWith('TASK_STORE_') ? 'storage_error' : code === 'TASK_UNSUPPORTED' ? 'unsupported' : 'task_control',
      dispatch: 'not_dispatched', next_action: code.startsWith('TASK_STORE_') ? 'restore_task' : code === 'TASK_UNSUPPORTED' ? 'check_compatibility' : 'inspect_task' },
  })
}

/** Host-only immutable association. It cannot create, control, or enlarge a task. */
export class SessionTaskCoordinator {
  constructor({ store, scopes, getTransport, conversationId }) {
    if (store != null && (typeof store.load !== 'function' || typeof store.save !== 'function')) throw new TypeError('A task store with load/save is required')
    Object.assign(this, { store, scopes, getTransport, conversationId })
    this.entries = new Map()
    this.queues = new Map()
    this.supportedBindings = new Set()
  }

  entry(id) {
    if (!this.entries.has(id)) this.entries.set(id, { record: null, pending: null, snapshot: null, failure: null })
    return this.entries.get(id)
  }

  serial(id, operation) {
    const result = (this.queues.get(id) ?? Promise.resolve()).then(operation)
    this.queues.set(id, result.catch(() => {}))
    return result
  }

  validate(raw, id) {
    if (!raw || raw.schema !== SCHEMA || raw.sessionId !== id || raw.revision !== 1 ||
      Object.keys(raw).sort().join(',') !== 'entries,revision,schema,sessionId' || !Array.isArray(raw.entries) || raw.entries.length !== 1) throw taskError('TASK_RECORD_INVALID')
    const value = raw.entries[0]
    if (!value || Object.keys(value).sort().join(',') !== 'members,scopeHash,taskBinding' || !HASH.test(value.scopeHash ?? '') ||
      value.taskBinding?.schema_version !== 'bailing.agent-task-binding.v1' || !UUID.test(value.taskBinding.task_id ?? '') ||
      !HASH.test(value.taskBinding.scope_hash ?? '') || Object.keys(value.taskBinding).sort().join(',') !== 'schema_version,scope_hash,task_id' ||
      !Array.isArray(value.members) || !value.members.length || value.members.length > 64 ||
      value.members.some(member => !member || Object.keys(member).sort().join(',') !== 'allowed_tools,client_app_id,client_conversation_id,connectionKey,session_id,workspace' ||
        !/^conn_[a-f0-9]{32}$/.test(member.connectionKey ?? '') || !UUID.test(member.session_id ?? '') ||
        typeof member.client_app_id !== 'string' || typeof member.workspace !== 'string' || member.client_conversation_id !== this.conversationId(id) ||
        !Array.isArray(member.allowed_tools) || member.allowed_tools.some(tool => typeof tool !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(tool)))) throw taskError('TASK_RECORD_INVALID')
    return copy(raw)
  }

  async read(id) {
    const entry = this.entry(id)
    if (!this.store) return null
    let raw
    try { raw = await this.store.load(id) } catch (error) { throw taskError(error?.code === 'TASK_STORE_CONFLICT' ? error.code : 'TASK_STORE_UNAVAILABLE') }
    const record = raw === null ? null : this.validate(raw, id)
    if (entry.record && metadataHash(entry.record) !== metadataHash(record)) throw taskError('TASK_BINDING_CONFLICT')
    if (record && entry.pending && metadataHash(record) !== metadataHash(entry.pending)) throw taskError('TASK_BINDING_CONFLICT')
    entry.record = record
    return record
  }

  async verify(id, taskId) {
    const scopeView = await this.scopes.get(id)
    if (!taskId && ['chat', 'unselected'].includes(scopeView.mode)) return { supported: undefined, mode: 'optional', scope: this.scopes.snapshot(id) }
    await this.scopes.assertUsable(id)
    const scope = this.scopes.snapshot(id)
    const transport = await this.getTransport()
    if (typeof transport.getTaskControlCapabilities !== 'function') {
      if (taskId) throw taskError('TASK_UNSUPPORTED')
      return { supported: false, mode: 'optional', scope }
    }
    const members = []
    let snapshot
    let required = false
    let supported = true
    for (const member of scope.authorizations) {
      const expectedBinding = { ...memberBinding(scope, member), sessionId: member.sessionId }
      const options = { connectionKey: member.connectionKey, workspace: member.workspace, expectedBinding,
        clientConversationId: this.conversationId(id) }
      // Only protocol support is stable for this exact original binding. The
      // unbound/optional path must still read current enrollment on every call.
      const protocolKey = metadataHash({ connectionKey: member.connectionKey, expectedBinding })
      const supportedProtocol = Boolean(taskId && this.supportedBindings.has(protocolKey))
      let caps
      try { if (!supportedProtocol) caps = await transport.getTaskControlCapabilities(options) }
      catch (error) {
        if (!taskId && error.publicCode === 'TASK_UNSUPPORTED') caps = { supported: false, mode: 'optional' }
        else throw error
      }
      if (!supportedProtocol) {
        if (!caps || typeof caps.supported !== 'boolean' || !['optional', 'required'].includes(caps.mode)) throw taskError('TASK_UNAVAILABLE')
        required ||= caps.mode === 'required'
        supported &&= caps.supported
      }
      if (!taskId) continue
      if ((!supportedProtocol && (!caps.supported || caps.inspect_invocation !== true)) || typeof transport.getTask !== 'function' ||
        typeof transport.inspectInvocation !== 'function') throw taskError('TASK_UNSUPPORTED')
      this.supportedBindings.add(protocolKey)
      const task = await transport.getTask(taskId, options)
      const own = task?.member
      if (task?.schema_version !== 'bailing.agent-task.v1' || task.task_id !== taskId || !HASH.test(task.scope_hash ?? '') ||
        task.member_count !== scope.authorizations.length || !TASK_STATES.has(task.state) || !Number.isSafeInteger(task.revision) ||
        task.metering !== 'write_invocation' || task.snapshot_is_dispatch_permission !== false ||
        !own || own.session_id !== member.sessionId || own.client_app_id !== expectedBinding.clientAppId ||
        own.workspace !== member.workspace || own.client_conversation_id !== options.clientConversationId ||
        !Array.isArray(own.allowed_tools) || new Set(own.allowed_tools).size !== own.allowed_tools.length) throw taskError('TASK_MEMBER_MISMATCH')
      if (snapshot && (task.scope_hash !== snapshot.scope_hash || metadataHash(task.policy) !== metadataHash(snapshot.policy))) throw taskError('TASK_BINDING_CONFLICT')
      members.push({ connectionKey: member.connectionKey, session_id: own.session_id, client_app_id: own.client_app_id,
        workspace: own.workspace, client_conversation_id: own.client_conversation_id, allowed_tools: [...own.allowed_tools].sort() })
      if (!snapshot || task.ledger_sequence >= snapshot.ledger_sequence) snapshot = task
    }
    await this.scopes.assertUsable(id)
    return { supported, mode: taskId ? undefined : required ? 'required' : 'optional', scope, snapshot, members: members.sort((a, b) => a.connectionKey.localeCompare(b.connectionKey)) }
  }

  async save(id, record) {
    try {
      const saved = await this.store.save(id, copy(record), null)
      if (metadataHash(saved) !== metadataHash(record)) throw taskError('TASK_STORE_UNAVAILABLE')
    } catch (error) { throw taskError(error?.code === 'TASK_STORE_CONFLICT' ? error.code : 'TASK_STORE_UNAVAILABLE') }
    this.entry(id).record = copy(record)
    this.entry(id).pending = null
  }

  set(id, request) {
    return this.serial(id, async () => {
      const entry = this.entry(id)
      try {
        if (!request || Object.keys(request).join(',') !== 'taskId' || !UUID.test(request.taskId ?? '')) throw taskError('TASK_RECORD_INVALID')
        if (entry.intendedId && entry.intendedId !== request.taskId) throw taskError('TASK_BINDING_CONFLICT')
        entry.intendedId = request.taskId
        if (!this.store) throw taskError('TASK_STORE_UNAVAILABLE')
        if (entry.failure?.startsWith('TASK_STORE_')) throw taskError(entry.failure)
        await this.scopes.begin(id)
        const current = await this.read(id)
        if ((current ?? entry.pending)?.entries[0].taskBinding.task_id !== undefined &&
          (current ?? entry.pending).entries[0].taskBinding.task_id !== request.taskId) throw taskError('TASK_BINDING_CONFLICT')
        const verified = await this.verify(id, request.taskId)
        const record = { schema: SCHEMA, sessionId: id, revision: 1, entries: [{ scopeHash: scopeFingerprint(verified.scope),
          taskBinding: { schema_version: 'bailing.agent-task-binding.v1', task_id: request.taskId, scope_hash: verified.snapshot.scope_hash }, members: verified.members }] }
        if (current && metadataHash(current) !== metadataHash(record)) throw taskError('TASK_BINDING_CONFLICT')
        if (!current) { entry.pending = record; await this.save(id, record) }
        entry.snapshot = verified.snapshot
        entry.supported = true
        entry.failure = null
        return this.view(id)
      } catch (error) { this.fail(id, error); throw error }
    })
  }

  fail(id, error) {
    const entry = this.entry(id)
    // Persistence failure remains primary until explicit restore succeeds.
    if (!entry.failure?.startsWith('TASK_STORE_')) entry.failure = error.publicCode ?? error.code ?? 'TASK_UNAVAILABLE'
  }

  refresh(id, restore = false) {
    return this.serial(id, async () => {
      const entry = this.entry(id)
      try {
        if (!restore && entry.failure?.startsWith('TASK_STORE_')) return this.view(id)
        let record = await this.read(id)
        let verified
        if (restore && entry.pending && !record) { verified = await this.verify(id, entry.pending.entries[0].taskBinding.task_id); await this.save(id, entry.pending); record = entry.record }
        if (!record && entry.intendedId) throw taskError(entry.failure ?? 'TASK_REQUIRED')
        verified ??= await this.verify(id, record?.entries[0].taskBinding.task_id)
        entry.supported = verified.supported
        entry.mode = verified.mode
        if (record) {
          const expected = { scopeHash: scopeFingerprint(verified.scope), members: verified.members,
            taskBinding: { schema_version: 'bailing.agent-task-binding.v1', task_id: verified.snapshot.task_id, scope_hash: verified.snapshot.scope_hash } }
          if (metadataHash(record.entries[0]) !== metadataHash(expected)) throw taskError('TASK_BINDING_CONFLICT')
          entry.snapshot = verified.snapshot
          entry.pending = null
        }
        entry.failure = !record && verified.mode === 'required' ? 'TASK_REQUIRED' : null
      } catch (error) { this.fail(id, error) }
      return this.view(id)
    })
  }

  view(id) {
    const entry = this.entry(id)
    const failure = entry.failure
    const snapshot = entry.snapshot
    return { state: failure ? failure.startsWith('TASK_STORE_') ? 'storage_error' : 'blocked' : snapshot?.state ?? 'inactive',
      availability: failure === 'TASK_UNSUPPORTED' ? 'unsupported' : failure && ['TASK_UNAVAILABLE', 'agent_transport_unavailable', 'agent_request_timeout'].includes(failure) ? 'unavailable' : entry.supported === true ? 'supported' : entry.supported === false ? 'unsupported' : 'unavailable',
      ...(failure ? { reason: failure } : {}), task_binding: copy(entry.record?.entries[0].taskBinding ?? null),
      ...(snapshot ? { task_state: snapshot.state, revision: snapshot.revision, ledger_sequence: snapshot.ledger_sequence,
        policy: copy(snapshot.policy), counters: copy(snapshot.counters), metering: 'write_invocation' } : {}),
      snapshot_is_dispatch_permission: false, object_metering: 'unsupported', unsavedRecords: entry.pending ? 1 : 0 }
  }

  async binding(id, { dispatch = false } = {}) {
    const view = await this.refresh(id)
    if (view.reason) throw taskError(view.reason)
    if (dispatch && view.task_binding && view.task_state !== 'active') throw taskError({ paused: 'TASK_PAUSED', cancelled: 'TASK_CANCELLED', blocked: 'TASK_SCOPE_BLOCKED' }[view.task_state])
    return view.task_binding
  }
}
