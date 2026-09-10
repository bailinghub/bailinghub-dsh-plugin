# DSH 0.5.0: check stock, then update and list a shop product

[简体中文](#简体中文)

**Release pairing: Core 0.7.0 → SDK 0.5.0 → DSH 0.5.0.** This release extends the same-system multi-account flow introduced in 0.4.0. Core 0.6.1 and SDK/DSH 0.4.0 do not include the additions described here.

## What changes for a user

After separately authorizing a shop and inventory system on the same Hub, select both for a new conversation and ask:

> “Check how many tumblers are in stock. If any are available, change the corresponding shop product's price to 59 and list it. Otherwise leave it unlisted.”

The 0.4 plugin already supports multiple accounts in one system. Version 0.5.0 extends that flow to different selected systems. It looks up stock with inventory tools, then performs permitted shop actions with shop tools. If only the shop is needed, inventory is not marked as executed. The original permissions and approvals apply to each action.

These actions must be exposed by the business systems, with product mappings confirmed. A stock read is not a reservation or automatic stock synchronization. A price change can succeed while listing waits for approval or fails; follow the actual results and original execution records rather than assuming the whole request completed.

## New and improved

- **One conversation across selected systems.** Discover capabilities by target, keep same-named tools separate, and preserve the original authorization for each call and recovery. First-message scope freezing remains in force.
- **Understand the target before searching.** Administrator-managed descriptions explain that a shop handles online selling while inventory handles stock. Missing metadata stays unknown; “not loaded” does not mean “no capabilities.” Description reads create no business run.
- **Recognize the approved business subject.** A compatible backend can supply “Brand flagship store” automatically. Current display names stay separate from the product description and internal connection key. Missing names remain explicit; duplicates and renames do not replace identities or rewrite history.
- **Follow the whole conversation and each system's actions.** The existing visible archive now retains cross-system member bindings and original run links. Upload retry uses saved events and never repeats business writes.

## Who needs to upgrade

Users need a matching Core and plugin installation, not just new display labels. Administrators can use **Agent Clients → Setup** in Core to configure authorization, system descriptions, tools/approvals and connection checks. Business backends supply names and keep their existing capability, permission and approval rules.

Custom hosts retain `setSessionScope`, `getSessionScope`, `restoreSessionScope`, `getSessionArchiveStatus` and `syncSessionArchive`. Preserve original real DSH Session events and complete v2 scope/outbox records with their revisions. Do not rebuild old conversations from the current authorization list.

## Upgrade order and checks

1. Ask the administrator to upgrade Core to 0.7.0 using its release guide. Back up first and apply only outstanding migrations in order, including 058/059 when upgrading from 0.6.1. Installing the plugin does not deploy or migrate the Hub.
2. Finish active business work, retry pending run completions with `/bailinghub sync`, then install `dsh-bailinghub@0.5.0` and restart DSH. It installs exact SDK 0.5.0 automatically. Keep existing credentials, original Session events and scope/outbox files; an upgrade alone is not a reason to authorize again.
3. Authorize each target and confirm the business subject. In a new conversation, select the fixed connection keys before the first message and wait for successful scope confirmation. A display name is not a connection key.
4. Verify a permitted stock read and a low-risk shop action, each actual target, any required approval, and their original execution associations in the conversation. An inventory-only or shop-only request must not claim the other system executed.
5. Check original-scope restoration, temporary offline recovery in the same runtime, revoked-member blocking and archive-only retry. Keep local history errors visible; changing a display name must not replace a Session or reset the archive.

Empty scope remains ordinary chat. Started conversations retain their original scope; additions require a new conversation. Revocation or identity replacement blocks the selected group instead of falling back to a default or subset. Missing cross-system SDK/Core support explicitly refuses that mode while preserving existing same-system behavior.

## Limits

One Hub and audit domain, with a distinct original Session per selected target. No cross-Hub scope, automatic product identity mapping, durable task scheduler, distributed transaction, automatic rollback or cross-process business task recovery. The local conversation can contain results from both systems; this is not automatic redaction or a field-level data-sharing policy.

See [cross-system integration](CROSS_SYSTEM_CONVERSATIONS.md), [host contract](AGENT_CLIENT_CONTRACT.md), [compatibility](COMPATIBILITY.md), [release procedure](RELEASING.md) and [Core scenarios](https://github.com/bailinghub/bailinghub/blob/v0.7.0/docs/RELEASE_NOTES_v0.7.0.en.md).

## 简体中文

**配套版本：Core 0.7.0 → SDK 0.5.0 → DSH 0.5.0。** 本版延续 0.4.0 的同系统多账户流程，扩展到同一中枢内的多个业务系统。Core 0.6.1 与 SDK/DSH 0.4.0 不含下述增量。

### 用一个商城场景说明变化

分别授权同一中枢下的商城与库存系统，为新会话选中两者，再说：“先查保温杯还有多少库存，有货再把商城对应商品改为 59 元并上架，没货就先不上架。”

0.4 已经支持同系统多账户。本次扩展到不同系统：查库存使用库存工具和授权，改价上架使用商城工具和授权；只用到商城时，库存系统不会被标成执行过。各步骤仍按原权限和审批处理。

前提是业务系统已开放相应动作，商品对应关系已确认。查库存不等于锁库存或建立自动同步。改价成功、上架待审批或失败可能分别发生，要看实际结果及原执行记录，不能笼统说全部完成。

### 本次更新了什么

- 在已选系统内按目标发现能力并调用，同名工具不串系统，调用和恢复保留原授权；首消息后范围固定。
- 第一次搜索工具前了解商城负责售卖、库存负责库存等受控系统说明；缺少说明显示未知，“尚未加载”不等于没有能力，介绍读取不创建业务 run。
- 配套后端可自动提供“品牌旗舰店”等真实授权主体名称；名称独立于系统用途和内部连接键。缺名明确提示，同名、改名不合并身份或改写历史。
- 在原完整可见归档上增加跨系统成员和执行关联。重试只补传保存的记录，不重复业务写操作。

### 谁需要调整、怎样升级

用户需要配套中枢和插件，不能只换显示标签。管理员在 Core“智能体客户端 → 接入配置”维护授权入口、系统说明、工具审批与连接检查。业务后端提供名称，保留原能力声明、权限与审批。

管理员先按 Core 发布指南备份并升级到 0.7.0，按顺序仅执行未应用迁移；从 0.6.1 升级时包括 058/059。用户结束当前业务任务，用 `/bailinghub sync` 重试待同步结尾记录，再安装 `dsh-bailinghub@0.5.0` 并重启 DSH；插件会自动安装精确 SDK 0.5.0。保留原凭据、真实 Session 事件与范围/待传记录，不因版本升级重新授权。

宿主继续使用原五个范围/归档接口，保存真实 DSH Session 事件及完整 v2 范围、待传事件与修订号，不按当前授权列表重建旧会话。新会话发送首消息前用固定连接键选定目标，等确认成功再发消息，不能用展示名代替键。

用一个允许的库存查询和一个低风险商城动作，核对目标、后台结果、原审批和会话中的执行关联；只用一个系统时，另一个不能被标为已执行。另需核对原范围恢复、同 runtime 断网重试、撤销整组阻断、仅重试归档，以及改名不替换 Session 或重置归档。

未选范围仍为普通聊天；旧会话不扩大，改选新建会话。原授权撤销或身份变化整组阻断，不换默认或剩余子集。SDK/Core 缺少跨系统支持时明确拒绝新模式，原同系统流程保留。

范围限同 Hub、同审计域和各自独立原 Session，不提供跨 Hub、自动商品映射、持久调度、分布式事务、自动回滚或跨进程恢复未完成业务任务。两边结果会参与同一段本地沟通，本功能不等于自动脱敏或字段级共享策略。

详见[跨系统接入](CROSS_SYSTEM_CONVERSATIONS.md#简体中文)、[宿主契约](AGENT_CLIENT_CONTRACT.md)、[兼容说明](COMPATIBILITY.md)、[发布流程](RELEASING.md)和[Core 场景说明](https://github.com/bailinghub/bailinghub/blob/v0.7.0/docs/RELEASE_NOTES_v0.7.0.md)。
