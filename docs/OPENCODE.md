# OpenCode 接入：TUI 与 GUI

**当前决定：主动创建、加载会话方向已取消，本工作副本已停用相关实验入口。通信及上下文显示修复保留。下文涉及生命周期的描述作为此前进度保存，清理记录见 [取消与收尾](SESSION-LIFECYCLE-CANCELLED.md)。**

Cooperation 通过 OpenCode 原生插件提供会话发现、上下文统计、双向消息、通信历史及按会话启用的自动维护。插件运行在会话所属后端，适用于独立 TUI、attach TUI、浏览器 GUI，以及桌面 GUI 的本地 sidecar 后端。维护流程和验证见 [OpenCode 自动维护](OPENCODE-MAINTENANCE.md)；创建/加载功能保持取消。

2026-09-18 已用 OpenCode **1.18.30**、DeepSeek 官方 **deepseek-v4-pro** 完成忙碌投递、真实双向通信、完整 TUI 与浏览器 GUI 的实时显示和重开检查。桌面应用使用同一 AppInterface/会话协议，插件已按此后端方式接入；**桌面应用壳的启动、服务器切换和窗口重开尚未实测**。自动维护另以真实1.18.30后端配合本地模拟模型完成软/硬流程验证。

## 安装与项目配置

Cooperation 主服务保持零 npm 运行依赖；OpenCode 插件有独立依赖目录。在 Cooperation 安装目录执行：

```powershell
npm.cmd ci --prefix plugins --cache .cooperation/opencode/npm-cache --ignore-scripts --no-audit --no-fund
```

插件依赖锁定在 `plugins/package-lock.json`，无需全局安装或升级 OpenCode。将下面的 `plugin` 项合并到**目标工作项目**的 `opencode.json`，填写插件实际位置和精确允许的目录，保留已有 provider、model、permission 等设置。

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [["/path/to/Cooperation/plugins/opencode.mjs", {
    "directories": ["/path/to/authorized-project"],
    "acceptUserMessages": true
  }]]
}
```

Windows 路径可写成 `E:/path/to/Cooperation/plugins/opencode.mjs` 或对应 `file:///` URL。[配置示例](../examples/opencode.config.json) 默认关闭接收；其中的相对插件路径以示例文件所在目录为基准。

`directories` 精确匹配 OpenCode 提供的工作目录，默认包含 Cooperation 安装目录。此外，插件默认跟随管理台已添加且启用的目录（`followManagedDirectories: true`），遵循其“包含子目录”设置。若希望仅使用插件配置中的固定列表，可设置 `followManagedDirectories: false`。插件的注册、凭据和投递账本写到 Cooperation 安装目录的 `.cooperation/opencode/`；可选 `root` 参数用于指定隔离 manager 的安装根目录。

**多项目使用：** 全局配置接入此插件一次后，先启动 Cooperation，在管理台添加工作目录，再打开该目录的 OpenCode。插件从本机 manager 的已保存目录中判断是否接入，校验服务身份和安装根目录，不需要逐项目编辑配置或把业务目录写进源码。未加入管理台且不在固定列表中的目录不注册。新增或移除目录会影响后续插件加载；已启动的 OpenCode 后端需在任务结束后重启。manager离线时，插件仍可按固定 `directories` 加载；依赖管理台目录的项目应先启动manager。

开发助手的文件访问限制只约束开发过程，不是软件的项目黑名单。Cooperation 应正常管理用户添加的任意工作目录；本地 `access-policy.json` 仅用于用户主动配置的产品限制，当前禁用列表为空。

**接收语义：** `acceptUserMessages: true` 允许协作内容通过原生 `user` 消息进入该目录的 OpenCode 会话。消息显示真实来源及 Cooperation 编号，并说明应在已有任务授权内处理。OpenCode 原生权限规则继续生效；这项机制与 Claude 的 peer 权限语义不同。默认值 `false` 允许发现和活动观察，拒绝入站投递。

配置修改在相应 OpenCode 后端退出、重新启动后生效。等待当前工作结束再操作；运行中的会话继续使用加载时的配置。

### 已连接但上下文显示为空

Cooperation manager 和原生 OpenCode 插件是两个独立运行实例。更新磁盘源码或重启 manager 后，已运行的 OpenCode 后端仍可能持有旧插件。旧桥接返回 `usage:null` 且没有 `capabilities.passiveUsage:true`；前端会显示“插件需要重新加载”，同时保留真实活动状态。

