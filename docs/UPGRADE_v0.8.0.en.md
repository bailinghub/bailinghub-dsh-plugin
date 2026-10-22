# Upgrade to DSH 0.8.0

Pair Core 0.10.0, SDK 0.8.0 and DSH 0.8.0. Node.js remains `^22.19.0 || >=24.0.0`; the exercised Harness line remains `0.1.1-rc.2`. The four public configuration fields are unchanged.

1. Back up and upgrade Core first, applying only its outstanding migrations. The plugin does not migrate the Hub database.
2. Checkpoint active tasks and preserve pending original operations/approvals, credentials, Sessions, scope/task/invocation stores and archives. Never reconstruct an unknown business action.
3. Install `dsh plugin --profile web add dsh-bailinghub@0.8.0`. It must resolve exact `bailinghub-mcp-server@0.8.0` automatically; do not substitute an optional peer, local path or another SDK version.
4. Restart and verify the actual Profile and loaded modules. Run `/bailinghub doctor` and `/bailinghub status` without printing credentials. Retain explicit authorization scope and business rules.

## Host integration

- Session tool reuse still requires explicit `toolLifecycle:'session'`. Calling an unprepared tool returns preparation only. Read the current context and complete schema before a new decision; never turn replay of the old call ID into execution.
- Current authorized protocol negotiation enables on-demand knowledge. Pin the original turn mode and use `search_business_knowledge` / `read_business_knowledge`, retaining ref, run, authorization_ref and pagination/truncation facts. Unknown protocols retain inline knowledge; service/auth failures cannot silently discard it. See [the knowledge protocol](AGENT_KNOWLEDGE.md).
- Integrate context confirmation only when the host can observe every final provider request and confirm its current named contributions. Keep inline bodies without confirmation. If a later request is missing context, reassemble/reconfirm or stop; never replay business calls to repair prompts. See [the host contract](CONTEXT_DELIVERY.md).
- Model descriptors pass through unchanged. Hosts may use SDK `resolveModelOutputBudget()` and `modelOutputOptions()` to separate defaults/ceilings, output keys and scope. Apply them to new requests only; existing operation/intent/hash remain unchanged.
- Automatic continuation needs a separate host implementation with final original receipts, checkpoints, bounded budgets, cancellation, approval and effect deduplication. Inspect missing final receipts with `inspectModelRequest()`; inspect business receipts with `inspectInvocation()`. `resume()` can first-dispatch an approved original and is not polling.

## Acceptance and fallback

Use an isolated Profile for single-plugin installation, one exact SDK resolution, normal tools, preparation without dispatch, knowledge search/pagination, authorization isolation, cancel/revoke and original recovery. Context confirmation requires checking final request contents. Each host separately accepts its real UI and long tasks.

The immutable Client Token 0.1.1 static path remains independent. Package rollback does not roll back Hub data or rewrite saved operations. Preserve new records and do not continue Sessions in an old host that lacks their task/recovery formats. Audit the actual installing host separately.
