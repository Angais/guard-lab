// Checks a desktop package built by `npm run dist` on this machine before it is shared:
// what app.asar holds, the visible license notices, the macOS signature, that the speech
// runtime loads from the package, and that the packaged app starts with its preload bridge.
// --release also requires the notices and runtimes the release workflow adds; --checksums
// writes a .sha256 file beside each download.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { ROOT } from './paths.mjs';
import { temporaryDirectory, removeTemporary } from '../shared/temporary.mjs';

const flags = new Set(process.argv.slice(2));
const option = (name) =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const release = path.resolve(ROOT, option('out') || 'release');
const { platform, arch } = process;
const { version } = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
  return ok;
};
const exists = (file) =>
  fs.access(file).then(
    () => true,
    () => false,
  );

// electron-builder's output folder for this platform and architecture.
const suffix = arch === 'x64' ? '' : `-${arch}`;
const folder = { darwin: `mac${suffix}`, win32: `win${suffix}-unpacked` }[platform];
const outDir = path.resolve(
  option('dir') || path.join(release, folder || `linux${suffix}-unpacked`),
);
let app = outDir,
  resources = path.join(outDir, 'resources'),
  executable;
if (platform === 'darwin') {
  const bundle = (await fs.readdir(outDir)).find((name) => name.endsWith('.app'));
  if (!bundle) throw new Error(`No .app in ${outDir}. Run npm run dist first.`);
  app = path.join(outDir, bundle);
  resources = path.join(app, 'Contents', 'Resources');
  executable = path.join(app, 'Contents', 'MacOS', bundle.slice(0, -4));
} else {
  const names = platform === 'win32' ? ['Guard Lab.exe'] : ['guard-lab', 'Guard Lab'];
  for (const name of names)
    if (await exists(path.join(outDir, name))) executable = path.join(outDir, name);
  if (!executable) throw new Error(`No Guard Lab executable in ${outDir}. Run npm run dist first.`);
}

