# Migrate to 0.5.0

## From 0.4.0: add systems without replacing existing authorizations

Version 0.5.0 extends one-system multi-account conversations to different business systems on one
Hub and audit domain. It adds system descriptions before capability search and optional business
subject names. The four public plugin fields, existing host scope/archive APIs, permissions and
business approval rules remain in place.

1. Have the administrator back up and upgrade to Core 0.7.0. Apply only outstanding migrations in
   order; upgrading from 0.6.1 includes 058/059. The plugin installer does not migrate the Hub.
2. Finish active business work and retry known pending completions with `/bailinghub sync`.
   Retain the original DSH home, SDK credentials, real Session events, scope files and archive outbox.
3. Install and restart DSH:

   ```bash
   dsh plugin --profile web add dsh-bailinghub@0.5.0
   ```

   The package installs exact SDK 0.5.0. Do not manually mix in an older SDK or a local file dependency.
4. Check `/bailinghub doctor` and `/bailinghub connections list`. Valid existing authorizations
   continue working; no new login is needed just for a version change or a display rename.
5. Add and authorize only the extra systems needed for the new task. In a new conversation, select
   their fixed connection keys and wait for `/bailinghub scope` to confirm before sending a message.
6. Test an inventory read and a low-risk shop action with confirmed product mappings. Check each
   target, separate result/approval, and original run link. Then check `/bailinghub archive status`.

Existing started v1 conversations keep their exact original scope and archive identity. The upgrade
never expands them to every account or converts them to a cross-system selection. A saved unstarted
draft requires confirmation; a started conversation whose scope cannot be restored stays blocked.
The same-runtime offline recovery rules continue to use the complete original group.

Custom hosts keep `setSessionScope`, `getSessionScope`, `restoreSessionScope`,
`getSessionArchiveStatus` and `syncSessionArchive`. Custom stores must preserve complete scope/outbox
v2 records, original bindings, events, acknowledgement positions and CAS revisions. Hosts may show
current `subjectDisplay` fields and omit a manual display-name input, but keep internal connection
selectors/keys separate; do not rebuild authorization or archive state to update a name. Missing
names stay explicit. Administrator-maintained system descriptions are separate from subject names
and do not grant tools or permissions.

### 0.4 用户升级摘要

管理员先备份并升级 Core 0.7.0，按顺序仅执行未完成迁移（从 0.6.1 升级包括 058/059）。用户先
结束当前业务任务，用 `/bailinghub sync` 重试待同步结尾，安装 `dsh-bailinghub@0.5.0` 并重启。
插件自动安装 SDK 0.5.0。保留原凭据、真实 Session 事件及范围/待传文件；有效授权不因升级或改名重建。