此时应在当前任务结束后重新启动**会话所属的 OpenCode 后端**，再打开原来的会话。独立 TUI 需要退出后重新启动；attach、Web 或桌面客户端连接远端/常驻后端时，需要重新加载对应后端，仅刷新或重新连接界面不足以更新插件。无需新建会话、重新安装依赖或再次重启 Cooperation manager。

新版插件分别报告 `no_measurement`（尚无有效回复统计）、`query_failed`（原生查询失败）、`capacity_unknown`（已有tokens但容量未知）、`ready`。查询失败时保留连接状态，前端可通过“刷新状态”重试；无用量时的时间显示为“状态检查”，不冒充最近统计时间。

## TUI 与 GUI 使用同一后端

| 使用方式 | 插件加载位置 | 连接方法 |
| --- | --- | --- |
| 独立终端 TUI | TUI 内嵌后端 | 在已配置的工作目录启动并打开已有会话；插件使用 OpenCode 提供的进程内 SDK client。 |
| 浏览器 GUI | `opencode web` 或 `serve` 后端 | 浏览器连接这个后端，打开对应目录与会话。 |
| attach TUI | 被 attach 的后端 | 使用 `opencode attach <后端地址> --dir <工作目录> --session <原生ID>`；认证通过 OpenCode 原生环境变量提供，避免写到命令行。 |
| OpenCode 桌面 GUI | sidecar，或 GUI 当前选择的服务端 | 在所选后端的项目配置中加载插件。切换服务器后重新检查连接；管理页发现的是该后端的原会话。 |

插件通过 OpenCode 提供的 `client` 发请求，包含原生认证与目录绑定。Cooperation 保存自己的随机端点凭据和实例 ID，连接前重新核验；桌面 sidecar 的随机端口、密码和模型 API Key 无需人工复制。

同一 session ID 同时存在于两个可连接后端时，发送会拒绝，等待用户选定唯一后端。旧实例失效后，新实例重新注册；结果不确定的历史投递保持待核对。

### 本项目隔离开发现场

本机根目录的 `opencode.json`、`.cooperation/opencode/environment.mjs`、DeepSeek 密钥及 probe 属于本机配置。根配置及已获授权的全局配置已接入正式插件；固定列表此前仅含本项目，新版插件还跟随管理台已添加的工作目录。本次未改用户级配置。隔离验证通过子进程 `OPENCODE_CONFIG_CONTENT` 将注册位置指向专用 manager。运行中的插件需待工作结束后正常重载才使用新版代码。

`environment.mjs` 将 OpenCode 数据、缓存、用户目录及临时路径重定向到本项目。裸 `opencode` 和桌面启动不自动采用这一环境。桌面 1.18.30 启动源码包含 `app.setAsDefaultProtocolClient("opencode")`，涉及系统协议注册；本次未启动桌面应用壳。

真实 Cooperation 数据库仍有其他目录的自动策略。本次只启动新目录里的隔离 manager，使用单独数据库、仅 OpenCode adapter 和 `startMonitoring: false`。测试端口与专用会话不是常驻服务配置。

## 发送与身份

地址保留 OpenCode 原生 ID 的大小写：

```text
opencode:ses_ExampleSessionID
opencode://会话标题:ses_ExampleSessionID
```

OpenCode 使用原生插件工具 `cooperation_send_message`，参数为用户给定或获准创建操作返回的 `to` 和正文 `message`。发送方 sessionID、messageID 和目录来自原生 `ToolContext`；插件请求原生工具权限，并生成仅在本次执行期间有效、消费一次的身份凭据。manager 从对应插件实例读取凭据绑定的原始参数，再进入普通消息 FIFO。审计保存 `source.kind=opencode-tool-context` 及来源原生消息 ID。新增 `cooperation_create_session` / `cooperation_connect_session` 使用相同来源核验，并独立持久化生命周期意图。

Codex、Claude 可沿用现有 CLI/MCP 向 `opencode:` 地址发送。共享 CLI/MCP 无法确定具体 OpenCode 调用会话，因此 OpenCode 自身必须使用插件；不接受模型填写发送者 ID。维护使用新增的原生插件工具 `cooperation_context_checkpoint`，绑定assistant及其父控制消息，不能经通用CLI伪造来源。

## 投递证据与恢复

