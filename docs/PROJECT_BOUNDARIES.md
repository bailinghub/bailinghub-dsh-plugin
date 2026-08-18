# Project Boundaries

The dependency direction is one-way:

```text
dsh-bailinghub
  -> DeepSeek Harness in-box MCP Client
  -> bailinghub-mcp-server
  -> BailingHub public Client API
  -> operator-selected business route
```

This repository owns only the DSH bundle and its compatibility evidence. It does not fork or
modify DeepSeek Harness, BailingHub Core, the generic MCP adapter, or a downstream business
system.

The integration does not establish a trusted business subject, grant permissions, make an
approval decision, or replace the business system's final authorization. It also does not
govern DSH tools that are unrelated to the three BailingHub MCP tools.

DeepSeek and DeepSeek Harness are names of their respective owners. This is an independent
community integration, not an official DeepSeek plugin or partnership.
