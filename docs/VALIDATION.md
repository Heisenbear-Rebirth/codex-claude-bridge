# Validation and supported scope

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
