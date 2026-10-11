// Local speech models: Supertonic 2 (text to speech) and Whisper base.en (speech to text).
// Used by the Electron voice worker and by `npm run voices:install`. Model files live in
// dataDirectory()/models; nothing is fetched outside installModel().
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import runtime from './runtime.cjs';
import { voiceStyle, resolveVoice, DEFAULT_VOICES } from './voice-catalog.mjs';
import {
  STT_SAMPLE_RATE,
  encodeWav,
  resample,
  isSilent,
  cleanTranscript,
  speakableText,
  spellNumbers,
  sentenceChunks,
  joinAudio,
  sizeLabel,
} from './voice-audio.mjs';

export * from './voice-audio.mjs';
export const MARKER_VERSION = 1;
export const KINDS = Object.freeze(['tts', 'stt']);

// `from` names the file's upstream location when it differs from the component's repo/path.
const file = (name, size, sha256, from) =>
  Object.freeze({ path: name, size, sha256, ...(from ? from : {}) });
// Supertonic 2's int8 ONNX conversion by k2-fsa/sherpa-onnx (same OpenRAIL-M weights).
const INT8 = Object.freeze({
  repo: 'csukuangfj2/sherpa-onnx-supertonic-tts-int8-2026-03-06',
  revision: '5dec5897b86e2b293790eedb5e1f561a3295651f',
});
const int8 = (name, size, sha256) => file('int8/' + name, size, sha256, { ...INT8, remote: name });
const style = (name, size, sha256) => file(`voice_styles/${name}.json`, size, sha256);

// Revisions are pinned to upstream commits; sizes and SHA-256 digests verify every byte.
export const MODELS = Object.freeze({
  tts: Object.freeze({
    kind: 'tts',
    label: 'Supertonic 2',
    title: 'Supertonic voices',
    repo: 'Supertone/supertonic-2',
    revision: '75e6727618a02f323c720cba9478152d4bc16ca4',
    dtype: 'int8',
    // The weights are never bundled: the player downloads them and their license applies.
    license: Object.freeze({
      name: 'OpenRAIL-M',
      url: 'https://huggingface.co/Supertone/supertonic-2/blob/main/LICENSE',
    }),
    // Earlier releases' Kokoro model: reported in status, deleted once Supertonic is installed.
    legacy: Object.freeze([
      Object.freeze({ model: 'Kokoro-82M', path: 'onnx-community/Kokoro-82M-v1.0-ONNX' }),
    ]),
    files: Object.freeze([
      file('LICENSE', 15007, '0d944a9110fed9a9602d60e0423a272903e7bd21ab060490774efc77c2275e9f'),
      file(
        'onnx/tts.json',
        8699,
        'ee531d9af9b80438a2ed703e22155ee6c83b12595ab22fd3bb6de94c7502fe96',
      ),
      file(
        'onnx/unicode_indexer.json',
        262196,
        'b7662a73a0703f43b97c0f2e089f8e8325e26f5d841aca393b5a54c509c92df1',
      ),
      style('M1', 420510, 'a04c823cbda6dd1c7de131ec68fea83bbb70d7f29d61623304eb871e3b83b5a1'),
      style('M2', 420285, '7ddd07bf873a3fd67d09ef4e8293b486beb658158b47e371166198e4c6926072'),
      style('M3', 420005, 'e8e77a56459e4dc8cdfeb88e6f778dc9a0adf22e1184414f4b0e82a5d1edbe72'),
      style('M4', 419957, '95322725e4d25d9ed4e7dcccbf0f3726b0e9a2471d876b7942373218dbd30174'),
      style('M5', 419619, 'be52f82327da63ff18481ce2dd8060c7df432e0168d748745ef3e21b92d706a5'),
      style('F1', 420050, '6106950ebeb8a5da29ea22075f605db659cd07dbc288a68292543d9129aa250f'),
      style('F2', 420293, '8b97feb16d79ac0447136796708feac5f83dbabe92a5be1168212653c38729ae'),
      style('F3', 419887, '7eda5bccb4e6eb7f228fa182462d5fcf982d77628234603599027f0734d70c29'),
      style('F4', 419642, 'e056fc2bee393edc8bff761eb28f33fb461e8dad828c3b05348a010ac1b7bb79'),
      style('F5', 419709, 'ce7645ad7e3c13cca04e0d62bf890ef9ac401988005ba8f5e9c9b59257bc6931'),
      int8('LICENSE', 1070, '0dfe0d0ba84416fe3879d9a34f4909d8d0137c78d1e95834177b0414ac096fa2'),
      int8(
        'duration_predictor.int8.onnx',
        1521526,
        '6d556b3691165c364be91dc0bd894656b5949f5acd2750d8ec2f954010845011',
      ),
      int8(
        'text_encoder.int8.onnx',
        27431318,
        'dd5f535ed629f7df86071043e15f541ce1b2ab7f1bdbce4c7892b307bca79fa3',
      ),
      int8(
        'vector_estimator.int8.onnx',
        40686657,
        '9cce89801068dc998719fbc91777f99f3f4d16ee36592281f8703f32e305daa2',
      ),
      int8(
        'vocoder.int8.onnx',
        25977132,
        'db99c36fb871fbfb128b903662995f2e22213e875f2434f319f8d10ee0f10e90',
      ),
    ]),
  }),
  stt: Object.freeze({
    kind: 'stt',
    label: 'Whisper base.en',
    title: 'Whisper speech-to-text',
    repo: 'onnx-community/whisper-base.en',
    revision: '51eefc0af78b103839eda9e7e4f4186acc6517fe',
    dtype: Object.freeze({ encoder_model: 'fp32', decoder_model_merged: 'q8' }),
    files: Object.freeze([
      file('config.json', 2197, 'c8a0de5ed8a083565a4319db29d0c210fda35b4d6076c2d711cae53ae00f3cb1'),
      file(
        'generation_config.json',
        1556,
        '3479b1f44a07e41db799e22599222fee5816738036def94a39841cb9cdbb4120',
      ),
      file(
        'preprocessor_config.json',
        339,
        'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d',
      ),
      file(
        'tokenizer.json',
        2405679,
        '5eb60cec1e77aeeb6869a2bb5a8e01a84c3fe5d072d75369343021fe6f5310d0',
      ),
      file(
        'tokenizer_config.json',
        282662,
        '93879c3dccdd4b976f709acd85b44778873f30c275e67026f30ca1e4c975230c',
      ),
      file(
        'onnx/encoder_model.onnx',
        82468078,
        '1cc86302d480b061452d348638064383ab41b6f3333ddd0e423532d14edaf535',
      ),
      file(
        'onnx/decoder_model_merged_quantized.onnx',
        53692803,
        'dd4761a3f7add26afda3512abff4706920404c2517e85a9f2ff090b0c0987909',
      ),
    ]),
  }),
});

