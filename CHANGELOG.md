# Changelog

Release notes for each published version. Notes for 1.0.0–1.0.4 are in [docs/POST-RELEASE-FIXES.md](docs/POST-RELEASE-FIXES.md).

## 1.2.0

### Install and desktop packages

- `npm run play` opens Guard Lab as its own process and returns at once. It rebuilds the renderer only when the source changed, and the window stays open after the terminal or agent task that launched it ends. Agents installing the game for a player use it; `npm start` stays the attached developer launcher with live reload.
- Node.js 22.12 or newer is required (Electron 44 and Vite 7 need it). Setup and `npm run doctor` check the minor version and name the installed one. The doctor also reports the Guard Lab version and Git commit.
- macOS packages are ad-hoc signed, so a downloaded copy opens through **Privacy & Security → Open Anyway** instead of being reported as damaged. A Developer ID build gets hardened runtime with microphone entitlements.
- Windows ships as a zip that starts instantly, plus the single-file portable `.exe` (which unpacks itself on every launch).
- Packages are about 100 MB smaller unpacked: renderer libraries are bundled by Vite only, source maps, install-only modules and non-English Chromium locales are left out.
- License notices are visible in the package's `resources/licenses` folder, now including ONNX Runtime's license and third-party notices and the libvips library list.
- The released app has no Reload or Developer Tools menu items, so a keystroke can no longer end a game; **Help → About** (macOS: **Guard Lab → About**) shows the version. Packaged builds ignore `--dev-url`.
- Release files are named `Guard-Lab-<version>-<macOS|Windows|Linux>-<arch>` and each gets a `.sha256` checksum. `npm run verify:package` checks a built package and launches it; CI runs the Electron smoke test on all three systems.
- sharp is pinned to 0.35.5, which fixes the high-severity libvips advisories reported by `npm audit --omit=dev`.

## 1.1.1

- One shared ruleset for every mode. The guard can wait, talk, warn, restrain or use lethal force as it decides; no rules profile sets its temperament or an escalation sequence.

## 1.1.0

- Tactical inventory: shield, grabber and crowbar starting items; foam disarm drops visible objects; `pick_up` and `drop_item` for floor objects.
- New guard capabilities: `deploy_net` (soft net, freed by `struggle`), `recover_item` for dropped objects near its base, and `call_security`, a twelve-round audible countdown.
- Wet floor makes running slip. The private objective (Transit or Heist) and carrying a valid transit pass are separate setup choices.

## 1.0.6

- The guard runs on Codex App Server with your Codex sign-in, in an isolated thread per encounter. A first-run setup screen checks Codex and offers ChatGPT sign-in.
- Local Kokoro voices and Whisper push-to-talk, downloaded on demand and run offline.
- Redesigned setup, home, settings and in-game interface.
- Desktop packages include the full GNU GPL-3.0 and LGPL-3.0 texts for eSpeak NG and libvips.

## 1.0.5

- The guard's prompt states its objective and the foresight it needs without prescribing tactics.
- Installers and agents are directed to the latest upstream version.
