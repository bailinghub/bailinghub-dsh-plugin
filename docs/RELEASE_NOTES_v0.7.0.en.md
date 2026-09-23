# DSH 0.7.0: optional model services and shared plan billing

Release pairing: Core 0.9.0, SDK 0.7.0 and DSH 0.7.0. The changes and integration impact below are relative to public 0.6.0.

Local agents can use administrator-configured model plans and discover image generation as a model tool. Context, tool loops, subtasks and business orchestration stay in the host. Core relays model requests, checks allowance and meters usage asynchronously.

- Separate `modelModels` and `modelTools` catalogs; bind requests to exact service IDs.
- Preserve provider streaming and complete tool declarations through `stream`. Settlement does not hold usable results or impose user-turn/tool-loop limits.
- Validate explicit `periodAllowanceUsd`; display server `presentation` as credits or percentage. Provider Token counts remain usage details, not a quota denominator.
- Submit asynchronous `runModelTool` once and use `recoverOperation` with its original operation ID after ACK loss or restart. Distinguish pending, failed, uncertain and pending billing outcomes.
- Preserve original identity, business authorization, approval, task, artifact and audit boundaries. Generating an image does not upload it to a business system.

Executable image support follows the Core catalog. Video/audio declarations do not promise execution. Reference prices are not supplier invoices. Payments, orders and currency conversion belong to the product backend.

See the [integration contract](USAGE_SERVICE.md) and [upgrade guide](UPGRADE_v0.7.0.en.md).
