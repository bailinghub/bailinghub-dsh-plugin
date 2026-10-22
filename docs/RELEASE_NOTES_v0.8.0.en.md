# DSH 0.8.0: tool preparation and knowledge on demand

A user may check stock, update a product and then ask about a page-setting rule. The Agent needs reusable declarations without treating preparation as completed business work. This release makes preparation distinct and reduces repeated guidance and knowledge bodies. It pairs **Core 0.10.0 / SDK 0.8.0 / DSH 0.8.0**. Business capabilities and product mappings must already exist; authorization and approval remain unchanged.

## Additions and fixes

- Preparation receipts explicitly report `result_type: capability_preparation`, `dispatch: not_dispatched` and `business_operation_performed: false`. A host opting into session tool reuse can retrieve complete declarations by original name. Preparation is not execution; replaying its call ID must not turn it into a write.
- When short descriptions advertise more guidance, use `search_business_capabilities` with `tool_name` and `include_usage_guidance` for bounded reference material tied to the original authorization and capability revision. Multiple targets remain distinct through `authorization_ref`.
- Add `search_business_knowledge` and `read_business_knowledge`. Negotiated support separates knowledge retrieval from tool discovery: inspect hints, then read relevant content and pages. Old SDK/Core combinations retain inline knowledge; authorization/service failures are not empty results. Core native chat and embed stay independent.
- Add host-only `getContextDeliveryManifest()`, `confirmContextDelivery()` and `invalidateContextDelivery()`. Later preparation receipts can omit repeated bodies only after a cooperating host confirms the current named contributions in each final model request. Unknown hosts keep inline bodies. Confirmation is neither business permission nor proof of model understanding.
- Pin SDK 0.8.0, including 1 MiB serialized tool arguments, on-demand knowledge and separate model-budget helpers. Library dependency overrides do not replace host audits.

## Hosts still own task loops

The plugin preserves original model operations, business invocations, approvals and cancellation fences. Hosts integrate model parameters and reasoning/answer budgets from service descriptors. Automatic long-task continuation is not enabled by this release: hosts must checkpoint, bound counts/cost/time, detect no progress and avoid repeating completed actions. Inspect unknown originals read-only; never execute truncated tool arguments.

## Upgrade and observe

Upgrade Core first, then install `dsh-bailinghub@0.8.0`; it installs the exact SDK without manual version mixing. Preserve credentials, real Sessions, scope/task/invocation stores and archive records. Restart and verify the actual resolved packages.

Observe preparation versus a normal tool result, independent knowledge search/pagination, multiple-authorization isolation and old-Core fallback. Hosts enabling context confirmation must additionally inspect the final provider request, not just preparation receipts. Missing confirmation requires restoring context or stopping the request, not replaying business work. See [the upgrade guide](UPGRADE_v0.8.0.en.md).
