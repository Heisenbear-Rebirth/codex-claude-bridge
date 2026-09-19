# Validation and supported scope

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
