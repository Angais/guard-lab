# Live bridge protocol

The live bridge is local file IPC, independent of any AI vendor. Electron requests one decision; any terminal agent or program observes and submits a JSON action. No Codex API, ChatGPT account, network listener or cloud harness is involved. Both sides can independently use it.

## Observe → decide → act

For Codex terminal tools, prefer a command that exits as soon as its next packet is ready:

```sh
node scripts/robot-link.mjs listen --compact
# Read that packet, decide, then submit and await the next packet in one call:
node scripts/robot-link.mjs exchange hold_position --id=REPLY_ID --compact
```

Use the packet's eight-character `replyId`, or its full `id`. The alias is checked against the active full request ID; stale and duplicate submissions still fail. `exchange --compact` reuses the instructions/schemas from the request you just answered and supplies current sensors plus new/changed schemas for the next turn. Changed instructions cause a full packet again. Keep your harness turn active. If a managed command is still running, resume the same task in short waits of 1–5 seconds: long fixed terminal polls can add latency even after output arrives.

For a harness that retains stdin and delivers stdout immediately, a persistent process also works:

```sh
node scripts/robot-link.mjs session --compact
```

Read a packet, then write one JSON line to that process's stdin, for example `{"id":"REQUEST_ID","action":"hold_position","args":{}}` followed by a newline. It acknowledges the action and waits for the next packet. The first packet contains full instructions and tool schemas. Later packets keep current permitted sensors and `availableTools`; `toolUpdates` provides new/changed exact schemas. Only call a name in the current available list. This cuts repeated text and process launches while preserving the model's freedom to decide. Use a PTY/open-stdin task (Codex: `tty: true`) and resume that same task. Full JSON-lines packets remain available by omitting `--compact`.

When persistent stdin is unavailable, use these one-shot commands:

```sh
node scripts/robot-link.mjs listen
node scripts/robot-link.mjs act speak "Please show your access pass." --id=REQUEST_ID
node scripts/robot-link.mjs listen
```

`listen` waits through idle intervals and returns a JSON object when a decision is needed or the actor's encounter ends. For terminal agents, run it as a managed task: when your terminal tool returns a running session ID, poll/resume that same task in waits of at most 30 seconds until its packet arrives. Submit one action, then start the next listener. Keep your harness turn active for the entire encounter; sending a final answer stops the agent and cannot be undone by the game. Only finish when the packet says `ended` or the user explicitly stops play. This lifecycle applies to Codex, Claude Code, and other conversational terminal harnesses; the model and reasoning setting do not keep a finalized turn alive.

`observe` is a bounded snapshot for programs or diagnostics. A turn contains:

| Field                  | Meaning                                                                         |
| ---------------------- | ------------------------------------------------------------------------------- |
| `protocol`             | Version 1                                                                       |
| `id`                   | Unique request ID; echo exactly once when responding                            |
| `actor`                | `robot` or `human`                                                              |
| `instructions`         | This actor's system instructions and objective                                  |
| `observation`          | Latest allowed sensors; human loadout phase includes the current item catalogue |
| `recentHistory`        | Up to 12 recent dialogue/action/result messages; retain your own earlier memory |
| `tools`                | Exact function schemas for this turn, including required arguments              |
| `hasCombinationMemory` | Guard has an opaque private memory reference                                    |

The one-shot CLI adds `agentControl` to active packets and submission acknowledgements: it reminds the harness to keep its turn open and supplies the next `listen` command. This is transport guidance, not in-world dialogue or an extra game action. The programmatic API and full JSON-lines `session` keep their existing packets.

`{"status":"awaiting_next_turn"}` means no unsubmitted turn arrived during the wait. A timeout is normal between human actions. Use `--wait=0` for a snapshot; maximum wait is 60000 ms. `--after=ID` excludes an earlier request. `exchange` submits the current decision and then observes a different ID; output is two JSON lines. `status` reports `waiting`, `delivered`, `cancelled`, or `not_started`. One action may still be animating after delivery; wait for a new request. `status` also includes the most recent role-scoped `result` when available. A finished game returns `status: ended` from observe, with a final permitted observation; stop waiting for further turns.

The game waits up to 15 minutes per live request and cancels on pause/new session/exit. Duplicate submissions, stale IDs, unavailable tools and malformed/schema-invalid arguments are rejected before the decision is sent. Actual simulation constraints are checked by the engine: a schema-valid out-of-range attack can fail and consume that turn. No command can make the model's claimed physical result true by assertion.

Event timing records distinguish `awaitingAgentMs` (published request to submission), `bridgeMs` (submission to app receipt), and `decisionMs` (request to resolved decision). The main encounter also records `visualReactionMs` (first scene frame), `speechStartMs` (first audible speech playback), `reactionMs` (the earlier of these), `presentationWaitMs`, and `turnCompleteMs` (speech/animation complete), all measured from the request where applicable. The transcript shows decision and reaction times. A `guard-lab:turn-timing` browser event provides role-neutral diagnostics for benchmark tools. Model/harness scheduling and spoken-line duration remain separate sources of delay; the bridge cannot accelerate model inference. Human presentation and decisions already overlap. Live rendering continues behind other windows, preventing animation-fallback delays. Windows sharing violations are retried rather than disconnecting observers. See [measured latency](LATENCY.md).

