# 下一阶段：主动创建与连接原生会话

**此计划已由用户取消，不再作为后续任务。进度保存与项目外清理见 [取消与收尾](SESSION-LIFECYCLE-CANCELLED.md)。**

状态：**已完成统一生命周期入口和 OpenCode 同后端创建/连接、上下文显示修复；Codex/Claude 自动创建与唤醒仍待完成。** 当前实现、验证和部署限制见 [SESSION-LIFECYCLE.md](SESSION-LIFECYCLE.md)。本文以下保留最初研究计划，标为“尚未实现”的历史描述以新文档为准。操作边界先读 [HANDOFF.md](../HANDOFF.md)。

## 1. 用户目标

用户原意：

> 一个会话能够主动发起新的会话，同样支持codex claude code和opencode。以后不用人手动发起一个新的会话并且复制id。关联的问题是项目能否主动连接某个会话，目前得要手动点开一个会话被项目所加载。

希望从已有agent会话发起协作对象，自动取得新会话的原生身份和可用地址；也希望让已有但未打开的会话进入可通信状态。用户已经要求兼顾TUI与GUI，不能把独立后台进程成功当作原有桌面界面已经接入。

本轮只写文档，之后由用户压缩再要求恢复。无需在交付过程中创建测试业务会话、启动客户端或联系其他agent。

## 2. 两个功能，分别核验

| 能力 | 期望结果 | 需要独立确认 |
| --- | --- | --- |
| 创建新的原生会话 | 在获准目录和选定客户端中创建会话，返回原生ID、Cooperation地址，来源会话可直接继续通信。 | 落库、真实独立会话身份、模型/agent/权限选择、后端归属、可发现/可发送、原生UI可见。 |
| 连接/加载已有会话 | 使用既有ID，让当前未加载或离线会话在正确原生后端可用。 | 不产生副本、目录/实例匹配、原设置是否保留、是否需要宿主运行、是否抢焦点/打断原任务。 |

相关状态不能合并成一个布尔“已连接”：

1. 管理库或原生历史中存在记录。
2. 原生宿主/SDK/IPC连接可达。
3. 会话已被某个合法原生实例加载或认领。
4. 具备消息接收能力，并核验投递。
5. 模型实际处理请求。
6. 会话在原生TUI/GUI中可见；窗口关闭后重开仍保留。

产品不必对每次操作都强制抢焦点。是否打开原生窗口、仅后台接入、自动加入某个自定义组，是待核对的产品选项；不能默认这些是同一个操作。

## 3. 当前三端基础与缺口

### Codex

**已知代码事实：**

- `src/adapters/codex.mjs`读取最新 `state_N.sqlite` 的元数据，并过滤内部worker、guardian、subagent；这只是发现，不代表在线。
- 普通消息依赖 `src/codex-bridge-connection.mjs` 恢复已授权的App Tools连接，不能伪造caller。
- `src/runtime/codex-runtime.mjs`调用 `thread-owner-discovery`；没有handledByClientId就返回unloaded，capabilities.wakeUnloaded=false。
- `src/runtime/codex-ipc.mjs`显式白名单只有initialize、owner discovery、start-turn、interrupt、compact；没有创建/加载方法。

**下一步研究：** 当前已安装版本的官方App Tools、App Server/原生接口是否支持创建与resume/load；原生深链接是否仅切换视图、是否能认领未加载会话；IPC有没有获准的加载操作。公开API创建会话不自动等于桌面App获得owner。

读取官方Codex资料时使用适用的 `openai-docs` 技能；需要研究本机接口或工具目录时限定文件范围。先检查接口能力/源码，不向业务会话试发创建或打开命令。不要猜方法名后直接发IPC，也不要为了加载会话冒充desktop owner。

### Claude Code

**已知代码事实：**

- `src/runtime/claude-runtime.mjs`只寻找已有匹配wrapper的注册记录，验证sessionId/instanceId/token；不会创建或唤醒进程。
- `src/adapters/claude.mjs`通过真实live registry与peer inbox投递；离线、多个活实例、PID复用有保护。
- `src/claude-process-wrapper.mjs`负责扩展原本启动的CLI，目录许可在 `src/wrapper-directories.mjs`，不能主动代答权限。

