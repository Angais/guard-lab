// Desktop packages. Speech models are not bundled: the setup screen downloads Kokoro (voices)
// and Whisper (push-to-talk) into the user's data folder. The native speech runtimes are
// unpacked from the asar so the voice utility process can load them, and each OS package
// carries only its own onnxruntime binaries.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const onnxBinaries = 'node_modules/onnxruntime-node/bin/napi-v3';

// --- Main-process dependencies only ------------------------------------------------------
// Vite bundles the renderer (React, Three.js, icons, fonts) into dist, so those are
// devDependencies. Of the production graph, keep only what the main process can load from
// package.json `dependencies`. The edges below are never followed at run time:
// onnxruntime-node's install script fetches with global-agent and unpacks with tar;
// transformers.js loads onnxruntime-web only in browsers; sharp's WebAssembly build is a
// fallback for platforms without a native binary, and every package ships a native one.
const NOT_LOADED = {
  'onnxruntime-node': ['global-agent', 'tar'],
  '@huggingface/transformers': ['onnxruntime-web'],
  sharp: ['@img/sharp-wasm32'],
};
function unusedPackages(root = __dirname) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const entries = lock.packages;
  const resolve = (from, name) => {
    for (let dir = from; ; dir = dir.slice(0, Math.max(0, dir.lastIndexOf('/node_modules/')))) {
      const key = `${dir ? dir + '/' : ''}node_modules/${name}`;
      if (entries[key]) return key;
      if (!dir) return null;
    }
  };
  const loaded = new Set();
  const visit = (key) => {
    // Optional platform packages that npm did not install for this machine stay unvisited.
    if (!key || loaded.has(key) || !fs.existsSync(path.join(root, key))) return;
    loaded.add(key);
    const entry = entries[key];
    const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    for (const dependency of Object.keys({
      ...entry.dependencies,
      ...entry.optionalDependencies,
    }))
      if (!NOT_LOADED[name]?.includes(dependency)) visit(resolve(key, dependency));
  };
  for (const name of Object.keys(entries[''].dependencies || {})) visit(`node_modules/${name}`);
  return Object.keys(entries).filter(
    (key) => key && !entries[key].dev && !loaded.has(key) && fs.existsSync(path.join(root, key)),
  );
}

const files = [
  'dist/**/*',
  'electron/**/*',
  'shared/**/*',
  'package.json',
  // LICENSE, THIRD_PARTY.md and docs/*-LICENSE.md ship visibly as extraResources (below).
  // Browser builds, sources, type declarations and maps the Node speech runtime never loads.
  '!**/*.{map,ts}',
  '!node_modules/onnxruntime-node/script/**',
  ...unusedPackages().map((key) => `!${key}/**`),
  '!node_modules/@huggingface/transformers/{src,types}/**',
  '!node_modules/@huggingface/transformers/dist/ort-wasm*',
  '!node_modules/@huggingface/transformers/dist/transformers.{js,min.js,web.js,web.min.js}',
  '!node_modules/@huggingface/transformers/dist/transformers.node.min.*',
  '!node_modules/kokoro-js/{types/**,dist/kokoro.web.js}',
  // Only the English Kokoro voice styles are offered.
  '!node_modules/kokoro-js/voices/{e,f,h,i,j,p,z}[fm]_*.bin',
];
// Platform `files` replace the top-level list, so each repeats it and then drops the other
// operating systems' and architectures' onnxruntime binaries.
const filesFor = (os) => [
  ...files,
  ...['darwin', 'win32', 'linux']
    .filter((other) => other !== os)
    .map((other) => `!${onnxBinaries}/${other}/**`),
  `!${onnxBinaries}/${os}/!(\${arch})/**`,
];

// --- Windows: Microsoft Visual C++ runtime -------------------------------------------------
// onnxruntime's Windows binaries link MSVCP140/VCRUNTIME140, which Electron does not ship and
// many PCs lack. Copy the redistributable DLLs next to every unpacked native module that needs
// them (Windows searches a loaded DLL's own folder for its dependencies). Sources, in order:
// GUARD_LAB_VC_RUNTIME_DIR, VCToolsRedistDir (VS developer shell), the newest Visual Studio
// redist folder found with vswhere, then System32 when it holds the target architecture.
const PE_MACHINES = { ia32: 0x14c, x64: 0x8664, arm64: 0xaa64 };
const ARCH_NAMES = ['ia32', 'x64', 'armv7l', 'arm64', 'universal']; // builder-util Arch enum
const RUNTIME_DLL = '(?:msvcp140(?:_[0-9a-z]+)?|vcruntime140(?:_[0-9a-z]+)?|concrt140)\\.dll';
const isRuntimeDll = (name) => new RegExp(`^${RUNTIME_DLL}$`, 'i').test(name);
const REDIST_ARCH = { ia32: 'x86', x64: 'x64', arm64: 'arm64' };

