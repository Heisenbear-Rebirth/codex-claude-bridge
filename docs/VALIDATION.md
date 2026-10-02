# Validation and supported scope

## 2026-10-02 项目重启接续确认

完整测试 **290 项通过**，浏览器 **8 组通过 / 0 页面错误**。实际 wrapper + 隔离管理服务验证两种启动顺序的额度接续和五个维护阶段；确认前无新阶段提交，确认后仍保留回执、未知压缩和未知发送保护。三端队列验证先确认再连接、暂缓、重复重启和旧连接快照不得放行。覆盖服务关闭前、关闭期间和原任务重连后发生额度中断。OpenCode 原生协议验证当前 429 阻止压缩与直接投递，确认不能绕过限流，原会话新轮次恢复后按序投递。

前端验证：三端离线会话、默认焦点“稍后处理”、Esc 和刷新、部分确认、跨标签页、已有页面随服务重启重新确认、过期 boot / CSRF 拒绝及移动端布局。修复了旧轮询结果晚到导致重新显示已处理事项的竞争情况。

证据：`.cooperation/verification/restart-confirmation-full-tests.txt`、`restart-confirmation-browser.json`、`restart-confirmation-deployment.json`。全部隔离进程、数据和浏览器缓存位于项目内；没有重启真实业务客户端或向其注入验证消息。未实测实体电脑断电或真实账户耗尽后的数小时等待。

## Shutdown and startup-order recovery (2026-10-02)

The default full suite passes **275 tests**, with no failures, skips or cancellations. Eleven new regressions first reproduced cancelled quota recovery after native instance changes and stalled maintenance after a manager-only restart. Fixes bind verified failures to new observations, retain uncertain-send holds, persist Claude quota metadata independently of the manager, and repeatedly reconcile the original phase after reconnect.

Isolated tests terminate the actual Windows wrapper executable, reopen its deterministic native child, and restart the management service in both orders. They preserve checkpoint gates and FIFO through writing handoff, awaiting handoff completion, completed compaction, restoring, and awaiting restore completion. A crash after a compact boundary but before its result holds the queue without repeating compaction. Quota failures observed while the manager is absent also survive restart. Actual Codex IPC adapter tests reconnect to a changed deterministic owner and submit one continuation with inherited settings. Same-process manager restarts, settings changes, manual stop, missing history, concurrent input and uncertain dispatch remain covered.

Four browser checks pass with zero page errors: offline waiting, history verification without a live quota marker, changing reasons without an activity change, and mobile layout. No real business client was restarted or messaged, no account quota was exhausted, and no physical power-loss test was performed. Running Claude wrappers load persistence at their next normal restart; missing pre-upgrade evidence requires confirmation.

Evidence: `.cooperation/verification/restart-recovery-full-tests.txt`, `restart-recovery-browser.json`, and `restart-recovery-deployment.json` when deployed. Intermediate logs retain a removed wrapper SQLite-warning dependency and random fixture-port conflicts; HTTP fixtures now use the existing retrying allocator. See [restart behavior](RESTART-RECOVERY.md).

## UI continuity and status-first layout (2026-10-02)

The full regression suite passes **239 tests**, with no failures, skips or cancellations. The published frontend also passes eight browser verification groups with zero page errors.

The Apple-design review reproduced discarded prompt drafts, lost keyboard focus on polling, cleared message-text selections, and quota explanations below the first viewport. The revised interface retains page-local drafts and caret positions, supports undo for reset/discard actions, handles save completion after dialog closure, and reconciles refreshed DOM nodes by stable identity. Current status and required actions now precede context statistics and collapsible thresholds.

An isolated browser exercised the published assets against a real isolated HTTP management service. It verified background status updates and unrelated session discovery during editing, message updates and new arrivals during text selection, Escape/reopen, reset/discard undo, invalid drafts, failed saves, closing during an in-flight save, 44px mobile controls, focus trapping/restoration, rapid drawer reversal, reduced motion, and an actual maintenance action through the test service. Page errors were zero. All browser profiles, caches, temporary files and fixtures stayed inside this repository; copy operations used a page-local clipboard substitute. Mobile verification used a 390px Chrome viewport rather than physical phone hardware.

