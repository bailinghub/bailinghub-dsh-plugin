# 三分钟开始使用

这份指南面向业务系统已经接入 BailingHub 的最终用户。如果还没有完成业务接入，需要先由
BailingHub 管理员和业务开发者准备中枢应用、授权页面与业务能力，再安装本插件。

本指南安装的公开 `0.3.0` 每个会话使用一份连接。同系统多授权选择属于
[未发布源码候选](README.zh-CN.md#未发布源码候选同一系统多份授权)，尚不属于该 npm 版本。

## 先向管理员获取什么

只需要向管理员获取四项公开连接信息：

```text
Hub URL
Client App ID
Workspace
Connection Name
```

它们用于定位 BailingHub 应用和初始业务空间，不是凭据。不要让管理员把 Client Token、Tool
Provider 密钥、业务密码、模型 API Key、授权码、浏览器 Cookie、业务地址或租户专属登录地址
发给你。

## 第一步：安装插件

把精确公开版本安装到 DSH Web Profile：

```bash
dsh plugin --profile web add dsh-bailinghub@0.3.0
```

插件会自动安装匹配版本的 BailingHub SDK，不需要再手工拼装依赖。

## 第二步：填写四项连接信息

可以在 DSH 插件设置页面填写，也可以使用对应环境变量：

```bash
export BAILINGHUB_HUB_URL='https://hub.example.com'
export BAILINGHUB_CLIENT_APP_ID='example-agent-client'
export BAILINGHUB_WORKSPACE='employee_assistant'
export BAILINGHUB_CONNECTION_NAME='default'
```

上面都是占位值，请替换成自己中枢管理员提供的公开信息。不要把凭据写进 Cordis Patch，也不要
把凭据粘贴到聊天消息里。

## 第三步：在浏览器完成授权

启动 DSH 后依次执行：

```text
/bailinghub login
/bailinghub status
/bailinghub workspaces
```

`login` 会打开 Client App 配置的唯一业务授权入口。在该页面登录或切换账号，并在业务系统要求
时选择租户；点击同意前，确认页面显示的最终业务身份和准备使用的 workspace。整个过程沿用业务
系统自己的登录流程，不会把业务密码或业务地址交给插件。

`Connection Name` 只是本机选择器。同一可信业务身份再次授权同一 Hub/client/workspace 绑定时，
SDK 会覆盖旧的本机连接；不同可信身份继续相互独立。如果当前名称已经属于旧身份，SDK 会保留
它，并给新身份分配一个可用名称（例如 `default-2`），同时把新名称设为当前连接。使用
`/bailinghub connections list` 可以查看两者，再用
`/bailinghub connections use <名称或连接键>` 显式切换。如果登录提示需要清理，新连接其实已经
授权成功，但某个旧连接可能仍需检查或删除：不要再次授权，应先列出连接，再删除提示的旧连接。

## 第四步：确认会话范围，再尝试业务请求

公开 `0.3.0` 的新会话使用选中的连接。**未发布源码候选改变这一默认行为**：未选择范围，或执行
`/bailinghub scope none` 时，只进行普通聊天，不会提供 BailingHub 业务工具或启动 run。
测试候选版本时，在第一条用户消息发送前执行：

```text
/bailinghub connections list
/bailinghub scope set <连接键> [<另一连接键> ...]
/bailinghub scope
```

请使用列表中的固定连接键，不要使用别名；只选择本次会话需要的账号，多份授权必须属于同一
Hub/client/workspace。等待范围设置成功回显后再发送消息。第一条用户消息会冻结范围，之后调整
账号或从普通聊天切换为业务模式都需要新建会话。选择或授权检查失败时，整个范围的业务访问
暂停，不会改用默认连接或剩余授权。没有原生命令的嵌入宿主须接入
[范围 API](AGENT_CLIENT_CONTRACT.md#host-owned-session-scope-api)。

在这个新会话里，先尝试所选业务系统已经开放的一条只读请求，例如：

```text
查询演示员工 EMP-001，并汇总我能看到的资料。
```

随后可以在专用开发空间尝试一次可回滚、当前账号允许的修改。实际能问什么，取决于业务系统
开放了哪些能力。需要审批的操作必须继续走原有审批，没有权限的操作仍然不可用。

## 第五步：在 BailingHub 查看结果

BailingHub 控制台应当能看到同一条可见会话、Agent Run、业务工具调用、审批状态与最终结果。
只有插件安装成功，还不能证明业务操作已经真正完成。
候选版本选择多份授权时，各 run 只收到自身调用摘要，汇总回答留在 DSH。重开已有会话时，只能
在验证后恢复已确认的范围；旧快照缺失或无效时暂停业务访问。范围恢复不等于进程重启后恢复
原 invocation 或待处理审批。

如果初始化失败，请在 GitHub Issue 中提供 DSH 版本、插件版本、操作系统、失败命令和脱敏错误。
不要附带 Token、私有地址、个人信息、授权码或生产业务载荷。
