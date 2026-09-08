# 自动上下文管理实施计划

日期：2026-09-07。依据 [设计稿](AUTO-CONTEXT-DESIGN.md)。本计划按可验证的能力分阶段交付，当前轮只做准备、接口检查和文档，不启动自动压缩流程。

> 实施更新：本文件保留原分阶段计划。P1–P6 的实现已进入本项目；最新完成项、真实验收与未完成边界以 [Validation](VALIDATION.md) 为准，不再以本文原始“当前轮”文字判断实现状态。

## 基线

当前已有：轻量Node管理服务、单目录管理页、跨客户端消息CLI/MCP、Codex独立压缩验证、Claude进程wrapper压缩CLI、两端上下文读取。最新完整自动检查35项通过；两端独立外部压缩已有原生完成证据。

当前缺少：可靠统一的实时activity契约、外部中断实测、忙碌时Claude用量与容量采样、会话级策略持久化、管理状态机、阶段回执、维护消息锁与持久队列、多目录UI。Codex原消息桥仍需要从合法App任务继承App Tools连接；自动管理服务从普通终端启动时必须先解决自己的控制消息发送路径，不能只凭独立压缩成功就宣称整个流程独立。

## P1：验证并统一外部客户端能力

交付 `runtime adapter` 及专用会话证据，优先解决全流程能否成立。

1. Codex：把已验证的原生IPC握手/owner发现整理成可复用连接层；只操作指定会话。接入原生实时轮次状态，核对idle、running、waiting approval、unloaded、offline、unknown与当前turnId。日志作为增量用量源和恢复线索；不凭未完成start断言存活。
2. Codex：验证有expectedTurnId的精确中断，以及普通外部程序的控制提示发送/原ID恢复。避免调用会清空后台终端的无条件user-stop路径，查明goal/子agent继续运行的情况。不能靠另起app-server或模型会话冒充原会话。
3. Claude：在wrapper补齐被动usage/capacity采样、活动版本、控制请求分类；扩展独立interrupt与maintenance-prompt入口，保留原面板SDK控制流和权限答复。原生context查询用于校正空闲时统计，不能作为唯一忙碌监测源。
4. 两端：在专用测试会话做短暂、可控工作→外部读running→中断→确认idle→同ID继续的闭环；分别验证权限等待、客户端断连、动作期间收到新业务轮次。真实测试不操作其他生产会话。
5. 核对模型、effort和permissionMode前后状态，保持caller环境独立；不再通过修改模型降低测试成本，避免原生插件把选择持久化为全局。

拟新增 `src/runtime/codex-ipc.mjs`、`src/runtime/codex-runtime.mjs`、`src/runtime/claude-runtime.mjs`，扩展wrapper。先保留旧消息adapter兼容，不静默改已有发送语义。

通过条件：每个客户端公开 capabilities；缺失readActivity、interrupt、sendControl、compact、observeCompletion中的任一必需项时，管理页明确显示未就绪，hard自动化不开启。不会通过估计或模拟测试填补真实中断证据。

## P2：事务存储与多目录基础

交付项目内SQLite迁移脚本、单实例约束、目录集合API和多目录页面。

- 设计management.sqlite表、唯一约束、schema版本和增量迁移。
- 对现有messages.jsonl在项目内备份，在副本上幂等导入并核对消息ID、正文hash、名称快照和状态。
- 用事务承载message admission、session lock、cycle、checkpoint、outbox意图，消除独立文件写入间的竞态。
- API支持多个directory及逐项recursive，当前旧directory参数可临时兼容。
- UI添加目录集合、跨目录并集、会话去重及目录错误分项显示；保留已有搜索、复制ID和消息详情。
- 同步显示Claude目录的wrapper接入情况：已连接、待重开或未启用，不能将目录列表等同于控制白名单。

拟新增 `src/management-store.mjs`、`src/directory-service.mjs`、`scripts/migrate-management-store.mjs`，修改service/http/public。切换写存储前检查旧服务状态；原日志保留，禁止双权威写入。

通过条件：两个独立目录分别包含Codex/Claude，能够同页展示与通信；目录重叠不重复；移除筛选不删策略/消息；两个服务进程不能同时调度同一目标。

## P3：会话策略与只读观察模式

交付每会话enabled、soft、hard编辑，以及只读判定轨迹。

- Codex新策略默认40/55，Claude50/80；复制默认值到会话，之后独立修改。
- UI明确显示阈值作用域、实际模型、分母、统计时间、是否滞后、activity及capabilities。
- 分别测试边界39.99/40/54.99/55和49.99/50/79.99/80。
- 验证soft期间active→idle时会触发，不要求再次跨阈值；hard优先；unknown不冒充idle。
- 仅记录“现在会触发什么”，先不发控制提示。检查监测开销、事件丢失、模型/窗口切换和重启恢复。

