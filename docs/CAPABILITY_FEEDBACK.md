# Discover capabilities and recover the right operation

This additive candidate improves the information the Agent receives. Existing
authorization, approval, fixed conversation scope and archive rules still apply.
The package version alone does not identify this candidate: use its source commit
and package SHA-256 from the accompanying candidate manifest.

## What users should notice

For example, an Agent checks warehouse stock and then updates a shop product.

- A currently loaded shop tool can be called directly for its selected account.
- The Agent can discover product creation, create a product, discover a query tool,
  check the result, and return to product creation without another search. Searching
  warehouse tools also retains valid shop tools within the current turn.
- Only 12 full schemas are shown at a time; up to 64 discovered business tools remain
  registered and directly callable with their original target and known parameters.
  This is a tool-type budget, not a limit on operations, products or task duration.
- If the shop request was sent but its response is unconfirmed, recover only its
  original invocation. A new search or tool name must not produce another write.

Business systems still define their own product fields, validation and approvals.
This change adds no stock synchronization, cross-system transaction or rollback.

## Search result meanings

`search_business_capabilities` keeps its existing parameters. Cross-system search
requires the original `authorization_ref` and a minimal target-specific query.
Single-account and same-system selection continue to work.

| Field | Meaning |
| --- | --- |
| `discovery.returned_count` | Candidates actually returned for this search target |
| `discovery.authorized_total` | Tools in the same authorization-filtered catalog; `null` when unknown |
| `discovery.matched_total` | `null`: ranked candidates do not establish an exact match count |
| `discovery.truncated`, `has_more` | Whether authorized catalog candidates were omitted by the search limit; `null` when unknown |
| `discovery.truncation_scope` | `authorized_catalog` when reported, otherwise `unknown` |
| `discovery.mode` | `ranked_candidates`, or `unknown` for older/malformed optional metadata |
| `discovery.pagination` | `unsupported`; the result does not promise complete paging |
| `active_tools` | Business tools currently registered for this conversation, with their target references where applicable |
| `toolset.active_count`, `limit` | Current registered business-tool count and shared ceiling of 64; search/resume/local tools do not consume this budget |
| `visible_tools`, `toolset.visible_count`, `visible_limit` | Current full-schema presentation window, capped at 12 across targets; absence here does not mean unloaded |
| `toolset.retained_outside_window_count` | Registered tools outside that window, still callable using the exact schema already discovered |
| `toolset.lifetime` | `active_turn`: one user message through its completion/cancellation, including all intermediate searches and operations |
| `toolset.generation` | Local collection generation, separate from Core's capability revision; compare only within the same runtime/session |
| `toolset.omitted_tool_count` | Compatible cached candidates omitted by the shared budget, not all unreturned Core capabilities |
| `toolset.conflicting_tool_count` | Excluded shared declaration conflicts plus per-target contradictory catalog entries |
| `toolset.catalog_conflict_count` | The per-target contradictory catalog portion of that count |

Multi-account results place `discovery` under each searched `authorizations[]`
entry. The top-level `toolset` covers the whole conversation, not just that target.
The existing top-level `omitted_tool_count` remains as a compatibility alias for
the shared-budget count. `toolset.update=merge` describes the registration policy, consistently for one or
many accounts. Per-target `candidate_update=merge` means the new results were added
under the same authoritative catalog revision; `reset` with
`invalidation_reason=capability_revision_changed` invalidates that target's old
cache before retaining the new response. Tools from other targets keep their own
revisions. `evicted_count` counts candidates removed by the per-target cache cap
in this update; it is not a catalog total.

If the same target, revision and tool name claim different declarations, that
name is quarantined for the revision. `conflicting_tools` and structured
`feedback.category=capability_changed` explain the exclusion. Other valid tools
remain available. The runtime never silently reinterprets old arguments under the
new declaration. An authoritative new revision can remove the quarantine.

An unrelated query can still return ranked candidates. Neither an empty result
nor a transport failure proves that the entire business system lacks a feature.
Optional metadata from older components is unknown, never a fabricated zero.

## Long-task lifecycle and safety

Discovery merges only tools actually returned for selected authorizations; it does
not preload a system's whole catalog. An empty successful search with an unchanged
revision or a temporary search failure preserves prior valid candidates. A new
revision clears that target's old candidates even if the new response is empty.
Core still checks the original identity, allowed surface and revision before each
new invocation; local retention does not extend permission or skip approval.

Each target retains up to 64 recently discovered/used declarations. The shared
registry also caps at 64, favoring recently searched/used tools; the schema window
favors the latest search and subsequent use. Candidates outside the registry cap
need discovery again. Tools merely outside `visible_tools` do not. This keeps
memory and prompt costs bounded without forcing a search for every call.

The registry applies differences rather than clearing all registrations on every
search. Unchanged definitions keep their registration; changed schemas or target
enumerations are retired individually. Searches are serialized within the turn;
independent calls keep their original invocation bindings while discovery runs.
An invocation already issued keeps its original arguments, revision, authorization
and ID regardless of cache eviction. Resume never creates a replacement write.

