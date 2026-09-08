# Privacy

This bundle adds no telemetry and stores no BailingHub credentials or task payloads.

Task text submitted through the installed tools is sent to the BailingHub deployment chosen
by the operator. DeepSeek Harness, the configured model provider, BailingHub, and the target
business system each have their own data-retention boundary. Review those deployments before
using personal, confidential, or regulated data.

Do not include tokens, private URLs, personal information, or production payloads in public
issues, screenshots, or compatibility reports.

## Native Agent Client 0.3.0

The native 0.3.0 plugin sends each direct human user turn to BailingHub Core and receives
model-visible instructions, memory, reference-only knowledge, governance, and active tool schemas.
Business tool arguments and governed results cross the same boundary. At completion it sends only
the hash-aliased assistant message id, visible final text, legal status, optional model/runtime
labels, and numeric public usage. It ignores `assistant/chunk` and never uploads hidden reasoning.

Browser authorization, refresh, and credential storage remain SDK-owned; this adapter stores no
BailingHub credential. The SDK uses macOS Keychain, Windows CurrentUser DPAPI, or an explicitly
enabled isolated mode-0600 POSIX file store. Review DSH, model-provider, BailingHub, and
business-system retention boundaries before enabling the plugin.

The multi-connection registry contains public connection name, Hub URL, client app id, workspace,
timestamps, and current-selection state. It does not contain access tokens, refresh tokens, model
keys, business cookies, prompts, tool arguments, or business results.

## Unreleased same-system authorization selection

The source candidate may include several independently authorized identities in one DSH
conversation, restricted to the same Hub/client/workspace binding. The host snapshots eligible
connection bindings and exposes only session-local authorization references, local display names,
and availability as the selection directory; it does not expose the raw registry, credentials, connection keys, or
Session inspection responses to the model. Local display names are user-controlled labels, not
verified business identity claims.

Each user turn is sent to a separate Core run under each captured authorization to obtain its
instructions, governance, memory, and reference-only knowledge. The local Agent and its model
provider therefore receive context from multiple authorized identities in the same conversation.
Authorization labels preserve attribution; they do not create isolation from the local model.
Use separate conversations when those identities' data must not share that boundary.

Each business call uses only its selected authorization. Recovery retains the original
authorization and invocation. At completion, multi-authorization runs receive separate
deterministic summaries of their own governed calls, not the combined visible final answer or
another authorization's results. The combined answer remains in DSH and its model-provider
boundary. Single-authorization conversations retain the existing visible-answer completion flow.
Hidden reasoning is never uploaded by the adapter.

The host checks the captured connection key, workspace, and original Agent Session id before
transport operations without projecting those inspection fields into the model's directory.
Invocation bindings are local to the running conversation; a new conversation or process restart
does not recover unknown invocation ids from that map.

The public npm release remains `0.3.0`; installing it does not enable this candidate behavior.
