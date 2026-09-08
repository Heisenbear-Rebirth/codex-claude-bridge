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
