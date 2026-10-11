import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  MODELS,
  MARKER_VERSION,
  VoiceEngine,
  installModel,
  readStatus,
  removeModel,
  runtimeFailure,
  totalBytes,
} from '../shared/voice-models.mjs';
import { temporaryDirectory, removeTemporary } from '../shared/temporary.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const REVISION = 'a'.repeat(40);
const CONTENT = {
  'config.json': Buffer.from('{"fixture":true}'),
  'onnx/model_quantized.onnx': Buffer.alloc(300000, 7),
};
const SPEC = {
  kind: 'tts',
  label: 'Fixture TTS',
  title: 'Fixture voices',
  repo: 'fixture-org/fixture-model',
  revision: REVISION,
  dtype: 'q8',
  files: Object.entries(CONTENT).map(([name, bytes]) => ({
    path: name,
    size: bytes.length,
    sha256: sha(bytes),
  })),
};

// No test may touch the network.
test.before(() => {
  globalThis.fetch = () => {
    throw new Error('Network access in tests.');
  };
});

function server(content = CONTENT) {
  const fetched = [];
  const fetchImpl = async (url) => {
    fetched.push(url);
    const name = url.split(`/resolve/${REVISION}/`)[1];
    if (!content[name]) return new Response('', { status: 404 });
    const bytes = content[name];
    // Several chunks so progress is aggregated across reads.
    const stream = new ReadableStream({
      start(controller) {
        for (let at = 0; at < bytes.length; at += 65536)
          controller.enqueue(new Uint8Array(bytes.subarray(at, at + 65536)));
        controller.close();
      },
    });
    return new Response(stream);
  };
  return { fetched, fetchImpl };
}

async function partFiles(dir) {
  const found = [];
  for (const entry of await fs.readdir(dir, { recursive: true }))
    if (/\.(part|tmp)$/.test(entry)) found.push(entry);
  return found;
}

async function withDir(prefix, run) {
  const dir = await temporaryDirectory(prefix);
  try {
    await run(dir);
  } finally {
    await removeTemporary(dir);
  }
}

test('pinned model specs carry exact sizes, digests and commit revisions', () => {
  for (const spec of Object.values(MODELS)) {
    assert.match(spec.revision, /^[0-9a-f]{40}$/);
    for (const entry of spec.files) {
      assert.match(entry.sha256, /^[0-9a-f]{64}$/);
      assert.ok(entry.size > 0);
      assert.ok(!entry.path.includes('..'));
    }
  }
  assert.equal(MODELS.tts.repo, 'Supertone/supertonic-2');
  assert.equal(MODELS.tts.revision, '75e6727618a02f323c720cba9478152d4bc16ca4');
  assert.equal(MODELS.tts.dtype, 'int8');
  assert.equal(MODELS.tts.license.name, 'OpenRAIL-M');
  // The int8 ONNX graphs come from the sherpa-onnx conversion, pinned to its own commit.
  const int8 = MODELS.tts.files.filter((entry) => entry.repo);
  assert.deepEqual(int8.map((entry) => entry.remote).sort(), [
    'LICENSE',
    'duration_predictor.int8.onnx',
    'text_encoder.int8.onnx',
    'vector_estimator.int8.onnx',
    'vocoder.int8.onnx',
  ]);
  for (const entry of int8) {
    assert.equal(entry.repo, 'csukuangfj2/sherpa-onnx-supertonic-tts-int8-2026-03-06');
    assert.match(entry.revision, /^[0-9a-f]{40}$/);
  }
  assert.equal(MODELS.tts.files.filter((f) => f.path.startsWith('voice_styles/')).length, 10);
  assert.deepEqual({ ...MODELS.stt.dtype }, { encoder_model: 'fp32', decoder_model_merged: 'q8' });
  assert.equal(Math.round(totalBytes(MODELS.tts) / 1e6), 100);
  assert.equal(Math.round(totalBytes(MODELS.stt) / 1e6), 139);
});

test('missing models report missing with size label and never start a download', async () => {
  await withDir('guard-voice-missing-', async (dir) => {
    const tts = await readStatus('tts', { dir });
    assert.equal(tts.state, 'missing');
    assert.equal(tts.progress, 0);
    assert.equal(tts.sizeLabel, '100 MB');
    assert.equal(tts.model, 'Supertonic 2');
    assert.deepEqual(tts.license, {
      name: 'OpenRAIL-M',
      url: 'https://huggingface.co/Supertone/supertonic-2/blob/main/LICENSE',
    });
    assert.equal(tts.legacy, undefined);
    assert.equal((await readStatus('stt', { dir })).sizeLabel, '139 MB');
    const engine = new VoiceEngine({ dir });
    await assert.rejects(engine.synthesize({ text: 'Hello' }), (error) => {
      assert.equal(error.code, 'NOT_INSTALLED');
      return true;
    });
    await assert.rejects(readStatus('nope', { dir }), /Unknown voice component/);
  });
});

