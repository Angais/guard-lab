# Privacy and publication

## Source package

The distributable source is created with an explicit file allowlist. It contains maintained code, generic documentation, ImageGen artwork derived from the actual game, generic vector assets, a dependency lockfile, fictitious test fixtures, license notices and workflows. It does not contain original Git history, author/account metadata, conversation exports, actual playthroughs, API keys, installed model inventories, screenshots, local logs, user paths, computer identifiers, voice assets/caches, build output or dependency directories.

`npm run package:source` audits the selected source and creates a ZIP with a fixed timestamp, normalized file permissions, no ZIP comments/extra fields, and a SHA-256 source manifest. `npm run audit:source` checks for hardcoded home directories, private network addresses, credential-shaped tokens, private keys and identity metadata. Automated scans are a useful check; the initial publication also requires inspecting the exact archive contents. Hashes identify source bytes, not a machine or account.

PNG and JPEG source graphics omit ancillary identity, location and profile metadata. The audit rejects additional metadata and unexpected source files. Local encounter storage uses IndexedDB; its contents are outside the source export.

Upload the clean source tree or extracted source ZIP contents. Do not upload an old workspace containing development/runtime data. A fresh Git repository contains no recoverable old commits. If you later commit personal data, deleting it from the latest revision is insufficient: remove it from history before publication and rotate any exposed secrets.

## What running the app stores

- Preferences and local experiment archives are stored in Electron's application data. Archives contain dialogue, full state, random seed and hidden information for replay; treat them as private.
- Bridge request/result files contain role-scoped instructions, observations, recent dialogue and tool schemas. The guard's private code stays opaque until deliberately spoken. The human channel contains that actor's private role/loadout. These are local runtime files, not source files.
- Kokoro caches synthesized guard speech as WAV files in app data `speech-cache/` (size-bounded) so repeated lines play instantly; text may be reconstructable by listening to them. Your own lines and push-to-talk transcripts are not written to disk. Microphone audio exists only in memory while you hold the push-to-talk key and is transcribed on this device by Whisper. Downloaded models live in app data `models/`.
- API keys are kept in memory for the running session; preferences/archive do not intentionally save them. Endpoint/model choices are local preferences. Exported transcripts can contain anything participants said, including secrets they typed; review before sharing.

Default app data location is computed from OS application-data conventions. `GUARD_LAB_DATA_DIR` selects a different root. The source exporter never includes this data. The same OS user's tools can inspect local files; role separation is for fair experiments, not protection from a malicious local process. Native OS privacy controls apply to voice workers and runtime storage.

## Network behavior

The game adds no analytics, crash upload, subscription checks or automatic cloud model calls. Source installation downloads npm dependencies/Electron from upstream infrastructure. Kokoro and Whisper models download from Hugging Face only when you click Download (or run `npm run voices:install`); speech synthesis and recognition then run locally and no audio or dialogue is sent anywhere for them. Source development serves the renderer on loopback only.

In Codex mode, Guard Lab runs your local Codex CLI (`codex app-server`) with your existing Codex sign-in. Each encounter actor gets an ephemeral thread whose instructions, observations, dialogue and tool definitions are sent to OpenAI under your Codex account and its policies, as with any Codex use. Guard Lab turns off your plugins, MCP servers and coding tools for these threads and stores no credentials; sign-in is handled by Codex itself in your browser. Ephemeral threads leave no Codex session files, but Codex may keep its own local diagnostic logs (for example `~/.codex/logs_*.sqlite`) under its own settings, and those can include turn inputs such as observations and dialogue. Guard Lab does not control them.

In direct model mode, the configured endpoint receives that actor's prompt, dialogue, permitted observations and tool definitions. A guard API receives its private safe code as required for the role. Local model endpoints remain local unless their own server forwards requests. A remote provider may store requests under its own policies. In live-agent mode, the game bridge is local, while the chosen agent/harness may send its observed packets to its model provider according to that harness's settings. The bridge cannot change the harness's privacy policy.

Loopback addresses and public upstream URLs in source/docs are generic service locations, not an originating user's network information. Third-party package and dataset attribution identifies upstream projects, not the person packaging this game.
