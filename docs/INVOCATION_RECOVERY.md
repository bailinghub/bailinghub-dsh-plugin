# Reopen a conversation and recover its original business actions

This is an **unreleased candidate**. The unchanged package version does not identify
its source: use the exact candidate commit and package digest supplied with it.

A shop listing may still await approval when a user closes the Agent. An inventory
adjustment may have reached the server even though its response was lost. Reopening
the same conversation must keep those actions attached to their original accounts
and calls. It must not create a second listing or stock adjustment from remembered text.

The plugin adds durable **invocation metadata**, separate from the visible conversation
archive and attachment space. It retains the original fixed scope fingerprint/revision,
connection key, Hub/client/workspace, Agent Session, authorization reference, run,
invocation ID, tool name, declaration revision, host call ID and parameter digest.
It also stores the last received state, receipt digest and retry deadline. It does not
store credentials, raw tool arguments, receipt bodies or conversation text in this journal.
Digests support association and change detection; they are not independent tamper-proof evidence.

## What happens before and after reopening

1. Before a new business request leaves the host, save its original binding using
   compare-and-swap (CAS). If that cannot be confirmed, do not send the request.
2. After a response, save only its state and digest. A failed save remains
   `storage_error` with an unsaved record. A successful business response does not
   erase the local recovery-storage error.
3. Reopen the real DSH Session with its original persisted events and scope. Reuse
   its invocation store. Do not create a replacement Session or replay user messages.
4. Inspect or restore local invocation metadata. This does **not** create business
   runs, invoke/resume business actions, or restore old dynamic tools.
5. When the user or Agent explicitly requests recovery, call
   `resume_governed_tool_invocation` with only the original `invocation_id`. The plugin
   verifies every original scope member and uses that call's original target. It sends
   `resume` with the original ID and an empty payload, never a replacement `invoke`.

`resume` is **not a read-only status operation**: Core may continue an approved or
otherwise resumable original operation. Unknown dispatched writes remain subject to
Core's existing reconciliation and approval rules. Reopening alone does not do this.
This candidate does not automatically continue a whole task, DAG or sequence of actions.
When the user starts a new recovery turn, the existing runtime may create a current-turn
run for the original selected target to keep the new conversation/audit association.
That run never replaces the recovered call's original run or invocation. The startup and
local status/restore stage creates no such run.

A local last-known state is not current server proof (`result_verified: false`). After
full reopening, recovery obtains the original server receipt even if local metadata says
`executed`. Within a living host, its original confirmed response may be reused. A
cancelled or ended turn can retain late original receipts without re-enabling its tools.

## Host integration

The default plugin uses its protected `invocation-records` directory under the DSH
plugin data directory. A host supplying a custom `scopeStore` must **explicitly** supply
an `invocationStore`; omission preserves existing business behavior but does not support
durable recovery after a full restart. `null` also explicitly disables the new store.

```js
import { createAgentClientPlugin, createFileInvocationStore } from 'dsh-bailinghub'

const plugin = createAgentClientPlugin({
  scopeStore: hostScopeStore,
  archiveStore: hostArchiveStore,
  invocationStore: createFileInvocationStore({ directory: hostInvocationDirectory }),
})
```

Place `hostInvocationDirectory` in the same durable, access-controlled host data area as
the original Session scope. Never derive it from model input. An explicit memory store
is exported for tests; a new empty memory store is not persistence after process restart.

Custom adapters implement the same asynchronous interface:

```js
await store.load(sessionId) // null or the complete metadata record
await store.save(sessionId, nextRecord, expectedRevision) // return saved record
```

The record schema is `bailing.agent-invocations.v1`; its top-level fields are `schema`,
`sessionId`, `revision`, `entries`. Revisions start at 1; missing expects `null`. Save must
atomically compare the previous revision, persist the full record, and acknowledge only
after durable success. A load error must not return `null`. Custom stores must retain
the strict metadata-only field restrictions and enforce the same 8 MiB record bound.

