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
