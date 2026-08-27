# Agent Client Host Adapter Contract

Status: public native Agent Client contract for `dsh-bailinghub@0.2.0`. This contract is not part
of the legacy public `0.1.x` line. The main-branch P1 multi-connection lifecycle described below
is an additive, unreleased candidate until its matching Core, SDK, and DSH versions are accepted.

## Host Configuration

The Cordis Config schema contains only:

```text
hubUrl
clientAppId
workspace
connectionName
```

`hubUrl`, `clientAppId`, and `workspace` identify a public Hub-side application/workspace and the
SDK credential scope. `connectionName` is a local SDK alias for that tuple. Multiple aliases for
the same tuple reuse the same SDK registry entry and credential; they are not independently
revocable Agent Sessions. No business endpoint, authorization endpoint, token, secret, or business
credential belongs in this config.

## Injectable Transport Seam

The default transport is lazily created from `bailinghub-mcp-server/sdk`. Tests and future host
adapters may inject an object with all methods below:

```js
connectionsList({})
connectionsAdd({ connectionName, hubUrl, clientAppId, workspace })
connectionsUse(connectionName)
connectionsRemove(connectionName)

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

## Verified DSH rc.7 Lifecycle

DSH `0.1.0-rc.7` claims inbox messages before assembling the current step:

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

Every active Core tool becomes an agent-scoped DSH definition. Its invocation id is a stable
64-character lowercase SHA-256 digest of the session, run, DSH call id, and Core tool name. It
calls the SDK `invoke` DTO without letting the model choose the run, capability revision, route,
or identity.

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
state are isolated per DSH Agent/session. This is runtime-state isolation, not a promise that two
aliases for the same Hub/client/workspace tuple own separate SDK credentials. A workspace switch
affects future sessions and is rejected while any Core run is active/completing or has an
unsynchronized completion payload.

Multi-connection add/use/remove is exposed only through the `/bailinghub connections` user
command. It is never registered as a model tool. Selecting a connection changes defaults for new
Agent sessions only; existing states keep their captured connection and workspace. Removing a
connection is rejected while any run is active or has an unsynchronized completion. The SDK then
revokes the remote Agent Session before removing local credentials and registry metadata; a revoke
failure preserves both.

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

DSH `0.1.0-rc.7` reports disjoint camelCase buckets (`inputTokens`, `cacheReadTokens`, optional
`cacheWriteTokens`, and `outputTokens`) on each durable `assistant/message`. The adapter sums them
across model steps, exposes total input as Core `input_tokens`, cache reads as the
`cached_input_tokens` subset, and derives `total_tokens` without adding `reasoningTokens` a second
time. Unknown, non-finite, and negative metrics are discarded; only the Core public usage
allowlist can leave the host.

## Graceful Degradation

Missing/invalid configuration, missing SDK, failed authorization, failed Core context, a tool-name
collision, or unsupported DSH Code Mode removes the Core business tools and inserts a concise
status section. The local Agent may continue using unrelated local tools, but it is explicitly
told not to claim a BailingHub business action was executed.
