# Discover capabilities and recover the right operation

This additive candidate improves the information the Agent receives. Existing
authorization, approval, fixed conversation scope and archive rules still apply.
The package version alone does not identify this candidate: use its source commit
and package SHA-256 from the accompanying candidate manifest.

## What users should notice

For example, an Agent checks warehouse stock and then updates a shop product.

- A currently loaded shop tool can be called directly for its selected account.
- Searching warehouse capabilities may replace some previously loaded tools under
  the shared limit. A retired shop tool means “discover it again”, not “the shop
  does not support this operation”.
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
| `toolset.active_count`, `limit` | Current session business-tool count and shared ceiling of 12; search/resume/local tools do not consume this budget |
| `toolset.generation` | Local collection generation, separate from Core's capability revision; compare only within the same runtime/session |
| `toolset.omitted_tool_count` | Compatible cached candidates omitted by the shared budget, not all unreturned Core capabilities |
| `toolset.conflicting_tool_count` | Separately excluded conflicting declarations |

Multi-account results place `discovery` under each searched `authorizations[]`
entry. The top-level `toolset` covers the whole conversation, not just that target.
The existing top-level `omitted_tool_count` remains as a compatibility alias for
the shared-budget count. Successful searches replace the searched target's
candidates (`candidate_update=replace`), then recompute the shared set
(`toolset.update=recompute_shared`). Single-account search uses `update=replace`.

An unrelated query can still return ranked candidates. Neither an empty result
nor a transport failure proves that the entire business system lacks a feature.
Optional metadata from older components is unknown, never a fabricated zero.

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
// { state, toolset, active_tools }; no HTTP requests or new business run

runtime.getToolDispatchFeedback(sessionId, {
  toolName, callId, errorCode: 'UNKNOWN_TOOL',
})
// feedback or null; call only after the host registry actually rejects lookup
```

Pass the original call ID. If that call already has an invocation, feedback points
to that original ID instead of suggesting a new operation. These methods do not
execute or restore tools and must not be used to bypass normal scope validation.
No new user/assistant message upload path is needed.

Tested with the public native registry `@deepseek-ai/dsh-tools@0.1.1-rc.2` and real
Cordis/DSH Sessions. A custom host must verify the hook and preserve the feedback
carrier through its own model loop. Simply adding properties to a thrown Error is
insufficient: the host may discard them. Older SDK/Core combinations retain their
business flows, but may lack precise counts or authoritative error detail.

Use the paired candidate packages and verify their installed hashes. A normal
installation of the same numbered registry release will not fetch unpublished
candidate changes. No credential, scope, archive or database migration is added.
