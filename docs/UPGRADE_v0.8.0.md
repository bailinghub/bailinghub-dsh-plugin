# 升级到 DSH 0.8.0

配套 Core 0.10.0、SDK 0.8.0 与 DSH 0.8.0。Node.js 保持 `^22.19.0 || >=24.0.0`，Harness 配套保持 `0.1.1-rc.2`，原四项公开配置不变。

1. 管理员先备份并升级 Core，仅执行其尚未完成的迁移；插件不迁移中枢数据库。
2. 保存当前任务检查点、原待决操作和审批；保留凭据、Session、scope、task、invocation 及归档存储。不要重建原未知业务动作。
3. 安装 `dsh plugin --profile web add dsh-bailinghub@0.8.0`。插件必须自动解析精确 `bailinghub-mcp-server@0.8.0`；不使用 optional peer、本地路径或另一个 SDK 版本替代。
4. 重启并核对实际 Profile 和已加载模块。先运行 `/bailinghub doctor`、`/bailinghub status`，不输出凭据。保持原显式授权范围和业务规则。

## 宿主接入

- 会话工具复用仍显式启用 `toolLifecycle:'session'`。直接调用未准备工具只返回准备信息；读取其当前上下文与完整 schema 后再作新决策，不能把旧 callId 自动重放成执行。
- 按需知识由当前授权下的协议协商开启。固定原 turn 模式，使用 `search_business_knowledge`、`read_business_knowledge`；保留原 ref、run、authorization_ref 与分页/截断事实。未知协议保留旧 inline；服务和授权错误不能默默删掉知识。[知识协议](AGENT_KNOWLEDGE.md)
- 只有宿主能观察每一份最终 provider 请求并确认当前命名上下文时，才接入上下文确认。未经确认保留 inline；确认后若下一请求缺少上下文，应重新组装/确认或停止，不重复业务调用。[宿主确认契约](CONTEXT_DELIVERY.md)
- 模型目录保持原样透传。宿主可使用 SDK `resolveModelOutputBudget()`、`modelOutputOptions()` 区分默认与服务上限、输出字段和 scope；只用于新请求，旧 operation/intent/hash 不变。
- 自动续跑需要宿主独立实现：最终原回执、检查点、有限预算、取消、审批和副作用防重。缺最终回执先 `inspectModelRequest()`；业务核对用 `inspectInvocation()`，`resume()` 可能首次派发原已批准调用，不能当轮询。

## 验收与回退

先在隔离 Profile 检查单插件安装、SDK 唯一解析、普通工具执行、准备不派发、知识搜索/分页、多授权隔离、取消/撤权及原操作恢复。上下文确认需核最终请求内容；不同宿主的真实 UI 与长任务仍分别验收。

旧 Client Token 0.1.1 静态路径独立保留，不改历史配置。回退包不回滚中枢数据，也不改写已保存原操作；保留新记录，不能把需要新任务/恢复格式的会话交给不支持的旧宿主继续执行。依赖审计按实际安装宿主另行核对。