| 字段或证据 | 含义 |
| --- | --- |
| `status: submitted` | 原生 `prompt_async` 请求被接受。 |
| `nativeMessageId` | 接收方原生消息 ID，投递前已落盘。 |
| `nativeRecorded: true` | 回读得到相同 ID、目标会话、角色与文本哈希的原生记录。 |
| `source.nativeMessageId` | 发出本次工具调用的原生 assistant 消息 ID，与接收方 ID 分开保存。 |
| 实际模型回复 | 专用测试以唯一标记核验；普通投递不自动声称模型已处理。 |
| `displayConfirmed` | 普通发送结果保持 false；GUI/TUI 的界面验收单独记录。 |

投递前排他创建 Cooperation ID → 原生 ID、目标、文本哈希和 `unknown` 意图。响应丢失或插件退出后保留意图；相同 ID 再出现只回读原生证据，**不重复提交**。同一 ID 携带不同内容或目标时拒绝。

刷新、重开和 attach 读取原生历史。插件不补造消息气泡，也不启用 Claude 自动历史补显。

## 2026-09-18 验证记录

| 检查 | 结果 |
| --- | --- |
| 精确忙碌窗口 | 等待工具进入后约 19 ms 确认 busy 并投递；25 秒工具正常完成；原任务和新消息均获模型确认；新消息只有一条原生记录。 |
| 正式插件双向通信 | 两个专用会话各完成一次原生工具发送，来源、目标和原生 ID 一一对应。 |
| GUI 发起与实时显示 | 浏览器原生输入触发发送工具，接收页实时显示来源、Cooperation 编号和模型回复。 |
| GUI 刷新与重开 | 刷新页面、完全关闭浏览器后重开，消息仍可见，原生记录数量不变。 |
| 完整 TUI | 隔离 PTY attach 同一后端，观察已有消息、新消息和回复；关闭 TUI 后重新 attach 仍显示。 |
| 后端重启 | 仅重启本次测试创建的后端，最初双向通信的两个原生 ID 均唯一保留。 |
| Cooperation 管理页 | 会话和通信可见；新版插件能力就绪后可启用自动维护及修改阈值，旧插件保持不可启用。 |
| 自动回归 | 全套 132 项通过，0 failed/skipped/cancelled；来源审计与并发重复提交补充后的 13 项相关回归全部通过。 |
| 桌面应用壳 | 共享后端与界面协议已核对；桌面进程启动、服务器切换与窗口重开待验收。 |
| 自动上下文维护 | 软/硬维护、两阶段原生回执、单次压缩、条件继续已完成隔离原生协议验证。操作结果不确定不自动重试；详见维护文档。 |

本机证据：`.cooperation/opencode/` 下的 `busy-validation-result.json`、`integration-validation-result.json`、`gui-validation-result.json`、`tui-validation-result.json`。截图、隔离数据库和 TUI 输出位于对应 `integration-<run>/`。运行目录包含凭据与测试历史，不随源码提交。

初次浏览器启动因过度改写 Chrome 环境超时；沿用项目已验证的独立 profile/cache/TEMP/APPDATA 配置后成功。初次 PTY connect-token 请求缺少原生 `x-opencode-ticket` 请求头，返回 403，未发送测试消息；补齐协议后完成完整 TUI 验证。

末轮回归发现 Windows 的随机端口可能属于 Fetch 禁用端口。插件现从 20000—65535 选择监听端口，遇已占用端口重新选择；回归覆盖了端口冲突。

## 后续与回退

主动创建/加载方向保持取消。自动维护已实现，后续可继续验证外部模型执行稳定性、原生界面显示以及更细的后台任务观测。现阶段存在原生子会话、待处理权限或回滚时停止自动推进，强停的公共API并发边界见维护文档。

撤下项目配置中的正式插件项，并在任务结束后自然重启对应后端，即停止新的插件接入。保留投递账本用于核对不确定结果。源码回退快照位于 `.cooperation/backups/opencode-integration-20260918/`，与此前 PID 复用修复分开；回退脚本先验证哈希，仅在用户明确要求时应用。

协议依据：[OpenCode Server](https://opencode.ai/docs/server/)、[Web 与 attach](https://opencode.ai/docs/web/)、[插件](https://opencode.ai/docs/plugins/)，以及 v1.18.30 的 `packages/plugin/src/index.ts`、`packages/opencode/src/plugin/index.ts`、`packages/desktop/src/renderer/index.tsx` 和 `packages/desktop/src/main/index.ts`。