Evidence: `.cooperation/verification/apple-design-audit.json`, `apple-design-polish-browser.json`, `apple-design-ui-full-tests.txt` and `apple-design-ui-deployment.json`. A full-suite run encountered an unrelated fixed test-port collision; that log is retained as `apple-design-ui-port-collision.txt`, and the affected fixture now uses the existing retrying automatic-port allocator. Publication changes only static frontend assets and preserves saved policies and prompt settings without restarting the service or native clients.

## Quota recovery with folded inputs and mixed native histories (2026-10-02)

The full default test suite passes **239 tests**, with no failures, skips or cancellations. Eight new regressions failed against the preceding implementation before the quota-state fixes. Claude now consumes native command lifecycle evidence instead of promoting local queued inputs into a fictional running turn. Codex orders mixed turn representations using a shared head or native timestamps; an ambiguous head retains quota evidence and blocks native controls until synchronization. Quota polling can proceed while the continuation boundary remains unavailable.

The executable Claude wrapper and isolated management service verified two inputs folded into the same turn, quota failure, read-only quota querying while busy, and one configured continuation in the original process without replaying the folded inputs. The real Codex IPC adapter and deterministic native endpoint verified ambiguous quota detection, polling, synchronization, and exactly one continuation with inherited settings. The browser verified enabled/disabled policy feedback, dated reset information, historical maintenance labeling, client upgrade guidance and the 390px layout, with no page errors.

A reload regression also verifies that a confirmed paused maintenance failure retains its original cause, checkpoint and queued messages. Intermediate full-suite runs exposed Fetch-blocked Windows ephemeral ports and a fixture initialization timeout; their logs were retained. Automatic HTTP allocation for the wrapper and management server now shares the existing OpenCode approach of selecting loopback ports in 20000–65535 with bind retries, without changing system configuration. The final default concurrent suite passed after these changes. Native business sessions were not sent test messages or restarted, and a real account exhaustion/reset cycle was not forced.

Evidence: `.cooperation/verification/quota-state-before.txt`, `quota-state-restart-before.txt`, `quota-state-full-tests.txt`, `quota-state-browser.json`, and the retained `quota-state-intermediate-*.txt` files.

## Reverse peer delivery into quota-limited Codex (2026-10-01)

The full suite passes **225 tests**. Production Codex message delivery now checks the current native state before invoking the App message bridge, so a stale idle snapshot cannot bypass an already observed native quota error. An explicitly unsent delivery remains queued through the same durable deferral path used by Claude.

The reverse-direction regression failed before this guard and passes with it. The isolated test connects the actual Codex IPC adapter to a deterministic native-protocol endpoint and verifies first-message quota detection, two queued followers, no compaction at high context use, one configured native continuation with inherited thread settings, and exactly-once FIFO delivery. It does not exhaust an actual Codex account. Evidence: `.cooperation/verification/codex-peer-quota-before.txt`, `codex-peer-quota-protocol.txt` and `codex-peer-quota-full-tests.txt`.

## Peer delivery into a quota-limited Claude session (2026-10-01)

The full suite passes **224 tests**. Current Cooperation peer-message IDs are registered before native delivery, allowing a peer-triggered quota failure to be associated with the receiving turn even when no IDE input preceded it. Historical peer replay cannot start an observed turn. A final native quota check defers unsent messages back to the durable queue if the monitoring snapshot was stale.

An isolated real wrapper and management service, using a deterministic protocol child in place of the model process, verified a Codex-origin first message triggering Claude's five-hour rejection, two subsequent messages remaining queued, one custom quota-continuation prompt after positive quota availability, and exactly-once FIFO delivery of the waiting messages. The receiving process stayed unchanged. This did not consume or force an actual account quota. Evidence: `.cooperation/verification/peer-quota-native.txt` and `peer-quota-full-tests.txt`.

## Everyday connection guidance and receipt recovery (2026-10-01)

The full suite passes **221 tests**. The regression suite reproduces synthetic Claude messages being treated as a model change, and a ten-minute handoff timeout rejecting receipts while the original control turn remains active. It also verifies safe late-receipt acceptance for Claude and Codex, metadata-only update races, retained user-intervention guards, and rotating credentials on explicit retries.

