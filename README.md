# Codex Claude Bridge

Local messaging and automatic context maintenance for existing Codex desktop and Claude Code sessions, with an MCP server and a multi-project dashboard. 项目内部命令与管理页名称保留为 Cooperation。

连接已有的 Codex 桌面任务与 Claude Code VS Code 会话。原生客户端继续承载对话，本地管理页负责多个目录的会话发现、通信记录与上下文维护。

实现与原生验收范围见 [Validation](docs/VALIDATION.md)。设计依据保留在 [设计稿](docs/AUTO-CONTEXT-DESIGN.md) 和 [分阶段计划](docs/AUTO-CONTEXT-IMPLEMENTATION-PLAN.md)。原始会话记录、本机交付和凭据不纳入仓库。

## 启动

需要现有 Node.js 22.13+，无需第三方依赖。已验证 Node.js 25.2.1。以下路径为示例，请替换成自己的克隆目录。

```powershell
cd E:\Projects\Cooperation
node bin/coop.mjs serve --port 11555
```

打开终端显示的本机地址。省略 `--port` 时自动选择空闲端口；`Ctrl+C` 关闭服务。一个工具目录只运行一个管理实例。

普通协作消息发往 Codex 时仍使用已有的 App Tools 桥，因此完整启动应来自合法 Codex 桌面任务环境。自动维护的 Codex 活动读取、中断、控制提示和压缩使用独立的本地 IPC，不需要借用调用者任务 ID。未加载的 Codex 任务需先在原生 App 打开；目前独立维护通道不自动唤醒未加载任务。IPC 受原系统权限约束。

中央数据、日志、数据库、迁移备份和交付副本写在本目录 `.cooperation/`。不要共享 `connection.json`、wrapper 实例注册文件或管理数据库中的阶段凭证。程序不创建系统服务或计划任务。

## 多目录与会话策略

- 添加多个目录并分别选择是否递归；勾选目录决定会话和消息的展示范围，重叠目录的同一会话只显示一次。目录失效单独报告。
- 查看会话名称和 ID，复制 `codex://名称:ID` 或 `claude://名称:ID` 通信地址。改名不会改变已有消息里的名称快照。
- 展开会话的“上下文管理”，读取原生状态、占用、模型与观测时间。每个会话独立保存开关、模式、空闲阈值和强停阈值。
- 默认关闭。先选择“只观察触发条件”可验证触发判断；选择“自动维护”并启用后才会执行维护。
- Codex 默认 40% / 55%；Claude 默认 50% / 80%。低阈值在空闲时触发，高阈值在工作中先精确中断，再维护。分母是完整有效模型窗口。

“Claude 控制”开关只配置本工具目录中的 wrapper 白名单，精确匹配对应目录，不随递归展示扩大。已经配置官方启动器的 Claude 面板需重开后接入；新版本 wrapper 会在操作前检查目录是否仍获准。会话可见不等于控制端点在线。该开关不修改其他项目文件，也不安装其回执权限规则。

## 自动维护流程

1. 创建持久流程并锁住目标的 Cooperation 入站消息；工作中触发高阈值则先中断期望轮次。
2. 目标把交付文档写进自己获准的工作目录，再回传 `handoff` 结构化回执。
3. 回执工具返回、对应原生轮次结束后，提交原生压缩并等待真实完成证据。
4. 发送“开始加载上文”，目标读取交付文档及必要文件，回传 `restored` 回执。
5. 恢复轮次结束后，仅向触发时正在工作的目标发送一次“继续工作”，随后按 FIFO 投递排队消息。

普通聊天文本 `OK` 不推进流程。回执校验真实调用者身份、流程 ID、阶段凭证、文档位置及内容哈希。模型、思考强度和原权限选项沿用原会话；Codex 的压缩操作思考强度与用户保存的会话选项分别读取。

维护阶段超时、权限阻碍、实例改变或新原生输入会保留锁和队列，显示“需要处理”。可核对原生完成记录后继续，或重新发送未完成的交付／恢复请求。结果未知的压缩和消息不自动重试。取消维护时明确选择释放或保留消息；保留消息仍阻挡新消息插队。

会话锁覆盖经过 Cooperation 的消息。原生界面输入与其他程序直接投递可绕过该入口；已观察到的介入会停止自动推进。原生 goal、子agent 和后台任务的完整暂停恢复尚未验收，有此类状态的会话不开放自动维护。

## 消息与 MCP

从原会话的工具环境运行，发送者身份自动取得：

```powershell
node E:/Projects/Cooperation/bin/coop.mjs send --to claude:会话ID --text "工作报告" --client codex
node E:/Projects/Cooperation/bin/coop.mjs send --to codex:会话ID --file ./report.txt --client claude
```

正文前附发送方名称、ID 和消息编号；是否回复由 agent 决定。目标可使用短地址、管理页复制的地址或原生深度链接。

stdio MCP：`node E:/Projects/Cooperation/bin/coop.mjs mcp --client codex|claude`。示例见 [Claude](examples/claude.mcp.json)、[Codex](examples/codex.config.toml)。仅暴露 `send_message` 和 `context_checkpoint` 两个业务工具，不向 agent 提供会话枚举或历史读取。

维护回执也有专用 CLI，参数由当前维护请求给出：

```powershell
node E:/Projects/Cooperation/bin/coop-checkpoint.mjs --client claude --cycle 流程ID --stage restored --receipt-token 阶段凭证 --document 交付文档绝对路径
```

如 Claude 的原生权限机制阻止回执，可由用户在项目 `.claude/settings.local.json` 中批准窄规则 `Bash(node E:/Projects/Cooperation/bin/coop-checkpoint.mjs *)`，将路径替换为自己的实际目录。该入口只能回传维护回执，不能启动服务或发送普通消息。权限规则不随仓库分发，也不自动应用；保留原权限模式及其他规则。

## 数据与投递状态

SQLite 是新的唯一写入存储。旧 `messages.jsonl` 保留，并在有哈希备份、正文和身份快照核对后幂等导入。若旧日志在迁移后又被修改，启动会停止并要求核对，防止双源写入。

| 状态 | 含义 |
| --- | --- |
| queued | 已持久排队 |
| held | 用户选择保留，等待释放 |
| pending | 已记录投递意图，正在提交 |
| submitted | 已提交到客户端；不等于已处理 |
| unknown | 结果不确定，阻挡该接收方后续投递，需人工对账 |
| failed | 已知发送失败 |

消息日志只保存本工具传递的消息。原生状态与统计的读取只保留控制字段，不把完整原生历史复制进管理界面。

## 验证与兼容性

```powershell
node --test test/*.test.mjs
```

全新 Windows 克隆需先运行 `./scripts/build-claude-wrapper.ps1`，生成本机 launcher 和路径文件，再运行上述测试。带真实会话信息的本机验收脚本不随仓库分发，自动测试使用模拟端点。

本机内部接口基线：Codex Desktop 26.901.6511.0 / Core 0.153.4，Claude Code VS Code 2.1.237。客户端升级后应复核版本和专用会话验收。Claude 进程接入、已批准的全局启动器历史和回滚见 [CLAUDE-WRAPPER.md](CLAUDE-WRAPPER.md)。