**下一步研究：** 已安装Claude CLI创建/恢复的受支持入口、会话ID分配时机、CLI与VS Code原生面板的归属关系、wrapper能否在本项目授权下托管一个新实例。研究创建后的进程生命周期和日志位置，避免后台CLI成为用户看不到的替代会话。

不把“CLI成功产生文本”作为VS Code会话接入验收。需要明确新实例如何进入peer registry、接收工具身份来自哪个祖先进程，以及用户打开原生面板后会否出现重复实例。不要读或启动受保护目录的Claude会话。

### OpenCode

**已知代码事实：**

- v1.18.30本机规范在 `.cooperation/opencode/openapi.json`。前一阶段隔离脚本已使用 `POST /session` 创建专用测试会话，因此原生API可创建这一事实已有证据；**产品工具/API尚未接入创建功能**。
- 正式插件 `plugins/opencode.mjs` 使用OpenCode给出的SDK client，具备同后端/目录绑定和ToolContext来源核验。
- `src/opencode-bridge.mjs`当前只提供list/find/status/send/identity，未开放create/connect。原生prompt_async可启动已存在会话的推理，但发送不是无副作用“纯连接”。
- 当前list/find主动过滤 `parentID` 非空、archived会话。Cooperation要创建可独立管理的会话时，应研究原生普通session与subagent的区别；不能简单设置parentID导致创建后被过滤。
- TUI与浏览器GUI已做通信可见性验收；桌面应用壳仍未实测。配置只在后端启动时加载；不能通过创建独立serve来声称原工作会话已接入。

**下一步研究：** 在插件所处后端调用受支持的session.create，确认新会话的目录/model/agent/permission和默认自动压缩行为；返回ID到源会话；会话列表刷新、状态进入可发送及TUI/GUI定位如何实现。连接现有会话时先查目标归属，API可访问、开始推理、打开前端页面应分别表示。

## 4. 推荐恢复后的顺序

1. **只读恢复。** 使用HANDOFF最新快照作为比较点，查Git、manager实例、OpenCode注册；保持现有UI和未提交改动，不重跑历史原生验收。
2. **建立能力表。** 三端分别列create、load/resume、send-ready、原生TUI/GUI可见、重开持久性，以及需要宿主运行的条件。每一格标注已有证据、待核对或不可用。
3. **先定义语义。** 明确新会话属于独立原生会话，来源关系由Cooperation保存；模型/目录/权限等默认值须来自明确规则或原生设置，不能偷偷扩大授权。
4. **逐端实现。** OpenCode已有同后端create的测试基础，可作为优先落地对象；Codex、Claude依据能力核对推进。排序是建议，不是用户指定三端优先级。
5. **统一入口。** 为service增加独立生命周期编排，MCP/原生插件提供对应能力；同时接入管理页。接口名可以考虑create_session、connect_session，最终以项目设计为准。
6. **隔离回归。** 先fake adapter覆盖状态机、权限、并发、幂等与未知结果；再在本项目专用会话做必要原生测试，保留原业务客户端。
7. **端到端证据。** 原会话发起→返回真实新ID→manager发现→双方能通信→原生界面与重开核对。连接已有会话还需证明ID不变、没有副本。

## 5. 建议的工程边界（尚未实现）

### 来源与授权

- 复用现有Codex/Claude原生身份检测、OpenCode ToolContext桥，不接受任意 `from`。
- 用户想减少“手工新建/复制ID”的摩擦，能力可由agent在获准任务内使用；权限规则应明确限定目标客户端、目录、数量/并发或生命周期范围，避免无限递归创建。具体规则待设计，不硬编码未经确认的产品限制。
- 在注册连接之前确认目标cwd，目录许可与递归展示是不同概念。当前OpenCode正式插件只允许Cooperation目录。
- 新会话初始维护策略建议保持默认关闭；能创建和通信不自动证明可压缩、可强停、可恢复。
- 任务来源是协作委派，不自动拥有比发起会话/用户授权更高的权限；不通过启用其他工具或宽权限绕过原生确认。

### 持久化与幂等

