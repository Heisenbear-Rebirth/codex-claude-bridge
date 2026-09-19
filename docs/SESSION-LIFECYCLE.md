# 原生会话创建、连接与能力边界

**已取消：用户决定停止此工作方向，以下作为研究与实现记录保留。不要继续执行原生实验。清理情况见 [取消与收尾](SESSION-LIFECYCLE-CANCELLED.md)。**

2026-09-18：统一生命周期入口、持久操作账本、OpenCode 同后端创建/连接和上下文显示已实现。Codex、Claude 的自动创建与未加载会话唤醒仍未完成。

## 当前能力

| 客户端 | 创建独立会话 | 连接既有 ID | 未运行宿主的唤醒 | 原生界面 |
| --- | --- | --- | --- | --- |
| OpenCode | 已实现，要求唯一可达的新版原生插件 | 已实现；同目录、同后端、原 ID，无 prompt/interrupt | 不支持 | 不抢焦点；本次核验原生落库和测试后端重开，未把它当成 TUI/GUI 窗口验收 |
| Codex | `unsupported` | 核对已加载的合法 desktop owner；无 owner 返回 `unavailable` | 不支持 | 保留原 App；当前安装的 App Tools 目录查询超时，创建接口未核实 |
| Claude Code | `unsupported` | 连接已注册且唯一的 wrapper；离线返回 `unavailable` | 不支持 | 2.1.237 扩展具有打开已有 session 的命令/URI，但新建面板命令不返回原生 ID |

`connected`、`sendReady`、`nativeRecorded`、`displayConfirmed`、`modelProcessed`、`reopenConfirmed`分别表示证据。Codex/Claude 仅核对到原生连接时，`sendReady` 为未知，不能凭连接宣称已完成投递。

## 使用入口

Codex/Claude MCP 新增 `create_session`、`connect_session`。OpenCode 使用 `cooperation_create_session`、`cooperation_connect_session`，来源仍由宿主 `ToolContext` 提供，并经过原生权限询问。

创建参数示例：

```json
{
  "requestId": "review-task-20260918-001",
  "client": "opencode",
  "directory": "C:/Tools/Cooperation",
  "title": "本次任务的独立协作会话"
}
```

连接参数示例：

```json
{
  "requestId": "connect-review-20260918-001",
  "directory": "C:/Tools/Cooperation",
  "to": "opencode:ses_ExampleSessionID"
}
```

创建完成返回 `operationId`、`status: created`、原生 `session` 和 `address`。初始任务由后续 `send_message` 发送，沿用既有 FIFO；创建本身没有模型调用。来源会话可使用获准创建操作返回的地址，无需用户手工复制 ID。

CLI 供可检测身份的 Codex/Claude 工具进程使用：

```powershell
node bin/coop.mjs session create --target-client opencode --directory C:/Tools/Cooperation --request-id review-task-20260918-001 --title 审阅任务 --client codex
node bin/coop.mjs session connect --to opencode:ses_ExampleSessionID --directory C:/Tools/Cooperation --request-id connect-review-20260918-001 --client codex
```

管理页沿用原项目布局，在目录项目增加“新建会话”“连接会话”，会话设置也提供连接入口。未实现客户端的新建选项禁用。未知请求的编号及参数保存在页面本地存储，刷新后继续核对同一请求。

## 授权与设置

- 生命周期目录默认仅为 Cooperation 安装目录。嵌入式 `startServer` 可由宿主显式传入 `lifecycleDirectories`；目录列表、递归发现和自定义分组不会自动扩展该权限。请求同时核对精确路径和 realpath。
- agent 来源必须处于同一获准目录；OpenCode 校验一次性身份凭据、原生 messageID、实例、目录，工具不接受自填 `from`。管理页用 CSRF，共享 CLI/MCP 拒绝 OpenCode 伪造身份。
- 来源或连接目标处于维护流程时拒绝操作；新会话不自动开启维护、不自动加入分组、不自动发送任务。
- OpenCode 新会话不带 `parentID`。原生模型/agent 默认遵循项目设置；同端来源已有 session model/agent 时继承。权限先设置为逐项 `ask`，再保留同端来源已有的 session 权限规则；不启用跳过权限。
- 创建前重新核对唯一原生后端，拒绝多实例歧义。OpenCode 来源实例改变时拒绝创建。

## 意图、未知结果和核对

SQLite `session_operations` 保存真实来源、参数指纹、requestId、operationId、时间和结果。幂等键由来源身份与 requestId 共同确定；同编号不同参数拒绝，并发相同操作复用一个结果。

外部动作前已持久化 `unknown`。进程退出和响应丢失不会使创建自动重试。OpenCode 插件另在 `.cooperation/opencode/session-operations/` 排他记录意图，并在原生 session metadata 保存 `cooperationOperationId`。重复请求通过已知原生 ID 或原生 metadata 只读核对；无证据时仍保持 `unknown`。不要换新 requestId 来重试未知创建。

## OpenCode 上下文占用修复

