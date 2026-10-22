# Agent Client on-demand knowledge

This adapter's knowledge disclosure applies only to local Agent Client sessions.
Core's native chat, embed and Widget retain their independent knowledge injection.
Instructions, governance and memory remain in their current system/runtime channels.

The optional SDK methods are `getKnowledgeCapabilities(options)`,
`searchKnowledge(input, options)` and `readKnowledge(input, options)`. An old SDK
still loads; its unsupported knowledge protocol retains complete legacy inline
context. A new SDK probes the current authorized Core. Only the explicit matching
knowledge protocol permits trusted `startTurn` option
`knowledgeDelivery: 'on_demand'`. This choice is pinned for the original user turn.
401/403, service failures and unknown schemas cannot silently remove knowledge.
The adapter checks Core's delivery echo; it never removes inline knowledge itself.

## Model tools

`search_business_knowledge` accepts a minimal `query` (up to 500 characters),
optional `limit` (1–3), and the intended `authorization_ref` when multiple targets
are selected. A lazy target can be prepared for a knowledge-only question without
searching business capabilities or dispatching a business tool. Queries are never
broadcast across authorizations or sent to an unselected global default.

Search returns at most three short title/summary/ref hints, `status` and an explicit
`trust: reference_only`. Use `read_business_knowledge` with a relevant `ref`, the
same authorization, optional `cursor` and optional `max_bytes` (4096–32768) to read
one page. The runtime supplies the original run; the model cannot redirect it.
Search JSON is bounded to 4 KiB, read JSON defaults to 16 KiB and is at most 32 KiB.

Read only relevant documents and follow `next_cursor` as necessary. Hints are not
full documents. `truncated: true` remains incomplete even when
`budget_exhausted: true` ends a 128 KiB content chain with no next cursor. Safe
`total_content_bytes`/`read_chain_max_bytes` scalars can explain that limit.

References are opaque, expire after 300 seconds, and remain bound to the original
Agent Session, route, run and current knowledge revision. Never reuse them across
accounts. Invalid/changed/expired references return `next_action: search_knowledge`.
Search again under the same authorization; never replay a business operation.
Unavailable retrieval is not an empty corpus. Empty business-tool hits do not mean
that knowledge is absent.

## Context and host cooperation

The prompt always explains that reference knowledge may exist and exposes these
two tools independently of business tool discovery. A prepared on-demand target's
named knowledge context contains the delivery status and light discovery hints;
document bodies arrive only through explicit reads. Reference text never overrides
system instructions, governance, identity or approval.

The first-batch `getContextDeliveryManifest` / `confirmContextDelivery` contract
continues unchanged. Confirm the exact named current contributions present in each
final provider request. Hints are not a full-body acknowledgement. Retain actual
read results in their current authorized conversation, with bounded pages and
source attribution. Do not inject a separate full knowledge corpus into new
on-demand sessions, and do not trim legacy inline knowledge on unknown Core/SDK.

The client should verify real final-provider request contents, not only a
preparation receipt. Required acceptance cases: knowledge-only question, relevant
hint followed by one read, empty result, unavailable retrieval, paginated/truncated
document, expired/changed ref, multi-account isolation, cancellation or revocation
during a read, old SDK/Core fallback and first-batch delivery confirmation.
Neither this adapter nor knowledge receipts acknowledge a business write.
