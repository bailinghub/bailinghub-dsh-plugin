# Agent Client Host Adapter Contract

Status: native Agent Client contract for `dsh-bailinghub@0.4.0`, paired with
`bailinghub-mcp-server@0.4.0` and BailingHub Core `0.6.0`. This contract is separate from the
legacy static `0.1.x` path. Version 0.3.0 supported user-managed connections but did not include
explicit conversation scope, multi-authorization tool selection, or the visible conversation archive.

## Same-System Authorization Selection

This increment supports multiple independently authorized identities for one public
`Hub + clientAppId + workspace` binding in one DSH conversation. It does not combine different
systems or routes, alter business capability declarations, or change Core authorization rules.

Version 0.4.0 changes the default: a new conversation with no selected scope, or an explicitly
empty `connectionKeys: []`, is ordinary chat. It starts no BailingHub run and exposes no BailingHub
business tools. Browser authorization, the registry's current connection, and the four bootstrap
fields do not select a conversation's scope. There is no automatic discovery-and-enable fallback.

The host explicitly selects fixed SDK connection keys before sending the first user message.
Exactly one selected authorization keeps the original typed arguments and result shape; two or
more selected authorizations use the shared envelope below. All selected keys must be authorized
under the same Hub/client/workspace binding. Unselected connections are never added to the scope.
The model receives a projected directory containing
session-local `authorization_ref` values, local display names, and availability, not raw connection
keys, credentials, Agent Session metadata,
or permission to supply arbitrary route or identity values. A local name is untrusted display
data, not proof of a tenant or store. The model must resolve ambiguous user intent before acting;
available authorization is not a request to act on every listed identity.
Labels use existing local `connectionName` metadata, not token-derived business names or a new
Core identity-display field. Generic aliases such as `default` and `default-2` do not establish
an A/B business mapping; the user must supply clear labels while the business authorization page
continues to determine the trusted identity.

The directory's references resolve to the explicitly selected SDK connection bindings. The first
`user/message` event freezes the selection, with `agent/inbox/claimed` as a fallback for drivers
that do not emit that event, before `startTurn`. Changing the selected keys after
that point requires a new conversation, including switching between ordinary chat and business
mode. Adding a registry authorization or changing its alias never expands an existing scope.
Capturing a binding does not freeze credentials or bypass refresh, expiry, revocation, or
downstream authorization checks.
Before transport operations, `status({ connectionKey })` must report the captured connection key,
workspace, and the original authorized Agent Session id captured during selection. If any selected
authorization is missing, invalid, replaced, or cannot be checked, business access for the entire
conversation pauses. It neither falls back to a default nor silently shrinks to the remaining
authorizations. A new conversation can explicitly select the still-valid subset. These inspection
fields stay host-side. The
adapter passes `connectionKey` and `workspace` as explicit SDK host metadata instead of
resolving a mutable alias or default.