旧实现同时在桥接层固定返回 `usage: null`、runtime.context 返回空统计、监控器跳过 OpenCode，造成界面持续显示未知。新实现读取最近 100 条原生消息中的最新有效 assistant 单次回复统计，优先使用该回复 `tokens.total`；无 total 时合计 input、output、reasoning、cache.read、cache.write。不会使用 session 累计消费。

容量取回复对应 provider/model 的 `limit.context`，只保留模型 ID 与容量，不保存或输出 provider 凭据。空会话、全零流式占位和不完整统计保持未知；后续消息、模型切换、回滚或压缩摘要标记统计已有变化。页面展示百分比、tokens、模型、统计时间及变化提示。Cooperation 自动维护继续关闭。

## 本次验证和部署状态

- 自动测试覆盖工具目录、用量口径、监控持久化、身份/CSRF/目录拒绝、维护阻挡、并发幂等、参数冲突、manager/plugin 重启后核对和无证据不重建。
- OpenCode 1.18.30 隔离原生后端：独立创建、原生 metadata/权限、重复请求同 ID、连接同 ID、测试后端重开后保留与核对均通过；没有模型调用。真实历史测试会话测得 3,962 / 1,000,000 tokens，0.4%。证据 `.cooperation/opencode/lifecycle-validation-result.json`。
- 隔离 Chrome：上下文显示、未知创建刷新后继续核对且只创建一次、连接保持原 ID 均通过；无页面错误，奶白背景保留。证据 `.cooperation/lifecycle-ui-result.json`。
- 本轮新增工具尚未在真实原生模型轮次中完成“发起创建→收到返回地址→新会话回信”的全链验收；已有双向消息验收不能替代该项。
- **真实 manager 和正在工作的 OpenCode 插件未重启，仍使用已加载的旧代码。** 升级需在安全窗口加载新版 manager/插件；真实库仍含受保护目录策略，不可直接执行普通启动脚本恢复它们。

## Codex / Claude 下一步

研究已核对项目源码、Codex App Tools 0.1.4 的动态工具目录机制、Claude Code VS Code 2.1.237 的相关命令处理代码，以及 Claude 官方 CLI 文档。App Server `thread/start`/`thread/resume` 与 Claude CLI `--session-id`/`--resume` 提供后台原生会话路线；它们与桌面 owner/VS Code 面板归属还需单独建立和验证。

Claude 原生 `/open?session=...` URI 会打开面板，不能精确证明它在预期工作区启动或返回新 ID；本次没有执行。Codex App Tools `tools/list` 只读请求超时，本次没有调用任何创建、打开或消息工具，也没有猜测 IPC 方法。

用户随后已明确授权：允许**仅针对本项目专用测试会话**，由已有 Codex/Claude 客户端写入其现有用户级会话历史、运行日志与相应界面状态。仍不包括全局安装、升级、修改用户配置、注册系统协议、其他项目访问或重启重要业务实例。部署真实 manager 还需单独保证受保护目录策略不会被触发。原生界面验收需要对应 App/VS Code 本项目窗口可用；不要求用户手工创建会话或复制 ID。

### 授权后的接口核对与宿主状态

2026-09-18T07:55:57Z，只读本项目 wrapper 注册并请求精确匹配本项目的 `/status`：Claude wrapper protocol2 已连接且空闲。Codex桌面App已在运行，但管理服务报告App Tools桥断开；本项目缓存连接仍是04:16:09Z取得的旧连接。证据 `.cooperation/native-host-readiness.json`。用户需在Codex打开Cooperation已有任务，使已配置MCP取得当前连接；无需手工新建或复制ID。

已限定读取当前已安装Codex **26.911.7940.0** 的app.asar中会话工具代码（只读安装代码，没有执行包内容），发现原生 `create_thread` 的准确实现：

- 工具参数：必填非空 `prompt`、`target:{type:"project",projectId,environment:{type:"local"}}`；title可选。项目ID由原生 `list_projects` 返回。禁止擅自创建worktree或projectless目录。
- 返回可能是 `{threadId,hostId}`，也可能是未就绪的 `{clientThreadId,hostId}` 或带firstTurn状态的结构；后两者不能直接冒充可发送的原生threadId。
- 原生创建会启动首轮，不能继续套用OpenCode的“空会话创建无模型调用”语义。业务初始任务、来源标记及FIFO顺序需明确设计，不能悄悄发引导提示。
- **新建的原生独立任务标记 `threadSource:"agent_created_thread"`**。现有Codex adapter只接受`thread_source=user`，后续需在保留内部worker过滤的前提下支持这一真实原生来源，避免创建后不可发现。
- IPC协议仍没有可直接用于新建/唤醒的公开follower方法；不要猜测请求或冒充owner。

本次没有调用create_thread，也没有启动新的真实Codex/Claude测试会话。App Tools研究脚本已补齐MCP初始化通知并复用已保存的原生Node路径，但`tools/list`仍超时；应恢复宿主给出的有效连接，不枚举或猜测其他私有端点。