export const modelsDirectory = (root = runtime.dataDirectory()) => path.join(root, 'models');
export const totalBytes = (spec) => spec.files.reduce((sum, f) => sum + f.size, 0);
const modelRoot = (dir, spec) => path.join(dir, ...spec.repo.split('/'));
const markerPath = (dir, spec) => path.join(dir, spec.kind + '.json');
const specFor = (kind, spec) => {
  if (spec) return spec;
  if (!KINDS.includes(kind)) throw new Error('Unknown voice component: ' + kind);
  return MODELS[kind];
};
const sameDtype = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// Where a file comes from upstream: its own repo/revision/path, or the component's.
const upstream = (spec, entry) => ({
  repo: entry.repo || spec.repo,
  revision: entry.revision || spec.revision,
  remote: entry.remote || entry.path,
});
// Every upstream commit a component is built from (markers written before this field existed
// name only their own repo and revision).
const sourcesOf = (spec) =>
  [
    ...new Set(
      spec.files.map((entry) => upstream(spec, entry)).map((u) => u.repo + '@' + u.revision),
    ),
  ].sort();

async function folderBytes(root) {
  let bytes = 0;
  for (const name of await fs.readdir(root, { recursive: true }).catch(() => [])) {
    const stat = await fs.stat(path.join(root, name)).catch(() => null);
    if (stat?.isFile()) bytes += stat.size;
  }
  return bytes;
}

/** Disk use of an earlier release's model for this component (null when none is left). */
async function legacyStatus(dir, spec) {
  let bytes = 0;
  const models = [];
  for (const old of spec.legacy || []) {
    const size = await folderBytes(path.join(dir, ...old.path.split('/')));
    if (size) {
      bytes += size;
      models.push(old.model);
    }
  }
  return bytes ? { model: models.join(', '), bytes, sizeLabel: sizeLabel(bytes) } : null;
}

/** Delete an earlier release's model for this component. Never touches other components. */
async function removeLegacy(dir, spec) {
  for (const old of spec.legacy || []) {
    const root = path.join(dir, ...old.path.split('/'));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 4 }).catch(() => {});
    // The organisation folder is shared (Whisper is onnx-community/whisper-base.en): only an
    // empty one is removed.
    await fs.rmdir(path.dirname(root)).catch(() => {});
  }
}