test('install verifies every byte, runs the load check, then marks ready', async () => {
  await withDir('guard-voice-install-', async (dir) => {
    const { fetched, fetchImpl } = server();
    const progress = [];
    let checked = false;
    const result = await installModel('tts', {
      dir,
      spec: SPEC,
      fetchImpl,
      endpoint: 'https://models.invalid',
      onProgress: (event) => progress.push(event),
      check: async (spec, options) => {
        // The marker is written only after this check succeeds.
        assert.equal((await readStatus('tts', { dir, spec })).state, 'missing');
        assert.equal(options.dir, dir);
        checked = true;
        return { fixtureModel: true };
      },
    });
    assert.equal(checked, true);
    assert.deepEqual(result.model, { fixtureModel: true });
    assert.equal(result.status.state, 'ready');
    assert.equal(result.status.progress, 1);
    assert.deepEqual(
      fetched.sort(),
      SPEC.files
        .map((f) => `https://models.invalid/${SPEC.repo}/resolve/${REVISION}/${f.path}`)
        .sort(),
    );
    for (let i = 1; i < progress.length; i++)
      assert.ok(progress[i].progress >= progress[i - 1].progress, 'progress never goes back');
    assert.ok(
      progress.some((p) => p.phase === 'downloading' && p.progress > 0 && p.progress < 0.96),
    );
    assert.equal(progress.at(-1).phase, 'ready');
    assert.equal(progress.at(-1).bytes, totalBytes(SPEC));
    assert.equal(progress.at(-1).totalBytes, totalBytes(SPEC));
    const marker = JSON.parse(await fs.readFile(path.join(dir, 'tts.json'), 'utf8'));
    assert.equal(marker.version, MARKER_VERSION);
    assert.equal(marker.repo, SPEC.repo);
    assert.equal(marker.revision, REVISION);
    assert.deepEqual(await partFiles(dir), []);
    assert.deepEqual(
      await fs.readFile(path.join(dir, 'fixture-org/fixture-model/onnx/model_quantized.onnx')),
      CONTENT['onnx/model_quantized.onnx'],
    );
  });
});

test('a failed load check leaves the model not ready and keeps verified files for retry', async () => {
  await withDir('guard-voice-check-', async (dir) => {
    const { fetched, fetchImpl } = server();
    await assert.rejects(
      installModel('tts', {
        dir,
        spec: SPEC,
        fetchImpl,
        check: async () => {
          throw new Error('Fixture model failed to load');
        },
      }),
      /failed to load/,
    );
    assert.equal((await readStatus('tts', { dir, spec: SPEC })).state, 'missing');
    const count = fetched.length;
    await installModel('tts', { dir, spec: SPEC, fetchImpl, check: async () => null });
    assert.equal(fetched.length, count, 'verified files are not downloaded again');
    assert.equal((await readStatus('tts', { dir, spec: SPEC })).state, 'ready');
  });
});

test('checksum and HTTP failures reject without partial files or a ready marker', async () => {
  await withDir('guard-voice-bad-', async (dir) => {
    const tampered = { ...CONTENT, 'onnx/model_quantized.onnx': Buffer.alloc(300000, 8) };
    await assert.rejects(
      installModel('tts', {
        dir,
        spec: SPEC,
        fetchImpl: server(tampered).fetchImpl,
        check: async () => null,
      }),
      /Checksum mismatch/,
    );
    assert.deepEqual(await partFiles(dir), []);
    assert.equal((await readStatus('tts', { dir, spec: SPEC })).state, 'missing');
    const missing = { 'config.json': CONTENT['config.json'] };
    await assert.rejects(
      installModel('tts', {
        dir,
        spec: SPEC,
        fetchImpl: server(missing).fetchImpl,
        check: async () => null,
      }),
      /HTTP 404/,
    );
    assert.deepEqual(await partFiles(dir), []);
  });
});

