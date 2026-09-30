# OpenCode 自动上下文维护

## 2026-09-30 修复与实际链路复核

- 共享 MCP 在 OpenCode 中的命名前缀会与原生插件工具重名。现在识别到 OpenCode 客户端后返回空 MCP 工具列表，保留原生 `cooperation_context_checkpoint` / `cooperation_send_message` 的 ToolContext 身份。旧 MCP 进程需重新连接或随 OpenCode 重启后生效。
- 显式重试恢复阶段时，使用重试前核对的当前轮次；成功投递后清除该重试编号，避免沿用交付阶段的旧编号。新的原生输入仍会阻止重试，不会重复压缩或提前放行队列。
- 普通协作消息会显式继承原生后端已保存的模型、agent 和 variant，避免 `prompt_async` 省略 variant 时把思考强度清回默认值。旧会话从最近用户消息读取选择；界面尚未随消息提交的选择不属于后端已保存状态。

完整自动测试：**184 passed，0 failed**。新增回归覆盖三种 OpenCode MCP 身份入口、交付/恢复重试及输入竞争、普通消息连续投递时保留选择。

用户指定的真实 OpenCode **1.18.33** 测试会话完成软阈值和强阈值维护。两条流程均核对原生工具回执、文档哈希和单次压缩；软流程的两条排队消息按顺序投递并分别得到回应；强流程确认原轮次被中断，恢复后只发送一次继续提示并收到测试标记。最初软流程还暴露了原生空摘要/空回复：读取交付文档后未回执时保留队列，经显式恢复重试完成，没有再次压缩。强流程生成了非空摘要并自动完成全链路。这个差异保留在验收记录中，不将原生返回成功等同于摘要内容质量。

最后重载插件并由原生用户消息保存 `max` 后，连续两条真实消息均保留模型、agent、variant和权限；原生发送工具的回信已在发起验收的Codex会话收到。最终会话空闲、队列0、无活动维护；测试策略恢复为关闭，阈值50/80。记录为 `final-live.json`。

真实 **1.18.30** 隔离后端配本地模拟模型，加载同名 MCP 与原生插件，软/硬维护及后续两条普通消息均通过；两条消息保留非默认 variant。证据位于本项目 `.cooperation/verification/opencode-repair-20260930/`：`full-tests.txt`、`reproduced-failures.json`、`soft-audit.json`、`hard-audit.json`、`native-final-coexistence-selection.json`。以下为早期实现记录。

2026-09-18：软阈值和强阈值维护已实现，已通过隔离 OpenCode 1.18.30 后端验证。原生后端、工具执行和压缩记录是真实的，模型响应由本地模拟服务提供。没有对用户业务会话执行维护。

## 启用

1. 更新 Cooperation 后，重新启动管理服务；等待当前原生任务结束，再重新启动所属 OpenCode 后端并打开原会话。两者都会缓存模块，仅刷新网页不足以升级。
2. 在管理台选中 OpenCode 会话，刷新状态。新版插件能提供维护状态时，“启用自动压缩”开关可用；旧插件或状态读取失败时保持不可启用。已启用的策略始终可以关闭。
3. 按会话启用，默认关闭。默认空闲阈值50%、强停阈值80%，允许独立修改。模型容量或有效用量未知时等待统计。

继续使用原来的会话ID、模型、agent、variant和权限。维护会在该会话工作目录写交付文档，并调用模型完成交付、摘要和恢复；写文件/读取权限沿用原生设置。如果原agent不允许写交付文件，需要按原权限流程处理，程序不会切换agent或放宽权限。

## 流程

- 软阈值：等当前任务空闲，创建维护cycle并锁住该目标的Cooperation消息队列。
- 强阈值：确认当前实例、轮次和设置，提交一次中断；确认原轮次结束后再写交付文档。
- 发送交付提示，接受 `cooperation_context_checkpoint` 的handoff回执，等待对应控制轮次结束。
- 调用原生 `summarize(auto:false)`，关联新增compaction消息与无错误的已完成summary回复，确认原生空闲。
- 发送读取交付文档/恢复上下文提示，接受restored回执，再等待对应轮次结束。
- 原本正在工作时发送一次继续提示，原本空闲时不额外续跑；之后释放FIFO中的协作消息。

插件回执绑定ToolContext的sessionID、assistant messageID及其父user messageID。manager验证阶段token、目标目录内的文档和哈希。共享CLI/MCP不能代填OpenCode来源身份。该回执工具独立于已取消的会话创建/加载功能。