async function component(spec, state, message, { dir } = {}) {
  const total = totalBytes(spec);
  const legacy = dir && spec.legacy ? await legacyStatus(dir, spec) : null;
  return {
    state,
    progress: state === 'ready' ? 1 : 0,
    bytes: state === 'ready' ? total : 0,
    totalBytes: total,
    sizeLabel: sizeLabel(total),
    model: spec.label,
    message,
    ...(spec.license ? { license: { ...spec.license } } : {}),
    ...(legacy ? { legacy } : {}),
  };
}

/** Cheap status check: marker matches this spec and every file has the expected size. */
export async function readStatus(kind, { dir = modelsDirectory(), spec } = {}) {
  spec = specFor(kind, spec);
  const marker = await fs
    .readFile(markerPath(dir, spec), 'utf8')
    .then(JSON.parse)
    .catch(() => null);
  const status = (state, message) => component(spec, state, message, { dir });
  if (!marker) return status('missing', 'Not installed');
  if (
    marker.version !== MARKER_VERSION ||
    marker.repo !== spec.repo ||
    marker.revision !== spec.revision ||
    !sameDtype(marker.dtype, spec.dtype) ||
    !sameDtype(marker.sources || [marker.repo + '@' + marker.revision], sourcesOf(spec))
  )
    return status('missing', 'A newer model is available. Install to update.');
  for (const entry of spec.files) {
    const stat = await fs.stat(path.join(modelRoot(dir, spec), entry.path)).catch(() => null);
    if (!stat?.isFile() || stat.size !== entry.size)
      return status('error', 'Model files are damaged. Install again to repair.');
  }
  return status('ready', 'Ready');
}

async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function intact(file, entry) {
  const stat = await fs.stat(file).catch(() => null);
  return Boolean(
    stat?.isFile() && stat.size === entry.size && (await sha256File(file)) === entry.sha256,
  );
}

/**
 * The copy of `entry` inside a local `source` folder. Accepted layouts: a models directory
 * (<source>/<org>/<repo>/<path>), a mirror of upstream repos (<source>/<org>/<repo>/<file>), one
 * downloaded repo (<source>/<file>), or folders of downloaded repos with any names
 * (<source>/<folder>/<file>). Only a file with the expected size and digest is used.
 */
async function sourceFile(source, spec, entry) {
  const root = path.resolve(source),
    { repo, remote } = upstream(spec, entry);
  const candidates = [
    path.join(root, ...spec.repo.split('/'), entry.path),
    path.join(root, ...repo.split('/'), remote),
    path.join(root, remote),
  ];
  for (const folder of await fs.readdir(root, { withFileTypes: true }).catch(() => []))
    if (folder.isDirectory()) candidates.push(path.join(root, folder.name, remote));
  for (const candidate of new Set(candidates)) if (await intact(candidate, entry)) return candidate;
  throw new Error(`${repo}/${remote} (${sizeLabel(entry.size)}) was not found in ${root}.`);
}