test('damaged files report an error and reinstall repairs only the damaged file', async () => {
  await withDir('guard-voice-repair-', async (dir) => {
    const { fetched, fetchImpl } = server();
    await installModel('tts', { dir, spec: SPEC, fetchImpl, check: async () => null });
    await fs.writeFile(path.join(dir, 'fixture-org/fixture-model/onnx/model_quantized.onnx'), 'x');
    const damaged = await readStatus('tts', { dir, spec: SPEC });
    assert.equal(damaged.state, 'error');
    assert.match(damaged.message, /damaged/);
    const before = fetched.length;
    await installModel('tts', { dir, spec: SPEC, fetchImpl, check: async () => null });
    assert.equal(fetched.length, before + 1);
    assert.ok(fetched.at(-1).endsWith('onnx/model_quantized.onnx'));
    assert.equal((await readStatus('tts', { dir, spec: SPEC })).state, 'ready');
  });
});

test('markers from another revision or format are not treated as ready', async () => {
  await withDir('guard-voice-marker-', async (dir) => {
    const { fetchImpl } = server();
    await installModel('tts', { dir, spec: SPEC, fetchImpl, check: async () => null });
    const file = path.join(dir, 'tts.json');
    const marker = JSON.parse(await fs.readFile(file, 'utf8'));
    for (const changed of [
      { ...marker, revision: 'b'.repeat(40) },
      { ...marker, version: MARKER_VERSION + 1 },
      { ...marker, dtype: 'fp32' },
    ]) {
      await fs.writeFile(file, JSON.stringify(changed));
      assert.equal((await readStatus('tts', { dir, spec: SPEC })).state, 'missing');
    }
    await fs.writeFile(file, '{ damaged');
    assert.equal((await readStatus('tts', { dir, spec: SPEC })).state, 'missing');
  });
});

test('concurrent installs share one download and a crashed installer lock is recovered', async () => {
  await withDir('guard-voice-lock-', async (dir) => {
    await fs.writeFile(
      path.join(dir, '.tts.install.lock'),
      JSON.stringify({ pid: 999999999, token: 'crashed-fixture' }),
    );
    const { fetched, fetchImpl } = server();
    const options = { dir, spec: SPEC, fetchImpl, check: async () => null };
    const first = installModel('tts', options);
    assert.equal(installModel('tts', options), first);
    await first;
    assert.equal(fetched.length, SPEC.files.length);
    await assert.rejects(fs.access(path.join(dir, '.tts.install.lock')));
  });
});

test('a local source folder installs offline with the same verification', async () => {
  await withDir('guard-voice-source-', async (root) => {
    const source = path.join(root, 'mirror'),
      dir = path.join(root, 'models');
    for (const [name, bytes] of Object.entries(CONTENT)) {
      const file = path.join(source, SPEC.repo, name);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, bytes);
    }
    const fetchImpl = () => {
      throw new Error('should not fetch');
    };
    const { status } = await installModel('tts', {
      dir,
      spec: SPEC,
      source,
      fetchImpl,
      check: async () => null,
    });
    assert.equal(status.state, 'ready');
    const removed = await removeModel('tts', { dir, spec: SPEC });
    assert.equal(removed.state, 'missing');
    await assert.rejects(fs.access(path.join(dir, SPEC.repo)));
    await assert.rejects(fs.access(path.join(dir, 'tts.json')));
  });
});

// A component built from two upstream repos, like Supertonic (weights + int8 conversion).
const OTHER = 'b'.repeat(40);
const MIXED_CONTENT = {
  'onnx/tts.json': Buffer.from('{"ae":{}}'),
  'int8/model.int8.onnx': Buffer.alloc(200000, 3),
};
const MIXED = {
  ...SPEC,
  legacy: [{ model: 'Old voices', path: 'old-org/old-voices' }],
  files: [
    { path: 'onnx/tts.json', size: 9, sha256: sha(MIXED_CONTENT['onnx/tts.json']) },
    {
      path: 'int8/model.int8.onnx',
      size: 200000,
      sha256: sha(MIXED_CONTENT['int8/model.int8.onnx']),
      repo: 'convert-org/model-int8',
      revision: OTHER,
      remote: 'model.int8.onnx',
    },
  ],
};