In the standard DSH command interface, `/bailinghub invocations status` reads this
status and `/bailinghub invocations restore` retries only the local metadata save.
Neither command calls the business resume endpoint.

The runtime exposes:

| Interface | Effect |
| --- | --- |
| `getSessionInvocationStatus(sessionId)` | Verify original scope and read local journal status. |
| `restoreSessionInvocations(sessionId)` | Verify scope and flush pending local metadata with original CAS identity. No business invocation or resume. |

Both return `state`, `entries`, `unsavedRecords`, plus `revision`/`reason` when available.
Each entry has `invocation_id`, `authorization_ref`, `tool`, `original_run_id`,
`last_known_state`, `retry_at`, and `result_verified: false`. Treat tool names as data.
Do not turn these entries into new calls or consider the task complete from this list.

| State | Host action |
| --- | --- |
| `ready` | Metadata is readable and saved; explicit original-call recovery is available for known records. This is not a claim that every historical call has a journal record. It does not confirm Core connectivity or the business outcome. |
| `inactive` | No selected business scope, or the conversation has not started. Ordinary chat makes no Hub request for this journal. |
| `unsupported` | No invocation store. Existing same-host business/recovery behavior is retained. |
| `blocked` | Original scope or invocation binding is unavailable/conflicting. Do not switch account or use a surviving subset. |
| `storage_error` | Restore local persistence first. Keep unsaved records and the original call identity. |

Keep conversation archive `storage_error`, `unsavedEvents` and `recovery_gap` visible
independently. A `ready` invocation journal cannot make an incomplete transcript complete. If local
metadata is unsaved while authorization is also blocked, preserve `storage_error` and
`unsavedRecords` as the primary state, with `scope_state: blocked` and `scope_reason`;
this does not enable business access or discard either failure.

## Failure and compatibility rules

- `invocation_store_unavailable` / `invocation_store_conflict`: category `storage_error`,
  next action `restore_invocations`. Do not interpret `not_dispatched` on a failed
  recovery attempt as evidence that the original business action never ran.
- `invocation_binding_unavailable` / `invocation_binding_conflict`: inspect original
  evidence. Never guess the binding from transcript text or accept model-supplied targets.
- `invocation_store_unsupported`: the host has not enabled durable invocation storage.
- Existing SDK/Core network, authorization, unsupported and reconciliation feedback
  continues unchanged. No new Core endpoint, SDK method, database migration or business
  backend capability declaration is required for this candidate.

Whole-scope revalidation includes single-system multiple accounts. Temporary offline
checks stay closed but can recover in the same runtime. A confirmed revoked or rebound
member blocks the complete original group. Existing cross-Hub restrictions remain.

Concurrent writers cannot overwrite a different stored outcome with a stale receipt.
On a conflict, preserve both the stored record and unsaved local status for inspection.
Do not clear an unsaved record simply to make the screen green. File-store locks are
not automatically treated as stale: after an abnormal host exit while saving, an
operator must establish that no writer remains, preserve the record/lock evidence and
resolve storage ownership before retrying. Do not instruct a model to delete locks.

The journal closes the host-side identity gap, not every crash gap. If the host saved
its dispatch fence but crashed before the request reached Core, an explicit resume can
return `invocation_not_found`. That response does not authorize automatic reconstruction
or resubmission. Missing/deleted records from older installations cannot be backfilled
from conversation prose. Old sessions without a journal remain explicitly unsupported
or unavailable; new calls begin producing records once the host enables the store.

## Acceptance expectations

Use synthetic shop/inventory data and real persisted DSH Session events. Cover pending
approval and lost responses across complete host reconstruction; unchanged original
invocation ID, authorization and run; zero duplicate `invoke`; no automatic startup
resume; all-member revalidation; offline recovery; pre/post-dispatch storage failures;
CAS conflicts and lost save acknowledgements; cancellation before delayed save returns;
and empty scope with zero Hub requests. Preserve the existing long-task tool retention,
declaration-change, archive and attachment regressions.
