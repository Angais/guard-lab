import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { MODELS, MARKER_VERSION, encodeWav } from '../shared/voice-models.mjs';
import { temporaryDirectory, removeTemporary } from '../shared/temporary.mjs';

const require = createRequire(import.meta.url);
const { registerVoice } = require('../electron/voice.cjs');
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

// A "ready" Supertonic install without the real 100 MB weights: sparse files of the pinned sizes.
async function fakeSupertonic(dir) {
  const spec = MODELS.tts,
    root = path.join(dir, 'models', ...spec.repo.split('/'));
  for (const entry of spec.files) {
    const file = path.join(root, entry.path);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '');
    await fs.truncate(file, entry.size);
  }
  await fs.writeFile(
    path.join(dir, 'models', 'tts.json'),
    JSON.stringify({
      version: MARKER_VERSION,
      kind: 'tts',
      repo: spec.repo,
      revision: spec.revision,
      sources: [
        ...new Set(spec.files.map((f) => `${f.repo || spec.repo}@${f.revision || spec.revision}`)),
      ].sort(),
      dtype: spec.dtype,
    }),
  );
}

function harness(dir) {
  const handlers = {},
    jobs = [],
    aborts = [],
    windows = { own: { id: 1 }, other: { id: 2 } };
  let forks = 0,
    permissionRequest,
    permissionCheck;
  const wav = encodeWav(new Float32Array(2400).fill(0.1), 24000);
  const electron = {
    utilityProcess: {
      fork() {
        forks++;
        const child = new EventEmitter();
        child.postMessage = ({ id, op, args }) => {
          const reply = (result) => child.emit('message', { id, ok: true, result });
          if (op === 'abort') aborts.push(args.target);
          else if (op === 'synthesize')
            jobs.push({
              id,
              args,
              finish: () => reply({ wav, sampleRate: 24000, durationMs: 100, voice: args.voice }),
            });
          else reply(true);
        };
        child.kill = () => {};
        setTimeout(() => child.emit('spawn'), 0);
        return child;
      },
    },
    session: {
      defaultSession: {
        setPermissionRequestHandler: (handler) => (permissionRequest = handler),
        setPermissionCheckHandler: (handler) => (permissionCheck = handler),
      },
    },
    systemPreferences: { getMediaAccessStatus: () => 'granted' },
  };
  const previous = process.env.GUARD_LAB_DATA_DIR;
  process.env.GUARD_LAB_DATA_DIR = dir;
  const service = registerVoice({
    ipcMain: { handle: (name, handler) => (handlers[name] = handler) },
    getWindow: () => ({ isDestroyed: () => false, webContents: windows.own }),
    app: { whenReady: () => new Promise(() => {}) },
    electron,
  });
  if (previous === undefined) delete process.env.GUARD_LAB_DATA_DIR;
  else process.env.GUARD_LAB_DATA_DIR = previous;
  const call = (name, data) => handlers[name]({}, data);
  return {
    service,
    jobs,
    aborts,
    windows,
    call,
    forks: () => forks,
    permissions: () => ({ request: permissionRequest, check: permissionCheck }),
    say: (text, extra = {}) => call('voice:synthesize', { text, actor: 'robot', ...extra }),
  };
}

async function withService(run) {
  const dir = await temporaryDirectory('guard-voice-service-');
  let h;
  try {
    await fakeSupertonic(dir);
    h = harness(dir);
    await run(h, dir);
  } finally {
    h?.service.close();
    await removeTemporary(dir);
  }
}

async function until(condition) {
  // Generous: the whole suite runs files in parallel.
  for (let i = 0; i < 2000 && !condition(); i++) await tick();
  assert.ok(condition(), 'condition reached');
}

test('the worker gets one synthesis at a time, in arrival order', async () => {
  await withService(async (h) => {
    const lines = ['First line.', 'Second line.', 'Third line.'].map((text) => h.say(text));
    await until(() => h.jobs.length === 1);
    await tick();
    assert.equal(h.jobs.length, 1, 'later lines wait in the main-process queue');
    assert.equal(h.jobs[0].args.text, 'First line.');
    h.jobs[0].finish();
    await until(() => h.jobs.length === 2);
    assert.equal(h.jobs[1].args.text, 'Second line.');
    h.jobs[1].finish();
    await until(() => h.jobs.length === 3);
    h.jobs[2].finish();
    const results = await Promise.all(lines);
    assert.ok(results.every((r) => r.audio instanceof Uint8Array && r.sampleRate === 24000));
    assert.equal(h.forks(), 1);
  });
});