The real wrapper executable, isolated management HTTP server and deterministic protocol child completed handoff, one compaction, restore and two accepted receipts in the same process. This is a protocol-level acceptance check, not a fault injection into a user's production model session. An isolated browser verified the state-specific command-free connection flow, three-stage maintenance feedback, disclosure controls, diagnostics, cancellation confirmation and desktop/mobile layout. See [implementation and evidence](USER-EXPERIENCE.md).

## Quota interruption and continuation (2026-10-01)

The complete automated suite passes **207 tests**, with no failures, skips or cancellations.

Quota failure is now distinct from idle activity for Codex and Claude. Policy and native control guards block compaction, while a durable continuation record holds queued messages. The manager reads quota without model probes and submits a single continuation only after positive availability and unchanged native identity/settings. Unknown delivery is not retried. Further quota failures back off; disabling automatic management cancels future continuation.

Tests cover both client recovery paths, expired reset timestamps, weekly/model limits, native user/settings races, restart deduplication, unknown delivery, FIFO holds, and failures during maintenance. The executable Claude wrapper test uses a deterministic protocol child to verify `get_usage` with behavior scanning disabled and same-process continuation. An old wrapper cannot perform automatic maintenance until normally reopened with quota support.

The actual Codex App usage endpoint returned public quota windows successfully. An isolated Chrome verified waiting-state display and the new configurable quota prompt on desktop and mobile, with no page errors. No production business session was sent a test prompt, and no real account was exhausted to simulate the five-hour cycle. Real exhaustion-to-restoration acceptance remains unverified. See [quota behavior and evidence](QUOTA-RECOVERY.md).

## Custom message and maintenance prompts (2026-09-30)

The complete suite passes **189 tests**. Project-local prompt settings are revisioned and atomically saved through a CSRF-protected UI endpoint. Tests verify bounded templates, mandatory runtime checkpoint insertion, restart persistence, stale-write rejection, queued-message affix snapshots, per-stage maintenance customization, OpenCode dynamic affixes and duplicate-delivery handling, and Claude presentation-only labels.

An isolated Chrome session verified all six editor categories, actual save/reload, example-only previews, empty affixes, per-category and full default restoration, stale-save drafts, keyboard closing, desktop and 390px mobile layouts, and zero page errors. It posted only to fixture discovery and prompt-settings endpoints. Browser profile, caches and temporary files stayed in the project.

A real isolated OpenCode 1.18.30 backend with a local deterministic model completed soft/hard cycles using customized handoff, restore and continuation templates, plus ordinary peer prefixes/suffixes. Both cycles retained one compaction, two accepted native checkpoints and the nondefault variant. No production business session was prompted for this feature. The production manager was gracefully reloaded at its existing URL when no active maintenance or queued deliveries required it. Native clients were left running; cached native plugin/wrapper code takes this feature on its next normal restart. See [usage and evidence](PROMPT-SETTINGS.md).

## OpenCode maintenance repair (2026-09-30)

The complete suite passes **184 tests**, with zero failures, skips or cancellations. The repair prevents the OpenCode MCP catalog from shadowing native plugin tools, binds explicit restore retries to the verified current input, and preserves the saved model/agent/variant on ordinary peer delivery. Regression coverage includes newer-input rejection and keeping FIFO locked until a valid restored receipt.

The user-designated OpenCode **1.18.33** session completed soft and hard maintenance with the configured external model. Native records confirm one compaction and two accepted checkpoints per cycle, identical handoff/restored document hashes, FIFO A/B delivery and individual replies, and exactly one continuation following the hard cycle's confirmed abort. The soft run required recovery after the original MCP collision and an empty native restore response; its summary was also empty. Those anomalies remain recorded. The hard run produced a nonempty summary and completed automatically. No missing receipt was synthesized and neither cycle repeated compaction.

After plugin reload and a native user turn persisted `max`, two further real peer messages retained the model, agent, variant and permissions. The OpenCode native send tool returned a callback to the initiating Codex chat; the callback was actually received and matched its `opencode-tool-context` audit identity. Final target state: idle, no active cycle, FIFO empty, `max` retained, and automatic maintenance restored to its original off state with 50/80 thresholds. Evidence: `final-live.json`.

