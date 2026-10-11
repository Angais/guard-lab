import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT } from './paths.mjs';
const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
let server,
  desktop,
  stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  desktop?.kill();
  await server?.close();
  process.exitCode = code;
}

// Everything the renderer bundle is built from.
const RENDERER_SOURCES = [
  'src',
  'shared',
  'public',
  'index.html',
  'vite.config.js',
  'package.json',
  'package-lock.json',
];
async function newestChange(entries) {
  let newest = 0;
  for (const entry of entries) {
    const stat = await fs.stat(entry).catch(() => null);
    if (!stat) continue;
    if (!stat.isDirectory()) newest = Math.max(newest, stat.mtimeMs);
    else
      for (const child of await fs.readdir(entry))
        newest = Math.max(newest, await newestChange([path.join(entry, child)]));
  }
  return newest;
}

// `npm run play`: open the built game as its own process and return at once. The window does
// not depend on this terminal, so closing it (or an agent task ending) leaves the game open.
async function play(extra) {
  const index = path.join(ROOT, 'dist', 'index.html');
  const built = (await fs.stat(index).catch(() => null))?.mtimeMs || 0;
  if (built < (await newestChange(RENDERER_SOURCES.map((entry) => path.join(ROOT, entry))))) {
    console.log('Building the game…');
    const { build } = await import('vite');
    await build({ root: ROOT, logLevel: 'error' });
  }
  const child = spawn(require('electron'), [ROOT, ...extra], {
    cwd: ROOT,
    env,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
  // A second launch hands over to the open window and exits; a failed launch exits non-zero.
  let timer;
  const exit = await new Promise((resolve) => {
    child.once('error', (error) => resolve({ error }));
    child.once('exit', (code) => resolve({ code }));
    timer = setTimeout(() => resolve(null), 3000);
  });
  clearTimeout(timer);
  if (!exit) console.log(`Guard Lab is open (process ${child.pid}). Close its window to quit.`);
  else if (exit.code === 0) console.log('Guard Lab was already open; its window is in front.');
  else {
    console.error(
      `Guard Lab did not start (${exit.error?.message || `exit code ${exit.code}`}).`,
      '\nRun npm run doctor, or npm start to see its output.',
    );
    process.exitCode = 1;
  }
}

async function develop() {
  const { createServer } = await import('vite');
  server = await createServer({
    root: ROOT,
    server: { host: '127.0.0.1', port: 5173, strictPort: false },
  });
  await server.listen();
  const url = `http://127.0.0.1:${server.httpServer.address().port}`;
  desktop = spawn(require('electron'), [ROOT, '--dev-url', url, ...args], {
    cwd: ROOT,
    env,
    stdio: 'inherit',
    // This process owns the interactive game window, not a background helper.
    windowsHide: false,
  });
  desktop.on('error', async (e) => {
    console.error('Desktop launch failed:', e.message);
    await stop(1);
  });
  desktop.on('exit', (code) => stop(code || 0));
  console.log('Guard Lab opened. Close its window to stop the launcher.');
  process.on('SIGINT', () => stop());
  process.on('SIGTERM', () => stop());
}

try {
  if (args.includes('--detach')) await play(args.filter((arg) => arg !== '--detach'));
  else await develop();
} catch (e) {
  console.error('Start failed:', e.message, '\nRun node scripts/setup.mjs, then npm run doctor.');
  await stop(1);
}
