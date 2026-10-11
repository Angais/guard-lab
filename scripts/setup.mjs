import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { ROOT } from './paths.mjs';
const require = createRequire(import.meta.url);
// Speech models (Supertonic voices, Whisper speech-to-text) install from the app's setup screen.
// Pass --voices to download them here as well.
const withVoices = process.argv.includes('--voices');
// Electron 44 and Vite 7 need Node.js 22.12 (require of ES modules) or newer.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  console.error(
    `Install Node.js 22.12 or newer from https://nodejs.org (current: ${process.versions.node}), then run this command again.`,
  );
  process.exit(1);
}
const stamp = path.join(ROOT, 'node_modules', '.guard-lab-install.json');
const fingerprint = createHash('sha256')
  .update(await fs.readFile(path.join(ROOT, 'package-lock.json')))
  .update(`${process.platform}/${process.arch}/${process.versions.node.split('.')[0]}`)
  .digest('hex');
async function installed() {
  try {
    for (const name of ['vite', 'onnxruntime-node', '@huggingface/transformers'])
      require.resolve(name);
    await fs.access(require('electron'));
    return true;
  } catch {
    return false;
  }
}
const saved = await fs
  .readFile(stamp, 'utf8')
  .then(JSON.parse)
  .catch(() => null);
if (
  !process.argv.includes('--force') &&
  saved?.fingerprint === fingerprint &&
  (await installed())
) {
  console.log(
    'Locked dependencies are already installed. Ready: npm run play. Use --force to reinstall.',
  );
  await finish();
  process.exit(process.exitCode || 0);
}
async function finish() {
  if (!withVoices) {
    console.log('Speech models install from the in-app setup screen (or: npm run voices:install).');
    return;
  }
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'install-voices.mjs')], {
    cwd: ROOT,
    stdio: 'inherit',
    windowsHide: true,
  });
  const [code] = await new Promise((resolve) =>
    child.on('exit', (...args) => resolve(args)).on('error', () => resolve([1])),
  );
  if (code !== 0) {
    console.error('Speech models were not installed. Retry later with: npm run voices:install');
    process.exitCode = code || 1;
  }
}
console.log(
  'Installing the locked dependencies. No account, API key, or model is required for demo mode.',
);
const install = spawn(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['ci', '--no-audit', '--no-fund', '--no-progress'],
  {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    windowsHide: true,
    // onnxruntime-node would otherwise fetch optional CUDA libraries on Linux x64.
    env: {
      ...process.env,
      ONNXRUNTIME_NODE_INSTALL_CUDA: process.env.ONNXRUNTIME_NODE_INSTALL_CUDA || 'skip',
    },
  },
);
install.on('error', (e) => {
  console.error('Could not run npm:', e.message);
  process.exitCode = 1;
});
install.on('exit', async (code) => {
  if (code !== 0) {
    process.exitCode = code || 1;
    console.error(
      'Setup failed. Check network/proxy access to npm and Electron downloads, then retry. No game data was changed.',
    );
    return;
  }
  if (!(await installed())) {
    console.error(
      'Electron did not download. Remove ELECTRON_SKIP_BINARY_DOWNLOAD / ignore-scripts settings, then rerun setup with --force.',
    );
    process.exitCode = 1;
    return;
  }
  await fs.writeFile(stamp, JSON.stringify({ fingerprint }));
  console.log(
    '\nReady. npm run play opens Guard Lab (npm start runs it from this terminal instead).\nRun npm run doctor for diagnostics. Read AGENTS.md before playing as an AI.',
  );
  await finish();
});