An isolated real **1.18.30** backend with a deterministic model also passed soft/hard cycles while the native plugin and a same-named Cooperation MCP were both enabled. Two subsequent peer deliveries retained a nondefault variant. Reports and test log: `.cooperation/verification/opencode-repair-20260930/`. The manager was gracefully reloaded at the same local URL after other active maintenance finished; the user reloaded OpenCode. Existing UI work and unrelated local changes were preserved. See [the repair details](OPENCODE-MAINTENANCE.md).

## Publication checks

The release passes **168 automated tests**. Personal paths and native session identifiers in documentation use generic examples. Local OpenCode configuration, runtime evidence, credentials, dependencies and build outputs are excluded from version control. The tracked `session-lifecycle-cancelled.json` preserves the discontinued lifecycle state in fresh checkouts; regression coverage verifies that no private runtime marker is needed.

## OpenCode automatic maintenance (2026-09-18, current)

The complete suite passes **167 tests**, zero failures. OpenCode now supports per-session soft/hard maintenance policies, native handoff/restored checkpoints bound to ToolContext and the controlling user-message ID, durable control intents, manual native compaction evidence, conditional continuation and FIFO release. New tests cover late/lost responses, forged/wrong-turn receipts, summary errors despite HTTP success, manager/plugin replacement, persisted epochs after history-window truncation, user-input revision conflicts, native settings, permissions and child-session guards. Existing Codex/Claude regressions pass.

An isolated **real OpenCode 1.18.30 backend with a local deterministic model endpoint** completed both soft-idle and hard-running flows. Native write/read tools handled the document; each flow had exactly two completed native checkpoint tool calls and one compaction. Soft maintenance stayed idle; hard maintenance aborted the active generation and continued once. This validates the native protocol, not the reliability of arbitrary external models. Final evidence: `.cooperation/opencode-maintenance-native-result.json`, run root `.cooperation/opencode-maintenance-native-6XPQVE/`.

Isolated Chrome verified capability-gated enablement, threshold autosave, reload persistence, disabling an enabled policy after capability loss, desktop/mobile layout and zero page errors. Evidence: `.cooperation/opencode-maintenance-ui-result.json`, screenshots `.cooperation/opencode-maintenance-ui-Djlxc3/`. Syntax and diff whitespace checks pass.

Native child sessions (including historical children), unresolved permission/question requests and reverted sessions currently block automatic control. Ordinary chat-input coordination is tested; public OpenCode abort has no atomic expected-turn condition, and direct native control paths remain outside a global lock guarantee. New maintenance-specific TUI/desktop-shell rendering and real-provider behavior were not revalidated. Production manager and user native backends were not restarted or upgraded. See [implementation and usage](OPENCODE-MAINTENANCE.md). Earlier test counts and disabled-maintenance descriptions below are historical.

## Lifecycle direction cancelled and external cleanup completed (2026-09-18, current)

The user cancelled proactive native session creation/loading. A 90-file project snapshot and hash manifest preserve the work. The project-local cancellation marker disables lifecycle management capabilities, MCP/OpenCode lifecycle tools, the experimental VS Code bridge and native experiment launch scripts; existing messaging, maintenance receipts and the OpenCode context-display fix remain.

Eighteen attributable external files were backed up, hash-verified and removed: one Claude test transcript, fifteen dedicated VS Code window logs, and two newly created `ext-dev` workspace database files. The original development-host process and its inspector listener no longer exist. Shared VS Code state/cache was not overwritten without a pre-experiment snapshot; no experiment identifiers were found in shared global state. This is not a claim of byte-for-byte rollback of every native runtime artifact.

Eleven isolated regressions for cancellation, messaging, directory guards and context accounting passed. The final check verified all 90 snapshot hashes and 18 backup hashes, no remaining deletion targets, and only `send_message` / `context_checkpoint` in the actual MCP catalog. Syntax checks and `git diff --check` passed. See [cancellation and cleanup record](SESSION-LIFECYCLE-CANCELLED.md). The earlier lifecycle results below are archived progress, not an active development direction or a deployed feature.

## Native lifecycle and OpenCode context display (2026-09-18, latest)

The full suite passes **145 tests**, with zero failures, skips or cancellations. New coverage includes latest-response OpenCode token accounting, actual-model capacity, stale measurements, monitor persistence, authenticated lifecycle tools, CSRF and exact-directory guards, maintenance guards, durable idempotency, conflicting parameters, manager/plugin restart reconciliation, and unknown creation without evidence remaining unknown.

