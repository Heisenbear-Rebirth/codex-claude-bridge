# Claude Code VS Code 原生控制接入

保留官方 Claude Code 面板，通过官方 `claudeCode.claudeProcessWrapper` 设置接入本项目 launcher。它启动插件原来选定的 Claude binary，转发原 stdin/stdout/stderr，并为明确允许的工作目录提供本机控制端点。

支持状态读取、上下文统计、原生中断、控制提示和原生压缩。实际验收与边界见 [Validation](docs/VALIDATION.md)。

## 构建

在 Windows 项目目录运行：

```powershell
./scripts/build-claude-wrapper.ps1
```

使用已有 Node.js 与 Windows .NET Framework C# 编译器，无需安装依赖。生成 `bin/claude-wrapper.exe` 和 `bin/claude-wrapper.paths`；后者记录本机 Node 与脚本的绝对路径。移动项目或克隆到其他机器后重新构建。生成文件不上传 Git。

## 配置

此步骤会影响 VS Code 用户以后启动 Claude 的路径，应由用户明确选择是否启用。在 VS Code 设置中填写自己生成的 launcher 路径，例如：

```json
"claudeCode.claudeProcessWrapper": "E:\\Projects\\Cooperation\\bin\\claude-wrapper.exe"
```

完整格式见 [示例](examples/claude-wrapper.vscode-settings.json)。不要用片段覆盖整个设置文件。Windows 普通 VS Code 的用户设置通常位于 `%APPDATA%/Code/User/settings.json`；其他发行版和配置文件位置可能不同。

在管理页为所需的精确目录勾选“Claude 控制”。白名单保存在本项目 `.cooperation/claude-wrapper/config.json`。已有面板需要重开才能经 wrapper 启动；未允许目录继续原样转发，不提供控制端点。递归展示目录不会自动扩大控制范围。

官方 wrapper 模式可能影响插件初始权限模式的回退选择，启用后应在原面板确认权限符合预期。工具不替用户选择模型、思考强度或权限模式。

## 使用

```powershell
node bin/coop-runtime.mjs status --to claude:SESSION_ID
node bin/coop-runtime.mjs context --to claude:SESSION_ID
```

独立手动压缩会实际改变目标上下文，仅在已选定的空闲目标上执行：

```powershell
node bin/coop-compact.mjs --to claude:SESSION_ID
```

日常自动维护可从管理页启用，每个会话独立配置阈值。初始化中、权限待答、半行输入或已有控制操作时，压缩请求会被拒绝。结果不确定不会自动重发。

## 回执权限

MCP 仅提供 `send_message` 与 `context_checkpoint`。未配置 MCP 时，维护提示会给出专用 `bin/coop-checkpoint.mjs` 命令。这个入口只回传结构化阶段确认，不接受任意发送者 ID、不启动服务、不发送普通协作消息。

Claude 可能要求用户批准该命令。可采用项目范围的窄 allow 规则，具体路径和授权由用户决定；不需要切换默认权限模式。配置提案脚本只在明确调用 prepare/apply/restore 时执行，操作前应检查目标与预览。

## 协议与数据

- 外部请求绑定会话 ID、随机实例 ID、本机 token 和期望活动版本。
- 权限请求与答复仍由原面板处理，wrapper 不代答。
- 活动 ID 来自 wrapper 观察的输入轮次，不冒充服务端 turn ID。
- 原生 interrupt 确认后仍等原 result 结束；压缩需观察 compact_boundary 与后续 result。
- 忙碌用量来自主会话 API usage，包含缓存和已报告输出。容量或 effort 无法确认时保持未知。
- 注册文件、日志和临时数据位于本项目。注册文件含本机凭据，不应分享。
- Windows launcher 的 Job Object 在退出时清理代理及其子进程；此生命周期行为应纳入使用评估。

## 回滚

先关闭使用 wrapper 的面板，在 VS Code 中恢复原 `claudeCode.claudeProcessWrapper` 值，再重新打开会话。不要覆盖其他设置。

`scripts/vscode-wrapper-settings.mjs` 提供带备份及哈希检查的 prepare/apply/restore 辅助命令；它会访问 VS Code 用户设置，只有用户明确授权后才应使用。未调用这些命令时，构建和启动本项目不会自动改写用户设置。


## 统一的可见消息发送

Cooperation 的 CLI、MCP 和管理页普通消息共同进入 `ClaudeRuntime.sendMessage`。普通消息使用 peer 通道，空闲与忙碌均可投递，保持原有发送方与接收策略；不会自动调用 interrupt。交付、恢复、继续提示也从该入口分派，但保持维护控制轮次和空闲状态校验。原生回显经 wrapper 显示，同一消息 UUID 不重复投递。

强停压缩的顺序仍是 interrupt → 确认原轮次结束 → 可见交付提示 → handoff 回执且轮次结束 → 原生 compact → 可见恢复提示 → restored 回执且轮次结束 → 按原状态决定是否继续并释放 FIFO。收到 interrupt 的确认本身不等于原轮次已结束。

`peerMessageVisibility` 能力只说明已启用实时显示转换；`peerHistoryVisibility` 说明已显式启用重开后恢复，默认 false。投递结果中的 `visibility.displayConfirmed` 不因传输提交而置为 true。旧 wrapper 可以继续收普通 peer 消息，但结果会说明其显示能力尚未启用，需在工作结束后正常重开。

默认不执行历史补显，也不为补显读取原生 JSONL；`visibilityHistory` 报告 `disabled`、count 为 0。新消息仍按原生回显实时显示。重开后旧协作消息可能不再出现在 Claude 面板中，可在 Cooperation 管理页查看通信历史。这样避免将多条旧消息集中补到对话末尾，让人误以为它们再次发来。

如明确需要恢复旧行为，可在项目 wrapper 配置中设置 `peerHistoryVisibility: true`，或在启动环境中设置 `COOP_PEER_HISTORY_VISIBILITY=1`；`COOP_PEER_HISTORY_VISIBILITY=0` 优先关闭。仅显式开启时读取本会话 JSONL，沿当前分支选取最近 200 条 Cooperation peer，在完整行边界向 IDE 补回；不会写原生历史或进入模型输入。恢复消息仍位于末尾，不保证原先的交错位置。未知历史位置、读取失败或同时压缩会跳过恢复并报告原因。

实时回放与历史补显共用按会话 ID 和消息 UUID 去重的记录，两种到达顺序都只输出一次，不依赖面板再次去重。配置及代码变更在 wrapper 下次正常启动时生效，不热更新或重启正在工作的客户端。

关闭 `COOP_PEER_MESSAGE_VISIBILITY=0` 或项目 wrapper 配置 `peerMessageVisibility: false` 会同时关闭实时转换与历史恢复，在下次启动时生效。原生启动参数、权限和模型设置仍原样传递。