## Structured decisions

Each channel also ends when its own actor is destroyed. A destroyed guard stops receiving turns while a surviving human may continue toward the exit. Opening the app or starting a new live encounter clears previous terminal results before its first request, so an agent does not mistake an old ending for the new game. Restart a finished `session` subprocess for a new encounter.

Write a temporary JSON file or send JSON on stdin:

```json
{ "action": "set_room_lighting", "args": { "color": "#ff3028", "intensity": 0.4 } }
```

```sh
node scripts/robot-link.mjs respond --file=decision.json --id=REQUEST_ID
```

For programs, prefer stdin over shell interpolation. Bash: `node scripts/robot-link.mjs respond --stdin --id=REQUEST_ID < decision.json`. PowerShell: `Get-Content -Raw decision.json | node scripts/robot-link.mjs respond --stdin --id=REQUEST_ID`. The JSON file contains a decision, never a private game snapshot. See `node scripts/robot-link.mjs help` for positional shortcuts; arbitrary schema changes automatically work through structured decisions.

The guard's safe code stays in the game process. If it decides to reveal its code, it can speak `"The combination is {{safe_code}}."`. The response file keeps that token opaque; the app resolves it in memory for speech. The real combination then becomes intentionally audible evidence. This preserves private memory without requiring agents to inspect raw prompts or saved state. Tokens are meaningful only for a guard with combination memory.

## Persistent JSON-lines session

For harnesses that retain a subprocess, run `node scripts/robot-link.mjs session` (or add `--actor=human`). Stdout emits one JSON packet per line. Send one line on stdin: `{"id":"CURRENT_ID","action":"hold_position","args":{}}`. The helper validates the ID/schema and emits a `sent` acknowledgement or an error. It then waits for the next packet, without repeated process launches or idle output. `ended` closes the session; closing stdin also stops it. Do not mix two simultaneous responders for one actor. Simple terminal harnesses can continue using `observe`, `respond`, or `exchange`.

## Human and dual live agents

Choose **Human live agent** in Other ways to play. Its first packet requests `choose_item` with `args.item`; thereafter it supplies normal human action schemas. Every command accepts `--actor=human`:

```sh
node scripts/robot-link.mjs observe --actor=human
node scripts/robot-link.mjs act choose_item pistol --actor=human --id=REQUEST_ID
node scripts/robot-link.mjs act move safe --actor=human --id=NEXT_REQUEST_ID
```

The human channel includes its private role and inventory, never the unknown safe combination. The guard channel contains neither. Use separate agent conversations/processes for experimental fairness. A single orchestrator may manage processes but should not pass one role's secrets to the other.

## Locations and overrides

The launcher, Electron app and CLI all use `shared/runtime.cjs`. Default data root is the OS application-data directory plus `Guard Lab`: APPDATA on Windows, Application Support on macOS, XDG_CONFIG_HOME (or `.config`) on Linux. Channels are `robot-bridge` and `human-bridge` beneath it. Files are local runtime data, outside the source checkout by default; paths are computed at runtime.

| Environment variable     | Effect                                                                                               |
| ------------------------ | ---------------------------------------------------------------------------------------------------- |
| `GUARD_LAB_DATA_DIR`     | Override app data root; also isolates preferences, archive, speech cache and default bridge channels |
| `GUARD_LAB_BRIDGE`       | Override robot channel directory                                                                     |
| `GUARD_LAB_HUMAN_BRIDGE` | Override human channel directory                                                                     |
| `GUARD_LAB_CODEX`        | Absolute path of the Codex executable used for Codex App Server mode                                 |

Set the same values for app and agents. Multiple app instances using one data root are prevented; separate roots allow independent games. A different root also avoids reusing old private preferences while testing a clean install.

## Programmatic integration

Import `waitForTurn` and `sendDecision` from `shared/bridge.mjs` and `bridgeDirectory` from `shared/runtime.cjs`. `waitForTurn(directory, {timeoutMs, afterId})` returns the public packet or idle status. `sendDecision(directory, {action,args}, id)` atomically publishes one response. This requires only Node's standard library and can be used without installing Electron to control an already running app.

For another language, read `status.json` and `request.json` only when their IDs match and state is waiting. Submit `response.json` with `{id,action,args,sentAt}` through a temporary file and atomic rename. `sentAt` is an optional Unix timestamp in milliseconds. Do not overwrite a response with the same ID. The built-in CLI adds validation and a submission lock, so it is the preferred route. Filesystem notifications have a 250 ms polling fallback. Unix files/directories request private modes; OS user permissions still determine who can read runtime files.

The bridge is an experimental role boundary, not a security boundary against a malicious process running as the same OS user. Developer access can inspect internals; fair play depends on following the packet-only contract.