The final identity-case and lifecycle-shutdown guards were followed by **22 passing focused regressions**. The authenticated production status still showed its original PID and start time; exact-project OpenCode discovery returned one session without warnings. All 50 local links in the three handoff/lifecycle documents resolved, and `git diff --check` passed.

An isolated OpenCode **1.18.30** backend created an independent native session with no parentID, returned its address, preserved the operation marker and permission rules, and connected the same ID. Repeated requests did not create duplicates. Restarting only the owned test backend preserved and reconciled that ID. A dedicated prior integration-test session reported **3,962 / 1,000,000 tokens (0.4%)** through the new monitor path. No model was invoked in this lifecycle validation. Evidence: `.cooperation/opencode/lifecycle-validation-result.json`.

Isolated Chrome verified the context number, token counts, model and stale-reading indicator; disabled unsupported creation choices; persistence of an unknown operation across page reload; read-only reconciliation without another create; pre-submission validation allowing correction; and connecting the unchanged native ID. There were no page errors, and the existing cream background was preserved. Evidence: `.cooperation/lifecycle-ui-result.json`, screenshots `.cooperation/lifecycle-ui-PDOn30/`.

Codex/Claude automatic creation and waking unloaded sessions remain unavailable. Their common connect endpoint checks an existing native owner/wrapper without launching or interrupting it. New tool-driven model delegation and new-session TUI/GUI visibility were not exercised. The production manager and current OpenCode plugin were not restarted or hot-updated; deployment remains pending the documented protected-project boundaries. See [lifecycle semantics and next steps](SESSION-LIFECYCLE.md).

## Project drawer and custom workspaces (2026-09-18)

The management UI now uses a compact project sidebar and a selected-project/session workspace. Native clients appear as muted labels on session rows. Selecting a session opens its settings; selecting a project opens its members and aggregate communication scope. Native controls retain their existing endpoints, with accessible switches replacing checkboxes. Phone-sized screens use an overlay navigation drawer and separate message list/detail views.

Named custom projects persist in the management database's `custom-projects-v1` setting. Users select sessions across configured directories, retain offline/missing members, rename groups, and edit membership. A session can belong to multiple groups while keeping one native policy. Mutations require CSRF and expected revision; selected identities resolve from server discovery or that group's existing member snapshots. Deleting a group preserves policies, messages and native sessions. No group operation sends messages or starts maintenance.

All **136 automated tests pass**, with zero failures, skips or cancellations. Four new tests cover database reopen, overlapping cross-directory membership, missing members, exact OpenCode ID case, stale writes/deletes, invalid inputs, HTTP CSRF and communication scope.

The final isolated Chrome run passed 12 interaction checks: flat navigation without checkboxes; session switches and threshold autosave; keyboard member selection preserving order/focus; cross-directory groups; exact communication scope; live message refresh preserving scroll; reload/mode persistence; rename/member edits; connected-only persistence; missing-member behavior; tablet/mobile layout and navigation; group deletion and directory settings. At 1440×960 the sidebar is 292 pixels wide and the workspace occupies the remaining 1148 pixels. The 1024×768 and 390×844 viewports have no document horizontal overflow. No page JavaScript errors occurred. An async button event-lifetime issue found in the first run was fixed and rechecked.

All browser data, profiles, caches and fixture services were project-local. Monitoring was disabled and adapters/runtime were fixtures; no production manager or native business session was started. Report: `.cooperation/workspace-ui-browser-result.json`; final screenshots: `.cooperation/workspace-ui-browser-cbcgU2/`. Pre-change backups, including existing uncommitted OpenCode work, are in `.cooperation/backups/workspace-ui-20260918/`.

## OpenCode communication integration (2026-09-18)

The full suite passes **132 tests**, with no failures, skips or cancellations. Eight new tests cover OpenCode native sender identity, case-sensitive addresses, directory and instance matching, busy transport, durable native IDs across uncertain sends and plugin restart, GUI tree scope, and withholding unsupported maintenance. Source-audit metadata and a concurrent duplicate-submission assertion added afterwards pass all **13 focused regressions**.

