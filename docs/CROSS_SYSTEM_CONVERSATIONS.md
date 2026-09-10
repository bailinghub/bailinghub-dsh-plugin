# One conversation across business systems

**Release pairing: Core 0.7.0, SDK 0.5.0 and DSH 0.5.0.** The plugin installs its exact SDK
dependency. Core 0.6.1 / SDK 0.4.0 / DSH 0.4.0 do not include this extension; upgrade the Hub
before selecting targets from different systems.

## What you can do

Select, for example, a shop account and an inventory account already authorized on the same
BailingHub deployment. Ask the same local Agent to check product stock, then change a corresponding shop product's price and list it using permitted actions. The Agent keeps each system's tools and authorizations distinct; you do not switch
the global connection between steps. Available actions still depend on each system's declared
capabilities and the permissions of the selected account.

The Agent initially sees the selected target directory. It searches the intended target's
capabilities when needed, then calls the corresponding typed tool. A capability search opens
that target's run with the search's minimal task description. Other systems do not automatically
receive the original user turn or contribute their memory. The local Agent and the independent
conversation audit still share the visible conversation.

## Start a conversation

### Understand the selected systems before choosing tools

An administrator can provide each connected system's name, short purpose, usual business areas
and boundaries in BailingHub. The Agent reads these descriptions for the selected accounts before
its first capability search. For example, it can distinguish online selling from inventory
management without a client-specific product dictionary. Business-supplied subject names identify
the particular organization, project or other authorized subject for display. They are separate
from product purpose and do not prove identity or grant permissions.

A description says what the product usually does. The actual tools and permissions still come
from authorized capability discovery. “Not loaded” means the tools have not been requested yet;
it does not mean the product has no capabilities. Missing descriptions or an older server show
unknown information and preserve the existing search flow. Reading a description sends no user
message and creates no business run. Existing same-system first-turn runs are unchanged.

If the server explicitly reports that a selected workspace is unavailable, its directory says
unavailable while retaining the original selection. An uncertain network failure remains unknown;
neither condition selects another account. A later turn reads the original target again.

### Select the accounts

1. Authorize each target separately and verify the intended subject on the business authorization
   page. With a compatible business backend, the backend supplies its name automatically. A local
   connection selector remains independent; missing names show “Authorization name pending sync”.
   Names do not prove a mapping between two systems or distinguish duplicate-named subjects.
2. In a new conversation, use `/bailinghub connections list`, then
   `/bailinghub scope set <shop-connection-key> <inventory-connection-key>`.
3. Wait for successful confirmation before sending the first message. Start with a precise
   request identifying the intended systems, objects and allowed action.
4. Review the separate results and any approval requests. Use `/bailinghub archive status`
   to check visible-record upload; `/bailinghub archive sync` retries uploads without repeating
   business actions.

An empty scope remains ordinary chat. The first user message freezes the selected targets.
Reopening a conversation restores the original selection after all original members pass
validation; a draft that never started needs fresh confirmation. A temporary outage can be
retried in the same runtime. Revoked/replaced members never cause a switch to a default or subset.

## Host integration

Keep the existing `setSessionScope`, `getSessionScope`, `restoreSessionScope`,
`getSessionArchiveStatus` and `syncSessionArchive` flow. The returned scope view retains its v1
schema and gains `targetMode: "multi_system"`; authorization entries additionally include
`clientAppId` and `systemRef`. Use those public fields to group the selection UI if helpful.
Never feed raw keys, credentials or writable scope records to the model.

The built-in stores understand both v1 and v2. A custom store must retain the complete v2 record
without reconstructing it from today's registry, preserve the original host Session identity,
and provide atomic revision comparison. Persist original DSH events so incomplete capture can
be detected on reopen. No second body-reporting path is required.

Cross-system operation requires the matching SDK's capability negotiation, frozen-binding guard,
and the Core's target-member archive extension. Missing support reports
`CROSS_SYSTEM_SCOPE_UNSUPPORTED`; it is not a reason to send the first message with an old scope.
The matched Core requires an additive database migration through its own deployment process;
installing this plugin does not migrate or deploy the Hub.

