# DSH 0.7.0 升级

使用 Core 0.9.0 / SDK 0.7.0 / DSH 0.7.0 配套升级。公开 0.6.0 的业务治理接入继续保持，可选模型套餐需宿主显式接入。

1. 按 Core 0.9.0 升级指南完成备份和新增迁移。未启用套餐时不需要重建原业务授权。
2. 安装精确配套包；DSH 0.7.0 固定依赖 SDK 0.7.0。重启宿主并核对实际 Profile 加载的版本，不能只检查开发目录。
3. 可信业务后端签发使用凭据，明确套餐范围或单模型范围；供应商密钥保留在 Core。读取 capabilities、modelModels、modelTools、modelSummary。无可用项时显示配置原因，不回退到其他模型或授权。
4. 宿主继续本地编排，将完整工具 schema 提供给模型；套餐使用 `stream`，生成工具使用 `runModelTool`。持久保存原 operation ID，取消/存储失败/已结束轮次不能被迟到结果重新启用。
5. 核对文本流式、图片结果、同一套餐额度及原请求恢复。`result_state=complete` 即可使用结果，`billing_state=pending` 不要求重复请求或阻止下一条独立用户消息。

额度显示直接读取 presentation；周期剩余按原 grant 的 periodAllowanceUsd，而非售价、Token 数或模型数量计算。后台手动重置后刷新摘要即可，无需重建账户或凭据。

模型计费是相对公开 0.6.0 的新增模块，不提供旧 Token 额度接口别名，也不要求清退历史或账户。从公开 Core 0.8.0 升级仅应用新增 063/064 迁移；测试配置的维护不属于真实客户升级步骤。已有业务 Session 和原 invocation 恢复规则不变。

视频/语音不含可执行适配时必须尊重 callable=false。断网或不确定请求只按原 ID 核对，不重新派发生成。详见[契约](USAGE_SERVICE.md)。
