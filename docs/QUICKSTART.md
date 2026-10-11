# Quickstart

## Download

Release packages need no Node.js or terminal. Get them from the [latest release](https://github.com/flowers-ops/guard-lab/releases/latest); each file has a `.sha256` checksum beside it.

| System                     | File                                         | First open                                                                                                                                            |
| -------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS 13+ on Apple Silicon | `Guard-Lab-VERSION-macOS-arm64.zip`          | Unzip and move Guard Lab to Applications. The app is not notarized: when macOS blocks it, open **System Settings → Privacy & Security → Open Anyway** |
| Windows 10/11 x64          | `Guard-Lab-VERSION-Windows-x64.zip`          | Extract all, then open `Guard Lab.exe`. On SmartScreen, click **More info → Run anyway**                                                              |
| Windows, single file       | `Guard-Lab-VERSION-Windows-x64-portable.exe` | Unpacks itself to a temporary folder on every start, so it opens more slowly than the zip                                                             |
| Linux x64                  | `Guard-Lab-VERSION-Linux-x86_64.AppImage`    | `chmod +x` the file, then run it                                                                                                                      |

Intel Macs and other systems run from source.

## Install from source

Use a desktop Windows, macOS, or Linux session with Node.js 22.12+ and npm. Get the source through Git (`git clone YOUR_REPOSITORY_URL`) or GitHub's Download ZIP, then open a terminal in the directory containing `package.json`.

```sh
node scripts/setup.mjs
npm run doctor
npm run play
```

These commands work in PowerShell, Command Prompt, zsh, bash, and terminal-based AI harnesses. The setup script runs `npm ci` against the committed lockfile, verifies the Electron download, and reuses a matching completed install. Use `node scripts/setup.mjs --force` to reinstall. It installs the Electron runtime, renderer and build tools; it does not install an LLM. Prefer a short checkout path, especially on Windows. There are no hardcoded home directories or working-directory-dependent bridge paths.

## Play with Codex (recommended)

```sh
npm run play
```

`npm run play` opens the game as its own window and returns; the terminal can be closed. `npm start` instead keeps the game attached to the terminal and reloads it when you edit the source (for development).

The first launch shows a setup screen with three checks:

1. **Guard AI (Codex):** Guard Lab looks for a Codex executable (Settings path, `GUARD_LAB_CODEX`, your PATH, the ChatGPT desktop app's bundled CLI). If you're signed out, click **Sign in with ChatGPT**. If Codex is missing or broken, click **Copy fix prompt**, paste it into Codex or ChatGPT, then **Check again**.
2. **Voices (Kokoro, about 92 MB):** natural voices for the guard and you.
3. **Voice input (Whisper, about 139 MB):** hold <kbd>Space</kbd> to talk; release to send.

Everything is optional: without Codex you get the practice guard, without Kokoro speech uses system voices, and without Whisper you type. You can rerun setup from Settings.

Pick a private objective — **Transit** (cross the room and leave through the exit) or **Heist** (steal the item from the safe and escape alive) — and optionally carry a valid transit pass. Bring one item and press **Start**. The guard can't see your objective, pass or item until you show them.

**Settings → Guard** picks the model, reasoning effort and fast mode (default GPT-6 Luna, low, fast on). Codex runs on your own Codex sign-in, in a separate ephemeral thread per encounter with your plugins, MCP servers and coding tools turned off, so the guard sees only the game. Faster settings make the guard react sooner; heavier reasoning makes it slower. `npm run doctor` reports what Codex Guard Lab found.

## Terminal agent bridge

```sh
npm run live
```

Ask Codex, Claude Code or another terminal agent to read `AGENTS.md` and play the guard (or the human with `--actor=human`). Launch this as a persistent process; do not give the launcher a short timeout that kills the app. The agent starts with `node scripts/robot-link.mjs listen --compact`, then uses `exchange ACTION --id=REPLY_ID --compact` to submit and await the next packet in one call. Keep the harness turn open until the encounter ends: a final chat answer disconnects the agent, and the app cannot wake it. Select the model and reasoning in your harness. [Latency measurements](LATENCY.md) describe the comparison. The bridge needs no network after dependencies are installed.

## Direct local or API connection

Open **Settings → Guard**, choose **Your model**, choose endpoint and model, test the connection, and save. API credentials remain in memory for that app session. The protocol is tool-capable `/chat/completions` plus `/models`; a text-only endpoint, provider-native API, or provider with a different tool format needs an adapter. Use a model that can follow one tool call per turn. No particular vendor is required.

| Provider       | API base URL                | Setup                                                                                                |
| -------------- | --------------------------- | ---------------------------------------------------------------------------------------------------- |
| Ollama         | `http://localhost:11434/v1` | Install/run Ollama separately, pull a tool-capable model, click Ollama and select an installed model |
| LM Studio      | `http://localhost:1234/v1`  | Load a tool-capable model and start its local server                                                 |
| Compatible API | Your provider's base URL    | Enter its model ID and optional API key                                                              |

The app lists models from your running server; it neither downloads models nor chooses a subscription. [Ollama's API documentation](https://docs.ollama.com/api/openai-compatibility) describes its compatibility interface. [LM Studio's documentation](https://lmstudio.ai/docs/developer/openai-compat) describes its local endpoint. Other agents may use the vendor-neutral live bridge instead of a direct API.

## Secondary modes

On the home screen, use **Other modes**. **Play as guard** gives you the robot controls and a human AI that chooses its own item. **AI vs AI** uses two independent connections. Each AI side can use Codex, a local/API model, the practice policy, or a terminal agent. For live human use `--actor=human` on bridge commands. A guard live agent uses the default robot channel. Pause/resume is available; long automated games pause after 100 rounds. A scripted demo is a deterministic convenience policy, not an LLM experiment.

## Voices and voice input

The setup screen and **Settings → Voice** download, test and remove the models. From a terminal:

```sh
npm run voices:install            # Kokoro and Whisper
npm run voices:install -- --tts   # Kokoro only
npm run voices:install -- --stt   # Whisper only
```

Models download from Hugging Face into app data `models/` (set `HF_ENDPOINT` to use a mirror, or `--from=DIR` to install from a local copy). After installation everything runs offline on your CPU through onnxruntime. Microphone audio is captured only while you hold the push-to-talk key and stays in memory. On macOS the first recording asks for microphone permission; on Windows check **Settings → Privacy → Microphone** if recording is blocked. Kokoro and Whisper need the Microsoft Visual C++ runtime on Windows (included with most PCs); if voices fail to load there, install the latest Visual C++ Redistributable from Microsoft. Review [model terms](../THIRD_PARTY.md) before redistribution.

## Troubleshooting

| Symptom                                       | Next step                                                                                                                                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `node`/`npm` missing                          | Install the official Node.js distribution and reopen the terminal                                                                                                                                      |
| Electron missing                              | Run `node scripts/setup.mjs`; installation must permit dependency lifecycle scripts                                                                                                                    |
| Setup asks for a newer Node.js                | Install Node.js 22.12 or newer (Electron 44 and Vite 7 need it), reopen the terminal and rerun setup                                                                                                   |
| macOS: "can't be opened" / "could not verify" | **System Settings → Privacy & Security → Open Anyway**. As a last resort: `xattr -dr com.apple.quarantine "/Applications/Guard Lab.app"`                                                               |
| Windows: SmartScreen blocks the app           | **More info → Run anyway**. The packages are not code-signed                                                                                                                                           |
| Linux: AppImage does not start                | `chmod +x` it. Install `libfuse2` (`libfuse2t64` on Ubuntu 24.04+). If it stops with a sandbox error (Ubuntu 24.04+ restricts the user namespaces Chromium's sandbox uses), run it with `--no-sandbox` |
| Desktop does not open on Linux                | Use a graphical session and run `npm run doctor` to identify missing system libraries. Headless tests, `npm run scenario`, and the bridge work without a display                                       |
| Live agent waits                              | Start the encounter and take a human action. Match the channel and environment variables between launcher and agent                                                                                    |
| Stale/duplicate response                      | Observe a fresh packet; use its exact ID once                                                                                                                                                          |
| Tool rejected                                 | Read the current schema and sensors. Check range, visibility, ammo and cooldown; do not invent a successful outcome                                                                                    |
| No speech                                     | Unmute, interact once to unlock audio, then install or test Kokoro in Settings → Voice                                                                                                                 |
| Codex not found or signed out                 | Use the setup screen's Sign in or Copy fix prompt; or set the executable in Settings → Guard → Advanced                                                                                                |
| Two sessions interfere                        | Use a different `GUARD_LAB_DATA_DIR` for each app and its agent                                                                                                                                        |
| Port already used                             | The source launcher automatically picks another available loopback port                                                                                                                                |
| API connection fails                          | Verify model/server/tool support. `/models` must respond and its model ID must be saved                                                                                                                |

Source builds are the baseline cross-platform experience. CI runs the source checks and the Electron smoke test on Windows, macOS and Linux, and the desktop workflow builds, launches and checksums each package; platform-specific display/graphics support is still required. Nothing in this repository grants a harness permissions it does not already have.
