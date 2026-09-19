# OpenCode 自动上下文维护：研究与实施方案

> 研究归档：用户之后已要求实现，现已完成软/硬流程与隔离原生验证。当前实现、限制和使用方法见 [OPENCODE-MAINTENANCE.md](OPENCODE-MAINTENANCE.md)。以下保留实施前的研究结论。

2026-09-18。用户要求先思考研究，尚未开始功能实现。本轮阅读 Cooperation 源码、项目内 SDK/OpenAPI 和 OpenCode v1.18.30 上游源码，没有调用原生中断、压缩、创建或重启接口，没有访问其他业务目录或会话。

## 结论

OpenCode 具备实现 Cooperation 自动上下文维护所需的主要原生能力，可以接入“交付 → 压缩 → 恢复 → 按原活动继续”的流程。当前禁用来自 Cooperation 的未完成集成，不是 OpenCode 原生不支持，也不是用户要求禁用。

方案覆盖软阈值和强阈值。强停的轮次竞争、后台任务可观察性，以及原生自动压缩与维护流程的协调，是实现前必须用隔离后端验证的重点；仅凭公开 API 存在，不能宣称完整流程已经验收。尤其公开 abort 接口不提供 expectedTurnId 原子条件，前后读状态不能证明绝无竞争窗口。

本功能维护已经存在的会话，不需要恢复已取消的主动创建/加载原生会话功能。产品可按用户配置管理多个目录，开发助手仍只在 Cooperation 内研究和测试。

## 1. 为什么当前代码禁用

| 文件 | 当前行为 | 实施时需要补齐 |
| --- | --- | --- |
| `src/context-policy.mjs` | 默认阈值只有Codex/Claude；validatePolicy拒绝OpenCode；evaluatePolicy返回disabled | OpenCode策略、能力判断、忙碌期间可信用量判定 |
| `src/runtime/opencode-runtime.mjs` | sendControl/interrupt/compact均直接抛“尚未开放” | 三种原生控制、查询操作结果、绑定实例和轮次 |
| `src/opencode-bridge.mjs` | automaticMaintenance/sendControl/compact/interrupt/observeCompletion固定false；仅粗粒度活动和用量 | 持久化控制操作、细粒度运行状态和完成证据 |
| `src/maintenance-controller.mjs` | trigger/step只接受Codex/Claude，压缩完成判断按二者分支 | OpenCode阶段证据及状态转换；不能直接落入Codex分支 |
| `src/maintenance-recovery.mjs` | controlTurnEnded/readRestartEvidence拒绝OpenCode；其他分支含UUID、小写比较等假定 | 大小写敏感ID、基于原生消息的阶段核对和重启恢复 |
| `src/maintenance-prompts.mjs` | 回执说明仅支持Codex/Claude，带各自CLI回退 | OpenCode插件回执工具说明，身份来自ToolContext |
| `plugins/opencode.mjs`、`src/http-server.mjs` | 尚无OpenCode原生身份绑定的checkpoint工具/专用回执路由 | 复用一次性身份凭据和CheckpointService，不接受模型填from |
| `public/app.js` | OpenCode维护控件被静态说明替代 | 按运行插件能力开放开关、阈值、阶段和错误说明 |

此前只完成通信、活动观察和用量显示，维护协议尚未接通。正确开发方式是补全上述链路后开放，而非只移除前端文案或改一个布尔值。

## 2. 原生能力与已核实的语义

核对依据为本项目锁定的 SDK/plugin 1.18.30、`.cooperation/opencode/openapi.json` 以及上游 v1.18.30 对应源码。网站概述及旧SDK类型不足以描述全部行为。

### 状态、控制提示和回执

- `session.status` 只报告idle/busy/retry，idle会从状态表移除；它不提供Cooperation需要的activeTurnId、权限等待或后台任务全貌。
- `prompt_async` 支持指定messageID、model、agent、variant，返回204后实际处理仍在进行。
- assistant记录有parentID、time.completed、finish、error，工具parts有运行/完成状态。需把Cooperation的控制user messageID与对应assistant/tool记录、原生idle联合核对。
- 维护提示应保留原agent/model/variant，并核对权限指纹。上游createUserMessage会按传入/默认值更新会话的agent/model；省略agent并不保证保留原agent。
- 不传`tools`覆盖原权限：上游prompt会根据该字段重写session.permission。
- 插件ToolContext提供sessionID、messageID、directory、agent和abort；可新增`cooperation_context_checkpoint`，由manager向插件取回绑定身份的原始参数。
- 回执除了cycle/stage/token/文档哈希，还应核对调用它的assistant是否属于该阶段控制user messageID；接收工具回执后仍需等待控制轮次真正结束。