- 创建具有外部副作用，先保存操作意图、requestId/idempotencyKey、真实源会话、目标client/cwd，再调用原生接口。
- 保存返回的原生ID、实例、Cooperation地址与创建结果。响应丢失可能已创建，必须记录unknown并核对；不得用新ID盲重试导致重复会话。
- 同一幂等键必须绑定相同参数；并发请求串行化或排他持久化。管理服务重启仍能识别未确认创建。
- 来源/新会话关系与分组关系分别记录。删除组不删除原生会话；失败或取消也不擅自清除已创建且可能已有工作的会话。
- 重连应核验原生ID/cwd/实例，不能仅依赖PID或旧端口；无法确认归属时返回可审查状态。

### 与现有系统整合

- 创建/加载不是普通消息，不直接复用message outbox伪装成一条发送；创建完成后的初始任务投递再进入既有消息FIFO，并保留独立结果。
- 明确处理维护中的来源/目标会话、原生权限待答、断连、多实例、目标归档等状态。
- 可通信、活动观察、维护控制与UI显示的capabilities分别报告；一端不支持时明确返回unsupported。
- 管理页沿用用户认可的抽屉和右侧设置，可在项目操作区加入新建/连接入口；若支持创建后加入当前自定义组，仍按组revision保存，防覆盖另一窗口修改。
- “连接”如果需要启动原生进程，必须保存本项目创建的所有权记录，关闭时只处理自身拥有的实例，不按历史PID全机杀进程。

## 6. 针对性验收清单

| 场景 | 成功证据 |
| --- | --- |
| 已有会话发起创建 | 真实来源已核验，返回原生ID/地址；新会话落在预期目录/后端，设置符合明确规则。 |
| 自动通信 | 发起方无需人工复制ID；新会话可收到一次初始任务并回信，模型处理有独立证据。 |
| 连接未加载会话 | 仍是原ID，原历史/设置保持，获得合法owner/连接，未创建副本。 |
| 已连接/工作中再连接 | 幂等返回或明确状态，不打断、重启或改变正在运行的任务。 |
| 超时/断线 | unknown可追踪；对创建和投递均不盲重试。 |
| 竞争与重启 | 并发创建、参数冲突、跨窗口分组更新、manager重启均有持久一致性。 |
| 原生界面 | 分别说明Codex App、Claude VS Code、OpenCode TUI/Web/桌面壳哪些已验收，不能互相替代。 |
| 越界与假身份 | 未授权目录/伪造来源/错误后端在外部动作前拒绝；不访问受保护目录做测试。 |

## 7. 快速索引

| 要解决的问题 | 文件 |
| --- | --- |
| 如何给agent加工具 | `src/mcp.mjs`、`bin/coop.mjs`、`src/client.mjs`、`plugins/opencode.mjs` |
| 如何确认真实来源 | `src/identity.mjs`、`src/opencode-bridge.mjs` 的sendMessage/identity、`src/http-server.mjs` 的/api/opencode/send |
| 服务统一分派 | `src/service.mjs`、`src/runtime/factory.mjs` |
| 为什么Codex必须手动点开 | `src/runtime/codex-runtime.mjs` 的refresh/owner-discovery；`src/runtime/codex-ipc.mjs` 的versions |
| 为什么Claude必须有进程 | `src/runtime/claude-runtime.mjs` 的connect；`src/adapters/claude.mjs` 的liveRecords/sendClaudeMessage |
| OpenCode原生create参考 | `.cooperation/opencode/openapi.json` 的/session POST；`.cooperation/opencode/integration-validation.mjs` 的专用session创建与权限设置 |
| 发现过滤规则 | `src/adapters/codex.mjs` 的isUserSession；`src/opencode-bridge.mjs` 的find/list；`src/adapters/claude.mjs` |
| 事务与不确定结果 | `src/management-store.mjs`、`src/session-mailbox.mjs`；OpenCode投递账本逻辑 |
| 新会话加入分组 | `src/project-groups.mjs`、`public/ui-state.mjs`、`public/app.js`、`test/project-groups.test.mjs` |
| 现有协议与验收边界 | `docs/OPENCODE.md`、`docs/VALIDATION.md`、`CLAUDE-WRAPPER.md`；以HANDOFF当前结论消除历史矛盾 |

后续研究可从官方OpenCode server/plugins/SDK、Claude Code CLI与VS Code扩展公开资料、Codex官方App Server/SDK/App Tools资料入手。以实际安装版本为准；本文未新增网络研究或宣称某个尚未验证的创建/加载API可用。
