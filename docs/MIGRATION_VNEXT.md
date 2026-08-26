# Migration Boundary: Public 0.1.x to Native 0.2

There is no automatic credential, configuration, tool, or orchestration migration from public
`dsh-bailinghub@0.1.x` to the native 0.2 Agent Client.

## What remains unchanged

Public `dsh-bailinghub@0.1.1` is immutable. It remains a configuration-only DSH Bundle that starts
`bailinghub-mcp-server@0.1.1` through the in-box MCP client and exposes exactly:

```text
mcp__bailinghub__submit_governed_job
mcp__bailinghub__get_governed_job
mcp__bailinghub__wait_for_governed_job
```

The operator supplies one Hub URL, route-scoped Client Token, and fixed route. BailingHub performs
the orchestration. Local DSH does not obtain a trusted Agent Session or dynamic capability catalog.

The retained [legacy patch](../cordis.patch.yml) documents that historical meaning. It is not
selected by the current native package metadata, and its presence is not a dual-mode switch.

## What changes in 0.2

| Concern | Public 0.1.1 | Native 0.2 |
| --- | --- | --- |
| DSH integration | in-box MCP client | native Cordis host adapter |
| Core unit | governed job | conversation, run, and governed invocation |
| Authentication | operator Client Token | end-user browser authorization with PKCE |
| Tool surface | three fixed job tools | current-turn typed tools plus search/resume |
| Reasoning/orchestration | BailingHub route | local DSH Agent |
| Business identity | not established by DSH | Agent Session approved through the business boundary |
| Hub audit | job records | conversation, run, completion, and invocation trajectory |

The new plugin config is limited to `hubUrl`, `clientAppId`, `workspace`, and `connectionName`.
The old `BAILINGHUB_CLIENT_TOKEN` is not read, copied, exchanged, or converted into an Agent
Session. Browser authorization creates a new independently revocable credential in SDK-owned
secure storage.

## Safe evaluation before migration

Do not replace a working production profile merely to evaluate 0.2.0. Use a separate DSH home or
another isolated Web profile and verify that the CLI really honors that location.

1. Keep the existing `0.1.1` profile and its legacy environment unchanged.
2. Install the exact released 0.2 package into an isolated profile.
3. Configure only the four public native fields using neutral values for dry composition.
4. Run `/bailinghub login` and approve a dedicated non-production business identity/workspace.
5. Verify status, workspace discovery, one read, one permitted mutation, approval/resume, and Hub
   trajectory.
6. Separately re-run the `0.1.1` submit and same-job follow-up against the newly released Core.

Passing the native path does not prove legacy compatibility, and passing the legacy path does not
prove the native Agent Client.

## Moving a profile to 0.2

Only after the isolated acceptance passes:

1. Record the exact old plugin, DSH, MCP, and Core versions without copying credentials into the
   migration record.
2. Finish or cancel outstanding legacy jobs. A wait timeout is not a terminal failure.
3. Install the exact accepted 0.2 plugin version. Do not use an unpinned dist-tag.
4. Replace the legacy plugin configuration with the four native fields. Remove the old Client
   Token from that process environment after confirming no remaining 0.1 integration uses it.
5. Start DSH, run `/bailinghub login`, inspect the business authorization page, and authorize the
   intended workspace.
6. Run `/bailinghub status`, open a new conversation, and repeat the accepted read/mutation checks.
7. Confirm BailingHub receives visible conversation and invocation audit without hidden reasoning.

The developer or deployer supplies the Hub URL, public client app id, and initial workspace/route.
The end user completes browser authorization. Neither role supplies a business API secret or model
key to this plugin.

## Rollback

Rollback is explicit; it does not convert the Agent Session back into a Client Token.

1. Finish active native runs and use `/bailinghub sync` for any known pending completion.
2. Run `/bailinghub logout` if the new Agent Session should be revoked.
3. Reinstall exact `dsh-bailinghub@0.1.1` in the target profile.
4. Restore the separately retained legacy Hub URL, route-scoped Client Token, and route through the
   original `BAILINGHUB_BASE_URL`, `BAILINGHUB_CLIENT_TOKEN`, and `BAILINGHUB_ROUTE` environment
   names.
5. Verify the three fixed MCP tools and follow one stable `request_id`/`job_id` flow to terminal
   state without resubmission.

Do not delete SDK credential files or Keychain entries manually as a substitute for logout. Do not
reuse, move, or republish an npm version or Git tag as a rollback mechanism.

## Release gates

Before any public 0.2 release:

1. The matching BailingHub Core Agent Auth/Agent API contracts are released.
2. The exact `bailinghub-mcp-server/sdk` version is publicly installable and has passed DTO,
   credential, invoke/resume, and completion tests.
3. Installing only `dsh-bailinghub` into a clean DSH `0.1.0-rc.7` profile installs and resolves that
   exact SDK dependency automatically.
4. Browser login, session isolation, dynamic tool replacement, approval recovery, visible
   completion, and Hub trajectory pass from the packaged artifact.
5. Public `0.1.1` still works against the new Core through the unchanged Client API.
6. The maintainer explicitly selects the public version and migration story.

Do not tag or publish a future 0.2.x version until all gates pass, and do not describe release
validation as public adoption.
