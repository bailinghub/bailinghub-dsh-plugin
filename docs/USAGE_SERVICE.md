# USD model gateway for local agents

A plan has a USD allowance, one multiplier, and a live selection of conversation models and model tools. The Hub relays individual requests and meters their cost. The host keeps its original planning, tool selection and AgentLoop. Business authorization, approval, session scope, task controls and conversation archives remain separate.

This optional module pairs Core 0.9.0, SDK 0.7.0 and DSH 0.7.0. It is new relative to public SDK/DSH 0.6.0 and has no legacy Token-allowance aliases, silent billing fallback, balance conversion or automatic BYOK substitution. Public Core 0.8.0 upgrades add outstanding 063/064 migrations and retain existing data. Do not erase business authorizations, history or unrelated sessions; abandoned test configuration is separate maintenance, not a customer upgrade requirement.

## Identity and catalog

The trusted product backend issues a Usage credential for the original Hub/user/account. `model_access:'token_gateway'` remains the credential scope spelling for the whole permitted plan; it does not select a Token billing algorithm. A deliberately single-service credential stays restricted to its original service. Supplier URLs and API keys stay server-side.

```js
import { createUsageClient } from 'bailinghub-mcp-server/usage'
const client = createUsageClient({
  hubUrl: trustedLogin.hubUrl,
  userId: trustedLogin.userId,
  accountId: trustedLogin.accountId,
  serviceId: trustedLogin.serviceId,
  accessTokenProvider: () => secureCredentials.readUsageToken(),
})
await client.capabilities()
const models = await client.modelModels()
const tools = await client.modelTools()
const summary = await client.modelSummary()
```

Capabilities must advertise `model_gateway` with schema `bailing.model-gateway.v1`, `billing_unit:'USD'`, `orchestration:'host'`, `turn_required:false`, streaming, native provider response envelopes and asynchronous settlement. Old Core/SDK returns explicit unsupported, not an alternative billing path.

`modelModels()` reads `/usage/v1/model/models`, schema `bailing.model-models.v1`. Its `items` are only conversation models. Render the operator's `label`, store the immutable `service_id`, never route by label or provider model name. Every read refreshes current plan membership. An empty directory is valid and does not authorize choosing an unrelated model.

`modelTools()` reads `/usage/v1/model/tools`, schema `bailing.model-tools.v1`. Each item has a stable `service_id`, `service_revision`, display label, capability/output kinds and a `tool:{name,description,input_schema}`. Register only `callable:true` items in the host's local tool registry. Keep unavailable items as configuration diagnostics with their explicit `reason`. Catalog reads neither generate media nor start business runs. Namespace registrations by service identity to avoid duplicate operator-defined names or collisions with business tools; tool names alone are never authorization identities.

## Shared allowance and display

`modelSummary()` returns `bailing.billing-summary.v1`, with USD fields `availableUsd`, `consumedUsd`, `currentPeriodConsumedUsd`, `overageUsd`, the original grant and current plan. The plan supplies `serviceIds` and one `multiplier`; per-model input/output multipliers and Token balances no longer exist.

Use `presentation` (`bailing.usage-presentation.v1`) for customer balances: allowance packs show credits; periodic plans show remaining percentage and reset time. Never recalculate balances locally from raw tokens, prices or a previous model response. Missing/malformed presentation is `USAGE_RESPONSE_INVALID`, not a guessed balance. Account details may show reported provider Token counts as usage information, separate from allowance and percentage. If unavailable, show not provided, never fabricate zero Tokens.

Reference provider pricing is not an actual supplier invoice or guaranteed margin. Each request snapshots its plan multiplier and reference price; server-side USD accounting is exact to twelve decimal places. Receipt fields `reference_cost_usd`, `billed_usd`, `overage_usd` are amounts; `usage` contains integer Token counts when reported, and `raw_usage` can contain non-Token measurements. Unknown usage keeps billing pending. No client-side multiplication, second debit or extra model request is allowed.

## Request and recovery API

| SDK method | Behavior |
| --- | --- |
| `modelComplete(input)` | One JSON model request, no server agent loop |
| `modelStream(input)` | Provider packets followed by the original durable operation receipt |
| `runModelTool(input)` | One model-tool generation request |
| `inspectModelRequest(operationId, originalCoordinates)` | Read original operation only |
| `cancelModelRequest(operationId, originalCoordinates)` | Cancel original operation, never replay it |

