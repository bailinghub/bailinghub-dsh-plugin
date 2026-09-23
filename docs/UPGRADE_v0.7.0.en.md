# Upgrade to DSH 0.7.0

Upgrade with the matched Core 0.9.0 / SDK 0.7.0 / DSH 0.7.0 release set. Existing public 0.6.0 business-governance integrations remain supported; managed model plans require explicit host integration.

1. Back up and apply the Core 0.9.0 upgrade migrations. Enabling this optional module does not recreate business authorizations.
2. Install exact paired packages. DSH 0.7.0 depends on SDK 0.7.0. Restart the host and verify its actual Profile resolution.
3. Exchange a Usage credential through the trusted backend, preserving plan-wide or single-service scope. Provider keys stay in Core. Read capabilities, modelModels, modelTools and modelSummary; never substitute a default model or authorization for an empty catalog.
4. Keep orchestration local, provide complete tool schemas, use transport.stream for plan models and runModelTool for generation. Persist the original operation ID before dispatch. Late responses cannot reactivate cancelled/ended turns or override storage failures.
5. Verify streaming, image results, shared allowance and original-request recovery. A complete result is usable while billing is pending; do not reissue it or block unrelated new user messages for settlement.

Display server presentation. Periodic allowance is grant.periodAllowanceUsd, not sale price, token totals or model count. Refresh summary after an administrator resets allowance; do not recreate accounts or credentials.

Model billing is new relative to public 0.6.0 and provides no legacy Token-quota aliases. No history or account purge is required. Upgrading public Core 0.8.0 only adds outstanding 063/064 migrations; maintaining test configuration is not a real-customer upgrade step. Existing business Sessions and original invocation recovery remain unchanged.

Respect callable=false for unsupported video/audio adapters. Inspect uncertain requests by original ID only. See the [contract](USAGE_SERVICE.md).
