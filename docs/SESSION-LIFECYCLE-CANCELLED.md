# 主动创建与加载会话：已取消

发布版通过仓库根目录 `session-lifecycle-cancelled.json` 保持停用，新克隆不依赖本机 `.cooperation/`。下文为脱敏后的历史收尾记录；目录访问边界仅约束开发助手，产品正常管理用户添加的项目。

用户已明确取消此方向，要求保存进度，并撤销本次尝试造成的项目外文件改动。不得自动恢复研究、启动测试客户端或创建新会话。

## 保留的进度

- OpenCode 上下文显示修复保留；它是独立的用户需求。
- OpenCode 原生创建/连接、统一生命周期账本及入口已有隔离验证。
- Codex 原生 create_thread 接口已从安装代码核实，但 App Tools 连接未恢复，没有执行真实 Codex 创建。
- Claude 原生界面接入仍为未验证实验代码。直接 CLI 初始化只得到临时 ID；带首轮的专用测试持久化了历史，但认证失败，没有可用通信入口。
- 最近完整测试为145项通过；此后目录保护相关45项测试通过。最后添加的 Claude native-ui adapter、VS Code 扩展和包装器标识变更尚未完成回归。
- 当前源码和本地证据保留在 Cooperation，未提交或推送。另已在 `.cooperation/cleanup/session-lifecycle-cancelled/project-progress/` 保存90个项目文件及SHA256清单，作为取消前进度快照。真实 manager 和当前 OpenCode 插件没有更新。
- 本工作副本通过 `.cooperation/session-lifecycle-cancelled.json` 停用实验入口：MCP及OpenCode插件不再公布创建/连接工具，管理页不再提供对应能力，旧调用在身份查询和创建意图落盘前拒绝。VS Code试验扩展和原生实验启动脚本也会直接停止。不要自动删除这一取消标记。

## 清理范围

只处理有本轮实验标识及时间证据的项目外文件。删除前将原件和SHA256备份到本项目；共享配置、共享数据库或其他会话文件没有前置快照时，不做整文件覆盖或猜测回退。

两个专用 Claude 测试ID：

- `00000000-0000-4000-8000-000000000001`：2026-09-18T08:12:24Z，仅初始化，CLI正常退出，无已确认持久历史。
- `00000000-0000-4000-8000-000000000001`：2026-09-18T08:14:03Z，首轮认证失败，CLI已退出，存在本项目的原生测试历史。

专用 VS Code 扩展开发宿主：PID26940，创建时间2026-09-18T08:21:25.0774132Z；对应已确认的本次日志目录为 Code/logs/20260918T154748/window3。其本机调试接口在本轮开启，需收尾。原生界面接入未成功，最后核对时该宿主的workspaceFolders为空。

此次开始前已有的 Codex/Claude/OpenCode 用户级配置和其他业务会话不属于撤销范围。

## 不可访问的目录

`C:/Work/ProjectA` 和 `C:/Work/ProjectB` 及其后代目录不读取、不写入、不执行会话操作。清理工作也不得访问这些目录；不能以核对影响为由读取它们。

## 清理结果

已清理18个有明确本轮归属的项目外文件，删除前均备份到 `.cooperation/cleanup/session-lifecycle-cancelled/external-backup/` 并校验SHA256：

- 1个 Claude 测试历史：`.claude/projects/E--Projects-Cooperation/00000000-0000-4000-8000-000000000001.jsonl`。
- 15个专用 VS Code `logs/20260918T154748/window3` 文件及空目录。
- 2个本轮首次创建的 VS Code `User/workspaceStorage/ext-dev` 状态库文件及目录；NTFS创建时间08:21:24.878Z与专用窗口吻合。

两个测试会话的临时注册、专用debug/tasks/session-env/file-history路径均无残留。专用扩展宿主PID26940在清理阶段已退出，9740本机调试监听已不存在；未再次关闭或重启业务客户端。

`.claude.json` 和 `.claude/history.jsonl` 的修改时间早于原生实验开始，没有回退它们。VS Code全局共享 `storage.json` / `state.vscdb` 中没有本轮扩展标识或路径；现存数据库备份与当前数据库相同，无法作为实验前副本。**共享状态、窗口位置、正常运行缓存没有整文件回滚，不能宣称已逐字节恢复到实验前。** 这样避免覆盖其他工作窗口和原有会话的状态。

报告位于同一项目内清理目录：`external-audit.json`、`external-cleanup-result.json`、`external-verification.json`、`owned-host-closed.json`、`vscode-state-audit.json`、`workspace-state-audit.json`、`final-verification.json`。备份可能含原生日志信息，继续保持本地忽略，不随源码发布。

最终核验时间2026-09-18T09:03:56Z：90个进度文件及18个外部备份哈希全部匹配，外部清理目标残留0，原测试PID不存在，9740调试监听0；实际MCP目录仅剩`send_message`与`context_checkpoint`。修改文件语法检查与`git diff --check`通过。

取消入口、消息保留、保护路径和上下文统计的11项隔离回归通过。没有重新运行原生创建实验。等待用户指定其他完善方向。