// --- app.asar -------------------------------------------------------------------------------
// Header: UInt32 4, UInt32 header pickle size, UInt32 payload size, UInt32 JSON length, JSON.
const asar = await fs.readFile(path.join(resources, 'app.asar'));
const header = JSON.parse(asar.toString('utf8', 16, 16 + asar.readUInt32LE(12)));
const contentStart = 8 + asar.readUInt32LE(4);
const entries = new Map();
(function walk(node, prefix) {
  for (const [name, child] of Object.entries(node.files || {})) {
    const file = prefix + name;
    if (child.files) walk(child, file + '/');
    else entries.set(file, child);
  }
})(header, '');
const read = (file) => {
  const entry = entries.get(file);
  if (entry.unpacked) return fs.readFile(path.join(resources, 'app.asar.unpacked', file), 'utf8');
  const start = contentStart + Number(entry.offset);
  return asar.toString('utf8', start, start + entry.size);
};
const ort = `node_modules/onnxruntime-node/bin/napi-v3/`;
const forbidden = [
  [/\.(map|ts)$/, 'source maps or TypeScript sources'],
  [/^node_modules\/(react|react-dom|scheduler|three|lucide-react|@fontsource)\//, 'renderer-only'],
  [/^node_modules\/(global-agent|roarr|sprintf-js|tar|onnxruntime-web)\//, 'install/browser-only'],
  [/^node_modules\/onnxruntime-node\/script\//, 'install script'],
  [/^node_modules\/@img\/sharp-wasm32\//, 'WebAssembly fallback'],
  [/^(models|speech-cache|recordings|robot-bridge|human-bridge)\//, 'user data'],
  [/\.(onnx|wav)$|(^|\/)\.env$/, 'model weights, recordings or secrets'],
];
const found = new Map();
for (const file of entries.keys()) {
  for (const [pattern, reason] of forbidden)
    if (pattern.test(file)) found.set(reason, [...(found.get(reason) || []), file]);
  if (file.startsWith(ort) && !file.startsWith(`${ort}${platform}/${arch}/`))
    found.set('other OS speech runtime', [...(found.get('other OS speech runtime') || []), file]);
}
for (const [reason, files] of found)
  check(false, `app.asar contains ${reason}: ${files.slice(0, 3).join(', ')} (${files.length})`);
for (const file of [
  'dist/index.html',
  'electron/main.cjs',
  'electron/preload.cjs',
  'shared/bridge.mjs',
  'node_modules/onnxruntime-node/package.json',
  'node_modules/@huggingface/transformers/package.json',
  'node_modules/sharp/package.json',
  `${ort}${platform}/${arch}/onnxruntime_binding.node`,
])
  check(entries.has(file), `app.asar is missing ${file}`);
if (entries.has('package.json'))
  check(JSON.parse(await read('package.json')).version === version, 'app.asar has another version');
const binding = path.join(resources, 'app.asar.unpacked', ort, platform, arch);
check(
  await exists(path.join(binding, 'onnxruntime_binding.node')),
  'onnxruntime is not unpacked from app.asar',
);
if (platform === 'win32' && flags.has('--release'))
  check(
    await exists(path.join(binding, 'msvcp140.dll')),
    'the Visual C++ runtime is not bundled next to onnxruntime',
  );

// --- Visible notices and locales ----------------------------------------------------------
const licenses = [
  'LICENSE.txt',
  'THIRD_PARTY.md',
  'GPL-3.0-LICENSE.md',
  'LGPL-3.0-LICENSE.md',
  'ONNXRUNTIME-LICENSE.md',
  'DM-SANS-LICENSE.md',
  'SPACE-GROTESK-LICENSE.md',
  'libvips-NOTICES.md',
  ...(flags.has('--release') ? ['ONNXRUNTIME-THIRD-PARTY-NOTICES.txt'] : []),
];
for (const name of licenses)
  check(await exists(path.join(resources, 'licenses', name)), `licenses/${name} is missing`);
if (
  !flags.has('--release') &&
  !(await exists(path.join(resources, 'licenses', 'ONNXRUNTIME-THIRD-PARTY-NOTICES.txt')))
)
  console.warn('Note: ONNX Runtime ThirdPartyNotices is added by the release workflow only.');
const localeDirs =
  platform === 'darwin'
    ? [
        resources,
        path.join(app, 'Contents/Frameworks/Electron Framework.framework/Versions/A/Resources'),
      ]
    : [path.join(outDir, 'locales')];
for (const dir of localeDirs) {
  const locales = (await fs.readdir(dir).catch(() => [])).filter((name) =>
    platform === 'darwin' ? name.endsWith('.lproj') : name.endsWith('.pak'),
  );
  const other = locales.filter((name) => !/^en([-_.]|$)/.test(name));
  check(other.length === 0, `non-English Chromium locales in ${dir}: ${other.slice(0, 5)}`);
}

// --- macOS signature -------------------------------------------------------------------------
if (platform === 'darwin') {
  const verify = spawnSync('codesign', ['--verify', '--deep', '--strict', app], {
    encoding: 'utf8',
  });
  check(verify.status === 0, `codesign --verify failed: ${(verify.stderr || '').trim()}`);
  const info = spawnSync('codesign', ['-dv', app], { encoding: 'utf8' }).stderr || '';
  check(
    /Identifier=lab\.guard\.desktop/.test(info),
    'the signature does not name lab.guard.desktop',
  );
}

// --- Speech runtime --------------------------------------------------------------------------
// Voice status only reads model files, so the launch below never loads onnxruntime or sharp.
// Load them as the voice worker would, through the packaged executable in Node mode (Electron's
// RunAsNode fuse, on by default): a missing binary or system library fails without models too.
{
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  for (const name of ['NODE_OPTIONS', 'NODE_PATH']) delete env[name];
  const probe = spawnSync(
    executable,
    [path.join(ROOT, 'scripts', 'speech-runtime-probe.cjs'), path.join(resources, 'app.asar')],
    { env, encoding: 'utf8', timeout: 120000, windowsHide: true },
  );
  let result = null;
  try {
    result = JSON.parse(probe.stdout.trim().split('\n').pop());
  } catch {}
  const detail =
    result?.message ||
    probe.error?.message ||
    (probe.stderr || '').trim().split('\n')[0] ||
    `exit ${probe.status}`;
  if (
    check(
      probe.status === 0 && result?.ok,
      `the speech runtime does not load from the package: ${detail}`,
    )
  )
    console.log(
      `Speech runtime loads: ${result.native.join(', ')} (${result.backends.join(', ')})`,
    );
}

// --- Launch the packaged app ---------------------------------------------------------------
async function launch() {
  const data = await temporaryDirectory('guard-package-');
  const env = { ...process.env, GUARD_LAB_DATA_DIR: data };
  for (const name of ['ELECTRON_RUN_AS_NODE', 'GUARD_LAB_BRIDGE', 'GUARD_LAB_HUMAN_BRIDGE'])
    delete env[name];
  // --dev-url must be ignored by a packaged build; --remote-debugging-port=0 picks a free port.
  const child = spawn(
    executable,
    ['--remote-debugging-port=0', '--dev-url', 'http://127.0.0.1:9/'],
    { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-4000)));
  const exited = once(child, 'exit');
  const deadline = Date.now() + 90000;
  const until = async (what, probe) => {
    for (;;) {
      const value = await probe().catch(() => null);
      if (value) return value;
      if (Date.now() > deadline || child.exitCode !== null)
        throw new Error(`Packaged app: timed out waiting for ${what}.\n${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };
  let socket;
  try {
    const port = await until('DevTools', async () =>
      Number((await fs.readFile(path.join(data, 'DevToolsActivePort'), 'utf8')).split('\n')[0]),
    );
    const base = `http://127.0.0.1:${port}`;
    const page = await until('the window', async () =>
      (await (await fetch(`${base}/json/list`)).json()).find((target) => target.type === 'page'),
    );
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await once(socket, 'open');
    let id = 0;
    const pending = new Map();
    socket.addEventListener('message', ({ data: message }) => {
      const reply = JSON.parse(message);
      pending.get(reply.id)?.(reply);
      pending.delete(reply.id);
    });
    const evaluate = async (expression) => {
      const reply = await new Promise((resolve, reject) => {
        setTimeout(() => reject(new Error(`no reply to ${expression}`)), 60000).unref();
        pending.set(++id, resolve);
        socket.send(
          JSON.stringify({
            id,
            method: 'Runtime.evaluate',
            params: { expression, awaitPromise: true, returnByValue: true },
          }),
        );
      });
      if (reply.result?.exceptionDetails)
        throw new Error(reply.result.exceptionDetails.exception?.description || 'evaluate failed');
      return reply.result?.result?.value;
    };
    await until('the interface', () =>
      evaluate(
        'document.readyState === "complete" && !!document.querySelector("#root")?.children.length',
      ),
    );
    check((await evaluate('location.protocol')) === 'file:', 'the packaged app honoured --dev-url');
    check(
      (await evaluate('window.desktop?.version')) === version,
      'preload reports another version',
    );
    const voice = await evaluate('window.desktop.voice.status()');
    check(voice?.tts?.state && voice?.stt?.state, 'voice status did not resolve');
    const codex = await until('Codex status', () => evaluate('window.desktop.codex.status()'));
    const webgl = await evaluate('Boolean(document.querySelector("canvas")?.getContext("webgl2"))');
    console.log(
      `Launched ${path.relative(ROOT, executable)}: voices ${voice?.tts?.state}/${voice?.stt?.state}, ` +
        `Codex ${codex.state}, WebGL2 ${webgl ? 'yes' : 'no (no GPU here)'}`,
    );
  } finally {
    socket?.close();
    child.kill();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await removeTemporary(data);
  }
}
if (!flags.has('--no-launch')) await launch().catch((error) => check(false, error.message));

// --- Checksums ----------------------------------------------------------------------------
if (flags.has('--checksums'))
  for (const name of await fs.readdir(release)) {
    if (!/\.(zip|exe|AppImage|dmg)$/.test(name)) continue;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path.join(release, name))) hash.update(chunk);
    const sum = `${hash.digest('hex')}  ${name}\n`;
    await fs.writeFile(path.join(release, name.replace(/\.[^.]+$/, '.sha256')), sum);
    process.stdout.write(sum);
  }

if (failures.length) {
  console.error(`Package check failed:\n- ${failures.join('\n- ')}`);
  process.exitCode = 1;
} else console.log(`OK: ${path.relative(ROOT, app)} (${entries.size} files in app.asar)`);