Native validation used OpenCode 1.18.30 and official DeepSeek `deepseek-v4-pro`, entirely in project-local data and an isolated manager with monitoring disabled. A 25-second native tool finished normally after a second message was submitted during confirmed busy state. Both markers were acknowledged and the new native message was unique. The formal plugin then completed bidirectional messages between two dedicated sessions, with matching Cooperation/native message IDs.

The **browser GUI** sent a message through its native input and plugin tool; the receiving page displayed the message and response live. Reloading and fully reopening the browser retained the same message without adding native records. The **full TUI** attached through an isolated native PTY to that same backend, displayed existing and live messages, and retained them after closing and reattaching. Restarting the owned test backend preserved the original two mapped native messages. GUI screenshots and terminal output remain in the ignored project-local evidence directory.

The desktop GUI uses the same backend and shared AppInterface; the plugin binds the SDK client supplied by its selected backend, including sidecar authentication. **The desktop application shell, server switching and window reopen have not been exercised.** Its startup includes OS protocol registration, outside this development session's project-only boundary. OpenCode context measurement was added in the latest lifecycle work above; compaction and automatic maintenance remain disabled. See [OpenCode setup and evidence](OPENCODE.md).

Validated on Windows with Node.js 25.2.1, Codex Desktop 26.901.6511.0 / Core 0.153.4, and Claude Code VS Code 2.1.237. These native interfaces may need adaptation after client updates.

## Automated checks

On a fresh Windows clone, build the local launcher before running tests:

```powershell
./scripts/build-claude-wrapper.ps1
node --test test/*.test.mjs
```

The build uses the existing .NET Framework C# compiler. It creates the executable and machine-specific Node/script path file inside the project. Neither generated file is committed. No global installation or configuration change is performed by the build.

61 automated tests passed at the initial delivery. Coverage includes native protocol mocks, Unicode framing, original permission-response forwarding, targeted interruption, context accounting, transactional migration, per-session policy isolation, checkpoint validation, durable locks, FIFO release, restart reconciliation, unknown-delivery handling, and HTTP boundaries. Test files and temporary directories stay inside the checkout.

## Native acceptance

Dedicated existing sessions completed both soft-idle and hard-running maintenance workflows for Codex and Claude: structured handoff acknowledgement, native turn end, native compaction, restore acknowledgement, conditional continuation, and ordered delivery of queued messages.

Each completed workflow had exactly one native compaction. Both acknowledgements and their corresponding native turn ends preceded the next stage. Claude retained the original session and process. Codex retained the original task ID; one hard-trigger test included an owner-instance change during recovery.

The management page was exercised in a real browser for multiple-directory filtering, live status reads, independent threshold changes and persistence after reload. Legacy message migration was verified against a copy before switching to SQLite.

Raw native transcripts, session IDs, local connection files, credentials, machine-specific handoffs and evidence are intentionally excluded from this repository. The automated tests use fixtures and do not invoke the developer's native test sessions.

## Boundaries

- Cooperation queues messages sent through its own entry points. Direct native UI input and third-party direct connections can bypass that queue.
- Native goal, subagent and background-task pause/resume behavior is not fully validated; automatic maintenance is withheld when relevant activity is observed.
- An unloaded Codex task must be opened in the native app before the independent maintenance channel can control it.
- Ordinary messages sent to Codex still use an authorized App Tools bridge environment. Native maintenance control uses an independent local IPC client.
- Native permission checks remain in force. Claude may require a narrowly scoped project-level permission for the checkpoint CLI.
- Ambiguous external outcomes are not automatically retried. Unknown delivery blocks subsequent messages for that recipient until reconciled.

## Dashboard follow-up (2026-09-08)

The current dashboard groups sessions by directory and client, scopes messages to expanded sessions, observes context while automatic compression is off, and saves threshold edits automatically. Startup and shutdown launchers run the project manager without closing native clients.

All 70 automated checks passed. New coverage includes message scope, serialized saves and stale-write rejection, observation without an enabled policy, repeated discovery without nested snapshots, and shutdown waiting for in-flight observation. The live service returned a 9,325-byte monitoring response with no nested snapshots, all automatic policies off, no active cycles and no queued messages.

The initial redesign could not be checked through the available browser connection tool. The later isolated browser verification below covers the current connection guidance and layout; native maintenance acceptance remains a separate record.

