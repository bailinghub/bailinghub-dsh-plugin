# Reuse business tools across user turns

This DSH candidate lets a conversation reuse recently discovered business tool
declarations while the same host runtime and Session remain alive. For example,
a user can ask an Agent to find a shop product, then ask for its details in the
next message without making the Agent search for the same tool again.

Reusing a declaration does not reuse an earlier execution context or operation.
The next turn prepares current rules, context, authorization and a new run for
the intended target before a new business operation can execute.

This is an opt-in candidate, not a statement that the same-numbered registry
release contains the feature. Install the exact package and verify its hash
against the accompanying candidate manifest. The manifest pins the paired SDK
and Core; this change introduces no new SDK/Core API or database migration.

## Enable it in the host

Pass the lifecycle option when creating the Agent Client plugin, alongside the
host's existing stores and transport options:

```js
import { createAgentClientPlugin } from 'dsh-bailinghub'

const plugin = createAgentClientPlugin({
  ...existingHostOptions,
  toolLifecycle: 'session',
})
```

Omitting the option, or setting `toolLifecycle: 'active_turn'`, preserves the
existing lifecycle: tools are retained through searches within one user turn,
then the next turn discovers its usable tools again. The default plugin entry
point and existing configuration files keep that behavior. This is a host
integration option, not an extra setting an ordinary user must manage.

The host must keep the same real DSH Session and runtime between messages. A new
Session, recreated runtime or host restart begins with an empty declaration
cache. Restoring the persistent original-invocation journal does not restore
cached tools; the two mechanisms have separate purposes.

## Two lifetimes

| Item | Lifetime and meaning |
| --- | --- |
| `toolset.lifetime=active_turn` | Current execution registrations and target preparation belong to this user turn |
| `toolset.reuse=session_runtime` | This host enabled declaration reuse between turns of the same living Session |
| `cache.lifetime=session_runtime` | Cached declarations may survive turn completion, but are not current permission or an active business run |
| Current run and context | Created lazily for the selected target in the current turn; never carried over as authority |
| Original invocation | Keeps its original authorization, arguments, run and ID for recovery, independently of the tool cache |

There is no fixed “rediscover every N messages” rule. Each turn must prepare a
target when business work is first needed. Existing identity, permission and
capability-revision checks still apply to execution. An unchanged, valid cached
declaration can be reused; a changed revision, missing entry or invalidated
declaration requires the current authoritative declaration.

The cache retains at most **64 target-tool pairs across the entire Session** and
at most **2 MiB of declaration and cache metadata JSON**. The full-schema prompt
window is **12 tools across targets**. These are cache and presentation budgets,
not limits on operations, messages, products or task duration. A declaration for
two separately authorized targets consumes two cache entries, even when their
parameters are identical. Recent use influences bounded eviction.

Only normalized declarations and trusted target/revision bindings are cached.
Previous run context, credentials, invocation arguments and business results are
not stored in this cache. All cache entries are memory-only in this phase.

## How the model should use tools

The existing `search_business_capabilities` tool is also the preparation and
schema-retrieval entry point in session mode. It accepts an optional exact
`tool_name`; use the `original_name` from `cached_tools`, not a generated alias,
an account display name or a guessed capability name.

1. Select the intended `authorization_ref` from the current Session's scope.
   It is required for multi-target preparation, including two accounts in the
   same system. A single-target Session can omit it.
2. Check `targets[].preparation_state`. Use `search_business_capabilities` with
   a short target-specific `query` and `tool_name` when reusing an exact known
   tool. Keep the query within 500 characters and avoid unrelated target data.
3. Read the returned `contexts` and complete `tool_schemas` before deciding on
   the business call. Preparation explicitly reports
   `business_operation_performed=false`; it is not a business receipt.
4. Call a ready tool using its current schema and selected target. It can be
   called repeatedly within the turn without repeating capability search.
5. For a new kind of task, omit `tool_name` and search with a relevant query.
   A broad query still requests ranked discovery; caching does not convert it
   into a promise to enumerate the entire catalog.

If a ready tool's full schema is outside the presentation window, use the exact
`tool_name` to bring its declaration back into the window. The declaration can
come from local cache, while normal scope validation may still make requests.
The model must not guess fields or rely on an old schema that it cannot inspect.

An exact valid cache hit avoids an additional `searchCapabilities` request. The
first preparation of a target still calls `startTurn` for current context; Core
may perform its existing bounded internal discovery there. This is reduced
duplicate discovery, not a promise of zero network requests or zero server-side
retrieval.

## Reading the returned state

Both model-facing preparation results and the read-only host method
`runtime.getSessionToolState(sessionId)` expose the following distinctions:

