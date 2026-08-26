# Migration Boundary: Public 0.1.x to Private vNext

There is no automatic upgrade from public `0.1.x` to this candidate.

## Public 0.1.x

Public `dsh-bailinghub@0.1.x` is a configuration-only DSH Bundle. It starts
`bailinghub-mcp-server@0.1.1` through the in-box MCP client and exposes three fixed job tools:

```text
mcp__bailinghub__submit_governed_job
mcp__bailinghub__get_governed_job
mcp__bailinghub__wait_for_governed_job
```

The operator configures one Hub URL, route-scoped Client Token, and route. BailingHub performs the
Hub-side orchestration. Local DSH does not obtain a trusted business login and does not receive a
dynamic capability catalog.

The retained [legacy patch](../cordis.patch.yml) is evidence for that exact meaning. It is not
selected by the private candidate package metadata.

## Private vNext Candidate

The candidate is native Cordis runtime code. It uses browser authorization through the generic
SDK, receives a governed runtime profile per human turn, exposes an agent-scoped typed active set,
and puts reasoning/orchestration in the local Agent. BailingHub still owns governance and audit.

| Concern | Public 0.1.x | Private vNext |
| --- | --- | --- |
| DSH integration | generic MCP client | native Cordis host adapter |
| Core unit | governed job | Agent Client conversation/run/tool invocation |
| Authentication | operator Client Token | end-user PKCE login in SDK secure storage |
| Tool surface | three fixed job tools | up to 12 governed typed tools plus search/resume |
| Reasoning/orchestration | BailingHub route | local DSH Agent |
| Business identity | not established by DSH | SDK session bound by Core authorization |
| Hub audit | job records | conversation, run, invocation, and completion records |

## Acceptance Gates Before Any Release

1. The matching `bailinghub-mcp-server/sdk >= 0.2.0` facade is packaged and its DTO contract tests
   pass.
2. Native DSH `0.1.0-rc.7` loads the temporary package, command login works, and two sessions prove
   isolated run/tool state.
3. Search safely replaces the active definitions after a live ToolRuntime execution.
4. Approval, in-progress, retryable pre-dispatch, and `accepted_unknown` recovery prove that the
   original invocation id is resumed, duplicate DSH calls are coalesced, and `invoke` is never
   repeated.
5. Core shows the user message, visible final assistant message, legal completion status, usage,
   and invocation audit without any hidden reasoning.
6. Maintainer explicitly accepts the private candidate and chooses a public version/migration
   story.

Until all gates pass, do not publish over `0.1.x`, do not call the candidate a released client, and
do not infer production adoption from private testing.
