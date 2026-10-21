# Agent Client context delivery confirmation

This optional local host contract reduces repeated context bodies in session-tool
preparation results. It does not change Core chat/embed context assembly, grant
authorization, or acknowledge business execution. The separate
[on-demand knowledge contract](AGENT_KNOWLEDGE.md) adds explicit search/read tools;
delivery confirmation itself never searches or reads a document.

## Default and timing

Existing or unknown hosts keep the complete `contexts` array in preparation
receipts. Named system/runtime contributions also remain in ordinary DSH prompt
assembly. Existing runtime-snapshot deduplication is unchanged.

The first lazy preparation creates context after the preceding model request was
sent, so it remains inline. After a cooperating host has assembled and confirmed
the current named contributions in a final provider request, later same-binding
preparations may omit that repeated body. This does not eliminate the first inline
copy already retained in tool history.

## Public local service

Use the `bailingHubAgentClient` service (`BailingHubAgentClientRuntime`), outside
model tools:

```js
const manifest = runtime.getContextDeliveryManifest(session.id)
const confirmation = await runtime.confirmContextDelivery(session.id, {
  delivery_id: manifest.delivery_id,
  generation: manifest.generation,
  request_id: 'opaque-provider-request-17',
  fragments: [
    { kind: 'system', name: 'bailinghub:agent-client-profile', text: actualSystemSection },
    // One entry per manifest runtime_context fragment, retaining its exact name.
    { kind: 'runtime_context', name: actualNamedContextName, text: actualNamedContextText },
  ],
})
```

The manifest is available only after a current active context was assembled. It
contains kind/name, SHA-256 and UTF-8 bytes, never document text. Target references
bind current run/profile/capability/context revisions. The opaque ticket also binds
the local Session, real user turn and complete original authorization scope and
revision, including connection, Hub, client, route and authorized Session identities.

Each assembly creates a new generation and clears preceding confirmation, even
if its text is unchanged. Tickets expire after 60 seconds. There is one opaque
`request_id` per generation: 1–128 ASCII letters/digits and `_.:-`, beginning with a
letter/digit. Identical confirmations for that request are idempotent; a different
request id needs a fresh assembly.

## Final provider request responsibility

The host must confirm **every final provider request**, after its own serialization,
clipping, compaction and policy transforms. Extract only the exact current
BailingHub system section and named runtime contributions actually present in
that request. DSH runtime snapshots may use a provider `user` role with trusted
plugin source; preserve `snapshot.source.sections` attribution through serialization.
Do not infer authority from role alone. Ordinary user/tool history is not a named
runtime contribution. Do not scan arbitrary messages for substrings or manufacture
fragments by parsing old inline preparation JSON.

All manifest entries require correct kind/name and exact text hash/size.
Unrelated kinds/names, duplicates, missing/truncated text and invalid inputs reject.
Text is compared only in memory: not retained, logged, or returned. Confirmation
is bounded to 256 fragments and 4 MiB total text; an unsupported host stays inline.

Request N's confirmation does not prove N+1 still contains context. Even if a light
preparation was produced between requests, the host **must not send N+1** without
reassembling and confirming current fragments. Missing/truncated context or rejected
confirmation requires restoring named contributions and assembling/confirming
again, or aborting that model request. Do not replay a business tool to repair a
prompt. Core authorization, approval and unknown-invocation recovery are unchanged.

The library cannot independently observe downstream network payloads. Confirmation
is a cooperating host's presentation protocol, not proof that a model received,
read or understood text and not a security/authorization assertion.

## Invalidation and fallback

```js
runtime.invalidateContextDelivery(session.id, { reason: 'request_failed' })
// host_reset, request_failed, assembly_discarded, authorization_unavailable
```

Reset when a prepared request is discarded, serialization fails, or delivery
strategy changes; unknown reason strings become `host_reset`. Reassemble before
confirmation. New assembly/turn/run/scope/account/route/Session/profile/capability/
context revision invalidates prior acknowledgement. Ended/disposed sessions cannot
confirm. Expired or changed-back bindings cannot revive an old ticket. Late old
tickets cannot replace a newer receipt. Malformed current confirmation invalidates
its generation; a fresh assembly is required.

Rejections return a bounded reason and
`next_action: reassemble_context_before_model_request`, never the submitted body.
They do not establish that any business operation ran or that an unknown one did not.

## Preparation and metrics

The existing preparation schema retains `result_type`, `dispatch: not_dispatched`,
`business_operation_performed: false`, preparation state, full tool schemas,
governance and explicit usage-guidance result. Confirmed optional delivery uses
`contexts: []` plus `context_delivery` with schema
`bailing.agent-context-delivery.v1`, mode `named_runtime`, state `confirmed`,
`body_omitted: true`, bounded delivery/generation/request/context references,
target revisions, `next_request_requires_confirmation: true`, and
`business_permission: false`. Empty contexts means already delivered by the named
path, not knowledge absence. Otherwise complete contexts remain with mode `inline`,
state `inline_fallback`, `body_omitted: false` and a bounded reason.

`context_metrics` contains fixed numeric fields only:

- `source_context_bytes`: UTF-8 bytes of JSON.stringify(full contexts array).
- `inline_context_bytes`: bytes of the returned array (`[]` is two bytes).
- `omitted_context_bytes`: the difference.
- `tool_schema_bytes`: bytes of returned tool_schemas.
- `usage_guidance_bytes`: bytes of explicit usage-guidance, otherwise zero.

These preparation-component bytes are not final model token counts, provider wire
sizes, relevance scores or evidence-retention guarantees. Measure the final provider
request separately without logging bodies or credentials. Do not globally dedupe
identical text across accounts.

## Dependency candidates

Source root overrides repair the registry SDK's old exact MCP dependency and retain
the SDK safety override, so this workspace lock can be audited cleanly. Library
overrides do not propagate downstream. Consumers must install the matching new SDK
and DSH candidates as direct local tarballs, select that SDK for DSH via their root
override, regenerate their actual lock and verify ESM resolution, installed bytes,
fresh audits and final runtime build. Version alone does not identify an internal
same-version candidate. Knowledge search/read follows the separate negotiated
contract; it does not introduce a free-form knowledge_get or off/hint/full switch.
