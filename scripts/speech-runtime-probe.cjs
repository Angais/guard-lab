// Loads the local speech runtime the way the voice worker does, without any model:
// shared/voice-models.mjs, @huggingface/transformers and onnxruntime-node, and through them the
// native onnxruntime-node and sharp addons. verify-package.mjs runs it with the packaged executable in
// Node mode, so a file, binary or system library the package lacks (on Windows the Visual C++
// runtime) fails here even on a machine without voice models:
//   ELECTRON_RUN_AS_NODE=1 "<executable>" scripts/speech-runtime-probe.cjs <resources>/app.asar
// Prints one JSON line and exits 1 when anything fails to load or comes from outside the app.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

const app = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const models = path.join(app, 'shared', 'voice-models.mjs');
const load = createRequire(models);
// Native addons are recorded under app.asar but read from app.asar.unpacked.
const inside = (file) =>
  [app, `${app}.unpacked`].some((root) => {
    const relative = path.relative(root, file);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  });

// voice-models.mjs imports transformers and onnxruntime-node from shared/, which resolves
// to the app's top-level node_modules. Their ES builds (and sharp's) are separate files.
async function importEntry(name) {
  const root = path.join(app, 'node_modules', ...name.split('/'));
  const { exports: map } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const entry = map?.node?.import?.default ?? map?.node?.import;
  if (typeof entry !== 'string') throw new Error(`${name} has no Node ES module entry`);
  return import(pathToFileURL(path.join(root, entry)).href);
}

async function main() {
  // CommonJS first: require.cache then shows where every package came from.
  const ort = load('onnxruntime-node');
  const sharp = load('sharp');
  load('@huggingface/transformers');
  const files = Object.keys(require.cache).filter((file) => file !== __filename);
  // Module lookup walks up parent folders: a package missing from the app could otherwise load
  // from a checkout's node_modules around the release folder.
  const outside = files.filter((file) => !inside(file));
  if (outside.length)
    throw new Error(`loaded from outside the app: ${outside.slice(0, 3).join(', ')}`);
  await import(pathToFileURL(models).href);
  await importEntry('@huggingface/transformers');
  // Supertonic runs on onnxruntime-node directly (a CommonJS package, imported as voice-models does).
  await import(pathToFileURL(load.resolve('onnxruntime-node')).href);
  // sharp's addon links libvips: one tiny encode shows it runs, not only that it opened.
  await sharp({ create: { width: 1, height: 1, channels: 3, background: '#000' } })
    .png()
    .toBuffer();
  return {
    ok: true,
    modules: files.length,
    native: files.filter((file) => file.endsWith('.node')).map((file) => path.basename(file)),
    backends: ort.listSupportedBackends?.().map((backend) => backend.name) ?? [],
  };
}

main().then(
  (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
  (error) => {
    const message = String(error?.message || error).split('\n')[0];
    process.stdout.write(`${JSON.stringify({ ok: false, code: error?.code || null, message })}\n`);
    process.exitCode = 1;
  },
);
