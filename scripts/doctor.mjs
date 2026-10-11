import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { ROOT } from './paths.mjs';
import {
  KINDS,
  MODELS,
  modelsDirectory,
  readStatus,
  runtimeFailure,
} from '../shared/voice-models.mjs';
const require = createRequire(import.meta.url);
// Electron 44 and Vite 7 need Node.js 22.12 (require of ES modules) or newer.
const [major, minor] = process.versions.node.split('.').map(Number);
const checks = [
  { name: 'Node.js 22.12 or newer', ok: major > 22 || (major === 22 && minor >= 12) },
];
const { version } = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
const git = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
  cwd: ROOT,
  encoding: 'utf8',
  windowsHide: true,
});
const commit = git.status === 0 ? git.stdout.trim() : null;
for (const name of ['vite', 'electron']) {
  try {
    require.resolve(name);
    checks.push({ name: `${name} installed`, ok: true });
  } catch {
    checks.push({ name: `${name} installed (run npm ci)`, ok: false });
  }
}
try {
  const binary = require('electron');
  await fs.access(binary);
  checks.push({ name: 'Electron binary downloaded', ok: true });
  if (process.platform === 'linux') {
    const result = spawnSync('ldd', [binary], { encoding: 'utf8', windowsHide: true });
    if (!result.error) {
      const missing = (result.stdout || '')
        .split('\n')
        .filter((line) => line.includes('not found'))
        .map((line) => line.trim().split(' ')[0]);
      checks.push({
        name: 'Electron system libraries',
        ok: missing.length === 0,
        ...(missing.length ? { missing } : {}),
      });
    }
  }
} catch {
  checks.push({
    name: 'Electron binary downloaded (run npm ci without --ignore-scripts)',
    ok: false,
  });
}
const display =
  process.platform !== 'linux' || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
checks.push({ name: 'Desktop display (needed for 3D app, not tests/bridge)', ok: display });
// Local speech: Supertonic (voices) and Whisper (push-to-talk) run through onnxruntime-node.
async function checkVoice() {
  const voiceChecks = [];
  try {
    for (const name of ['onnxruntime-node', '@huggingface/transformers']) require.resolve(name);
    const runtime = createRequire(require.resolve('@huggingface/transformers'));
    const ort = path.dirname(runtime.resolve('onnxruntime-node/package.json'));
    const binding = path.join(ort, 'bin', 'napi-v3', process.platform, process.arch);
    await fs.access(path.join(binding, 'onnxruntime_binding.node'));
    // Load the native modules for real: a missing system library (on Windows the Visual C++
    // runtime) only shows up here.
    runtime('onnxruntime-node');
    runtime('sharp');
    voiceChecks.push({ name: 'Local speech runtime loads (onnxruntime, sharp)', ok: true });
  } catch (error) {
    const failure = runtimeFailure(error);
    voiceChecks.push({
      name:
        failure.code === 'VC_RUNTIME_MISSING'
          ? 'Local speech runtime (install the Microsoft Visual C++ Redistributable)'
          : 'Local speech runtime (run npm ci)',
      ok: false,
      error:
        failure.code === 'VC_RUNTIME_MISSING'
          ? failure.message
          : String(error.message).split('\n')[0],
    });
  }
  const speech = { models: modelsDirectory() };
  for (const kind of KINDS) {
    const status = await readStatus(kind);
    speech[kind] =
      status.state === 'ready'
        ? `${MODELS[kind].label} ready`
        : `${MODELS[kind].label} ${status.state} (${status.sizeLabel}; install from the setup screen or npm run voices:install)`;
  }
  return { voiceChecks, speech };
}
const { voiceChecks, speech } = await checkVoice();
checks.push(...voiceChecks);
// Codex App Server is the default guard brain. Non-fatal: the live bridge and demo work without it.
async function checkCodex() {
  const { createCodexService } = require('../electron/codex.cjs');
  const service = createCodexService();
  let timer;
  try {
    const status = await Promise.race([
      service.status({ refresh: true }),
      new Promise((resolve) => {
        timer = setTimeout(
          () => resolve({ state: 'error', message: 'Timed out checking Codex.' }),
          30000,
        );
      }),
    ]);
    return {
      state: status.state,
      message: status.message,
      ...(status.binaryPath ? { path: status.binaryPath, version: status.version } : {}),
      ...(status.warnings?.length ? { warnings: status.warnings } : {}),
      ...(status.state === 'ready'
        ? {}
        : {
            fix: 'Optional. In Guard Lab setup use "Copy fix prompt", or run: npm install -g @openai/codex && codex login. GUARD_LAB_CODEX can point at a codex executable.',
          }),
    };
  } catch (error) {
    return { state: 'error', message: String(error.message).split('\n')[0] };
  } finally {
    clearTimeout(timer);
    service.close();
  }
}
const codex = await checkCodex();
console.log(
  JSON.stringify(
    {
      ok: checks.every((c) => c.ok),
      version,
      ...(commit ? { commit } : {}),
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      checks,
      speech,
      codex,
    },
    null,
    2,
  ),
);
if (checks.some((c) => !c.ok)) process.exitCode = 1;