### 手动压缩

- 原生`POST /session/{sessionID}/summarize`支持providerID、modelID和auto，auto缺省false。项目旧SDK声明只列providerID/modelID，但本地OpenAPI和对应源码均确认auto字段存在。
- 建议显式`auto:false`。标准成功路径创建compaction user part及summary assistant；不走auto=true的自动续跑分支，适合压缩之后先单独恢复交付文档。
- handler等待prompt loop之后返回true；模型压缩失败可以由消息error表示，因此true不等于成功压缩。
- 成功证据：新出现的compaction part、与其user messageID对应的summary assistant、完成时间/finish且无error、原生回到idle。`session.compacted`用作及时通知，不能独自充当对应请求的完成证明。
- `session.compacted`只有sessionID，没有Cooperation的cycle/requestId。压缩接口也不接受客户端指定的compaction messageID。需要记录操作前消息边界和持久化意图，再关联新增原生记录；遇其他压缩或用户输入竞争时停止自动推进。
- 原生压缩模型可由用户的compaction agent配置覆盖；应区分压缩专用模型与业务会话模型，不能因此擅自修改用户设置。
- 压缩模型使用`tools:{}`，不能指望在压缩摘要生成阶段完成写交付文档/工具回执。它们需要单独的维护控制轮次。

### 中断、后台工作与竞态

- 原生abort调用SessionRunState.cancel，除主runner外还会递归取消匹配的后台任务。
- 公共abort只按sessionID操作，没有expectedTurnId或状态revision条件。Cooperation自己的mutex只能串行化自己的调用，无法单独排除用户原生输入。
- 需要结合chat.message、message/part事件、权限/提问事件、children及工具任务状态构造运行观察，维护期间用户新输入优先让维护暂停。不能静默丢弃用户输入。
- `GET /permission`、`GET /question`可用于恢复待处理请求状态；读取后仅保留目标session的数据。
- `/experimental/session/{sessionID}/background`是POST“将阻塞子任务转为后台”，不是只读任务列表；不能拿它当探测接口。
- 尚需验证：子会话状态与插件事件能否完整覆盖运行中后台工作；插件加载/重连后的重建是否可靠；chat.message拦截发生在部分会话设置更新之后，不能直接把它当作原子运行锁。
- 若要求严格保证不可能中断用户刚开启的新轮次，需要验证足够强的原生协调机制，必要时增加上游按预期轮次条件执行的接口。不能以“调用前查过busy”冒充这项保证。

### 原生自动压缩的协调

- `experimental.session.compacting`允许加入交付文档索引或摘要上下文。
- `experimental.compaction.autocontinue`可在标准自动续跑路径设enabled=false；只应作用于当前Cooperation维护cycle。
- overflow恢复存在重放先前user消息的分支，绕开上述autocontinue hook，不能宣称一个hook就能拦住所有自动续跑。
- 原生自动压缩保持用户配置。Cooperation阈值应给交付轮次和原生压缩预留空间；维护途中遇原生提前压缩，必须识别边界并重新判定或暂停，不能把它自动归为本次手动压缩成功。

## 3. 拟实现流程

```text
每会话独立开关与阈值
  → 获取可信用量、原生实例、轮次、权限/提问及后台工作状态
  → 创建维护cycle并锁住该目标的Cooperation消息队列
  → 软阈值：等待业务空闲；强阈值：确认目标轮次后请求中断
  → 等待原业务轮次及工具执行结束
  → 发送写交付文档提示
  → 收到handoff回执 + 确认对应控制轮次结束
  → 原生summarize(auto:false)
  → 核对新压缩记录、摘要成功及idle
  → 发送读取交付文档与恢复上下文提示
  → 收到restored回执 + 确认对应控制轮次结束
  → 触发前正在工作：发送继续提示；原本空闲：保持空闲
  → 释放Cooperation消息队列
```