function peMachine(file) {
  try {
    const handle = fs.openSync(file, 'r');
    try {
      const header = Buffer.alloc(4096);
      fs.readSync(handle, header, 0, header.length, 0);
      const offset = header.readUInt32LE(0x3c);
      if (header.toString('latin1', 0, 2) !== 'MZ' || offset + 6 > header.length) return null;
      if (header.toString('latin1', offset, offset + 4) !== 'PE\0\0') return null;
      return header.readUInt16LE(offset + 4);
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return null;
  }
}

/** Unpacked folders whose .node/.dll files import VC++ runtime DLLs → the names they need. */
function runtimeNeeds(root) {
  const needs = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(node|dll)$/i.test(entry.name) && !isRuntimeDll(entry.name)) {
        const imports = fs
          .readFileSync(file)
          .toString('latin1')
          .match(new RegExp(RUNTIME_DLL, 'gi'));
        const names = new Set((imports || []).map((name) => name.toLowerCase()));
        if (names.size) needs.set(dir, new Set([...(needs.get(dir) || []), ...names]));
      }
    }
  };
  if (fs.existsSync(root)) walk(root);
  return needs;
}

function crtFolder(redistVersionDir, arch) {
  const base = path.join(redistVersionDir, REDIST_ARCH[arch] || arch);
  try {
    const crt = fs.readdirSync(base).find((name) => /^Microsoft\.VC\d+\.CRT$/i.test(name));
    return crt ? path.join(base, crt) : null;
  } catch {
    return null;
  }
}