async function acquireLock(lock, onWait) {
  const token = randomUUID(),
    deadline = Date.now() + 30 * 60 * 1000;
  await fs.mkdir(path.dirname(lock), { recursive: true, mode: 0o700 });
  while (true) {
    try {
      const handle = await fs.open(lock, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, token }));
      await handle.close();
      return token;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const owner = await fs
      .readFile(lock, 'utf8')
      .then(JSON.parse)
      .catch(() => null);
    let stale = false;
    if (owner?.pid) {
      try {
        process.kill(owner.pid, 0);
      } catch (error) {
        stale = error.code === 'ESRCH';
      }
    } else {
      const stat = await fs.stat(lock).catch(() => null);
      stale = !stat || Date.now() - stat.mtimeMs > 30000;
    }
    if (stale) {
      await fs.rm(lock, { force: true });
      continue;
    }
    if (Date.now() > deadline)
      throw new Error('Another model installation is still running. Retry when it finishes.');
    onWait?.();
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function releaseLock(lock, token) {
  const owner = await fs
    .readFile(lock, 'utf8')
    .then(JSON.parse)
    .catch(() => null);
  if (owner?.token === token) await fs.rm(lock, { force: true });
}

// Chromium errors for a connection that dropped after the download had started.
const INTERRUPTED =
  /^net::ERR_(?:CONTENT_LENGTH_MISMATCH|INCOMPLETE_CHUNKED_ENCODING|CONNECTION_(?:RESET|CLOSED|ABORTED)|NETWORK_(?:CHANGED|IO_SUSPENDED)|HTTP2_PROTOCOL_ERROR|SOCKET_NOT_CONNECTED)$/;

function friendly(error, name, received = 0) {
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError')
    return new Error(`Download of ${name} stalled. Check your connection and retry.`);
  // Electron's net.fetch (used by the app so system proxies and certificates apply).
  const network = /\bnet::ERR_[A-Z_]+/.exec(error?.message || '')?.[0];
  const fetchFailed = error instanceof TypeError && /fetch|terminated/i.test(error.message);
  if ((network || fetchFailed) && (received > 0 || INTERRUPTED.test(network || '')))
    return new Error(`Download interrupted${network ? ` (${network})` : ''}. Retry to continue.`);
  if (network)
    return new Error(
      `Could not reach huggingface.co (${network}). Check your connection and retry.`,
    );
  if (fetchFailed)
    return new Error('Could not reach huggingface.co. Check your connection and retry.');
  return error;
}

async function* download(url, { fetchImpl, signal, idleMs, name }) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  let timer;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () => controller.abort(new DOMException('Download stalled', 'TimeoutError')),
      idleMs,
    );
  };
  try {
    arm();
    const response = await fetchImpl(url, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok) throw new Error(`Model download failed (HTTP ${response.status}): ${name}`);
    for await (const chunk of response.body) {
      arm();
      yield chunk;
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

async function fetchFile(target, entry, { url, source, fetchImpl, signal, idleMs, onBytes }) {
  const name = path.basename(entry.path),
    part = `${target}.${randomUUID()}.part`;
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const handle = await fs.open(part, 'wx');
  const hash = createHash('sha256');
  let received = 0;
  try {
    const chunks = source
      ? createReadStream(source, { highWaterMark: 1 << 20 })
      : download(url, { fetchImpl, signal, idleMs, name });
    for await (const chunk of chunks) {
      if (signal?.aborted) throw signal.reason || new Error('Installation cancelled.');
      received += chunk.length;
      if (received > entry.size) throw new Error(`Unexpected size for ${name}. Retry the install.`);
      hash.update(chunk);
      await handle.write(chunk);
      onBytes(received);
    }
    await handle.close();
    if (received !== entry.size)
      throw new Error(`Incomplete download: ${name}. Retry the install.`);
    if (hash.digest('hex') !== entry.sha256)
      throw new Error(`Checksum mismatch for ${name}. Retry the install.`);
    await fs.rename(part, target);
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.rm(part, { force: true });
    throw friendly(error, name, received);
  }
}

/** Delete partial downloads and marker temporaries left by an interrupted install. */
async function removeLeftovers(root, marker) {
  const names = await fs.readdir(root, { recursive: true }).catch(() => []);
  const stale = names.filter((name) => name.endsWith('.part')).map((name) => path.join(root, name));
  const prefix = path.basename(marker) + '.';
  for (const name of await fs.readdir(path.dirname(marker)).catch(() => []))
    if (name.startsWith(prefix) && name.endsWith('.tmp'))
      stale.push(path.join(path.dirname(marker), name));
  await Promise.all(stale.map((file) => fs.rm(file, { force: true }).catch(() => {})));
}

async function ensureSpace(dir, needed) {
  if (!needed || typeof fs.statfs !== 'function') return;
  const stats = await fs.statfs(dir).catch(() => null);
  if (stats && stats.bavail * stats.bsize < needed * 1.1 + 50e6)
    throw new Error(`Not enough disk space: ${sizeLabel(needed)} is needed for the model.`);
}

const installs = new Map();
/**
 * Download (or copy from `source`, a directory laid out like the models directory), verify,
 * load-check and mark a component ready. Resolves to { status, model } where `model` is the
 * loaded instance returned by `check` (kept warm by the worker).
 */
export function installModel(kind, options = {}) {
  const spec = specFor(kind, options.spec),
    dir = path.resolve(options.dir || modelsDirectory()),
    key = dir + '|' + spec.kind;
  if (installs.has(key)) return installs.get(key);
  const pending = lockedInstall(spec, { ...options, dir }).finally(() => installs.delete(key));
  installs.set(key, pending);
  return pending;
}

async function lockedInstall(spec, options) {
  const { dir, onProgress = () => {} } = options;
  const lock = path.join(dir, `.${spec.kind}.install.lock`);
  const token = await acquireLock(lock, () =>
    onProgress({ phase: 'waiting', progress: 0, message: 'Waiting for another install' }),
  );
  try {
    return await install(spec, options);
  } finally {
    await releaseLock(lock, token);
  }
}

async function install(
  spec,
  {
    dir,
    onProgress = () => {},
    fetchImpl = fetch,
    source,
    signal,
    check = defaultCheck,
    endpoint = process.env.HF_ENDPOINT || 'https://huggingface.co',
    idleMs = 60000,
  },
) {
  const total = totalBytes(spec),
    root = modelRoot(dir, spec);
  const report = (phase, bytes, message, extra) =>
    onProgress({
      kind: spec.kind,
      phase,
      bytes,
      totalBytes: total,
      // Downloads fill 0..0.96; verification and the load check take the rest.
      progress: phase === 'ready' ? 1 : Math.min(0.96, (bytes / total) * 0.96),
      message,
      ...extra,
    });
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  // Not ready again until every file is verified and the model loads.
  await fs.rm(markerPath(dir, spec), { force: true });
  // The install lock is held, so any partial file here belongs to an interrupted install.
  await removeLeftovers(root, markerPath(dir, spec));
  report('checking', 0, 'Checking files');
  let done = 0;
  const todo = [];
  for (const entry of spec.files) {
    if (await intact(path.join(root, entry.path), entry)) done += entry.size;
    else todo.push(entry);
  }
  await ensureSpace(
    dir,
    todo.reduce((sum, entry) => sum + entry.size, 0),
  );
  report('downloading', done, todo.length ? 'Downloading ' + spec.label : 'Files verified');
  for (const entry of todo) {
    let last = 0;
    const { repo, revision, remote } = upstream(spec, entry);
    await fetchFile(path.join(root, entry.path), entry, {
      url: `${endpoint.replace(/\/$/, '')}/${repo}/resolve/${revision}/${remote}`,
      source: source && (await sourceFile(source, spec, entry)),
      fetchImpl,
      signal,
      idleMs,
      onBytes: (received) => {
        // Throttle to ~1% steps of the whole component.
        if (received === entry.size || received - last > total / 100) {
          last = received;
          report('downloading', done + received, 'Downloading ' + spec.label, {
            file: entry.path,
          });
        }
      },
    });
    done += entry.size;
  }
  onProgress({
    kind: spec.kind,
    phase: 'loading',
    bytes: total,
    totalBytes: total,
    progress: 0.98,
    message: 'Testing ' + spec.label,
  });
  const model = await check(spec, { dir });
  const marker = {
    version: MARKER_VERSION,
    kind: spec.kind,
    repo: spec.repo,
    revision: spec.revision,
    sources: sourcesOf(spec),
    dtype: spec.dtype,
    files: Object.fromEntries(spec.files.map((entry) => [entry.path, entry.size])),
    installedAt: new Date().toISOString(),
  };
  const temporary = markerPath(dir, spec) + '.' + randomUUID() + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(marker, null, 2));
  await fs.rename(temporary, markerPath(dir, spec));
  await removeLegacy(dir, spec);
  report('ready', total, 'Ready');
  return { status: await readStatus(spec.kind, { dir, spec }), model };
}

/** Remove a component's files. The caller must unload the model first. */
export async function removeModel(kind, { dir = modelsDirectory(), spec } = {}) {
  spec = specFor(kind, spec);
  await fs.rm(markerPath(dir, spec), { force: true });
  await fs.rm(modelRoot(dir, spec), { recursive: true, force: true, maxRetries: 4 });
  await fs.rmdir(path.dirname(modelRoot(dir, spec))).catch(() => {});
  await removeLegacy(dir, spec);
  return readStatus(kind, { dir, spec });
}

/**
 * Readable error for a speech runtime that fails to load. On Windows onnxruntime needs the
 * Microsoft Visual C++ runtime; packages bundle it, but a source checkout relies on the system.
 */
export function runtimeFailure(error, { platform = process.platform, arch = process.arch } = {}) {
  const detail = String(error?.message || error || 'unknown error').split('\n')[0];
  if (
    platform === 'win32' &&
    (error?.code === 'ERR_DLOPEN_FAILED' || /specified module could not be found/i.test(detail))
  ) {
    const target = arch === 'arm64' ? 'arm64' : arch === 'ia32' ? 'x86' : 'x64';
    return Object.assign(
      new Error(
        `Local speech needs the Microsoft Visual C++ Redistributable. Install https://aka.ms/vs/17/release/vc_redist.${target}.exe and restart Guard Lab.`,
      ),
      { code: 'VC_RUNTIME_MISSING' },
    );
  }
  // Otherwise usually a missing native binary (onnxruntime-node or sharp) for this OS/architecture.
  return new Error(
    `The local speech runtime could not start (${detail}). Reinstall Guard Lab or run npm ci.`,
  );
}

let transformersModule;
async function transformers(dir) {
  transformersModule ||= import('@huggingface/transformers').catch((error) => {
    transformersModule = null;
    throw runtimeFailure(error);
  });
  const library = await transformersModule;
  // Offline only: models resolve from dir/<org>/<repo>/... and are never fetched at load time.
  library.env.allowRemoteModels = false;
  library.env.allowLocalModels = true;
  // transformers joins with "/" (Windows accepts forward slashes in file paths).
  library.env.localModelPath = dir.split(path.sep).join('/').replace(/\/?$/, '/');
  library.env.useFSCache = false;
  library.env.useBrowserCache = false;
  library.env.cacheDir = dir;
  return library;
}

let ortModule;
function onnxRuntime() {
  ortModule ||= import('onnxruntime-node')
    .then((module) => (module.InferenceSession ? module : module.default))
    .catch((error) => {
      ortModule = null;
      throw runtimeFailure(error);
    });
  return ortModule;
}

const cancelled = () => Object.assign(new Error('Speech cancelled.'), { code: 'CANCELLED' });

// Deterministic noise for the flow-matching sampler: one seed per (voice, text), so a line
// always sounds the same and cached audio matches a fresh synthesis.
function seedOf(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return hash >>> 0;
}
function gaussian(length, seed) {
  let state = seed | 0;
  const random = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++)
    out[i] = Math.sqrt(-2 * Math.log(Math.max(1e-10, random()))) * Math.cos(2 * Math.PI * random());
  return out;
}