| Field | Meaning |
| --- | --- |
| `targets[].preparation_state=not_prepared` | Selected target has no current-turn run yet; cached tools are not evidence that it is absent or expired |
| `targets[].preparation_state=ready` | Target has current-turn context and an active run; individual tool validity still matters |
| `active_tools` | Tools ready for business dispatch with the listed current-turn authorizations |
| `cached_tools` | Cached names and target bindings; `prepared_authorization_refs` identifies which targets are prepared |
| `cached_tools[].state=cached_unverified` | At least one associated target still needs current-turn preparation |
| `visible_tools` | Ready tools in the current full-schema presentation window |
| `cache.tool_count`, `limit` | Stored target-tool pair count and shared cache ceiling |
| `cache.bytes`, `byte_limit` | Retained JSON bytes and byte ceiling |
| `toolset.cached_count` | Shared cached tool-name view; it can differ from the target-tool pair count |
| `authorizations[].source=cache` | Exact declaration was available after target preparation; no extra search request was needed |
| `authorizations[].source=discovery` | A current capability search was required |
| `authorizations[].requested_tool_available=false` | The requested exact tool was not obtained; inspect the returned declarations and feedback instead of calling it blindly |

State can be `inactive` or `blocked`; neither permits dispatch. A prepared target
does not imply that every possible tool in its business system is available.
Discovery counts keep the separate meanings defined in
[capability feedback](CAPABILITY_FEEDBACK.md#search-result-meanings).

## If the model directly calls an unprepared cached tool

The retained name has a preparation guard. If the target is not ready, the guard
prepares that exact target and declaration, then returns context and schema with
`business_operation_performed=false`. It does **not** execute the requested
business arguments. The model must read the result and decide on a new tool call
using the current instructions and schema.

The original guard call ID stays attached to preparation. Replaying that same
call ID returns its preparation result, rather than turning the old attempt into
a write after preparation finishes. A later business call needs its own genuine
model-issued call ID. Hosts must not silently replay or re-label the first call
as an operation, and must not display a successful preparation as “product
updated.” A failed preparation remains a failure or unavailable result.

This guard is a fallback. Providing the preparation guidance and current state
to the model before it acts is the normal path and avoids unnecessary surprise.
Calls that enter concurrently before preparation finishes remain preparation-only.
The host must return preparation to the model before requesting the next business
decision. Do not queue a previously planned write behind preparation and silently
issue it under a new call ID. The runtime cannot establish that a custom host has
actually shown a response to the model merely by observing a later request.

## Example: shop and inventory conversation

In the first message, the user asks to find a shop product. The Agent selects the
shop authorization, searches product capabilities and calls the query tool.

In the next message, the user asks for that product's details. The Agent sees
the cached original tool name, prepares it for the same shop authorization,
reads current shop context and uses the returned schema. If the declaration is
still valid, no additional capability-search request is needed. The new query
uses the new turn's run, not the previous product-query run.

The user then asks to check warehouse stock. The Agent selects the separately
authorized inventory target and discovers its capabilities. Matching tool names
or product identifiers do not establish a cross-system relationship; the Agent
must use the business systems' verified identifiers and declared relationships.
Returning to a still-ready shop tool in the same turn requires no new search.

Simply saying “thanks” does not prepare either system or create business runs.
Scope validation, controlled system metadata or archive negotiation may still
occur under their existing contracts; no tool cache restores historical writes.

## Invalidation and original-operation recovery

The original complete selected scope is revalidated. Revocation or a changed
binding blocks the scope; it never falls back to a default account, another
Agent Session or the surviving subset. Target keys include the trusted original
binding, so same-named tools cannot acquire a different target from display text.

Current capability revision changes discard the affected target's old cache.
A same-revision, same-name contradictory declaration is quarantined rather than
silently replacing its meaning. Known conflicts survive tool eviction and local
invalidation; an authoritative new revision can clear them. Cache or metadata
budget pressure cannot expand authorization or establish that a missing tool
never existed. Re-discover only within the original selected target.

An operation already issued is different from a missing declaration. Awaiting
approval or uncertain outcomes keep the original invocation ID and run link.
Use `resume_governed_tool_invocation` for the original operation; never create a
replacement write after preparing tools. `inspect_original` means stop automatic
retries and inspect the original outcome. See
[durable invocation recovery](INVOCATION_RECOVERY.md).

Cancellation and ended turns continue to reject late tool activation. Cache
reuse does not weaken local storage errors, archive ACK/CAS, original-run audit
links, attachment identity or existing business approval rules.
Temporary target-preparation transport failures can be retried in the same
runtime and user turn. The retry preserves the original turn ID and initial
target-specific input, including after a lost response. A cancelled preparation
keeps its late run link without reopening that target in the ended attempt; a
later user turn can prepare the original target again.

## Host acceptance checklist

- Preserve the real Session, fixed scope, original call IDs and existing stores;
  enable session mode explicitly with the exact candidate.
- Keep preparation state, current context, `tool_schemas`,
  `business_operation_performed`, structured feedback and original invocation IDs
  in the model-visible tool result. A terse success badge alone is insufficient.
- Dispatch through the native tool registry, including cached preparation guards
  and valid tools outside the schema window. Do not filter by only the latest
  search result or `visible_tools`.
- Verify consecutive-message reuse, same-system accounts and cross-system
  same-name tools, changed declarations, revocation, cache eviction, ordinary
  chat without business runs, cancellation and preparation call-ID replay.
- Verify original-operation recovery independently: no repeated business write,
  no target substitution and no loss of the original execution record.

The business backend continues to own each capability's parameters, validation,
permissions and approval requirements. No new business API or consumer UI setting
is required for this opt-in DSH lifecycle.
