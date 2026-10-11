// Local voice service for the renderer: Supertonic speech, Whisper push-to-talk transcription and
// microphone permission. Models run in a utilityProcess (voice-worker.cjs) forked on demand.
const path = require('node:path');
const fs = require('node:fs/promises');
const { createHash, randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { dataDirectory } = require('../shared/runtime.cjs');

const KINDS = ['tts', 'stt'];
const MAX_TEXT = 2000;
const MAX_SECONDS = 60;
const CACHE_BYTES = 64 * 1024 * 1024;
const CACHE_FILES = 800;
// Marks a cache written by this version. Older caches (Piper, Kokoro) are deleted: Piper's also
// held the player's lines, and no other voice model can use them.
const CACHE_MARKER = '.speech-cache-v2';
// Human lines are never written to disk: a small in-memory cache only.
const MEMORY_BYTES = 12 * 1024 * 1024;
const MEMORY_ITEMS = 32;
// A synthesis request's timeout starts when the worker takes it, not when it is queued.
const SYNTH_BASE_MS = 45000;
const SYNTH_PER_CHAR_MS = 150;
// Permissions the game window may use besides microphone audio.
const ALLOWED_PERMISSIONS = new Set(['fullscreen', 'pointerLock', 'clipboard-sanitized-write']);

const load = (file) => import(pathToFileURL(path.join(__dirname, '..', 'shared', file)).href);
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

function wavInfo(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sampleRate = view.getUint32(24, true),
    frameBytes = view.getUint16(32, true) || 2;
  return {
    sampleRate,
    durationMs: Math.round(((bytes.byteLength - 44) / frameBytes / sampleRate) * 1000),
  };
}

function microphoneStatus(systemPreferences) {
  if (!['darwin', 'win32'].includes(process.platform)) return 'unknown';
  try {
    const status = systemPreferences.getMediaAccessStatus('microphone');
    if (status === 'granted') return 'granted';
    if (status === 'denied' || status === 'restricted') return 'denied';
    if (status === 'not-determined') return 'prompt';
  } catch {}
  return 'unknown';
}

// `electron` is injectable so the service logic can be tested without Electron.
function registerVoice({ ipcMain, getWindow, app, electron = require('electron') }) {
  const { utilityProcess, session, systemPreferences } = electron;
  const root = dataDirectory(),
    modelsDir = path.join(root, 'models'),
    cacheDir = path.join(root, 'speech-cache');
  const models = load('voice-models.mjs'),
    catalog = load('voice-catalog.mjs');
  models.catch(() => {});
  catalog.catch(() => {});
  let worker = null,
    spawned = null,
    sequence = 0,
    closed = false,
    started = false,
    pushTimer = null,
    pruneTimer = null,
    lastError = '';
  const pending = new Map(),
    installing = {},
    failures = {},
    // Speech jobs not yet handed to the worker, oldest first; jobs by cache key (incl. active).
    synthQueue = [],
    synthJobs = new Map(),
    // Owners cancelled recently: their requests still in flight are dropped on arrival.
    cancelledOwners = new Set(),
    // Synthesis requests still checking caches; later arrivals wait for them to queue first.
    undecided = new Set(),
    memory = new Map();
  let synthActive = null,
    arrivals = 0,
    memoryBytes = 0,
    cacheReady = null;

  function window() {
    const win = getWindow?.();
    return win && !win.isDestroyed() ? win : null;
  }

  function fork() {
    if (worker) return spawned;
    if (closed) return Promise.reject(new Error('Voice service closed.'));
    const child = utilityProcess.fork(path.join(__dirname, 'voice-worker.cjs'), [], {
      serviceName: 'Guard Lab Voice',
      stdio: 'pipe',
      env: { ...process.env, GUARD_LAB_DATA_DIR: root, GUARD_LAB_MODELS_DIR: modelsDir },
    });
    worker = child;
    // Keep only the last diagnostic line in memory; nothing is logged to disk.
    child.stdout?.on('data', () => {});
    child.stderr?.on('data', (chunk) => {
      const line = String(chunk).trim().split('\n').at(-1);
      if (line) lastError = line.slice(0, 300);
    });
    child.on('message', (message) => {
      if (message?.event === 'progress') {
        const job = installing[message.kind];
        if (job) job.progress = message.progress;
        push();
        return;
      }
      const request = pending.get(message?.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.ok) request.resolve(message.result);
      else
        request.reject(
          Object.assign(new Error(message.error?.message || 'Voice engine error.'), {
            code: message.error?.code || null,
          }),
        );
    });
    child.on('exit', (code) => {
      if (worker !== child) return;
      worker = null;
      spawned = null;
      const error = new Error(
        closed
          ? 'Voice service closed.'
          : `The voice engine stopped (code ${code}).${lastError ? ' ' + lastError : ''}`,
      );
      for (const request of pending.values()) request.reject(error);
      pending.clear();
    });
    spawned = new Promise((resolve, reject) => {
      child.once('spawn', () => resolve(child));
      child.once('exit', (code) =>
        reject(new Error(`The voice engine could not start (${code}).`)),
      );
    });
    spawned.catch(() => {});
    return spawned;
  }

  async function request(op, args = {}, timeoutMs = 0, onSent) {
    const child = await fork();
    if (closed) throw new Error('Voice service closed.');
    const id = ++sequence;
    onSent?.(id, child);
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs &&
        setTimeout(() => {
          pending.delete(id);
          reject(new Error('The voice engine took too long. Try again.'));
        }, timeoutMs);
      const done = (callback) => (value) => {
        clearTimeout(timer);
        callback(value);
      };
      pending.set(id, { resolve: done(resolve), reject: done(reject) });
      child.postMessage({ id, op, args });
    });
  }

  async function component(kind) {
    const { readStatus } = await models;
    const status = await readStatus(kind, { dir: modelsDir });
    const job = installing[kind];
    if (job)
      return {
        ...status,
        state: 'installing',
        progress: job.progress?.progress ?? 0,
        bytes: job.progress?.bytes ?? 0,
        message: job.progress?.message || 'Starting',
      };
    if (failures[kind] && status.state !== 'ready')
      return { ...status, state: 'error', message: failures[kind] };
    return status;
  }

  async function status() {
    const [tts, stt] = await Promise.all(KINDS.map(component));
    return { tts, stt, microphone: microphoneStatus(systemPreferences) };
  }

  function push() {
    if (pushTimer || closed) return;
    pushTimer = setTimeout(async () => {
      pushTimer = null;
      const win = window();
      if (!win) return;
      try {
        win.webContents.send('voice:status', await status());
      } catch {}
    }, 120);
  }

  function checkKind(kind) {
    if (!KINDS.includes(kind)) throw new Error('Unknown voice component.');
  }

  async function install(kind) {
    checkKind(kind);
    if (!installing[kind]) {
      delete failures[kind];
      const job = { progress: null };
      job.promise = request('install', { kind })
        .catch((error) => {
          failures[kind] = error.message;
        })
        .finally(() => {
          delete installing[kind];
          push();
        });
      installing[kind] = job;
      push();
    }
    await installing[kind].promise;
    return status();
  }

  async function remove(kind) {
    checkKind(kind);
    if (installing[kind]) throw new Error('Wait for the install to finish first.');
    delete failures[kind];
    if (worker) await request('remove', { kind });
    else await (await models).removeModel(kind, { dir: modelsDir });
    if (kind === 'tts') {
      await fs.rm(cacheDir, { recursive: true, force: true }).catch(() => {});
      cacheReady = null;
      memory.clear();
      memoryBytes = 0;
    }
    push();
    return status();
  }

  async function ttsReady() {
    if (installing.tts) return false;
    return (await (await models).readStatus('tts', { dir: modelsDir })).state === 'ready';
  }

  function prepareCache() {
    cacheReady ||= (async () => {
      const marker = path.join(cacheDir, CACHE_MARKER);
      if (
        await fs.access(marker).then(
          () => true,
          () => false,
        )
      )
        return;
      // First run of this version: drop older caches (other voice models, the player's lines).
      await fs.rm(cacheDir, { recursive: true, force: true });
      await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });
      await fs.writeFile(marker, '', { mode: 0o600 });
    })().catch(() => {});
    return cacheReady;
  }

  async function cached(key) {
    await prepareCache();
    const file = path.join(cacheDir, key + '.wav');
    try {
      const bytes = new Uint8Array(await fs.readFile(file));
      const now = new Date();
      fs.utimes(file, now, now).catch(() => {});
      return bytes;
    } catch {
      return null;
    }
  }

  async function store(key, bytes) {
    try {
      await prepareCache();
      await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });
      const file = path.join(cacheDir, key + '.wav'),
        temporary = `${file}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, bytes, { mode: 0o600 });
      await fs.rename(temporary, file);
    } catch {}
    if (!pruneTimer)
      pruneTimer = setTimeout(() => {
        pruneTimer = null;
        prune().catch(() => {});
      }, 2000);
  }

  async function prune() {
    const names = await fs.readdir(cacheDir).catch(() => []);
    const entries = [];
    for (const name of names) {
      if (name === CACHE_MARKER) continue;
      const file = path.join(cacheDir, name);
      const stat = await fs.stat(file).catch(() => null);
      if (!stat?.isFile()) continue;
      if (!name.endsWith('.wav')) {
        if (Date.now() - stat.mtimeMs > 60000) await fs.rm(file, { force: true });
        continue;
      }
      entries.push({ file, size: stat.size, time: stat.mtimeMs });
    }
    entries.sort((a, b) => b.time - a.time);
    let total = 0;
    for (const [index, entry] of entries.entries()) {
      total += entry.size;
      if (total > CACHE_BYTES || index >= CACHE_FILES) await fs.rm(entry.file, { force: true });
    }
  }

  function recall(key) {
    const bytes = memory.get(key);
    if (!bytes) return null;
    memory.delete(key);
    memory.set(key, bytes);
    return bytes;
  }

  function remember(key, bytes) {
    if (memory.has(key)) return;
    memory.set(key, bytes);
    memoryBytes += bytes.byteLength;
    for (const [old, value] of memory) {
      if (memoryBytes <= MEMORY_BYTES && memory.size <= MEMORY_ITEMS) break;
      memory.delete(old);
      memoryBytes -= value.byteLength;
    }
  }

  // Requests may name an owner (`channel` + `utterance`) so a player that stops a line can
  // drop the segments it queued. Requests without an owner are never cancelled.
  const channelOf = (data) =>
    typeof data?.channel === 'string' && data.channel ? data.channel.slice(0, 80) : '';
  const ownerOf = (data) =>
    channelOf(data) && Number.isSafeInteger(data.utterance)
      ? `${channelOf(data)}#${data.utterance}`
      : null;

  function cancel(data = {}) {
    const channel = channelOf(data),
      utterances = Array.isArray(data?.utterances)
        ? data.utterances.filter(Number.isSafeInteger).slice(0, 256)
        : [];
    if (!channel || !utterances.length) return 0;
    const owners = utterances.map((utterance) => `${channel}#${utterance}`);
    for (const owner of owners) {
      cancelledOwners.delete(owner);
      cancelledOwners.add(owner);
    }
    while (cancelledOwners.size > 512)
      cancelledOwners.delete(cancelledOwners.values().next().value);
    let dropped = 0;
    for (let index = synthQueue.length - 1; index >= 0; index--) {
      const job = synthQueue[index];
      for (const owner of owners) job.owners.delete(owner);
      if (job.keep || job.owners.size) continue;
      synthQueue.splice(index, 1);
      synthJobs.delete(job.key);
      job.resolve({ cancelled: true });
      dropped++;
    }
    // The job the worker is running stops before its next synthesis step.
    const active = synthActive;
    if (active && !active.settled && !active.keep) {
      for (const owner of owners) active.owners.delete(owner);
      if (!active.owners.size) {
        active.settled = true;
        active.resolve({ cancelled: true });
        try {
          active.child?.postMessage({ op: 'abort', args: { target: active.requestId } });
        } catch {}
        active.release();
        dropped++;
      }
    }
    return dropped;
  }

  function pump() {
    if (synthActive || closed || !synthQueue.length) return;
    for (const order of undecided) if (order < synthQueue[0].order) return;
    const job = synthQueue.shift();
    synthActive = job;
    // Runs once: when the worker answers, or earlier when the job is cancelled.
    job.release = () => {
      if (synthJobs.get(job.key) === job) synthJobs.delete(job.key);
      if (synthActive === job) synthActive = null;
      pump();
    };
    const timeout = SYNTH_BASE_MS + SYNTH_PER_CHAR_MS * job.args.text.length;
    request('synthesize', job.args, timeout, (id, child) =>
      Object.assign(job, { requestId: id, child }),
    )
      .then(
        (result) => {
          if (job.settled) return;
          job.settled = true;
          job.resolve({
            audio: result.wav,
            sampleRate: result.sampleRate,
            durationMs: result.durationMs,
            voice: result.voice,
          });
          if (job.args.actor === 'human') remember(job.key, result.wav);
          else store(job.key, result.wav);
        },
        (error) => {
          if (job.settled) return;
          job.settled = true;
          job.reject(error);
        },
      )
      .finally(() => job.release());
  }

  function enqueue(key, args, owner, order) {
    let job = synthJobs.get(key);
    if (!job) {
      job = { key, args, order, owners: new Set(), keep: false };
      job.promise = new Promise((resolve, reject) => Object.assign(job, { resolve, reject }));
      synthJobs.set(key, job);
      // Requests are handled concurrently; queue them in the order they arrived.
      let at = synthQueue.length;
      while (at > 0 && synthQueue[at - 1].order > order) at--;
      synthQueue.splice(at, 0, job);
    }
    if (owner) job.owners.add(owner);
    else job.keep = true;
    return job.promise;
  }

  async function synthesize(data = {}) {
    // Requests are handled concurrently; `order` keeps the worker queue in arrival order.
    const order = ++arrivals;
    undecided.add(order);
    let queued;
    try {
      // Segments of lines the player has stopped since its last request.
      if (Array.isArray(data?.drop)) cancel({ channel: data.channel, utterances: data.drop });
      const text = String(data?.text ?? '')
        .trim()
        .slice(0, MAX_TEXT);
      if (!text) throw new Error('Nothing to say.');
      if (String(data.voice || '').startsWith('native:') || !(await ttsReady()))
        return { native: true };
      const actor = data.actor === 'human' ? 'human' : 'robot';
      const voice = (await catalog).resolveVoice(data.voice, actor);
      const speed = Math.round(clamp(Number(data.speed) || 1, 0.6, 1.6) * 100) / 100;
      const key = createHash('sha256')
        .update(JSON.stringify([(await models).MODELS.tts.revision, voice, speed, text]))
        .digest('hex');
      const hit = recall(key) || (actor === 'robot' ? await cached(key) : null);
      if (hit) return { audio: hit, ...wavInfo(hit), voice };
      const owner = ownerOf(data);
      if (owner && cancelledOwners.has(owner)) return { cancelled: true };
      queued = enqueue(key, { text, voice, actor, speed }, owner, order);
    } finally {
      undecided.delete(order);
      pump();
    }
    try {
      return await queued;
    } catch (error) {
      if (error.code === 'NOT_INSTALLED') return { native: true };
      throw error;
    }
  }

  async function transcribe(data = {}) {
    const sampleRate = Number(data?.sampleRate);
    if (!(sampleRate >= 8000 && sampleRate <= 192000)) throw new Error('Invalid sample rate.');
    let pcm = data.pcm;
    if (!(pcm instanceof Float32Array)) {
      if (!ArrayBuffer.isView(pcm) && !Array.isArray(pcm))
        throw new Error('No audio to transcribe.');
      pcm = Float32Array.from(pcm);
    }
    if (pcm.length > sampleRate * MAX_SECONDS) pcm = pcm.slice(0, sampleRate * MAX_SECONDS);
    const stt = await component('stt');
    if (stt.state !== 'ready')
      throw new Error('Speech-to-text is not installed. Install it in Settings to talk.');
    return request('transcribe', { pcm, sampleRate }, 90000);
  }

  function warmSpeechToText() {
    // Whisper uses ~1 GB of RAM, so it loads when the player first reaches for the microphone
    // (not at launch) and then stays warm for the session.
    component('stt')
      .then((stt) => stt.state === 'ready' && request('warm', { kind: 'stt' }))
      .catch(() => {});
  }

  async function microphone(ask) {
    warmSpeechToText();
    const current = microphoneStatus(systemPreferences);
    if (ask && process.platform === 'darwin' && current === 'prompt') {
      const granted = await systemPreferences.askForMediaAccess('microphone');
      push();
      return granted ? 'granted' : 'denied';
    }
    return current;
  }

  function ownContents(contents) {
    const win = window();
    return Boolean(contents && win && contents.id === win.webContents.id);
  }

  function setupPermissions() {
    const target = session.defaultSession;
    target.setPermissionRequestHandler((contents, permission, callback, details) => {
      if (!ownContents(contents)) return callback(false);
      if (permission === 'media') {
        const types = details?.mediaTypes || [];
        return callback(types.length > 0 && types.every((type) => type === 'audio'));
      }
      callback(ALLOWED_PERMISSIONS.has(permission));
    });
    target.setPermissionCheckHandler((contents, permission, _origin, details) => {
      if (!ownContents(contents)) return false;
      if (permission === 'media') return details?.mediaType === 'audio';
      return ALLOWED_PERMISSIONS.has(permission);
    });
  }

  function ready() {
    if (started || closed) return;
    started = true;
    setupPermissions();
    if (process.argv.includes('--test-desktop')) return;
    // Warm Supertonic after the window has painted so the guard's first line starts quickly.
    setTimeout(async () => {
      if (!closed && (await component('tts').catch(() => null))?.state === 'ready')
        request('warm', { kind: 'tts' }).catch(() => {});
    }, 2500).unref?.();
  }

  app.whenReady().then(ready);
  ipcMain.handle('voice:status', () => status());
  ipcMain.handle('voice:install', (_, kind) => install(kind));
  ipcMain.handle('voice:remove', (_, kind) => remove(kind));
  ipcMain.handle('voice:voices', async () => (await catalog).VOICES.map((voice) => ({ ...voice })));
  ipcMain.handle('voice:synthesize', (_, data) => synthesize(data));
  ipcMain.handle('voice:cancel', (_, data) => cancel(data));
  ipcMain.handle('voice:transcribe', (_, data) => transcribe(data));
  ipcMain.handle('voice:microphone', (_, ask) => microphone(Boolean(ask)));

  return {
    ready,
    close() {
      closed = true;
      clearTimeout(pushTimer);
      clearTimeout(pruneTimer);
      const error = new Error('Voice service closed.');
      for (const request of pending.values()) request.reject(error);
      pending.clear();
      for (const job of synthQueue.splice(0)) job.reject(error);
      synthJobs.clear();
      memory.clear();
      worker?.kill();
      worker = null;
    },
  };
}

module.exports = { registerVoice };
