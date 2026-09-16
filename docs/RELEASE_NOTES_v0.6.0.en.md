# v0.6.0 DSH plugin: move between queries, edits and result checks

Release 0.6.0. Pairing: Core 0.8.0 / Agent Client SDK 0.6.0 / DSH 0.6.0. Changes below are relative to the preceding public release.

An Agent creates a shop product, checks inventory and returns to editing it. New searches now merge still-valid tools within a turn instead of discarding the earlier batch. Adapted hosts can also reuse declarations across messages in the same living Session, reducing repeated remote discovery.

## User-visible changes

**Smoother tool switching.** The retained registry is bounded to 64 tools with a 12-schema presentation window. Session reuse has a cache of at most 64 target-tool pairs and 2 MiB; these are not operation or product quotas. Each turn still prepares the intended target's current context. Identity, permission and declaration-revision checks remain. The existing search entry point supplies full schemas so the model need not guess old parameters.

**Inspect an original operation after reopening.** A persistent journal retains original target, run and invocation links. A pending shop listing can be inspected after closing the host. Public host methods support panel inspection and explicit continuation without manufacturing a model turn. Unknown writes are not replaced, and inspection never consumes approval.

**Task controls across turns.** Hosts can bind an administrator-created task with its original members and cumulative budget. Models cannot choose a task ID, create tasks or increase budgets. Pause, cancellation, budget exhaustion and ordinary frequency limits have distinct states.

**Use attachments in business actions.** Hosts register generated images or images explicitly selected by the user for business use. `list_generated_artifacts` / `upload_generated_artifacts` return reusable URLs. Their existing names do not restrict the source to AI generation. PNG/JPEG/WebP, 1–8 per batch and up to 6 MiB each, are supported. Ordinary chat attachments are not uploaded automatically. Subsequent business actions have separate results.

**Understand failures.** Rediscovery, unsupported interfaces, temporary outages, changed identity and unknown outcomes have distinct guidance. Rate-limited work retains its original invocation. A missing original record stops automatic recovery and requests inspection of original evidence; it does not prove that the business action never happened.

## Host integration

| Feature | Required host work |
| --- | --- |
| Cross-turn reuse | Opt into `toolLifecycle: 'session'`, keep the real Session/runtime and handle preparation results; the default remains `active_turn` |
| Original-call restart recovery | Provide a persistent `invocationStore` and retain scopes, events and archives; a custom scope store needs explicit durable companion stores |
| Task controls | Provide a persistent `taskStore`, use `getSessionTaskCoordinates` and public binding/restore methods for administrator-created tasks |
| Invocation panel | Call `inspectSessionInvocation` / `resumeSessionInvocation` with the real Session, original ID and cancellation signal; display business state from receipts |
| Attachment space | Connect a controlled `artifactSource` and persistent `artifactStore`; resolve approved references, not arbitrary paths |

Preparation is not business execution. Direct calls to unprepared cached tools return preparation only; read the current schema before issuing the actual action. Replaying that old call ID must not turn preparation into a write. `ready` likewise does not mean business success. Preserve storage failures, unsaved events and recovery gaps as primary errors.

Propagate cancellation when a panel closes or the user switches conversations. Late results must not reactivate ended-turn tools. Cancelling a wait does not withdraw an already submitted request.

## Upgrade and limits

Follow the [paired upgrade guide](UPGRADE_v0.6.0.en.md): upgrade Core and SDK before the actual host's DSH and persistence adapters. Existing backend APIs and approvals need no change.

The declaration cache survives only within the current Session/runtime; a restart requires discovery again. Original-call recovery uses a separate durable journal and does not resume a whole model plan. Missing historical bindings are not reconstructed, and any invalid original member blocks the whole group. The same-Hub, same-audit-domain boundary remains. These DSH seams do not automatically appear in generic MCP hosts.

Bounded client synthetic acceptance and actual development Profile package verification are complete. Actual clicks in the latest panel, Windows devices and arbitrary model-driven long tasks are not fully covered. Verify the actual installed release package.