Completion, cancellation, scope failure and a new user turn retain their existing
boundaries: ended turns cannot accept late search results or reactivate tools.
The cache is not persisted or reused as authority across turns/restarts. Archive
events, original run links, ACK/CAS and attachment upload identities are unchanged.
Original invocation metadata can be persisted separately by the
[durable recovery candidate](INVOCATION_RECOVERY.md); it does not restore the old tool cache.

## Structured failure feedback

Failures carry `bailing.agent-feedback.v1` with `category`, `code`, `origin`,
`operation`, `dispatch`, `retryable`, `next_action`, a controlled `message`, and the
original `invocation_id` when one exists. SDK-defined feedback is projected through
a safe allowlist; raw transport messages and arbitrary extra fields are omitted.

`retryable` refers only to `next_action`. It never grants permission to issue a new
business invocation. `dispatch=not_dispatched` is used only for a known stage; a
transport failure after invoking cannot establish that the request was not sent.

| Category | Intended next step |
| --- | --- |
| `tool_not_loaded` | Rediscover the same selected target, unless an existing invocation needs recovery |
| `capability_changed` | Check the current declaration; an original recovery stays bound to the original invocation |
| `transport_unavailable` | Retry discovery or original identity validation/recovery as indicated |
| `authorization_unavailable` | Restore/confirm the original scope or reauthorize; do not use defaults or a surviving subset |
| `unsupported` | Check the supported component combination; arbitrary 404/503 errors are not version evidence |
| `invocation_outcome_unknown` | Resume or inspect the original invocation; never create a replacement write |
| `cancelled`, `invalid_request`, `unknown_failure` | Follow the explicit action; do not guess a business retry |

Core's `reconciliation_required` result remains a non-auto-retry result. Its
feedback says `inspect_original`; ordinary resume may only replay the recorded
uncertainty and can require an operator to verify the result.

An authoritative original-record lookup failure also requires inspection:
`code=invocation_not_found`, `category=invocation_outcome_unknown`,
`next_action=inspect_original`, `retryable=false`, `original_outcome=unverified`.
The plugin stops the current recovery poll and preserves the original invocation ID.
For example, a host may have saved a shop listing's dispatch fence before it crashed,
while the request never reached Core. That is only one possible cause: a missing
record does not prove that the listing was never performed. Do not recreate it from
the conversation or switch accounts. Generic 404/network errors cannot establish
this condition. See [recovery failure rules](INVOCATION_RECOVERY.md#failure-and-compatibility-rules).

## Client host integration

Standard native DSH uses the existing `tools/execute` hook. Error results retain
`isError=true` and the original host error information, while carrying the same
safe feedback in `result.meta.bailinghub.feedback` and JSON text content
`{"feedback": ...}`. Ordinary multi-target search can succeed overall while a
target entry contains `state=unavailable` plus its own `feedback`.

Only BailingHub-owned tool failures are decorated. Host `UNKNOWN_TOOL` is classified
as retired only for a previously registered business name in that conversation
which is no longer registered. Other plugins, unknown names, currently registered
tools hidden by host presentation, and reserved tools are not reclassified.

Two read-only runtime methods support hosts which intercept dispatch earlier:

```js
runtime.getSessionToolState(sessionId)
// { state, toolset, active_tools, visible_tools }; no HTTP requests or new business run

runtime.getToolDispatchFeedback(sessionId, {
  toolName, callId, errorCode: 'UNKNOWN_TOOL',
})
// feedback or null; call only after the host registry actually rejects lookup
```

Pass the original call ID. If that call already has an invocation, feedback points
to that original ID instead of suggesting a new operation. These methods do not
execute or restore tools and must not be used to bypass normal scope validation.
Do not filter dispatch against `visible_tools` or the latest search response: the
native registry and `active_tools` determine retained availability. Do not cache a
stale copy of the registry or demand discovery before every call. Keep all new
fields in model-facing search results. Custom hosts which only allow names in the
current schema window need to support retained native registry dispatch; otherwise
their presentation layer can still produce an artificial `UNKNOWN_TOOL`.
No new user/assistant message upload path is needed.

Tested with the public native registry `@deepseek-ai/dsh-tools@0.1.1-rc.2` and real
Cordis/DSH Sessions. A custom host must verify the hook and preserve the feedback
carrier through its own model loop. Simply adding properties to a thrown Error is
insufficient: the host may discard them. Older SDK/Core combinations retain their
business flows, but may lack precise counts or authoritative error detail.

This iteration changes DSH only; the accompanying manifest pins the existing SDK/Core
without requiring a server deployment or database migration. Use the exact DSH
candidate package and verify its installed hashes. A normal
installation of the same numbered registry release will not fetch unpublished
candidate changes. No credential, scope, archive or database migration is added.
