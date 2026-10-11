# Development

Tactical rules and inventory interactions: [TACTICS.md](TACTICS.md), `src/sim/tactics.mjs` and `src/scene/tactics.mjs`. All game modes share one ruleset. The AI freely chooses among available actions; prompts describe consequences without prescribing escalation.

## Architecture

| Location                                          | Responsibility                                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `src/sim/engine.mjs`                              | Pure initialState/applyHuman/applyTool/observe; authoritative consequences           |
| `src/sim/tools.mjs`                               | Guard capabilities, parameter schemas, objective/sensor prompt                       |
| `src/sim/items.mjs`                               | Starting loadouts and gadget consequences                                            |
| `src/sim/human-agent.mjs`                         | Private human prompt, loadout choice, observations and dynamic actions               |
| `src/sim/perception.mjs`, `hearing.mjs`           | Camera/microphone evidence and visibility boundaries                                 |
| `src/sim/random.mjs`, `status.mjs`                | Seeded chance and structural damage displays                                         |
| `src/sim/agent.mjs`                               | Model response → one action; dialogue/context compaction                             |
| `src/scene/Chamber.jsx`, `rig.mjs`, `physics.mjs` | Procedural Three.js room, articulated rigs, contact/rebound motion                   |
| `src/App.jsx`, `src/ui/`                          | Turn scheduling, screens (setup, home, HUD, dock, settings), local archive           |
| `src/audio`                                       | Procedural SFX, Kokoro playback, push-to-talk capture, system-speech fallback        |
| `electron`                                        | Sandboxed window, Codex App Server client, voice utility process, narrow preload IPC |
| `shared`                                          | Runtime paths, role-scoped bridge, Kokoro/Whisper model install and inference        |
| `scripts`                                         | Setup, launch, agent CLI, generated docs, audit/source export, voice model install   |
| `tests`                                           | Consequences, seed repeatability, collisions, private sensors and bridge protocol    |

Presentation math is separated into `paths.mjs` (obstacle clearance), `motion.mjs` (step/glove/impact curves), `rig.mjs` (arms), `physics.mjs` (fixed-step projectile contacts), and `impact-fx.mjs` (bounded particle pools/post effects). Change these without changing outcomes. Particle buffers and line geometry are reused; transient GPU resources are disposed; rendering throttles when hidden. Reduced-motion preferences suppress camera shake/chromatic impact. Archives use asynchronous IndexedDB and only changed records are written.

`contact-shadows.mjs` contains the depth/normal filtering for contact shadows, including transparent labels and particles. Its buffer is capped at 900 pixels wide and 65% of the display width. `Chamber.jsx` owns the lighting, materials, camera framing and visible props; `character.mjs` owns both human appearances. Adjust these together when changing art direction. Keep light power synchronized with blackout and flashlight rules. Cosmetic anticipation/rebound must stay within collision bounds; the spring can never extend beyond its resolved contact point. `audio/sfx.mjs` provides procedural, synchronized effects with a limiter and reusable noise buffers.

The renderer consumes resolved events, including before/after snapshots and target positions. It does not roll dice, spend ammunition or inflict damage. Animations overlap with AI decision/speech preparation where safe; handoffs use filesystem notifications. `electron/codex.cjs` finds a native Codex binary (settings path, `GUARD_LAB_CODEX`, PATH with JS shims resolved to the native executable, the ChatGPT desktop bundle, then a login shell), starts `codex app-server` with the user's plugins, MCP servers and coding tools disabled, and runs one ephemeral thread per encounter actor with the game's tools as dynamic tools. The first valid tool call is accepted and the turn interrupted, so each decision is exactly one action. `shared/voice-models.mjs` installs and runs Kokoro TTS and Whisper STT (transformers.js + onnxruntime-node) under app data `models/`; `electron/voice-worker.cjs` hosts it in an Electron utility process so inference never blocks the window.

## Work loop

`src/scene/character.mjs` contains the cosmetic human details: shared employee uniform, facial features and hairstyle variants. It adds to the existing articulated rig without changing collision extents or exposing the selected role. The showcase includes both appearances. Keep role credentials separate from cosmetic geometry.

