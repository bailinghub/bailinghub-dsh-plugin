# DSH 0.8.0：工具准备与知识按需读取

用户先查库存、再修改商品、最后确认页面规则时，智能体需要复用已发现工具，又不能把“声明已准备”当成业务已经完成。本版把准备和执行结果说清楚，并减少重复指导与知识正文。配套 **Core 0.10.0 / SDK 0.8.0 / DSH 0.8.0**；业务能力及商品映射须由业务系统预先提供，原授权和审批不变。

## 新增与修复

- 准备回执明确给出 `result_type: capability_preparation`、`dispatch: not_dispatched` 与 `business_operation_performed: false`。宿主启用会话工具复用时，可按原工具名取得完整声明；准备工具不等于执行工具，不能把相同调用 ID 重放成写入。
- 短描述提示有补充指导时，用 `search_business_capabilities` 的 `tool_name` 和 `include_usage_guidance`，只读取对应授权及能力修订下的有界参考。多目标仍由 `authorization_ref` 区分。
- 新增 `search_business_knowledge`、`read_business_knowledge`。协议协商成功后，工具发现与知识搜索独立；先看提示，再读取相关正文和分页。旧 SDK/Core 保留 inline 知识；授权、服务异常不能当成空结果。Core 原生聊天/嵌入不受此模式影响。
- 新增宿主级 `getContextDeliveryManifest()`、`confirmContextDelivery()` 与 `invalidateContextDelivery()`。只有协作宿主确认每份最终模型请求实际包含当前命名上下文，后续准备回执才可省略重复正文；未知宿主默认保留正文。确认不是业务权限或模型理解证明。
- 精确依赖 SDK 0.8.0，包含 1 MiB 序列化工具参数、按需知识及独立模型预算 helper。库内依赖覆盖不替代宿主自身依赖审计。

## 任务循环仍由宿主负责

插件保留原模型 operation、业务 invocation、审批和取消边界。模型参数与思考/答案预算由宿主按服务目录接入。自动长任务续跑不是本版自动开启的功能：宿主须保存检查点、限制次数/费用/时长、识别无进展并避免重复已完成动作。原结果未知时只读核对；截断工具参数不执行。

## 升级与观察

先升级 Core，再安装 `dsh-bailinghub@0.8.0`；插件自动安装精确 SDK，无需手工混装。保留凭据、真实 Session、scope、task、invocation 与归档记录，重启后核对实际加载包。

观察一次正常工具调用与准备回执的差异、知识单独搜索与分页、多授权隔离和旧 Core 回退。若宿主启用上下文确认，额外核对最终 provider 请求，不能只检查准备回执。缺失确认必须恢复上下文或停止请求，不重做业务动作。[完整升级步骤](UPGRADE_v0.8.0.md)