拟新增 `src/context-policy.mjs`、`src/context-monitor.mjs`；对现有context-usage增加增量读取游标，避免每2秒全文件扫描所有会话。

通过条件：A策略修改不改变B；多会话同时监测数据不串；累计token不作为占用；压缩epoch变更和capacity缺失均处理正确。

## P4：阶段回执、入站锁和持久队列

交付 `context_checkpoint` MCP工具与CLI命令、会话消息admission和出站队列。

- 回执绑定实际sender、cycle、stage与阶段token，重复幂等，拒绝错误阶段/其他会话/过期cycle。
- 第一回执验证文档存在、hash及允许路径；第二回执验证恢复阶段。
- 锁在流程事务创建时获取，普通发送返回queued而不是堵住发送方工具。
- 队列持久化正文/身份快照/sequence，控制提示走单独通道。
- 消息router成为所有Cooperation入口的唯一admission点；去除任何绕过锁的内部直发路径。
- ACK先返回，等控制轮次真正结束再推进，避免MCP回执工具与压缩相互中断。

拟新增 `src/checkpoint-service.mjs`、`src/session-mailbox.mjs`；扩展src/mcp.mjs、bin/coop.mjs和service。MCP工具变化保持最小：send_message + context_checkpoint；不给agent暴露会话发现。

通过条件：写交付和恢复期间连续发消息全部入队，原文未丢失；第二回执前零投递；不同会话互不阻塞；重复回执不重复压缩或继续；重启后仍保持锁和队列。

## P5：完整维护状态机

交付soft/hard两种入口与完整交付—压缩—恢复流程。

- 使用设计稿的提示词模板，路径和回执字段由服务生成，模型不承担状态路由。
- hard入口先记录wasWorking与原轮次，然后执行精确中断；idle入口跳过。
- 在交付、压缩、恢复各阶段抑制该cycle再次触发阈值；其他会话继续各自监测。
- 原生压缩完成以Codex ContextCompaction+轮次结束，Claude compact_boundary+result为依据，不以传输success替代。
- 第二回执及恢复轮次结束后，建立恢复命令与FIFO普通队列的出站顺序。
- 如用户手工停止或输入新目标，标为user_intervened，停止自动继续；不把旧wasWorking当作永久继续授权。
- goal、后台工具与子agent若不能按客户端原状态恢复，显示能力限制而不是终止整棵进程树。

拟新增 `src/maintenance-controller.mjs`、`src/maintenance-prompts.mjs`，与store/mailbox/runtime adapter交互。自动调度属于项目服务进程，不创建Codex App定时自动任务或系统服务。

通过条件：两端各一次soft-idle完整流程、一次hard-running完整流程；对应会话ID不变，两个回执明确、真实压缩完成、需继续才继续、锁内消息顺序正确。暂时降低阈值仅用于专用会话，并在测试后恢复策略。

## P6：故障恢复与用户管理

- 在副作用intent写入前后、回执返回前后、中断/压缩超时、客户端退出、manager崩溃等位置模拟故障。
- 恢复时校验lease/fencing、目标instance/turn和原生事件，不自动重放结果不确定的消息或压缩。
- UI展示needs_attention原因、队列和安全恢复选项；取消流程需明确队列释放/保留结果。
- 报告完整测试与真实原生验收范围，单独标明仍未验证的并发/重启场景。
- 文档描述原生UI输入和外部直连可能绕过Cooperation锁，不承诺全系统硬隔离。

通过条件：无丢消息、无乱序插队、无误把未知当完成、无恢复后无限压缩；原模型/权限未被服务改写；未纳管会话继续原使用方式。

## 设计假设与后续需确认项

当前采用以下具体默认，不阻碍先做P1/P2：

1. 会话逐个或批量显式纳管，新增目录先发现不自动接管。
2. 阈值分母为客户端报告的完整有效窗口，而非自动压缩指示器预算。
3. 锁首先覆盖所有Cooperation入站消息，原生UI直接输入视为用户介入；全来源锁需要额外客户端能力。
4. wasWorking=true时先发送一次继续工作，再FIFO投递排队消息。
5. “强制暂停”采用原生中断业务轮次，保留进程、文件和权限状态；不使用操作系统挂起或kill。

实施如发现这些选择会改变用户预期，在具体可审结果出现时说明并询问；不把尚未确定的选择写成用户已经明确要求。

## 当前轮与上下文压缩后的接续

当前轮交付本计划、设计稿、活动状态预检查和HANDOFF。压缩后收到用户启动指令，应先阅读HANDOFF及两份设计文档，回复OK表示已恢复，再从P1未完成接口验证继续。不得从本计划直接启动生产会话自动管理，不重跑既有压缩验收，不重建全局配置或启动器。
