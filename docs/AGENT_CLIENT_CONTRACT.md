# Agent Client Host Adapter Contract

Status: public native Agent Client baseline for `dsh-bailinghub@0.3.0`, plus the explicitly
unreleased source-candidate extension below. This contract is not part of the legacy public
`0.1.x` line. Public `0.3.0` supports user-managed connections with Core `0.5.1` and
`bailinghub-mcp-server@0.3.0`; it does not include model selection among authorizations. The
remaining sections describe the baseline except where the candidate section states a change.

## Unreleased Same-System Authorization Selection

This increment supports multiple independently authorized identities for one public
`Hub + clientAppId + workspace` binding in one DSH conversation. It does not combine different
systems or routes, alter business capability declarations, or change Core authorization rules.
It is a source candidate with no new npm release or version claim.

At session creation, the adapter captures eligible same-binding connections from the SDK
registry. At least two eligible connections activate this path; fewer preserve the original
single-connection behavior and tool schemas. The model receives a projected directory containing
session-local `authorization_ref` values, local display names, and availability, not raw connection
keys, credentials, Agent Session metadata,
or permission to supply arbitrary route or identity values. A local name is untrusted display
data, not proof of a tenant or store. The model must resolve ambiguous user intent before acting;
available authorization is not a request to act on every listed identity.
Labels use existing local `connectionName` metadata, not token-derived business names or a new
Core identity-display field. Generic aliases such as `default` and `default-2` do not establish
an A/B business mapping; the user must supply clear labels while the business authorization page
continues to determine the trusted identity.

The directory's references resolve to captured SDK connection bindings. Calls do not change or
re-resolve the global current connection. New authorizations and renamed aliases take effect in
new sessions. Capturing a binding does not freeze credentials or bypass refresh, expiry,
revocation, or downstream authorization checks; unavailable original access must not fall back
to another identity.
Before transport operations, `status({ connectionKey })` must report the captured connection key,
workspace, and the original authorized Agent Session id. The first valid check captures that id;
a later replacement requires a new conversation. These inspection fields stay host-side. The
candidate passes `connectionKey` and `workspace` as explicit SDK host metadata instead of
resolving a mutable alias or default.

For each direct user turn, the adapter starts one Core run per captured authorization before
assembling the model request. Instructions, governance, knowledge, memory, and tool results carry
authorization labels. The user input is sent to each of those runs. Separate run state preserves
attribution; all injected context still shares the local Agent/model boundary described in
[Privacy](../PRIVACY.md#unreleased-same-system-authorization-selection).

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
answer remains local to DSH. Single-authorization completion keeps the existing visible-answer
behavior. Connection add/use/remove remain user-only commands, not model tools.

## Host Configuration

The Cordis Config schema contains only:

```text
hubUrl
clientAppId
workspace
connectionName
```

`hubUrl`, `clientAppId`, and `workspace` identify a public Hub-side application/workspace binding.
`connectionName` selects one local SDK connection instance, but it is not an account, tenant, or
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
status({ connectionName })
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
resume(invocationId, {}, { workspace, connectionName, signal? })
completeRun(runId, {
  assistantMessageId,
  content,
  status,
  model?,
  runtime?,
  usage?,
})
```

The adapter may pass a second host metadata argument (`workspace`, `connectionName`, and an
`AbortSignal`) to turn/tool methods. The framework-neutral SDK DTO is always the first argument;
an SDK implementation that does not consume host metadata may ignore it.

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

The adapter captures only a claimed message whose `source.kind` is `user`. On the authoritative
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

In the public baseline, every active Core tool becomes an agent-scoped DSH definition. Its
invocation id is a stable 64-character lowercase SHA-256 digest of the session, run, DSH call id,
and Core tool name. It
calls the SDK `invoke` DTO without letting the model supply the run, capability revision, route,
or arbitrary identity. The candidate's constrained authorization selector is described above.

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
preserves the selected connection instance and affects future sessions; it is rejected while any
Core run is active/completing or has an unsynchronized completion payload.

After a same-alias login resolves to a different trusted identity, the SDK-returned replacement
alias becomes the adapter default for new sessions. The retained old alias and the new alias both
remain visible through `connections list` and user-selectable through `connections use`; existing
DSH sessions remain pinned as described below.

Multi-connection add/use/remove is exposed only through the `/bailinghub connections` user
command. It is never registered as a model tool. Selecting a connection changes defaults for new
Agent sessions only; existing states keep their captured bindings. In public `0.3.0` this is one
connection and workspace; in the candidate it is the same-binding authorization directory.
Removing a connection is rejected while any run is active or has an unsynchronized completion. The SDK then
revokes only that instance's remote Agent Session before removing its local credentials and
registry metadata; a revoke failure preserves both. Repeating add with the same name and public
binding selects the existing instance; reusing a name for different public metadata fails.
`connectionName` remains a local user selector and never becomes a trusted identity claim.

After a successful remove, the adapter reads the registry again. A valid remaining
`currentConnectionKey` replaces all four public defaults for future sessions, using the key itself
when the profile has no alias; no remaining connection sets the adapter to unconfigured. A refresh
failure does not change the successful remove result. It makes a removed default unavailable, but
does not invalidate an unchanged non-current default. Existing session state is never rewritten.

The four static adapter fields bootstrap SDK construction only. Before the first new Agent session
or user command after process start, the adapter reads `connectionsList()` and adopts the public
metadata matching `currentConnectionKey`. Invalid, missing, or unavailable registry data leaves the
bootstrap defaults in place and must not remove or block unrelated host tools. The lookup is not a
model tool, and restoring or later selecting a default never mutates an already-created session.

The completion request is restricted to:

```json
{
  "assistant_message_id": "stable alias",
  "content": "visible final text",
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