test('files from several upstream repos download from their own pinned commits', async () => {
  await withDir('guard-voice-mixed-', async (dir) => {
    const fetched = [];
    const fetchImpl = async (url) => {
      fetched.push(url);
      const name = url.endsWith('model.int8.onnx') ? 'int8/model.int8.onnx' : 'onnx/tts.json';
      return new Response(MIXED_CONTENT[name]);
    };
    const { status } = await installModel('tts', {
      dir,
      spec: MIXED,
      fetchImpl,
      endpoint: 'https://mirror.invalid/',
      check: async () => null,
    });
    assert.equal(status.state, 'ready');
    assert.deepEqual(fetched.sort(), [
      `https://mirror.invalid/convert-org/model-int8/resolve/${OTHER}/model.int8.onnx`,
      `https://mirror.invalid/fixture-org/fixture-model/resolve/${REVISION}/onnx/tts.json`,
    ]);
    await fs.access(path.join(dir, 'fixture-org/fixture-model/int8/model.int8.onnx'));
    const marker = JSON.parse(await fs.readFile(path.join(dir, 'tts.json'), 'utf8'));
    assert.deepEqual(marker.sources, [
      `convert-org/model-int8@${OTHER}`,
      `fixture-org/fixture-model@${REVISION}`,
    ]);
    // A changed conversion commit is a new model.
    await fs.writeFile(
      path.join(dir, 'tts.json'),
      JSON.stringify({ ...marker, sources: [`convert-org/model-int8@${REVISION}`] }),
    );
    assert.equal((await readStatus('tts', { dir, spec: MIXED })).state, 'missing');
  });
});

test('markers written before multi-repo models (Whisper) stay ready', async () => {
  await withDir('guard-voice-old-marker-', async (dir) => {
    const { fetchImpl } = server();
    await installModel('stt', {
      dir,
      spec: { ...SPEC, kind: 'stt' },
      fetchImpl,
      check: async () => null,
    });
    const file = path.join(dir, 'stt.json');
    const { sources, ...old } = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.ok(sources);
    await fs.writeFile(file, JSON.stringify(old));
    assert.equal((await readStatus('stt', { dir, spec: { ...SPEC, kind: 'stt' } })).state, 'ready');
  });
});

test('local sources: folders of downloaded repos with any names install offline', async () => {
  await withDir('guard-voice-folders-', async (root) => {
    const source = path.join(root, 'bench'),
      dir = path.join(root, 'models');
    const put = async (name, bytes) => {
      await fs.mkdir(path.dirname(path.join(source, name)), { recursive: true });
      await fs.writeFile(path.join(source, name), bytes);
    };
    // Same file name in two folders: only the copy with the pinned digest is used.
    await put('official/onnx/tts.json', MIXED_CONTENT['onnx/tts.json']);
    await put('another-int8/model.int8.onnx', Buffer.alloc(200000, 4));
    await put('my-int8/model.int8.onnx', MIXED_CONTENT['int8/model.int8.onnx']);
    const fetchImpl = () => {
      throw new Error('should not fetch');
    };
    const options = { dir, spec: MIXED, source, fetchImpl, check: async () => null };
    assert.equal((await installModel('tts', options)).status.state, 'ready');
    await withDir('guard-voice-empty-', async (empty) => {
      await assert.rejects(
        installModel('tts', { ...options, dir: path.join(empty, 'models'), source: empty }),
        /tts\.json .* was not found in/,
      );
    });
  });
});

test('an earlier model is reported, then removed once the new one installs; others stay', async () => {
  await withDir('guard-voice-legacy-', async (dir) => {
    const old = path.join(dir, 'old-org/old-voices/onnx/model.onnx'),
      neighbour = path.join(dir, 'old-org/speech-to-text/model.onnx');
    for (const file of [old, neighbour]) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, Buffer.alloc(4000, 1));
    }
    const before = await readStatus('tts', { dir, spec: MIXED });
    assert.equal(before.state, 'missing');
    assert.deepEqual(before.legacy, { model: 'Old voices', bytes: 4000, sizeLabel: '1 MB' });
    const fetchImpl = async (url) =>
      new Response(
        MIXED_CONTENT[url.endsWith('model.int8.onnx') ? 'int8/model.int8.onnx' : 'onnx/tts.json'],
      );
    // A failed install keeps the earlier model.
    await assert.rejects(
      installModel('tts', {
        dir,
        spec: MIXED,
        fetchImpl,
        check: async () => {
          throw new Error('fixture load failure');
        },
      }),
    );
    await fs.access(old);
    const { status } = await installModel('tts', {
      dir,
      spec: MIXED,
      fetchImpl,
      check: async () => null,
    });
    assert.equal(status.state, 'ready');
    assert.equal(status.legacy, undefined);
    await assert.rejects(fs.access(path.join(dir, 'old-org/old-voices')));
    await fs.access(neighbour);
    // remove() also clears a leftover earlier model.
    await fs.mkdir(path.dirname(old), { recursive: true });
    await fs.writeFile(old, 'x');
    await removeModel('tts', { dir, spec: MIXED });
    await assert.rejects(fs.access(path.join(dir, 'old-org/old-voices')));
    await fs.access(neighbour);
  });
});