已有同系统会话范围保持不变。要把商城与库存一起使用，分别授权，另开会话，在首消息前选中固定
连接键并等确认。先验证库存查询与一个低风险商城动作，核对各自结果、原审批和执行关联。
自定义宿主保留原五个接口；自定义存储需完整保存 v2 的原绑定、事件、确认进度与修订号。名称
只用于展示，不能替代连接键、身份或系统说明。详情见[本次更新](RELEASE_NOTES_v0.5.0.md#简体中文)。

### Downgrading from 0.5 to 0.4

Finish active work and synchronize pending completions and archives first. Keep the original profile
and v2 files as recovery material. Version 0.4.0 does not understand cross-system v2 scope/outbox or
provide this release's system/subject metadata. Do not reinterpret v2 as v1, delete it, or reconstruct
it from the current registry. Use a separate profile with new same-system conversations if reverting.
An application downgrade does not undo an accepted business action or remove its Hub audit. Core
database rollback follows Core's own migration guide; never drop new columns as a plugin rollback.

## Historical 0.3.0 → 0.4.0 behavior

The section below documents the scope change introduced in 0.4.0. When upgrading directly to 0.5.0,
follow the current install/Core versions above and also preserve these explicit-scope requirements.

### From 0.3.0: choose the conversation scope explicitly

Version 0.4.0 keeps the four public configuration fields and existing SDK-owned authorizations.
It changes how a conversation gets business access: logging in or selecting a default no longer
automatically enables it. A new conversation is ordinary chat until you select its scope.

1. Ask the administrator to upgrade the Hub to Core 0.6.1. The plugin installs exact SDK 0.4.0.
2. Before restarting, finish active business work and retry known pending run completions with
   `/bailinghub sync`. Do not assume a process restart resumes an invocation or approval.
3. Upgrade the plugin and restart DSH:

   ```bash
   dsh plugin --profile web add dsh-bailinghub@0.4.0
   ```

4. Run `/bailinghub doctor` and `/bailinghub connections list`. Existing valid authorizations can
   be selected; you do not need to authorize them again merely because the plugin was upgraded.
5. Start a new conversation. Before its first message, run
   `/bailinghub scope set <connection-key> [<another-connection-key> ...]`, using fixed keys from
   the list, then `/bailinghub scope`. Wait for successful confirmation. Select only this task's
   accounts; several accounts must share one Hub/Client App/workspace.
6. Try a read, then a reversible permitted update. Check the actual result and original business
   calls in BailingHub. Use `/bailinghub archive status` to inspect the separate visible record.

Keep old started conversations as history: if they have no valid locked scope snapshot, they
cannot automatically adopt today's selected connection. A stored draft that never started needs
explicit selection again. Existing 0.4 saved business conversations can reopen with their original
scope after every member is revalidated. An offline reopen can retry in the same conversation
with `/bailinghub scope` or `/bailinghub archive sync` once connectivity returns.

The new archive uploads visible user/assistant text, turn boundaries, and original run links for
the full frozen member set. Local pending events survive restart and upload without replaying
business work. It does not backfill all pre-upgrade history or restore unfinished invocations.
A detectable gap stays `recovery_gap`; missing host history is unverified. Review [Privacy](../PRIVACY.md):
the local outbox retains plaintext visible text, including acknowledged events, until removed by
the host/operator. There is no automatic retention cleanup.

### 0.3 用户升级摘要

先由管理员升级 Core 0.6.1；结束当前业务任务并用 `/bailinghub sync` 收口待同步结尾记录，再安装
`dsh-bailinghub@0.4.0` 并重启 DSH。已有有效授权可继续使用，不必仅因插件升级重新授权。
执行 `/bailinghub connections list` 后，**新建会话，在首条消息前**用
`/bailinghub scope set <连接键> [<另一连接键> ...]` 选择账号，并等待 `/bailinghub scope`
确认。未选范围就只是普通聊天；旧版已开始会话没有范围快照时不能直接恢复业务访问。

上传状态用 `/bailinghub archive status` 查看，联网后用 `/bailinghub archive sync` 补传。
这会恢复原范围并上传已保存文本，不会恢复重启前的业务调用或待审批操作，也不代表全部旧历史已
归档。更多步骤见[中文上手指南](GETTING_STARTED.zh-CN.md)与[隐私说明](../PRIVACY.md)。

## Downgrading from 0.4 to 0.3

Finish current business work and synchronize pending completions and archives before an explicit
downgrade. Keep the old profile and its scope/outbox files intact. Version 0.3.0 does not provide
0.4's explicit scope gate, multi-authorization conversation, or archive retries; its new conversations
use its selected default connection. Use a separate profile and new conversation if reverting.
Do not delete credential or archive files as a downgrade shortcut. A downgrade does not cancel an
accepted business action or delete its Hub audit.

## Legacy 0.1.x to the native Agent Client

There is no automatic credential, configuration, tool, or orchestration migration from the legacy
static MCP path. The following boundary remains separate from the 0.3 to 0.4 upgrade above.

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

## What changed in 0.2

| Concern | Public 0.1.1 | Native 0.2 and later |
| --- | --- | --- |
| DSH integration | in-box MCP client | native Cordis host adapter |
| Core unit | governed job | conversation, run, and governed invocation |
| Authentication | operator Client Token | end-user browser authorization with PKCE |
| Tool surface | three fixed job tools | current-turn typed tools plus search/resume |
| Reasoning/orchestration | BailingHub route | local DSH Agent |
| Business identity | not established by DSH | Agent Session approved through the business boundary |
| Hub audit | job records | conversation, run, completion, and invocation trajectory |

## What 0.3 adds

Version 0.3 keeps the same native boundary and adds stable named multi-connection lifecycle,
same-binding trusted-identity reconciliation, and Windows CurrentUser DPAPI credential storage.
It does not reinterpret or migrate the public 0.1.x Client Token path.

The new plugin config is limited to `hubUrl`, `clientAppId`, `workspace`, and `connectionName`.
The old `BAILINGHUB_CLIENT_TOKEN` is not read, copied, exchanged, or converted into an Agent
Session. Browser authorization creates a new independently revocable credential in SDK-owned
secure storage. The plugin does not accept a business URL: the Hub Client App resolves to one
stable, account- and tenant-neutral business authorization entry, where the user can log in,
switch account, and select a tenant.

## Safe evaluation before migration

Do not replace a working production profile merely to evaluate 0.5.0. Use a separate DSH home or
another isolated Web profile and verify that the CLI really honors that location. The named
connection lifecycle introduced in `0.3.0` creates a separate credential for each name registered through
`connections add` while authorization is pending. After authorization, the SDK replaces an older
same-binding connection when its trusted `on_behalf_of` is the same; different trusted identities
remain independent. A different identity returned from a same-alias login keeps the original
alias and Session and receives a non-conflicting alias that becomes current. Use the exact matching
SDK installed by the DSH package when evaluating that behavior.

1. Keep the existing `0.1.1` profile and its legacy environment unchanged.
2. Install the exact released 0.5.0 package into an isolated profile.
3. Configure only the four public native fields using neutral values for dry composition.
4. Run `/bailinghub login` and approve a dedicated non-production client app/workspace whose
   credential can be revoked without affecting a maintainer's existing profile.
5. Verify status and workspace discovery. In a new conversation explicitly select its scope, then
   verify one read, one permitted mutation, approval/resume, and the Hub trajectory.
6. Separately re-run the `0.1.1` submit and same-job follow-up against the newly released Core.

Passing the native path does not prove legacy compatibility, and passing the legacy path does not
prove the native Agent Client.

## Moving a legacy 0.1 profile to 0.5

Only after the isolated acceptance passes:

1. Record the exact old plugin, DSH, MCP, and Core versions without copying credentials into the
   migration record.
2. Finish or cancel outstanding legacy jobs. A wait timeout is not a terminal failure.
3. Install the exact accepted 0.5.0 plugin version. Do not use an unpinned dist-tag.
4. Replace the legacy plugin configuration with the four native fields. Remove the old Client
   Token from that process environment after confirming no remaining 0.1 integration uses it.
5. Start DSH, run `/bailinghub login`, use the business page to log in or switch account and select
   a tenant if required, then authorize the intended workspace.
6. Run `/bailinghub status`, open a new conversation, explicitly select its scope before the first
   message, and repeat the accepted read/mutation checks.
7. Confirm BailingHub receives visible conversation and invocation audit without hidden reasoning.

The developer or deployer supplies the Hub URL, public client app id, and initial workspace/route.
The end user completes browser authorization. Neither role supplies a business API secret or model
key to this plugin.

## Rollback

Rollback is explicit; it does not convert the Agent Session back into a Client Token.

Before downgrading a 0.3 profile to 0.2, first use the installed 0.3 plugin to finish active runs
and remove every named instance through `/bailinghub connections remove <name>`. The SDK returns
the registry to schema v1 after the last such instance is removed. Stable `0.2.0` fails closed on
schema v2; do not manually delete the registry, Keychain entry, DPAPI ciphertext, or secure file
credentials as a downgrade shortcut.

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

Before a public 0.5 release:

1. The matching BailingHub Core Agent Auth/Agent API contracts are released.
2. The exact `bailinghub-mcp-server/sdk` version is publicly installable and has passed DTO,
   credential, invoke/resume, and completion tests.
3. Installing only `dsh-bailinghub` into a clean DSH `0.1.1-rc.2` profile installs and resolves that
   exact SDK dependency automatically.
4. Browser login, session isolation, dynamic tool replacement, approval recovery, visible
   completion, same-identity replacement, different-identity isolation, explicit one/many-account
   scope, visible archive, offline reopen/retry, and Hub trajectory pass from the packaged artifact.
   Revocation must block the complete original selection, and archive retries must not replay business work.
5. Public `0.1.1` still works against the new Core through the unchanged Client API.
6. The maintainer explicitly selects the public version and migration story.

Do not tag or publish a future version until all gates pass, and do not describe release
validation as public adoption.

## Local task-control candidate

The host-only task binding and read-only invocation inspection integration is documented in [TASK_CONTROL.md](./TASK_CONTROL.md). It requires the exact paired SDK/Core candidate. Existing journal v1 is read compatibly; subsequent writes use v2 without inferring a task for old entries. Keep scope, task and invocation stores together when reopening, and do not downgrade managed Sessions to an older host. No public package version is changed by this candidate.