function visualStudioRedists(arch) {
  if (process.platform !== 'win32') return [];
  const vswhere = path.join(
    process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    'Microsoft Visual Studio',
    'Installer',
    'vswhere.exe',
  );
  if (!fs.existsSync(vswhere)) return [];
  const result = spawnSync(vswhere, ['-products', '*', '-sort', '-property', 'installationPath'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const folders = [];
  for (const install of String(result.stdout || '')
    .split(/\r?\n/)
    .filter(Boolean)) {
    const msvc = path.join(install.trim(), 'VC', 'Redist', 'MSVC');
    let versions = [];
    try {
      versions = fs.readdirSync(msvc).filter((name) => /^\d+\.\d+/.test(name));
    } catch {}
    versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const version of versions) {
      const crt = crtFolder(path.join(msvc, version), arch);
      if (crt) folders.push(crt);
    }
  }
  return folders;
}

function runtimeSources(arch) {
  const sources = [];
  if (process.env.GUARD_LAB_VC_RUNTIME_DIR)
    sources.push(path.resolve(process.env.GUARD_LAB_VC_RUNTIME_DIR));
  if (process.env.VCToolsRedistDir) sources.push(crtFolder(process.env.VCToolsRedistDir, arch));
  sources.push(...visualStudioRedists(arch));
  if (process.platform === 'win32')
    sources.push(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'));
  return sources.filter(Boolean);
}

/** The first source folder holding every needed DLL for `arch`, as name → path. */
function findRuntime(arch, names) {
  for (const folder of runtimeSources(arch)) {
    let listing;
    try {
      listing = new Map(fs.readdirSync(folder).map((name) => [name.toLowerCase(), name]));
    } catch {
      continue;
    }
    const found = new Map();
    for (const name of names) {
      const file = listing.has(name) && path.join(folder, listing.get(name));
      if (file && peMachine(file) === PE_MACHINES[arch]) found.set(name, file);
    }
    if (found.size === names.size) return { folder, files: found };
  }
  return null;
}

async function bundleWindowsRuntime(context) {
  if (context.electronPlatformName !== 'win32') return;
  const arch = typeof context.arch === 'number' ? ARCH_NAMES[context.arch] : context.arch;
  const unpacked = path.join(context.appOutDir, 'resources', 'app.asar.unpacked');
  const needs = runtimeNeeds(unpacked);
  if (!needs.size) return;
  const names = new Set([...needs.values()].flatMap((set) => [...set]).sort());
  const runtime = PE_MACHINES[arch] && findRuntime(arch, names);
  if (!runtime) {
    const message =
      `Visual C++ runtime for ${arch} not found (${[...names].join(', ')}). ` +
      'Local speech will need the Microsoft Visual C++ Redistributable on the target PC. ' +
      'Build on Windows with Visual Studio Build Tools, or set GUARD_LAB_VC_RUNTIME_DIR.';
    // Release builds (desktop-build.yml) must not ship a package whose voices cannot load.
    if (process.env.GUARD_LAB_REQUIRE_VC_RUNTIME) throw new Error(message);
    console.warn(`  • Guard Lab: ${message}`);
    return;
  }
  for (const [dir, wanted] of needs)
    for (const name of wanted) {
      const target = path.join(dir, name);
      if (!fs.existsSync(target)) fs.copyFileSync(runtime.files.get(name), target);
    }
  console.log(
    `  • Guard Lab: bundled Visual C++ runtime (${[...names].join(', ')}) from ${runtime.folder}`,
  );
}

// --- Visible license notices --------------------------------------------------------------
// extraResources copies the license texts to a visible resources/licenses folder instead of
// hiding them in app.asar. electron-builder strips package READMEs, and sharp's libvips README
// is the only list of the libraries bundled in its shared library, so afterPack copies it too.
function resourcesDirectory(context) {
  if (context.electronPlatformName !== 'darwin') return path.join(context.appOutDir, 'resources');
  const app = fs.existsSync(context.appOutDir)
    ? fs.readdirSync(context.appOutDir).find((name) => name.endsWith('.app'))
    : null;
  return app ? path.join(context.appOutDir, app, 'Contents', 'Resources') : null;
}

function copyLibvipsNotices(context) {
  const resources = resourcesDirectory(context);
  if (!resources || !fs.existsSync(resources)) return;
  const arch = typeof context.arch === 'number' ? ARCH_NAMES[context.arch] : context.arch;
  const platform = context.electronPlatformName;
  const notice = [`sharp-libvips-${platform}-${arch}`, `sharp-${platform}-${arch}`]
    .map((name) => path.join(__dirname, 'node_modules', '@img', name, 'README.md'))
    .find(
      (file) => fs.existsSync(file) && /third-party libraries/.test(fs.readFileSync(file, 'utf8')),
    );
  if (!notice) {
    console.warn(`  • Guard Lab: no libvips license list found for ${platform}-${arch}.`);
    return;
  }
  fs.mkdirSync(path.join(resources, 'licenses'), { recursive: true });
  fs.copyFileSync(notice, path.join(resources, 'licenses', 'libvips-NOTICES.md'));
}

async function afterPack(context) {
  await bundleWindowsRuntime(context);
  copyLibvipsNotices(context);
}

// Ad-hoc signing gives the macOS app a valid signature that covers the renamed bundle, so a
// downloaded copy opens through Privacy & Security → Open Anyway instead of being reported as
// damaged. With CSC_LINK or CSC_NAME, sign with that Developer ID and hardened runtime; the
// entitlements keep Electron's JIT and the push-to-talk microphone working under it.
const developerId = Boolean(process.env.CSC_LINK || process.env.CSC_NAME);

module.exports = {
  appId: 'lab.guard.desktop',
  productName: 'Guard Lab',
  directories: { output: 'release' },
  // No auto-updater: skip app-update.yml/latest*.yml, which would embed the Git remote.
  publish: null,
  files,
  extraResources: [
    { from: 'LICENSE', to: 'licenses/LICENSE.txt' },
    { from: 'THIRD_PARTY.md', to: 'licenses/THIRD_PARTY.md' },
    { from: 'docs', to: 'licenses', filter: ['*-LICENSE.md'] },
    // Upstream notices the release workflow fetches (ONNX Runtime's ThirdPartyNotices).
    ...(fs.existsSync(path.join(__dirname, '.cache', 'licenses'))
      ? [{ from: '.cache/licenses', to: 'licenses' }]
      : []),
  ],
  asar: true,
  asarUnpack: [
    'node_modules/onnxruntime-node/**',
    'node_modules/onnxruntime-common/**',
    'node_modules/sharp/**',
    'node_modules/@img/**',
  ],
  // The interface, voices and speech recognition are English only.
  electronLanguages: ['en'],
  // Native dependencies ship N-API prebuilds; nothing needs compiling for Electron.
  npmRebuild: false,
  afterPack,
  icon: 'public/icon.png',
  // The zip is an unpacked folder that starts instantly. The portable .exe is a single file
  // that extracts the whole app to a temporary folder on every launch.
  win: {
    target: ['zip', 'portable'],
    signExecutable: false,
    files: filesFor('win32'),
    artifactName: 'Guard-Lab-${version}-Windows-${arch}.${ext}',
  },
  portable: { artifactName: 'Guard-Lab-${version}-Windows-${arch}-portable.${ext}' },
  mac: {
    target: ['zip'],
    category: 'public.app-category.games',
    files: filesFor('darwin'),
    artifactName: 'Guard-Lab-${version}-macOS-${arch}.${ext}',
    ...(developerId ? { hardenedRuntime: true } : { identity: '-', hardenedRuntime: false }),
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    extendInfo: {
      NSMicrophoneUsageDescription:
        'Guard Lab uses your microphone only while you hold the push-to-talk key, to turn your voice into text on this device.',
    },
  },
  linux: {
    target: ['AppImage'],
    category: 'Game',
    maintainer: 'Guard Lab contributors',
    // npm ci on Linux x64 may add onnxruntime's CUDA/TensorRT providers; speech runs on the CPU.
    files: [
      ...filesFor('linux'),
      `!${onnxBinaries}/linux/*/libonnxruntime_providers_{cuda,tensorrt}.so`,
    ],
    // AppImage names x64 as x86_64.
    artifactName: 'Guard-Lab-${version}-Linux-${arch}.${ext}',
  },
};