test('a stalled download is aborted with a readable message', async () => {
  await withDir('guard-voice-stall-', async (dir) => {
    const fetchImpl = async (url, { signal }) =>
      new Response(
        new ReadableStream({
          start(controller) {
            signal.addEventListener('abort', () => controller.error(signal.reason));
          },
        }),
      );
    await assert.rejects(
      installModel('tts', { dir, spec: SPEC, fetchImpl, idleMs: 50, check: async () => null }),
      /stalled/,
    );
    assert.deepEqual(await partFiles(dir), []);
  });
});

test('a dropped connection reads as interrupted, an unreachable host as unreachable', async () => {
  await withDir('guard-voice-drop-', async (dir) => {
    // Electron's net.fetch errors mid-body after some bytes have arrived.
    const dropping = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(10));
            setTimeout(() => controller.error(new Error('net::ERR_CONTENT_LENGTH_MISMATCH')), 5);
          },
        }),
      );
    await assert.rejects(
      installModel('tts', { dir, spec: SPEC, fetchImpl: dropping, check: async () => null }),
      /^Error: Download interrupted \(net::ERR_CONTENT_LENGTH_MISMATCH\)\. Retry to continue\.$/,
    );
    assert.deepEqual(await partFiles(dir), []);
    const offline = async () => {
      throw new Error('net::ERR_INTERNET_DISCONNECTED');
    };
    await assert.rejects(
      installModel('tts', { dir, spec: SPEC, fetchImpl: offline, check: async () => null }),
      /Could not reach huggingface\.co \(net::ERR_INTERNET_DISCONNECTED\)/,
    );
    // Node's fetch (the CLI installer) reports a dropped body as "terminated".
    const terminated = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(10));
            setTimeout(() => controller.error(new TypeError('terminated')), 5);
          },
        }),
      );
    await assert.rejects(
      installModel('tts', { dir, spec: SPEC, fetchImpl: terminated, check: async () => null }),
      /^Error: Download interrupted\. Retry to continue\.$/,
    );
  });
});

test('partial files left by an interrupted install are removed by the next install', async () => {
  await withDir('guard-voice-leftover-', async (dir) => {
    const root = path.join(dir, SPEC.repo);
    await fs.mkdir(path.join(root, 'onnx'), { recursive: true });
    // What a killed installer leaves behind: a random-name partial download and marker temp.
    await fs.writeFile(path.join(root, 'onnx/model_quantized.onnx.0f3c-crashed.part'), 'partial');
    await fs.writeFile(path.join(root, 'config.json.1a2b.part'), 'partial');
    await fs.writeFile(path.join(dir, 'tts.json.5e6f.tmp'), '{}');
    await fs.writeFile(path.join(dir, 'stt.json.7a8b.tmp'), '{}');
    const { fetchImpl } = server();
    await installModel('tts', { dir, spec: SPEC, fetchImpl, check: async () => null });
    assert.deepEqual(await partFiles(root), []);
    assert.equal((await readStatus('tts', { dir, spec: SPEC })).state, 'ready');
    // Another component's temporaries are not this install's to delete.
    await fs.access(path.join(dir, 'stt.json.7a8b.tmp'));
  });
});

test('a speech runtime that cannot load explains the Windows Visual C++ fix', () => {
  const dlopen = Object.assign(
    new Error('The specified module could not be found.\r\n\\\\?\\C:\\x\\onnxruntime_binding.node'),
    { code: 'ERR_DLOPEN_FAILED' },
  );
  const windows = runtimeFailure(dlopen, { platform: 'win32', arch: 'x64' });
  assert.equal(windows.code, 'VC_RUNTIME_MISSING');
  assert.match(windows.message, /Visual C\+\+ Redistributable/);
  assert.match(windows.message, /vc_redist\.x64\.exe/);
  assert.match(runtimeFailure(dlopen, { platform: 'win32', arch: 'arm64' }).message, /arm64\.exe/);
  const mac = runtimeFailure(new Error('dlopen failed\nstack'), { platform: 'darwin' });
  assert.match(mac.message, /could not start \(dlopen failed\)\. Reinstall/);
});