Conversation requests use `/usage/v1/model/requests` and `/usage/v1/model/requests/stream`. Tool requests use `POST /usage/v1/model/tools/requests` with `{operation_id,service_id,arguments,conversation_id?,turn_id?}`. A tool POST can return HTTP 202 with a durably admitted pending operation. Poll the original request until complete or cancelled; do not submit another generation. All use the same original request inspection/cancellation path and `bailing.model-operation.v1` receipt. Streaming frames use `bailing.model-stream.v1`.

A completed model result can have `billing_state:'pending'`; billing settlement must not stop the local loop. Native provider response bytes are preserved in `bailing.provider-response.v1`. The local provider adapter interprets content, finish reason and tool calls. A tool result uses `bailing.model-tool-result.v1` with typed outputs. Downloading or using a result in a business attachment space is an explicit subsequent host action, never an automatic business write by the Hub.

Persist the original operation ID, selected service and local event coordinates before any dispatch. If a POST loses its ACK, inspect that original ID; do not create a new ID, regenerate an image, change service, retry through BYOK or label the operation not dispatched. Read/cancel failures preserve uncertainty. Storage failure and recovery gaps remain primary errors.

## Host integration

The host must actually register executable model tools; putting their description in a prompt alone is insufficient. Present concise guidance alongside current registered tools: “These are the model tools available under this plan. Use the supplied schemas. When an operation is pending or its result is uncertain, recover the original operation ID rather than repeating generation.”

The server still rechecks the live plan and selected service on each new request. A cached descriptor is not a permission grant. Business tool scope and approvals are not bypassed by generating a media file.

## Durable DSH host adapter

```js
import { createUsageModelTransport, usageNativeModelChunks } from 'dsh-bailinghub'
const usage = createUsageModelTransport({
  client,
  ensureSessionPersisted: session => persistRealSessionAndConfirm(session),
  getPrimaryStatus: session => currentPersistenceStatus(session),
})
const tools = await usage.modelTools()
const receipt = await usage.runModelTool(realSession, {
  userMessageId: originalUserMessageId,
  modelRequestId: stableLocalToolCallId,
  serviceId: selectedTool.service_id,
  arguments: validatedToolArguments,
})
```

Register each callable descriptor using the native host tool registry and route its stable service ID to `usage.runModelTool`. Reuse the same local tool call ID when inspecting an unresolved call. `recoverOperation(session, operationId)` reads the saved original result; it never dispatches a second generation. For a new intentional generation, use a new local call ID.

`model({serviceId,refresh?})`, `complete(session,input)`, `stream(session,input)`, `status(session)`, `endTurn`, `cancelTurn`, `completeRequest` and `streamRequest` remain the host transport interfaces. Omit `mode` or use `model_gateway`. The descriptor cache lasts 60 seconds; cache hits do not extend freshness. Use `refresh:true` after settings change. No message-count, paid-turn count or task wall-clock quota is added.

The real durable DSH Session indexes `bailinghub/model-request` markers. Each request has a bounded CAS sidecar containing identity/hash/state only, not messages, tool arguments, provider credentials or generated content. Save both before dispatch. Retain them for same-operation recovery; missing metadata produces `USAGE_RECOVERY_GAP`, never an invented request. Old unpublished Token billing markers are not imported into the new ledger; ordinary business session history remains intact.

Native streaming uses `usageNativeModelChunks` with the host's actual provider parser. Text/reasoning may display incrementally, but executable tool blocks and finish wait for the original durable receipt. Ending/cancelling the user input immediately fences late results; they remain inspectable history and do not restart tools. Final local save failures remain `storage_error` even when the provider result is known. Unknown billing settlement alone does not make a complete model result unusable.

Synthetic acceptance covers current account catalog isolation, empty/unavailable tools, generation ACK loss across full store reopen, cancellation before late generation, raw Token usage alongside USD amounts, native provider streaming, original request recovery and long local tasks.

### Image provider outcome receipts

`result_state=failed`, `state=failed`, `dispatch=rejected` is a confirmed provider rejection. Stop waiting; show the bounded `error` and `next_action=contact_operator`. Never automatically create a replacement operation. `unknown` is not a running task or proof of zero cost: preserve the original ID for inspection. Only `pending` means keep waiting. A complete result is usable independently of pending billing.

The diagnostic whitelist is `code`, fixed safe `message`, optional `http_status`, `provider_code`, `provider_request_id`, `retryable=false`, and `next_action`. Provider bodies and credentials are excluded. Cancelled/ended turns never regain active tools through late receipts. Existing durable request identities and prior unknown records remain unchanged.

DSH stores failed requests using the existing local `rejected` state and returns `delivery_state=request_failed`. Unknown receipts return `unresolved_original`; pending receipts retain `pending_original`. No Session event or sidecar migration is required, and primary storage/recovery errors retain priority.
