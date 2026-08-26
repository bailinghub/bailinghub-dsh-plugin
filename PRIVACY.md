# Privacy

This bundle adds no telemetry and stores no BailingHub credentials or task payloads.

Task text submitted through the installed tools is sent to the BailingHub deployment chosen
by the operator. DeepSeek Harness, the configured model provider, BailingHub, and the target
business system each have their own data-retention boundary. Review those deployments before
using personal, confidential, or regulated data.

Do not include tokens, private URLs, personal information, or production payloads in public
issues, screenshots, or compatibility reports.

## Native Agent Client 0.2.0

The native 0.2.0 plugin sends each direct human user turn to BailingHub Core and receives
model-visible instructions, memory, reference-only knowledge, governance, and active tool schemas.
Business tool arguments and governed results cross the same boundary. At completion it sends only
the hash-aliased assistant message id, visible final text, legal status, optional model/runtime
labels, and numeric public usage. It ignores `assistant/chunk` and never uploads hidden reasoning.

Browser authorization, refresh, and credential storage remain SDK-owned; this adapter stores no
BailingHub credential. Review DSH, model-provider, BailingHub, and business-system retention
boundaries before enabling the plugin.