## Late Claude compaction completion (2026-09-08)

The manager now continues checking the same Claude compaction request after the wrapper HTTP wait expires, within the maintenance deadline. Restoration requires matching completion evidence and the matching last native turn. Regression tests cover late success, a different request, and intervening native input. The full suite passes 76 tests.


## Automatic Codex connection recovery (2026-09-09)

A project-local private record preserves an already-authorized Codex bridge connection. The manager validates it on startup and before sending, and checks for updated connections in the background. Codex MCP initialization and Codex CLI requests refresh the record; no unrelated conversation identity is discovered or fabricated. The dashboard displays bridge readiness separately from HTTP service availability.

All 83 automated tests passed. A live startup test removed all three Codex connection environment variables and launched the normal Windows startup script: the manager recovered the saved connection and the native message tool was available. The test performed handshake/catalog reads only and sent no message. App restart/connection rotation is covered by simulated MCP registration and reconnect tests; no running native client was restarted for validation.


## Per-directory connection guidance (2026-09-09)

Each directory now shows Claude and Codex connection badges with manual setup guidance. The UI distinguishes directory permission from a live connection, treats stale observations as unconfirmed, and distinguishes Codex message-bridge connectivity from individual loaded tasks. Help provides copyable configuration and a read-only recheck action.

The full suite passes 87 tests. An isolated headless Chrome profile and fixture-only management server verified disconnected and connected directory badges, Claude help, Codex task and bridge guidance, the global connection button, recheck, close and Escape. At 1440 x 900, the document stayed within the viewport and message feed/detail remained side by side. There were no page JavaScript errors; observed POST requests were session-list reads only. No live conversation, user browser profile or real project configuration was changed by browser testing.


## Claude peer-message visibility trial (2026-09-09)

The wrapper now projects only replayed, top-level peer messages whose target session and Cooperation envelope UUID match. It labels the IDE copy and clears its synthetic-display flag; the native input, peer provenance, UUID and original protocol observer remain unchanged. Unmatched traffic stays byte-for-byte intact. Startup switches can disable projection through `COOP_PEER_MESSAGE_VISIBILITY=0` or `peerMessageVisibility: false` in the project wrapper configuration.

Seven new regressions cover source and identity guards, Unicode and partial framing, malformed and oversized passthrough, and busy child-process integration with projection on and both switches off. The isolated fixture proves the original active turn, child PID, permission state and input sequence remain unchanged, and the original work finishes normally. Together with existing wrapper/context tests, 22 checks passed; the full suite passed all 94 tests. No live Claude process was sent a message or restarted. Native VS Code rendering, replay availability and history after reload remain unverified; isolated protocol success is not native acceptance.

The scoped pre-change backup and hash-guarded rollback helper are under `.cooperation/backups/peer-visibility-20260909`. They preserve all changes that existed before this trial. Existing wrapper processes retain their old code until they exit naturally and the panel is reopened.


### Dedicated native follow-up (2026-09-09)

The user reopened only the existing `coop-claude-test` in this project and authorized testing. New wrapper capability `peerMessageVisibility` was confirmed; automatic maintenance was disabled and the mailbox was empty. The first wait-based attempt sent no peer: Claude used PowerShell/background execution, while the observer expected Bash. It is not counted as a visibility success.

The subsequent read-only review test sent one peer message while the original native turn was running. The native queue recorded enqueue at 07:32:37.258Z, then one user record with the same message UUID at 07:32:57.678Z after the original review completed. Claude acknowledged the marker at 07:33:01.755Z. The process and wrapper instance stayed the same and ended idle; no interrupt was sent. The user explicitly confirmed seeing the bubble with the Cooperation title. Desktop automation initialization failed, so visual confirmation is user-observed, not an automated screenshot assertion. Immediate display at enqueue and history after reload remain unverified. Evidence: `.cooperation/peer-visible-native-6f23de86.json`.


## Unified visible delivery and history restoration (2026-09-12)

Before changing delivery, both idle and busy submissions were retested on the dedicated `coop-claude-test`. Each produced exactly one native peer record and an acknowledgment; the busy review completed without interrupt, in the same process. The user reported both initially visible, but the latter disappearing after reopening. Evidence: `.cooperation/visible-unified-before-5f7d3c48.json`. This exposed the extension history loader's isMeta filter; it was not treated as a successful reload test.