```sh
node scripts/setup.mjs
npm start
npm test
npm run docs:generate
npm run check
```

`npm run dev` runs a loopback renderer preview, which supports scripted mode; direct models/live IPC require the Electron app. For renderer-only visual checks, `npm run dev` plus `?showcase=1` previews the same generated demo in development mode. `npm run showcase` opens deterministic chapters demonstrating every guard tool and equipment warning. It resets fatalities between chapters. Showcase data is generated from current code, not a checked-in user recording.

## Change balance or run a reproducible scenario

`src/sim/rules.mjs` centralizes hearts, safe/exit thresholds, pistol capacity, damage probabilities, effect duration and entry behavior. Tool-specific ammo/range/damage/cooldown live in `TOOLS`; item metadata lives in `ITEMS`. Current rules are attached to prompts and both actors' observations, overriding default narrative examples. Update descriptions and regenerate docs when changing a mechanic.

Run `npm run scenario` for a complete deterministic, headless sample that discloses a code, detects a replica, returns the original and exits. Copy `docs/scenario.json`, change its seed/loadout/actions, then run `node scripts/scenario.mjs --file=my-scenario.json`. Use `--actor=robot` or `--actor=human` to inspect that role's evidence; `--export=my-record.json` writes an omniscient debug record and refuses to overwrite an existing file. This is developer tooling; never read debug records while playing a fair live role.

The low-level engine functions resolve individual commands; an encounter scheduler must alternate actors. `scenario.mjs` is a small example. The UI preserves a pending guard phase across pause/error/retry. `applyTool` additionally rejects duplicate guard commands for the same round.

## Add a guard tool

Add metadata/schema in `tools.mjs`, consequence/validation in `applyTool`, and visibility rules in `requiresVision`/`availableTools`. Add the corresponding rig/effect in `Chamber.jsx` and a meaningful consequence test. If it is audible, define the sound evidence without revealing hidden state. Update the showcase if appropriate; `showcase.test.mjs` verifies capability coverage. Regenerate docs and run checks. A new tool must not alter the observation contract accidentally.

## Add a human item or action

Add the loadout in `items.mjs`, permitted action schemas in `humanToolSchemas`, and engine consequences. Render the item in `Home.jsx` and the scene. Check that the guard cannot infer selection before visible use, and that stun/blur/darkness constraints match UI and schemas. Regenerate the catalogue and verify all harnesses when item choices change. Selection and motives remain private.

## Add a model adapter

Direct chat-completions integration lives in `electron/main.cjs`. The request boundary accepts `{messages,tools,temperature}` and returns `{message:{role,content,tool_calls}}`; function arguments are JSON strings. Provider-native formats can be normalized here without changing the engine. Each actor's credentials/connection ID are independent; keys stay in the main process and session memory. Do not persist them in config/archive or print raw provider responses that could contain credentials.

A harness adapter usually needs no app changes: use `shared/bridge.mjs` or the agent CLI, retain only your role's permitted memory, and return one action with its request ID. For headless rule experiments import the pure engine into Node and supply separate observations to each model; never feed full state as an observation. The supplied tests run headlessly, but the shipped game UI requires a display.

## Preserve the experiment

Seeded rules, audiovisual presentation and model decisions are separate. Prompt guidance should state capabilities and objectives, without prescribing an escalation sequence unless that is explicitly the experiment. Verify secrecy in normal, sack, dark, smoke and flashlight modes. Do not claim empirical results from scripted demos. New replay/archive formats should version their schema. Existing legacy replay fields are tolerated for backwards compatibility, but no historical recordings are distributed.

The repository excludes local development patch scripts, unused old room renderers, runtime assets and private data. Publish through the audited source exporter rather than zipping an arbitrary working directory. See [RELEASE.md](RELEASE.md).

`npm run test:desktop` additionally verifies the built renderer, sandboxed preload, actual Electron bridge and independent provider connections using a local mock endpoint. It uses an isolated temporary data root and requires a graphical session. It does not contact a real model provider or assert an LLM's behavior.