test('a stopped line drops its queued segments so the next line does not wait', async () => {
  await withService(async (h) => {
    // Another caller's line keeps the worker busy while the player queues its segments.
    const busy = h.say('Busy line.');
    await until(() => h.jobs.length === 1);
    const owner = { channel: 'player-a', utterance: 1 };
    const segments = ['One.', 'Two.', 'Three.', 'Four.'].map((text) => h.say(text, owner));
    // Someone else asked for "Four." too; that job must survive the cancel.
    const shared = h.say('Four.');
    // Queued segments are removed; any still arriving are dropped when they do.
    const removed = await h.call('voice:cancel', { channel: 'player-a', utterances: [1] });
    assert.ok(removed >= 0 && removed <= 3);
    for (const index of [0, 1, 2]) assert.deepEqual(await segments[index], { cancelled: true });
    assert.deepEqual(h.aborts, [], "another caller's running job is left alone");
    // The drop list can also arrive with the next request.
    const more = h.say('Five.', { channel: 'player-a', utterance: 2 });
    const next = h.say('Stop right there.', {
      channel: 'player-a',
      utterance: 3,
      drop: [2],
    });
    assert.deepEqual(await more, { cancelled: true });
    h.jobs[0].finish();
    assert.ok((await busy).audio);
    await until(() => h.jobs.length === 2);
    assert.equal(h.jobs[1].args.text, 'Four.', 'shared job kept its place');
    h.jobs[1].finish();
    await until(() => h.jobs.length === 3);
    assert.equal(h.jobs[2].args.text, 'Stop right there.');
    h.jobs[2].finish();
    // "Four." is still made for the other requester (the cancelled owner may get either).
    assert.ok((await shared).audio);
    const four = await segments[3];
    assert.ok(four.audio || four.cancelled);
    assert.ok((await next).audio);
    // Cancelling something unknown or malformed is harmless.
    assert.equal(await h.call('voice:cancel', { channel: 'player-a', utterances: [99] }), 0);
    assert.equal(await h.call('voice:cancel', null), 0);
  });
});

test('guard lines are cached on disk; the player character lines stay in memory', async () => {
  await withService(async (h, dir) => {
    const cache = path.join(dir, 'speech-cache');
    // A cache from an older version (Piper) may hold the player's lines: it is cleared once.
    await fs.mkdir(cache, { recursive: true });
    await fs.writeFile(path.join(cache, 'a'.repeat(64) + '.wav'), 'old piper line');
    const robot = h.say('Halt. Badge, please.');
    await until(() => h.jobs.length === 1);
    h.jobs[0].finish();
    await robot;
    const human = h.call('voice:synthesize', { text: 'I fix vents.', actor: 'human' });
    await until(() => h.jobs.length === 2);
    h.jobs[1].finish();
    await human;
    let files = [];
    for (let i = 0; i < 100; i++) {
      files = (await fs.readdir(cache)).filter((name) => name.endsWith('.wav'));
      if (files.length === 1) break;
      await tick();
    }
    assert.equal(files.length, 1, 'only the guard line is on disk');
    assert.ok(!files.includes('a'.repeat(64) + '.wav'));
    await fs.access(path.join(cache, '.speech-cache-v2'));
    const again = await h.call('voice:synthesize', { text: 'I fix vents.', actor: 'human' });
    assert.ok(again.audio instanceof Uint8Array);
    assert.equal(h.jobs.length, 2, 'repeated human line came from memory');
    const cached = await h.say('Halt. Badge, please.');
    assert.ok(cached.audio);
    assert.equal(h.jobs.length, 2, 'repeated guard line came from disk');
  });
});

test('only the app window may use the microphone, and only for audio', async () => {
  await withService(async (h) => {
    h.service.ready();
    const { request, check } = h.permissions();
    const ask = (contents, permission, details) =>
      new Promise((resolve) => request(contents, permission, resolve, details));
    assert.equal(await ask(h.windows.own, 'media', { mediaTypes: ['audio'] }), true);
    assert.equal(await ask(h.windows.own, 'media', { mediaTypes: ['audio', 'video'] }), false);
    assert.equal(await ask(h.windows.own, 'media', { mediaTypes: [] }), false);
    assert.equal(await ask(h.windows.other, 'media', { mediaTypes: ['audio'] }), false);
    assert.equal(await ask(h.windows.own, 'notifications', {}), false);
    assert.equal(await ask(h.windows.own, 'geolocation', {}), false);
    assert.equal(await ask(h.windows.own, 'fullscreen', {}), true);
    assert.equal(check(h.windows.own, 'media', '', { mediaType: 'audio' }), true);
    assert.equal(check(h.windows.own, 'media', '', { mediaType: 'video' }), false);
    assert.equal(check(h.windows.other, 'media', '', { mediaType: 'audio' }), false);
  });
});

test('stopping the line being synthesized aborts it and starts the next line at once', async () => {
  await withService(async (h) => {
    const long = h.say('A long guard line that is still being made.', {
      channel: 'player-b',
      utterance: 7,
    });
    const next = h.say('Hands up.', { channel: 'player-b', utterance: 8 });
    await until(() => h.jobs.length === 1);
    assert.equal(await h.call('voice:cancel', { channel: 'player-b', utterances: [7] }), 1);
    assert.deepEqual(await long, { cancelled: true });
    assert.deepEqual(h.aborts, [h.jobs[0].id], 'the worker is told to stop that job');
    await until(() => h.jobs.length === 2);
    assert.equal(h.jobs[1].args.text, 'Hands up.');
    h.jobs[0].finish(); // the aborted job's late answer is ignored
    h.jobs[1].finish();
    assert.ok((await next).audio);
  });
});