All normal service sends now use ClaudeRuntime.sendMessage, which dispatches peer traffic without interrupt, while sendControl delegates maintenance through the same entry with its original idle/expected-state guard. Unsupported visibility is reported separately from transmission outcome. History recovery reads only the matching session transcript and follows current-branch ancestry; original files and model input remain untouched. It restores at most 200 confirmed Cooperation peers, reports truncation and read failures, and defers output to complete protocol lines.

The full automated suite passes 104 tests. New coverage includes two successive isolated wrapper launches restoring the same history with only initialize controls reaching the simulated child; byte-identical original transcript; unknown and stale branch exclusion; live/history UUID deduplication; idle and busy unified peer routing; legacy visibility disclosure; and delayed native completion after interrupt acknowledgment, during which no handoff prompt may be sent. Read-only extraction from the real dedicated transcript recovered both missing test IDs. Native panel reload of this implementation is pending user confirmation; these checks are not a substitute for it.

Rollback to the earlier, live-visible implementation: `.cooperation/backups/unified-visible-20260910/rollback.mjs`. This is a second layer above `.cooperation/backups/peer-visibility-20260909`; apply the newer rollback before the older one when reverting the entire feature. Neither helper restarts running processes.


## Restart-aware maintenance recovery (2026-09-12)

The controller now preserves its lock in waiting_client while a client is offline, unloaded or initializing; offline time does not consume the stage deadline. It polls reconnection and selected legacy attention reasons, but only a changed native instance permits automatic replay of an unfinished control prompt. Same-instance transient disconnects resume their existing state without replay. Manual intervention and evidence-based recovery refusal are preserved across manager restarts.

New-instance adoption requires the same session ID and working directory, idle native state, no observed queued inputs/background work/pending requests, no detected change in available model/effort/permission selections, matching document hash when a receipt exists, and corresponding native input/turn identity. A second native status and cycle revision check prevents overwriting concurrent user input or a late checkpoint. Missing values remain unknown; no account credentials are read. Claude continuity reads only the selected JSONL; completed compaction additionally joins the original wrapper instance/request audit with a native manual compact boundary. Codex uses its latest terminal native turn and compact completion timestamp. Unknown compactions never repeat automatically.

121 automated tests pass. Added regressions cover both clients, offline deadline pause, late receipts, accepted handoff and restore transitions, FIFO/conditional continuation, concurrent checkpoint acceptance, changed documents and models, malformed or changing history, request/instance mismatch, and refusing unknown compaction. These are isolated regression tests; no real account switching or forced production-client restart was performed for acceptance. A safe manager reload is recorded separately under `.cooperation/client-recovery-deployment.json` when performed.

Scoped rollback: `.cooperation/backups/client-recovery-20260912/rollback.mjs --apply`; it verifies current and backup hashes before restoring only this change's files. It neither restarts native clients nor edits their histories.


## Historical replay flood correction (2026-09-12)

The user reported old messages appearing in a burst after VS Code restart, then clarified that their message IDs differ. The previous automatic backfill appended old peer messages at the end of the panel. This was display restoration, not a second model input. The affected business workspace was neither read nor modified, and no native client was restarted or messaged during this correction.

At the user's choice, automatic history backfill is now off by default; live visibility remains on. Disabled backfill reports `visibilityHistory.status=disabled` and `peerHistoryVisibility=false` and does not invoke the history reader. The optional history feature requires a separate explicit setting. A second confirmed defect was also fixed: the wrapper formerly deduplicated live-before-history but forwarded subsequent duplicate native replays. Both directions now use a shared session/UUID ledger with case normalization.

Targeted tests exercise three consecutive isolated wrapper launches with history disabled and with explicit opt-in, repeated native echoes, unchanged transcript bytes, and initialize-only child input. Busy live output still preserves the active turn, process, permissions, and original completion. Two new deduplication tests failed on the old implementation before passing with the fix. These tests do not constitute a visual acceptance of the user's VS Code panel; running native wrappers keep their already loaded code until a normal restart.

The full automated suite passes 124 tests (0 failed, skipped, or cancelled); project-local log: `.cooperation/peer-replay-flood-tests.txt`.