## Limits

- One Hub, with independently authorized Sessions for every selected target. Cross-Hub scope
  and multiple selected routes sharing one Agent Session are not supported.
- Task planning and step ordering are performed by the Agent. This is not a deterministic
  dependency engine, a distributed transaction, automatic rollback, or cross-process task recovery.
- Original invocation recovery is available in later turns of the same live runtime. Archive
  restoration after restart does not reconstruct pending invocations or approvals.
- Different systems' object IDs are unrelated unless a verified business mapping establishes
  the relationship. The Agent must clarify an ambiguous mapping.
- The runtime enforces target and capability boundaries. It does not provide automatic
  sensitive-text redaction or a field-level cross-system data-sharing policy.
- Complete transcript reading remains an administrator audit operation. An individual business
  authorization does not grant an API to read the entire mixed transcript.

## 简体中文

本版配套 Core 0.7.0、SDK 0.5.0 与 DSH 0.5.0，插件会安装精确 SDK 依赖。
Core 0.6.1、SDK/DSH 0.4.0 不含本次扩展；选择不同系统前先升级中枢。

### 对使用者有什么变化

你可以在同一个会话里选中“商城”和“库存系统”的授权，让助手先查询保温杯库存，再使用商城允许的
改价、上架等动作。每一步都会使用对应系统的工具与授权，仍按该系统的权限和审批规则执行。

助手先看到你选中的目标目录，需要哪个系统时才查找它的能力、加载它的上下文。不会因为选中了两个系统，
就把每句话自动发送给两者。某个系统的查询结果进入本地模型后，会成为同一会话的上下文；只有允许这样共享
的数据才适合放在同一会话。完整可见沟通通过独立会话账本归档，各系统仍保留自己的操作记录。

### 怎样开始

接入方可以在中枢维护系统名称、简短用途、典型业务方向和边界。助手在首次搜索工具前就能看到本会话所选系统
的介绍，例如分清“线上售卖”和“库存管理”，不需要每个客户端分别写死产品词典。同系统的多个账号也会显示
相同的系统归属。授权主体展示接口单独提供业务授权主体的名称，用于表示具体的组织、账号、项目等；名称不证明身份，
也不增加权限。

系统介绍说明产品通常做什么，实际能做什么仍取决于此授权的能力查询和原有权限规则。“尚未加载”表示还未
查询工具，不表示没有能力。介绍缺失、旧版本不支持或介绍请求暂时失败时，可继续使用原有的授权工具搜索。
读取介绍本身不发送用户正文、不创建业务运行记录；同系统原有首轮运行机制保持不变。

如果服务端明确报告所选工作空间不可用，目录会显示“不可用”并保留原选择；无法确定的网络失败显示“未知”。
两者都不会自动切换授权，后续轮次仍查询原目标。

先分别授权并在业务授权页确认对象。授权主体展示接口由业务后端提供主体名称；名称缺失时明确显示“授权名称待同步”，
内部连接标识独立保留。再新建会话，使用上面的 scope 命令选中两份固定授权。
等选择成功后，再明确提出操作对象和要做的事。首次消息后范围固定；需要增减系统时新建会话。

如果库存里的商品与商城中的某个商品需要关联，应使用已经确认的业务映射，或由用户明确确认。
两个系统的商品名或编号看起来相同，并不能证明它们是同一对象。库存查询不等于锁库存或建立自动库存同步。

### 下游需要配合什么

宿主继续使用现有五个范围与归档接口，不需要另加一条正文上报链路。界面可以按新返回的系统字段分组展示，
并继续保持“选择成功才允许发首条消息”。内置持久化已支持新记录；自定义存储需要原样保留 v2 的目标绑定、
原会话身份、事件和修订号。Core 0.7.0 需要通过自身升级流程应用未执行的迁移（本次包括 058/059）。

业务后端只需继续声明能力、独立授权并执行原有业务规则；如果用户要做的动作尚未开放，才需要补充该业务能力。
本版解决跨系统选择、调用和完整追溯，不包含周年庆等长任务的持久依赖调度、跨进程恢复或自动回滚。