const SUPERTONIC_REPLACE = [
  [/[–‑—]/g, '-'],
  [/_/g, ' '],
  [/[“”]/g, '"'],
  [/[‘’´`]/g, "'"],
  [/[[\]|/#→←]/g, ' '],
  [/[♥☆♡©\\]/g, ''],
  [/@/g, ' at '],
];

/** Supertonic's character input: NFKD text in a language tag, ending with punctuation. */
export function supertonicText(text, lang = 'en') {
  let clean = String(text ?? '').normalize('NFKD');
  for (const [pattern, value] of SUPERTONIC_REPLACE) clean = clean.replace(pattern, value);
  clean = clean
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/ ([,.!?;:'])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (!/[.!?;:,'")\]}…]$/.test(clean)) clean += '.';
  return `<${lang}>${clean}</${lang}>`;
}

// Flow-matching steps per pass: 5 is the upstream default (2 sounds rough, 8 adds little).
export const SUPERTONIC_STEPS = 5;
// Upstream's default speaking rate; the game's speed setting multiplies it.
export const SUPERTONIC_SPEED = 1.05;

/** Supertonic 2 on onnxruntime-node: four ONNX sessions and the voice style vectors. */
class Supertonic {
  static async load(root) {
    const ort = await onnxRuntime();
    const read = async (name) => JSON.parse(await fs.readFile(path.join(root, name), 'utf8'));
    const [config, indexer] = await Promise.all([
      read('onnx/tts.json'),
      read('onnx/unicode_indexer.json'),
    ]);
    const options = {
      intraOpNumThreads: Math.max(1, Math.min(4, os.availableParallelism?.() || 4)),
      interOpNumThreads: 1,
      graphOptimizationLevel: 'all',
    };
    const names = ['duration_predictor', 'text_encoder', 'vector_estimator', 'vocoder'];
    const sessions = await Promise.allSettled(
      names.map((name) =>
        ort.InferenceSession.create(path.join(root, 'int8', name + '.int8.onnx'), options),
      ),
    );
    const failed = sessions.find((result) => result.status === 'rejected');
    if (failed) {
      for (const result of sessions)
        if (result.status === 'fulfilled') await result.value.release?.().catch(() => {});
      throw failed.reason;
    }
    return new Supertonic(
      ort,
      root,
      config,
      indexer,
      sessions.map((result) => result.value),
    );
  }

  constructor(ort, root, config, indexer, [duration, encoder, estimator, vocoder]) {
    Object.assign(this, { ort, root, indexer, duration, encoder, estimator, vocoder });
    this.sampleRate = config.ae.sample_rate;
    this.chunk = config.ae.base_chunk_size * config.ttl.chunk_compress_factor;
    this.latentDim = config.ttl.latent_dim * config.ttl.chunk_compress_factor;
    this.styles = new Map();
  }

  async style(name) {
    if (!/^[MF][1-5]$/.test(name)) throw new Error('Unknown voice style.');
    if (!this.styles.has(name)) {
      const json = JSON.parse(
        await fs.readFile(path.join(this.root, 'voice_styles', name + '.json'), 'utf8'),
      );
      const tensor = (s) =>
        new this.ort.Tensor('float32', Float32Array.from(s.data.flat(Infinity)), s.dims);
      this.styles.set(name, { ttl: tensor(json.style_ttl), dp: tensor(json.style_dp) });
    }
    return this.styles.get(name);
  }

  /** One pass: text (a sentence or a few) → mono float samples at this.sampleRate. */
  async generate(text, { voice = 'M1', speed = 1, steps = SUPERTONIC_STEPS, seed, signal } = {}) {
    const { ort } = this,
      styles = await this.style(voice),
      input = supertonicText(text);
    const ids = Array.from(input, (c) => Math.max(0, this.indexer[c.charCodeAt(0)] ?? 0));
    const length = ids.length,
      textIds = new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, length]),
      textMask = new ort.Tensor('float32', new Float32Array(length).fill(1), [1, 1, length]);
    const [{ duration }, { text_emb: textEmb }] = await Promise.all([
      this.duration.run({ text_ids: textIds, style_dp: styles.dp, text_mask: textMask }),
      this.encoder.run({ text_ids: textIds, style_ttl: styles.ttl, text_mask: textMask }),
    ]);
    const samples = Math.max(1, Math.floor((duration.data[0] / speed) * this.sampleRate)),
      frames = Math.ceil(samples / this.chunk);
    let latent = gaussian(this.latentDim * frames, seed ?? seedOf(voice + '|' + input));
    const latentMask = new ort.Tensor('float32', new Float32Array(frames).fill(1), [1, 1, frames]),
      total = new ort.Tensor('float32', Float32Array.of(steps), [1]);
    for (let step = 0; step < steps; step++) {
      if (signal?.aborted) throw cancelled();
      const result = await this.estimator.run({
        noisy_latent: new ort.Tensor('float32', latent, [1, this.latentDim, frames]),
        text_emb: textEmb,
        style_ttl: styles.ttl,
        text_mask: textMask,
        latent_mask: latentMask,
        total_step: total,
        current_step: new ort.Tensor('float32', Float32Array.of(step), [1]),
      });
      latent = result.denoised_latent.data;
    }
    const { wav_tts: wav } = await this.vocoder.run({
      latent: new ort.Tensor('float32', latent, [1, this.latentDim, frames]),
    });
    return wav.data.slice(0, samples);
  }

  async release() {
    const sessions = [this.duration, this.encoder, this.estimator, this.vocoder];
    this.duration = this.encoder = this.estimator = this.vocoder = null;
    // Released explicitly: onnxruntime can abort at process exit with sessions still open.
    for (const session of sessions) await session?.release?.().catch(() => {});
  }
}

export async function loadModel(kind, { dir = modelsDirectory() } = {}) {
  const spec = specFor(kind);
  if (kind === 'tts') return Supertonic.load(modelRoot(dir, spec));
  const library = await transformers(dir);
  return library.pipeline('automatic-speech-recognition', spec.repo, {
    dtype: { ...spec.dtype },
    device: 'cpu',
  });
}

export async function unloadModel(model) {
  try {
    if (model instanceof Supertonic) await model.release();
    else await (model?.model?.dispose?.() ?? model?.dispose?.());
  } catch {}
}

/** Load the freshly installed model and run one short inference. */
export async function defaultCheck(spec, { dir }) {
  let model;
  try {
    model = await loadModel(spec.kind, { dir });
  } catch (error) {
    if (error.code === 'VC_RUNTIME_MISSING') throw error;
    throw new Error(`${spec.label} could not load: ${error.message}`);
  }
  try {
    if (spec.kind === 'tts') {
      const audio = await model.generate('Ready.', { voice: voiceStyle(DEFAULT_VOICES.robot) });
      if (!audio?.length) throw new Error('Supertonic produced no audio.');
    } else await model(new Float32Array(STT_SAMPLE_RATE));
    return model;
  } catch (error) {
    await unloadModel(model);
    throw new Error(`${spec.label} could not run on this computer: ${error.message}`);
  }
}

// Pass size: sentences merged up to TTS_CHUNK characters. A longer sentence is split at clauses,
// and at words only above TTS_HARD_LIMIT: each pass ends with falling intonation, so a cut
// mid-phrase sounds like a full stop. A cancelled line stops before its next flow step.
export const TTS_CHUNK = 230;
export const TTS_HARD_LIMIT = 300;

/** Text prepared for Supertonic: speakable, numbers spelled out, split into passes. */
export const speechPasses = (text) =>
  sentenceChunks(spellNumbers(speakableText(text)), TTS_CHUNK, TTS_HARD_LIMIT);

/**
 * Supertonic text → { wav: Uint8Array, sampleRate, durationMs, voice }. An aborted `signal`
 * stops the job before its next flow-matching step.
 */
export async function synthesizeSpeech(
  tts,
  { text, voice, actor = 'robot', speed = 1 },
  { signal } = {},
) {
  const id = resolveVoice(voice, actor),
    rate = Math.min(1.6, Math.max(0.6, Number(speed) || 1));
  const chunks = speechPasses(text);
  if (!chunks.length) throw new Error('Nothing to say.');
  const sampleRate = tts.sampleRate;
  const parts = [];
  for (const chunk of chunks) {
    if (signal?.aborted) throw cancelled();
    parts.push(
      await tts.generate(chunk, { voice: voiceStyle(id), speed: SUPERTONIC_SPEED * rate, signal }),
    );
  }
  const samples = joinAudio(parts, sampleRate);
  return {
    wav: encodeWav(samples, sampleRate),
    sampleRate,
    durationMs: Math.round((samples.length / sampleRate) * 1000),
    voice: id,
  };
}

/** Whisper: mono float samples at any rate → { text, ms }. */
export async function transcribeSpeech(asr, { pcm, sampleRate }) {
  const started = performance.now();
  let audio = pcm instanceof Float32Array ? pcm : Float32Array.from(pcm || []);
  if (sampleRate !== STT_SAMPLE_RATE) audio = resample(audio, sampleRate, STT_SAMPLE_RATE);
  if (isSilent(audio)) return { text: '', ms: Math.round(performance.now() - started) };
  const result = await asr(
    audio,
    audio.length > 30 * STT_SAMPLE_RATE ? { chunk_length_s: 30, stride_length_s: 5 } : {},
  );
  return {
    text: cleanTranscript(
      Array.isArray(result) ? result.map((r) => r.text).join(' ') : result?.text,
    ),
    ms: Math.round(performance.now() - started),
  };
}

/** Keeps loaded models warm and runs one inference per model at a time. */
export class VoiceEngine {
  constructor({ dir = modelsDirectory(), fetchImpl, source } = {}) {
    this.dir = dir;
    this.fetchImpl = fetchImpl;
    this.source = source;
    this.models = {};
    this.loading = {};
    this.queues = { tts: Promise.resolve(), stt: Promise.resolve() };
  }
  serial(kind, task) {
    const run = this.queues[kind].then(task, task);
    this.queues[kind] = run.catch(() => {});
    return run;
  }
  async status() {
    return {
      tts: await readStatus('tts', { dir: this.dir }),
      stt: await readStatus('stt', { dir: this.dir }),
    };
  }
  async load(kind) {
    if (this.models[kind]) return this.models[kind];
    if (!this.loading[kind]) {
      this.loading[kind] = (async () => {
        const status = await readStatus(kind, { dir: this.dir });
        if (status.state !== 'ready')
          throw Object.assign(
            new Error(
              kind === 'tts'
                ? 'Supertonic voices are not installed.'
                : 'Speech-to-text is not installed.',
            ),
            { code: 'NOT_INSTALLED' },
          );
        return (this.models[kind] = await loadModel(kind, { dir: this.dir }));
      })().finally(() => delete this.loading[kind]);
    }
    return this.loading[kind];
  }
  async unload(kind) {
    const model = this.models[kind] || (await this.loading[kind]?.catch(() => null));
    delete this.models[kind];
    await unloadModel(model);
  }
  async install(kind, { onProgress, signal } = {}) {
    const result = await installModel(kind, {
      dir: this.dir,
      onProgress,
      signal,
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
      ...(this.source ? { source: this.source } : {}),
      check: (spec, options) =>
        this.serial(kind, async () => {
          await this.unload(kind);
          return defaultCheck(spec, options);
        }),
    });
    if (result.model) this.models[kind] = result.model;
    return result.status;
  }
  remove(kind) {
    return this.serial(kind, async () => {
      await this.unload(kind);
      return removeModel(kind, { dir: this.dir });
    });
  }
  warm(kind) {
    return this.serial(kind, () => this.load(kind)).then(() => true);
  }
  synthesize(args, { signal } = {}) {
    return this.serial('tts', async () => {
      if (signal?.aborted) throw cancelled();
      return synthesizeSpeech(await this.load('tts'), args, { signal });
    });
  }
  transcribe(args) {
    return this.serial('stt', async () => transcribeSpeech(await this.load('stt'), args));
  }
  async dispose() {
    await Promise.all(KINDS.map((kind) => this.unload(kind)));
  }
}
