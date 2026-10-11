// Electron utilityProcess entry: Supertonic (text to speech) and Whisper (speech to text) run here,
// off the main process, and stay loaded after first use.
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Model downloads use Chromium's network stack so system proxy (PAC/WPAD) settings and the OS
// certificate store apply, as in a browser. The CLI installer keeps Node's fetch.
let fetchImpl;
try {
  const { net } = require('electron');
  if (typeof net?.fetch === 'function') fetchImpl = (url, init) => net.fetch(url, init);
} catch {}

const port = process.parentPort;
const engine = import(
  pathToFileURL(path.join(__dirname, '..', 'shared', 'voice-models.mjs')).href
).then(
  ({ VoiceEngine, modelsDirectory }) =>
    new VoiceEngine({ dir: process.env.GUARD_LAB_MODELS_DIR || modelsDirectory(), fetchImpl }),
);

const operations = {
  status: (voice) => voice.status(),
  install: (voice, { kind }) =>
    voice.install(kind, {
      onProgress: (progress) => port.postMessage({ event: 'progress', kind, progress }),
    }),
  remove: (voice, { kind }) => voice.remove(kind),
  warm: (voice, { kind }) => voice.warm(kind),
  synthesize: (voice, args, signal) => voice.synthesize(args, { signal }),
  transcribe: (voice, args) => voice.transcribe(args),
};

// Requests that can be abandoned (a stopped line's speech): id → AbortController.
const running = new Map();

port.on('message', async ({ data }) => {
  const { id, op, args = {} } = data || {};
  if (op === 'abort') return running.get(args?.target)?.abort();
  const controller = new AbortController();
  running.set(id, controller);
  try {
    if (!Object.hasOwn(operations, op)) throw new Error('Unknown voice request.');
    const result = await operations[op](await engine, args, controller.signal);
    port.postMessage({ id, ok: true, result });
  } catch (error) {
    port.postMessage({
      id,
      ok: false,
      error: { message: error?.message || String(error), code: error?.code || null },
    });
  } finally {
    running.delete(id);
  }
});