## 持久化和恢复

操作记录位于安装目录 `.cooperation/opencode/maintenance/<sessionID>/`。提交前保存请求ID、参数指纹、原生消息ID及意图，避免丢失响应后重复提交。记录不包含提示正文或阶段token。

压缩由插件持有原生长请求，manager短连接结束不代表压缩停止。manager/插件重启后回读原生消息与操作记录，只在证据充分时接续。没有回执的已提交控制提示不会自动重发；结果未知的压缩不会自动重做。

成功压缩的摘要ID也作为持久上下文epoch。它移出最近消息窗口后仍可识别，后续业务达到阈值时可以再次维护。摘要生成本身的用量不当作压缩后的业务上下文，恢复轮次提供新的统计。token回退口径与OpenCode一致，不把reasoning重复加到output上。

## 当前支持边界

- 原生存在子会话时，暂不自动维护该父会话。当前版本没有可用的完整只读后台作业列表；此检查包括历史子会话，程序不会删除或关闭它们。待后台任务观测接通后再细化为只阻塞活跃子任务。
- 待处理权限/提问、未落盘输入、会话回滚会阻止控制；维护阶段超时后保留队列供处理。
- 原生用户输入优先：控制调用前复核活动revision；普通输入在单次提示/中断调用期间短暂等待，随后原样提交。新轮次或设置改变会停止维护推进。压缩期间原生输入保持可用，新输入会使压缩证据不再匹配。
- OpenCode的公共abort没有按expectedTurnId原子执行的条件；其他客户端直连、原生命令/后台路径不能由插件的chat.message协调完整覆盖。当前实现和测试验证了普通输入竞争检测，**不承诺任意并发原生操作下都具备原子轮次锁**。
- 原生自动压缩配置保持不变。若它提前发生或用户介入，控制轮次/压缩记录不再匹配时暂停或进入需要处理，而不把其他压缩当作一次新的自动重试。建议给交付轮次留出容量余量。
- 重连证据读取当前有限消息窗口；活动维护被大量原生输入覆盖后，证据不足时保留流程，不能据此重试压缩。

## 验证与文件索引

完整 `node --test test/*.test.mjs`：**167 passed，0 failed**。其中新增12项OpenCode维护测试，覆盖软/硬全流程、FIFO、回执身份、原生摘要失败、迟到回执、未知投递、manager/插件重启、长历史epoch、设置/权限/子会话阻塞与普通输入竞争；另有用量和原有Codex/Claude回归。

真实OpenCode **1.18.30** 后端 + 本地模拟模型：软/硬两条流程均完成，每条只有一次原生压缩、两次已完成的原生checkpoint工具调用；软流程不续跑，硬流程继续一次。写交付和读恢复通过原生write/read工具完成。这项验证证明原生协议链路，未用付费外部模型验证自然语言执行稳定性，也未重新验收原生TUI/桌面壳显示。

隔离管理页浏览器：旧插件不可启用、新插件开关及阈值保存、刷新持久、能力丢失后仍可关闭、桌面/390px手机无横向溢出、页面错误0。

| 文件 | 内容 |
| --- | --- |
| `src/opencode-maintenance.mjs` | 原生消息头、状态revision、输入协调、操作ledger、压缩完成证据和持久epoch |
| `src/opencode-bridge.mjs`、`plugins/opencode.mjs` | 插件控制RPC、原生身份回执和chat.message钩子 |
| `src/runtime/opencode-runtime.mjs`、`src/adapters/opencode.mjs` | manager到原生实例的状态与控制接口 |
| `src/maintenance-controller.mjs`、`src/maintenance-recovery.mjs` | 两阶段维护与重启接续 |
| `src/checkpoint-service.mjs`、`src/http-server.mjs` | 文档/阶段/原生控制轮次校验，策略能力检查 |
| `test/opencode-maintenance.test.mjs` | 隔离HTTP端到端与异常回归 |
| `.cooperation/opencode-maintenance-native-result.json` | 最终原生后端结果；对应根目录 `opencode-maintenance-native-6XPQVE/` |
| `.cooperation/opencode-maintenance-ui-result.json` | 浏览器结果；截图 `opencode-maintenance-ui-Djlxc3/desktop.png`、`mobile.png` |

备份：`.cooperation/backups/opencode-maintenance-1789731680680/`（19文件）和 `opencode-maintenance-1789733593380/`（README/VALIDATION）。源码未提交；真实manager和用户OpenCode后端本轮未重启或部署。
