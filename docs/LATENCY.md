# Live Codex latency

For Codex terminal tools, use `listen --compact` for the first packet, then `exchange ACTION --id=REPLY_ID --compact`. Each exchange submits the decision, waits for the next request, and exits immediately when that request arrives. Retain the running task during quiet intervals. Long polls of a persistent terminal can continue waiting after stdout has arrived; use short waits if your harness requires polling.

Compact exchange preserves current permitted observations and exact new/changed schemas. Earlier instructions and schemas remain in the agent's conversation. Changed instructions force a full packet. Short reply IDs reduce transcription errors; the bridge still validates the active full UUID and allows only one response. Invalid IDs return the current reply ID without disconnecting the session. No reasoning setting, tactical policy or tool consequence is changed.

## Measured comparison

These are local live Codex measurements in the actual Electron renderer. The human side used repeatable button actions; the conversational agent chose the guard actions through the real bridge. Both runs used the same conversation/model/reasoning setting and the same six guard action types. No API model or scripted guard was substituted. Measurements include harness scheduling and agent deliberation, so they are not pure model-inference times or a general latency guarantee.

| Human action  | Guard action    |                                   Before: first visual reaction | After transport/rendering changes |
| ------------- | --------------- | --------------------------------------------------------------: | --------------------------------: |
| Enter         | Speak           | No frame before the 6 s animation fallback; decision at 20.16 s |                           12.24 s |
| Show pass     | Verify pass     |                                                          7.14 s |                            4.18 s |
| Approach safe | Speak           |                                                          8.55 s |                            4.99 s |
| Touch safe    | Ready glove     |                                                         10.08 s |                            4.54 s |
| Wait          | Hold position   |                                                         12.18 s |                            6.33 s |
| Move to exit  | Lower equipment |                                                         10.51 s |                            4.98 s |

An uninterrupted final repeat after the remaining presentation improvements measured **6.19, 4.22, 3.96, 4.50, 3.98 and 3.89 seconds**, in the same action order. After the initial setup turn, median first visual reaction fell from **10.08 s to 3.98 s** (about 60%). Mean fell from 9.69 s to 4.11 s. Final file delivery was 20–28 ms, with the first scene frame 3–17 ms after the decision arrived. An interrupted attempt is excluded. The first turn includes launcher/setup effects and is reported separately.

Live rendering continues when the game is behind another window. Human animation and the decision request already overlap. Kokoro warms at startup when installed; scene shaders compile early; long confirmed dialogue prepares its remaining audio while the first chunk plays. Three animated dots above the robot and a gentle eye pulse indicate processing, and players may draft dialogue during the guard's turn. These improve responsiveness without choosing an action for the model. They are not counted as the model's decision reaction.

## Timing fields

The main encounter records request-to-decision (`decisionMs`), agent/harness wait (`awaitingAgentMs`), file handoff (`bridgeMs`), decision-to-human-presentation completion (`presentationWaitMs`), first scene frame (`visualReactionMs`), first spoken audio (`speechStartMs`), earliest visible/audible reaction (`reactionMs`), and presentation completion (`turnCompleteMs`). First-frame/audio/complete values start at the decision request. Transcript timing and the `guard-lab:turn-timing` browser event expose these measurements. Codex App Server decisions also record `model`, `effort`, `serviceTier` and `reportedServiceTier`. Codex reports a decision's token usage just after the decision is returned, so the next decision of the same actor carries it as `previousUsage`. An action Guard Lab substituted because the model gave none it could use (three invalid calls, or a turn with neither a call nor text) is marked with `fallback` (`invalid_calls` or `no_action`) and `fallbackDetail`. Initial tests recorded visual timing only; audio timing was added afterward. Keep startup, thinking, transport and speech duration separate when comparing changes.

Provider-side reasoning, context processing and tool scheduling remain outside the game's control. The bridge does not change the selected Codex model or reasoning setting. No game-side optimization guarantees identical action choices from a nondeterministic conversational model; keeping the prompt, sensors and rules intact preserves the experiment's conditions.
