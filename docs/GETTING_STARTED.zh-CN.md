# 三分钟开始使用

这份指南面向业务系统已经接入 BailingHub 的最终用户。如果还没有完成业务接入，需要先由
BailingHub 管理员和业务开发者准备中枢应用、授权页面与业务能力，再安装本插件。

## 先向管理员获取什么

只需要向管理员获取四项公开连接信息：

```text
Hub URL
Client App ID
Workspace
Connection Name
```

它们用于定位 BailingHub 应用和初始业务空间，不是凭据。不要让管理员把 Client Token、Tool
Provider 密钥、业务密码、模型 API Key、授权码或浏览器 Cookie 发给你。

## 第一步：安装插件

把精确公开版本安装到 DSH Web Profile：

```bash
dsh plugin --profile web add dsh-bailinghub@0.2.0
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

`login` 会打开业务侧授权页。点击同意前，确认页面显示的是当前登录的业务身份和准备使用的
workspace。整个过程沿用业务系统原来的登录状态，不会把业务密码交给插件。

## 第四步：尝试一条安全的业务请求

新建一个会话，先尝试业务系统已经开放的一条只读请求，例如：

```text
查询演示员工 EMP-001，并汇总我能看到的资料。
```

随后可以在专用开发空间尝试一次可回滚、当前账号允许的修改。实际能问什么，取决于业务系统
开放了哪些能力。需要审批的操作必须继续走原有审批，没有权限的操作仍然不可用。

## 第五步：在 BailingHub 查看结果

BailingHub 控制台应当能看到同一条可见会话、Agent Run、业务工具调用、审批状态与最终结果。
只有插件安装成功，还不能证明业务操作已经真正完成。

如果初始化失败，请在 GitHub Issue 中提供 DSH 版本、插件版本、操作系统、失败命令和脱敏错误。
不要附带 Token、私有地址、个人信息、授权码或生产业务载荷。