软阈值尚未空闲时只观察，达到可触发条件才创建维护cycle并持锁。用户原生输入不在Cooperation FIFO内，需单独检测并尊重用户介入。

每个控制操作采用独立操作ID、调用参数指纹、原生messageID及阶段ledger，提交前先保存意图。未知投递不盲重发，未知压缩不再次压缩。插件/manager重连后回读指定原生消息和有界分页历史，结合已有回执和文档哈希恢复；证据不足显示需要处理。

## 4. 用量和触发逻辑必须一起改

当前`openCodeUsage`主要服务显示，不能直接拿来驱动完整维护：

1. `historyChangedAfterMeasurement`在出现新消息或未完成assistant时为true，evaluatePolicy直接等待。因此持续工具调用中的忙碌会话可能永远无法触发硬阈值。需要区分“当前业务轮次内已确认的最近一步用量”和“新用户输入/换模型/回滚/压缩后失效的旧用量”。
2. 当前没有contextEpoch。现有同周期去重比较可能在undefined上误判，必须采用可持久重建的成功压缩边界标识，并覆盖后续业务推进。
3. 最新summary回复的用量是生成摘要时的输入，不等于压缩后的业务上下文大小。完成压缩后要使旧用量失效，恢复轮次提供新的真实统计。
4. 现有回退合计包含reasoning；上游overflow逻辑为total或input+output+cache.read+cache.write。要按该版本provider归一化语义校准，避免reasoning已含于output时重复计数；显示口径与决策口径明确一致。
5. 上游实际可用输入预算还考虑model.limit.input、输出预算及compaction.reserved。百分比可沿用完整窗口，但不能允许阈值留不出交付/压缩空间。
6. 最近100条消息适合常规展示，不足以保证重连时找到压缩和控制边界。优先指定ID回读，必要时用before/cursor分页，超过边界则报告未知。

## 5. 实施顺序与验收

1. 增加OpenCode运行观察和持久化操作ledger，确认status、轮次、模型/variant、等待权限/提问、子任务、压缩边界及用量有效性。
2. 增加原生ToolContext回执桥，复用CheckpointService的文档验证；明确控制轮次归属，避免仅凭from/token通过。
3. 打通软阈值完整交付→压缩→恢复流程，以及维护期FIFO、原生用户介入和断线重建。
4. 验证并接入强阈值中断→确认结束→同一维护流程→继续工作。针对公开接口的竞争边界，决定是否需要原生条件控制支持。
5. 调整controller/recovery中二客户端特例和大小写处理，回归Codex/Claude，最后按插件实际能力开放前端开关和阈值。

最终验收包含软/硬阈值、多工具轮次、空闲不误续跑、控制轮次回执与结束分离、原生自动压缩竞争、用户新输入/模型切换、权限等待、后台子任务、未知响应不重试、两个层级重启恢复、多目录隔离、TUI/Web状态与重开持久性。

本轮没有运行上述原生验收。后续验证应在Cooperation内独立root/原生数据目录中进行，显式fixture adapters/runtime及startMonitoring:false用于自动测试；真实模型验证另用专用隔离会话，不复用用户业务会话或此前已取消实验授权。自动维护的启用与会话创建功能的取消标记应完全分开。

## 6. 资料索引

- [OpenCode Server API](https://opencode.ai/docs/server/)
- [OpenCode 插件与压缩hooks](https://opencode.ai/docs/plugins/)
- [v1.18.30 原生HTTP处理：summarize/abort/promptAsync](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts)
- [v1.18.30 压缩：摘要、auto/replay、compacted事件](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/session/compaction.ts)
- [v1.18.30 运行状态与后台取消](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/session/run-state.ts)
- [v1.18.30 prompt：agent/model/variant与权限更新](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/session/prompt.ts)
- [v1.18.30 原生压缩阈值](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/session/overflow.ts)
- [v1.18.30 插件事件映射与异步回调](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/plugin/index.ts)
- 本地类型：`plugins/node_modules/@opencode-ai/plugin/dist/index.d.ts`、`tool.d.ts`；实际协议：`.cooperation/opencode/openapi.json`。
