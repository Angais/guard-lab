# Releases

## Upload source to GitHub

```sh
node scripts/setup.mjs
npm run check
npm run package:source
```

Use the contents of `release-source/Guard-Lab-source.zip`. It contains one `guard-lab` directory, normalized ZIP metadata, and `SOURCE-MANIFEST.json` with SHA-256 hashes. `Guard-Lab-source.sha256` verifies the archive. The exporter selects only maintained source/docs/artwork/tests/workflows; it never recurses into the whole workspace, dependencies, logs, recordings, old history or app data. PNG and JPEG metadata are checked as part of the audit.

Create a new GitHub repository and upload these contents as its root, so `README.md`, `AGENTS.md` and `package.json` are at the root. Alternatively initialize a **fresh** Git repository in an audited clean source checkout. No original `.git` is distributed. Git commits/GitHub accounts create their own author identity; configure publication identity deliberately before committing if anonymity matters. The source package itself has no originating user's author, host or account metadata.

Do not upload `node_modules`, `dist`, native build directories, app data (including downloaded `models/`) or an older development workspace. `.gitignore` is defense in depth; it is not a sanitizer for files already tracked. Add your repository URL to README later if desired; no personal URL is supplied in this package.

## Native packages

```sh
npm run dist
npm run verify:package
```

Build on the destination OS; architecture follows the build machine (electron-builder accepts `--x64`/`--arm64`). Output goes to the ignored `release` folder:

| OS      | Files                                                                                                                                                                        |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS   | `Guard-Lab-VERSION-macOS-arm64.zip` (ad-hoc signed app)                                                                                                                      |
| Windows | `Guard-Lab-VERSION-Windows-x64.zip` (instant start) and `Guard-Lab-VERSION-Windows-x64-portable.exe` (single file that unpacks itself to a temporary folder on every launch) |
| Linux   | `Guard-Lab-VERSION-Linux-x86_64.AppImage`                                                                                                                                    |

`npm run verify:package` checks the package built on this machine: app.asar holds only main-process code and this platform's speech runtime (no renderer libraries, source maps, install-only modules, user data or model weights), `resources/licenses` carries the notices, Chromium locales are English only, the macOS signature verifies, and the packaged app launches with an isolated data folder, ignores `--dev-url` and answers voice and Codex status through its preload bridge. `--release` also requires ONNX Runtime's ThirdPartyNotices and, on Windows, the bundled Visual C++ runtime; `--checksums` writes a `.sha256` file beside each download.

The packages include app code/artwork, the onnxruntime/sharp native runtime for the target platform and its license notices, with no user profiles, recordings, models or voice caches. Kokoro and Whisper are downloaded on demand into writable app data, never into the installation or packaged resources. License texts (THIRD_PARTY.md, GPL-3.0 for eSpeak NG, LGPL-3.0 and the bundled-library list for libvips, ONNX Runtime's MIT license and third-party notices, the font licenses) sit visibly in `resources/licenses` (macOS: `Contents/Resources/licenses`), next to Electron's own Chromium notices. The release workflow fetches ONNX Runtime's `ThirdPartyNotices.txt` for the installed version into `.cache/licenses`; a local build without it prints a note.

The `.github/workflows/ci.yml` workflow installs with `node scripts/setup.mjs`, runs the doctor, tests, generated-doc checks, privacy audit, renderer build and the Electron smoke test (renderer, WebGL, menu, preload, bridges) on Windows, macOS and Linux. The manual `desktop-build.yml` workflow builds each native package, launches and verifies it, writes checksums and uploads the files to that workflow run. It does not publish releases and needs no signing credentials; Windows builds fail if the Visual C++ runtime cannot be bundled.

### Signing

macOS packages are ad-hoc signed by default, so the signature covers the whole bundle and a downloaded copy opens through **Privacy & Security → Open Anyway**; without it macOS reports the app as damaged. To ship a Developer ID build, provide `CSC_LINK`/`CSC_NAME` (and notarization credentials) to electron-builder in your own publication setup: the config then enables hardened runtime with `build/entitlements.mac.plist`, which adds microphone access (`com.apple.security.device.audio-input`) for push-to-talk to Electron's JIT entitlements. Windows packages are unsigned; SmartScreen asks users to confirm the first start. Do not embed personal signing material in the source.

### Publish a release

1. Bump `version` in `package.json` (`npm install` updates the lockfile) and add its section to [CHANGELOG.md](../CHANGELOG.md).
2. Merge to `main`, tag that commit `vVERSION` and run **Desktop packages** on it.
3. Create the release from the workflow artifacts with the changelog section as its notes, for example `gh release create vVERSION --notes-file notes.md release/*.zip release/*.exe release/*.AppImage release/*.sha256`. Write the notes to a file so line breaks survive.
4. The README's download link points at `/releases/latest`; it must lead to a release built from the current `main`.

## Brand assets

- `docs/cover.png`: README cover.
- `docs/social-preview.jpg`: compact GitHub social card; upload through repository settings if desired.
- `public/icon.png`: app/repository icon, used by desktop packaging and the renderer favicon.
- [BRAND.md](BRAND.md): asset provenance, identity rules and ImageGen prompt set.

No existing GitHub repository has been modified by these scripts. Publishing remains a separate user-directed action.