The full selection is validated before any selected system receives the turn. For each direct
user turn, the adapter starts one Core run per selected authorization before
assembling the model request. Instructions, governance, knowledge, memory, and tool results carry
authorization labels. The user input is sent to each of those runs. Separate run state preserves
attribution; all injected context still shares the local Agent/model boundary described in
[Privacy](../PRIVACY.md#same-system-authorization-selection).

Business definitions with the same name, description, input schema, and governance are registered
once.
Conflicting declarations are not merged for execution. Availability remains specific to each
authorization, and the conversation's total active business-tool limit remains 12. In a
multi-authorization session, each shared definition wraps its unchanged business schema:

```json
{
  "authorization_ref": "<host-issued reference from this session>",
  "arguments": { "<business parameter>": "<value>" }
}
```

The selector is host metadata; it is not forwarded as a business argument or new Core HTTP
field. A single-authorization session keeps the original unwrapped business schema.
`search_business_capabilities` accepts an optional `authorization_ref` using the same reference
boundary; omission searches all captured authorizations. Its responses update the selected
authorizations' capability revisions and definitions before rebuilding
the shared tool view. It cannot import a different binding into the conversation.

Invocation state captures the selected authorization, Core run, capability revision, tool, and
arguments. A replay with a different selector or payload fails closed. Recovery accepts only an
invocation known to this conversation and uses the original binding; it accepts no replacement
authorization selector. Pending approval and unknown dispatch outcomes follow the same
exact-invocation recovery rules as the baseline. Removing or selecting another default must not
retarget an existing invocation.
The local invocation map survives later turns of the same live conversation. It is not persisted
across process restarts or copied into new conversations, and unknown invocation ids fail closed.
This increment does not provide durable task recovery across those boundaries.

On multi-authorization completion, the adapter freezes one deterministic summary of each run's
own governed calls and synchronizes that run separately. It does not send the combined visible
assistant answer, another authorization's results, or hidden reasoning to every run. The combined
answer is instead eligible for the separate conversation audit below. Single-authorization completion keeps the existing visible-answer
behavior. Connection add/use/remove remain user-only commands, not model tools.

### Host-owned session scope API

The runtime service exposes asynchronous `getSessionScope(sessionId)`,
`setSessionScope(sessionId, { connectionKeys, expectedRevision? })`, and
`restoreSessionScope(sessionId)`. They are host APIs, never model tools. Use keys returned by the
SDK registry, not aliases or model-provided identity values.

Native DSH users can inspect `/bailinghub scope`, choose ordinary chat with
`/bailinghub scope none`, or select fixed keys with `/bailinghub scope set <connection-key>...`
before the first user message. Obtain keys from `/bailinghub connections list`; the scope command
does not accept aliases, adopt a registry default, or start a business run. These are user-only
commands over the same scope API.

```js
const runtime = ctx.get('bailingHubAgentClient')
const previous = await runtime.getSessionScope(sessionId)
const selected = await runtime.setSessionScope(sessionId, {
  connectionKeys: selectedConnectionKeys, // [] explicitly chooses ordinary chat
  expectedRevision: previous.revision,
})
// Render selected.mode and selected.authorizations, then enable sending.
// Do not dispatch the first user message while this operation is pending or failed.
```

The returned view includes `schema`, `sessionId`, integer-or-null `revision`, `state`
(`unselected`, `ready`, or `needs_selection`), `locked`, `mode` (`chat`, `business`, or `blocked`),
and public authorization entries. `get` reads the scope; it does not grant access. A host must await
a successful `set`, show its returned selection, and only then send the first message. Never
optimistically send using an earlier scope. Before the first message, a failed replacement
selection leaves business access blocked; it cannot restore the previous broader selection.
After the scope is frozen, a change request returns `SESSION_SCOPE_LOCKED` and leaves the original
frozen scope unchanged. The host must open a new conversation, not treat that rejection as a
successful selection of the requested keys. Revision values may advance more than once
during selection; always use the returned value for the next compare-and-swap request.

Each returned `authorizations` entry has exactly the public host-facing fields
`{ authorizationRef, connectionKey, label, workspace }`. The selection accepts at most 64 unique
connection keys. The trusted host owns `sessionId`: it must remain stable when reopening the same
conversation and be unique within that store's namespace. Do not let the model or an untrusted
client choose another conversation's id, edit scope records, or control the storage namespace.
The store and its access policy belong to the host. The model sees only the projected reference,
label, and availability directory; raw connection keys and scope storage are not model APIs.

Reopening an existing conversation must call `restoreSessionScope` before sending. A valid
`locked: true` snapshot restores its original scope after the saved binding and Agent Sessions
are checked; it remains locked. A stored `locked: false` snapshot is only a draft, even if its
stored state says `ready`. Loading it into a new runtime returns `needs_selection` / `blocked`
without probing its previously selected SDK connections. A never-started draft remains
`locked: false`: the host must explicitly call `setSessionScope` again and show success before
sending. It must not silently reactivate the saved draft selection.

If a locked conversation is reopened offline, its business gate stays closed. A timeout,
connection failure, or incomplete authorization response is not proof of revocation: retry
`restoreSessionScope`, `getSessionScope`, or `syncSessionArchive` on the **same runtime and Session**
after connectivity returns. All original members must pass validation before business access or
archive upload resumes. Concurrent callers wait for the same in-flight whole-scope validation.
Retries preserve the original keys, Agent Sessions, binding, member set, and persisted scope revision.
Confirmed revocation, identity/binding replacement, corrupt storage, or a CAS conflict remains
blocked; retries never select a default, remaining subset, or replacement Session.

An old conversation without a valid snapshot stays blocked; missing or corrupt state must not
adopt today's registry default or discovered authorizations. Trusted history containing only
configuration or metadata still permits draft selection. Actual user-message or turn history
requires the original locked scope; changing that scope requires a new conversation. Embedded
hosts without the native commands or a scope-selection UI must integrate these APIs;
`connections use` is not a substitute.

### Scope persistence seam

`createAgentClientPlugin({ scopeStore })` accepts an explicit store with `load(sessionId)` and
`save(sessionId, record, expectedRevision)`. `load` returns a validated record or `null` for absence;
errors and corrupt records are not absence. `save` compares the stored revision atomically:
`null` means the record must not exist, the first revision is `1`, and each update increments it.
Before validating a replacement selection, the coordinator attempts to save a `needs_selection`
record. If that first write fails, the previous draft can remain on disk; the write is not
reported as successful. Restart safety also depends on the draft rule above: every loaded
unlocked snapshot requires explicit confirmation, so a stale saved selection never becomes
`ready` automatically, even when its replacement marker could not be written.

The default `createFileSessionScopeStore()` saves non-secret JSON under
`$DSH_HOME/plugins/dsh-bailinghub/session-scopes`, using `~/.dsh` when `DSH_HOME` is unset. Session
ids are hashed into filenames. On POSIX, files use mode `0600` and directories `0700`; writes use a
cross-process lock, compare-and-swap, and atomic replacement. Lock conflicts and storage failures
fail closed; the adapter never switches to an in-memory fallback. Hosts may inject another
durable implementation. `createMemorySessionScopeStore()` is an explicit, non-persistent option
for tests or hosts that deliberately accept losing scope state on restart.

The snapshot contains only the scope schema, DSH session id, revision, state/lock, public binding,
and selected connection keys, sanitized labels, workspace, and original Agent Session ids. It
contains no credentials, tokens, prompts, business arguments/results, or invocation state.
Restoring a scope does **not** restore an invocation, approval, pending completion, or task.

### Independent visible conversation archive

The visible archive requires SDK `0.4.0` and Core `0.6.0`; earlier `0.3.0` packages do not
provide this contract. After a nonempty scope is frozen, the adapter captures claimed user text, every
durable `assistant/message` text block, turn start/end, and verified original run links. It ignores
`assistant/chunk`, hidden reasoning, attachments, raw provider requests, and arbitrary tool payloads.
The archive is one record for the complete fixed authorization set; per-authorization run summaries
are unchanged. It is not written into each member's memory.

The optional SDK seam is `syncConversationArchive(envelope, { members })`. `envelope` contains a
durable random UUID `clientArchiveId`, the same `clientConversationId` used by `startTurn`, and
ordered `events`. Each event has a stable UUID `event_id`, contiguous `sequence` starting at one,
the original `client_turn_id`, and `kind`: `turn_start`, `user_message`, `assistant_message`,
`run_link`, or `turn_end`. Messages contain `content`; a run link contains the original `run_id`
and `member_session_id`; turn end contains `completed`, `failed`, or `cancelled` status. A late
original run response may attach its link to an already ended turn. It never reactivates its
business tools, dispatches that cancelled turn's remaining members, or replaces a newer active turn.
The SDK receives host-only member records `{ connectionKey, workspace, expectedSessionId, label }`,
checks every original authorization, and owns HTTP batching and credential use. The first frozen
member is the writer. Neither the old hash alias nor a random archive UUID confers read/write access.

`createAgentClientPlugin({ archiveStore })` accepts an independent CAS store with `load`/`save`,
using the same revision semantics as the scope store but a distinct schema and directory.
`createFileConversationArchiveStore({ directory? })` defaults to
`$DSH_HOME/plugins/dsh-bailinghub/conversation-outbox`, with private file permissions, atomic writes,
and a 32 MiB local record bound. `createMemoryConversationArchiveStore()` is explicitly volatile.
Outboxes retain the frozen membership, random identity, visible events, event hashes/ids, and
acknowledged cursor. They contain task text; they are not credential stores. The SDK rejects a
message above 64,000 characters; the adapter does not silently truncate it or discard pending text.
Core's conversation/event quotas and the local bound can leave synchronization pending.

Host APIs `getSessionArchiveStatus(sessionId)` and `syncSessionArchive(sessionId)` and the user-only
`/bailinghub archive status|sync` commands expose synchronization separately from business state.
Persisted pending events can be retried after reopening under the original valid frozen scope,
without replaying `startTurn`, `invoke`, `resume`, or `completeRun`. An older SDK reports
`unsupported` without accessing the outbox directory; an unavailable/older Core leaves saved events
pending or unsupported for retry. Empty scope does not load a transport or create an archive.

Capture begins with business turns enabled under this archive contract. Previously unarchived history is not silently
claimed as complete. Status compares saved visible events against the available DSH `session.events`:
missing user/assistant text or turn boundaries report `recovery_gap` / `coverage: incomplete`, even
if the saved prefix is synchronized. Hosts without durable history report `coverage: unverified`.
This check does not reconstruct missing business run ids. Network failure leaves durable events
retryable; a local write failure can leave only an in-memory pending event until storage recovers.
While scope validation or transport availability prevents upload, a known `storage_error` or
`recovery_gap` remains visible with the existing unsaved-event count and coverage. An optional
`availability` field describes the additional upload restriction; it does not clear the local error.
Capability-discovery network failures report `pending`, not a fabricated local storage failure.
If the process ends before that write succeeds, the host-history check reports the detectable gap;
there is no atomic transaction between DSH's event log, this outbox, and Core. It does not promise
recovery of absent host history, hidden content, or durable business task execution.

## Host Configuration

The Cordis Config schema contains only:

```text
hubUrl
clientAppId
workspace
connectionName
```

`hubUrl`, `clientAppId`, and `workspace` identify a public Hub-side application/workspace binding.
`connectionName` selects a local SDK connection for connection-management commands; it does not
select the conversation scope. It is not an account, tenant, or
identity claim. The Hub Client App resolves to one stable business authorization endpoint; no
business endpoint, authorization endpoint, token, secret, or business credential belongs in this
config. The business authorization page owns sign-in, account switching, tenant selection, and
the trusted identity ultimately represented by `on_behalf_of`.

## Injectable Transport Seam

The default transport is lazily created from `bailinghub-mcp-server/sdk`. Tests and future host
adapters may inject an object with all methods below:

```js
connectionsList({})
connectionsAdd({ connectionName, hubUrl, clientAppId, workspace })
connectionsUse(connectionNameOrKey)
connectionsRemove(connectionNameOrKey)

login({ hubUrl, clientAppId, workspace, route, connectionName })
status({ connectionKey }) // conversation checks; management may use connectionName
logout({ connectionName })
workspaces({ connectionName })
use({ workspace, route, connectionName })

startTurn({
  clientConversationId,
  clientTurnId,
  userMessageId,
  userInput,
  pageContext?,
  renderers?,
})

searchCapabilities({ query, limit?, runId? })
invoke({ invocationId, capabilityRevision, agentRunId, tool, arguments })
resume(invocationId, {}, { workspace, connectionKey, signal? })
completeRun(runId, {
  assistantMessageId,
  content,
  status,
  model?,
  runtime?,
  usage?,
})
```

The adapter passes host metadata (`workspace`, fixed `connectionKey`, and optional `signal`)
separately from the business DTO to turn/tool methods, and as the third argument to completion
and resume. The transport must honor that exact selection; it must never ignore it or substitute
a mutable alias/default. Connection-management commands may use `connectionName`. The optional
archive seam and its complete frozen member selection are specified above.

## Browser Identity and Local Reconciliation

`/bailinghub login` always starts from the selected Hub/client/workspace binding. The plugin does
not accept or derive a business URL, account id, tenant id, or identity selector. Core redirects
to the single authorization endpoint configured for that Client App, and the business page
performs any login, account switching, or tenant selection required before it approves the
authorization.

The SDK may stage more than one named local instance for the same public binding while browser
authorization is in progress. After authorization it compares the trusted Session
`on_behalf_of`, never the local `connectionName`:

- the same identity replaces the older local connection and revokes its old Agent Session;
- a different identity remains a separate named connection; when login was launched from an alias
  already owned by the old identity, the SDK preserves that alias and Session, allocates an
  available alias such as `default-2` to the new identity, and makes the new connection current;
- an uncertain identity inspection or failed old-Session revoke keeps the new Session authorized
  and returns `cleanupRequired: true` with cleanup metadata.

The adapter reports that last result as successful authorization plus a visible warning. It tells
the user not to authorize again and to retry explicit cleanup with the user-only connection
lifecycle commands. It does not turn the result into a failed login or let the model perform
cleanup.

## Core HTTP Mapping

The SDK, not this adapter, maps those DTOs to:

```text
POST /agent-api/v1/workspaces/:route/turns
POST /agent-api/v1/workspaces/:route/capabilities/search
POST /agent-api/v1/tool-invocations
POST /agent-api/v1/tool-invocations/:invocation_id/resume
POST /agent-api/v1/runs/:run_id/complete
```

`startTurn` accepts the Core `schema` or `schema_version` alias, but the resolved value must be
exactly `bailing.agent-turn-context.v1`. Its runtime result is:

```json
{
  "schema_version": "bailing.agent-turn-context.v1",
  "run_id": "UUID",
  "profile_revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "capability_revision": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "context": {
    "instructions": "...",
    "page_context": {},
    "renderers": [],
    "memory": null,
    "memory_refs": [],
    "knowledge": [],
    "knowledge_refs": [],
    "governance": {}
  },
  "active_tools": []
}
```

At most 12 active tools are accepted. Each tool must use the Core tool-name grammar, an
object-rooted input schema, and complete governance metadata (`scope`, `risk`,
`approval_required`, `readonly`, and `idempotent`).
Both revision fields are required lowercase 64-character SHA-256 values; shorter labels or
uppercase digests fail closed.

## Verified DSH Lifecycles

DSH `0.1.0-rc.7` and `0.1.1-rc.2` claim inbox messages before assembling the current step:

```text
agent/inbox/claimed
  -> systemPrompt.assemble()
  -> system-prompt/assemble async waterfall
  -> agent/pre-step
  -> model request
```

The adapter captures only a claimed message whose `source.kind` is `user`. The
first `user/message` event freezes scope; the inbox claim is a fallback if that event is absent.
The assembly gate permits business work only for the saved selection.
When inspecting attached or restored history, only `user/message` with `source.kind: 'user'` or
`turn/start` proves that a conversation has started. Configuration events, metadata, and
`session/end-seed` alone do not freeze a draft. `firstLiveSeq` is a seed-history boundary, never
proof of a started conversation by itself. The adapter separates the previously observed or
seeded prefix from new events so the current first message is not mistaken for an older turn.
On the authoritative
`system-prompt/assemble` waterfall, it calls `startTurn`, registers the returned definitions
through `agent.ctx.tools.register()`, and also adds their schemas to the already-sampled current
assembly. Later steps receive the same agent-scoped definitions from the ordinary ToolRuntime
registry.

Stable profile/instructions/governance are system-prompt sections. Memory, reference-only
knowledge body/refs, page context, and renderers are named runtime-context entries. Knowledge
content is evidence, never an instruction source.

The adapter listens to durable `session/event` values:

- `assistant/message`: keep only `content` blocks whose type is `text`, plus model and the
  public numeric usage buckets;
- `tool/call`: count distinct durable call ids for the public `tool_calls` metric; never copy
  tool arguments or results into completion usage;
- `turn/end`: freeze the completion DTO and synchronize it;
- `assistant/chunk`: deliberately ignored, including hidden reasoning chunks.

## Tool Invocation and Recovery

Every active Core tool becomes an agent-scoped DSH definition. Its
invocation id is a stable 64-character lowercase SHA-256 digest of the session, run, DSH call id,
and Core tool name. It
calls the SDK `invoke` DTO without letting the model supply the run, capability revision, route,
or arbitrary identity. The constrained authorization selector is described above.

An SDK error with `disposition === 'accepted_unknown'` starts recovery with the exact invocation
id; it never repeats the business-tool `invoke`. Likewise, `awaiting_approval`, `in_progress`, and
retryable `rejected_before_dispatch` results keep the original DSH tool call open while the
adapter performs bounded `resume` polling. Approval therefore continues the same invocation and
the same Core run before the local Agent writes its final answer.

The default recovery window is at most 120 seconds and 60 resume attempts. `executed`,
`business_rejected`, `denied`, non-retryable `rejected_before_dispatch`, and
`reconciliation_required` are terminal and are never polled. If the bounded wait expires while a
known result is still pending, the tool returns that result plus an `agent_client_wait` marker
containing the same invocation id and the only legal recovery tool. If no trustworthy invocation
result was ever received, the safe error still retains only that exact id. Raw transport errors
are never exposed.

Concurrent or replayed executions of the same DSH call share one in-flight operation. A terminal
result is returned from the per-run cache, while an unfinished replay resumes the same invocation;
neither path submits another `invoke`. A replay that changes the original tool or arguments fails
closed.

`search_business_capabilities` applies the returned revision/tool set only to the current
session/run. `resume_governed_tool_invocation` accepts only the exact 64-character id, shares the
same bounded recovery state when known locally, and never creates a replacement invocation.

## Session and Completion State

Connection selector, workspace, conversation alias, Core run, active definitions, and completion
state are isolated per DSH Agent/session. Named connections for different trusted identities own
separate SDK credentials and Agent Sessions. Same-binding connections that resolve to the same
trusted identity are reconciled to one local survivor after authorization. A workspace switch
preserves the selected connection instance and changes connection-management defaults; it is rejected while any
Core run is active/completing or has an unsynchronized completion payload.

After a same-alias login resolves to a different trusted identity, the SDK-returned replacement
alias becomes the adapter's registry default. The retained old alias and the new alias both
remain visible through `connections list` and user-selectable through `connections use`; existing
DSH sessions remain pinned as described below.

Multi-connection add/use/remove is exposed only through the `/bailinghub connections` user
command. It is never registered as a model tool. Selecting a connection changes registry defaults;
existing states keep their captured bindings. Defaults affect connection management only;
the host-owned scope API alone selects the conversation's authorization directory.
Removing a connection is rejected while any run is active or has an unsynchronized completion. The SDK then
revokes only that instance's remote Agent Session before removing its local credentials and
registry metadata; a revoke failure preserves both. Repeating add with the same name and public
binding selects the existing instance; reusing a name for different public metadata fails.
`connectionName` remains a local user selector and never becomes a trusted identity claim.

After a successful remove, the adapter reads the registry again. A valid remaining
`currentConnectionKey` replaces all four public connection-management defaults, using the key itself
when the profile has no alias; no remaining connection sets the adapter to unconfigured. A refresh
failure does not change the successful remove result. It makes a removed default unavailable, but
does not invalidate an unchanged non-current default. Existing session state is never rewritten.

The four static adapter fields bootstrap SDK construction only. For connection management, the
adapter reads `connectionsList()` and adopts the public
metadata matching `currentConnectionKey`. Invalid, missing, or unavailable registry data leaves the
bootstrap defaults in place and must not remove or block unrelated host tools. The lookup is not a
model tool, and restoring or later selecting a default never mutates an already-created session.
These registry bootstrap rules do not grant business scope, even to a new
conversation. A failed scope load or selection never uses the bootstrap fields as a fallback.

The completion request is restricted to:

```json
{
  "assistant_message_id": "stable alias",
  "content": "visible final text for one authorization, or that run's deterministic call summary for a multi-authorization scope",
  "status": "completed | failed | cancelled",
  "model": "optional",
  "runtime": "optional",
  "usage": {}
}
```

The adapter supplies the camelCase SDK equivalent. It never passes an event, message object,
reasoning block, DSH end-reason object, or arbitrary host metadata. The payload is frozen before
the first attempt and reused unchanged for up to three automatic attempts. A failed completion
remains pending in its original run; `/bailinghub sync` starts another bounded attempt batch with
that same id and payload.

The verified DSH releases report disjoint camelCase buckets (`inputTokens`, `cacheReadTokens`,
optional `cacheWriteTokens`, and `outputTokens`) on each durable `assistant/message`. The adapter sums them
across model steps, exposes total input as Core `input_tokens`, cache reads as the
`cached_input_tokens` subset, and derives `total_tokens` without adding `reasoningTokens` a second
time. Unknown, non-finite, and negative metrics are discarded; only the Core public usage
allowlist can leave the host.

## Graceful Degradation

Missing/invalid configuration, missing SDK, failed authorization, failed Core context, a tool-name
collision, or unsupported DSH Code Mode removes the Core business tools and inserts a concise
status section. The local Agent may continue using unrelated local tools, but it is explicitly
told not to claim a BailingHub business action was executed.
