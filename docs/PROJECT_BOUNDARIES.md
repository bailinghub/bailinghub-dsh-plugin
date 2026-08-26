# Project Boundaries

The dependency direction is one-way:

```text
dsh-bailinghub
  -> DeepSeek Harness native Cordis lifecycle
  -> bailinghub-mcp-server/sdk
  -> BailingHub Agent Client Core
  -> Core-selected business adapter and final business authorization
```

This repository owns only the DSH bundle and its compatibility evidence. It does not fork or
modify DeepSeek Harness, BailingHub Core, the generic MCP adapter, or a downstream business
system.

The integration does not grant permissions, make an approval decision, or replace the business
system's final authorization. It also does not govern DSH tools unrelated to the dynamic
BailingHub tool surface.

DeepSeek and DeepSeek Harness are names of their respective owners. This is an independent
community integration, not an official DeepSeek plugin or partnership.

## Public native 0.2.0

Version 0.2.0 adds a separate dependency path without reinterpreting the public static MCP path:

```text
DeepSeek Harness local Agent
  -> dsh-bailinghub native Cordis host adapter
  -> bailinghub-mcp-server/sdk
  -> BailingHub Agent Client Core
  -> Core-selected business adapter and final business authorization
```

This repository owns only the DSH host adaptation and compatibility evidence. DSH owns local
reasoning and tool orchestration; the SDK owns authorization/credentials and HTTP DTO mapping;
Core owns trusted identity, authorization, candidate trimming, approval, invoke/resume, knowledge
retrieval, and audit. The adapter does not copy Core governance or knowledge bases, establish a
business identity, govern unrelated DSH tools, or upload hidden reasoning.
