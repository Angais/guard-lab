import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoicePlayer, playbackSegments } from '../src/audio/voice-player.mjs';
import { createRecorder, microphoneHelp } from '../src/audio/push-to-talk.mjs';
import { encodeWav } from '../shared/voice-audio.mjs';

function fakeAudio({ ended = true } = {}) {
  const log = { oscillators: 0, sources: [], shapers: 0, closed: false, options: null };
  const param = (value = 0) => ({ value });
  const node = (extra = {}) => ({ connect: (target) => target, disconnect() {}, ...extra });
  class FakeContext {
    constructor(options) {
      log.options = options;
      this.state = 'running';
      this.destination = node();
      this.started = performance.now();
      this.sampleRate = options?.sampleRate || 48000;
    }
    get currentTime() {
      return (performance.now() - this.started) / 1000;
    }
    resume() {
      return Promise.resolve();
    }
    close() {
      log.closed = true;
      return Promise.resolve();
    }
    createDynamicsCompressor() {
      return node({
        threshold: param(),
        knee: param(),
        ratio: param(),
        attack: param(),
        release: param(),
      });
    }
    createBiquadFilter() {
      return node({ type: '', frequency: param(), Q: param(), gain: param() });
    }
    createGain() {
      return node({ gain: param(1) });
    }
    createOscillator() {
      log.oscillators++;
      return node({ frequency: param(), start() {}, stop() {} });
    }
    createDelay() {
      return node({ delayTime: param() });
    }
    createWaveShaper() {
      log.shapers++;
      return node({ curve: null, oversample: 'none' });
    }
    createAnalyser() {
      return node({
        fftSize: 2048,
        getFloatTimeDomainData: (data) => data.fill(log.sources.length ? 0.1 : 0),
      });
    }
    createBuffer(_, length, sampleRate) {
      const data = new Float32Array(length);
      return { length, sampleRate, getChannelData: () => data };
    }
    createBufferSource() {
      const source = node({
        buffer: null,
        onended: null,
        start() {
          log.sources.push(source);
          if (ended) source.timer = setTimeout(() => source.onended?.(), 5);
        },
        stop() {
          clearTimeout(source.timer);
        },
      });
      return source;
    }
  }
  return { FakeContext, log };
}

function fakeDesktop() {
  const calls = [];
  const releases = [];
  return {
    calls,
    releaseAll: () => releases.splice(0).forEach((release) => release()),
    desktop: {
      voice: {
        synthesize: (data) => {
          calls.push(data);
          return new Promise((resolve) =>
            releases.push(() =>
              resolve({
                audio: encodeWav(new Float32Array(240).fill(0.1), 44100),
                sampleRate: 44100,
                durationMs: 10,
                voice: data.voice,
              }),
            ),
          );
        },
      },
    },
  };
}

test('long lines start with a short first segment and synthesize all segments at once', async () => {
  const text =
    'You are not cleared for this room. ' +
    'Step back from the vault door and keep your hands where I can see them. '.repeat(6);
  const segments = playbackSegments(text);
  assert.ok(segments.length >= 3);
  assert.equal(segments[0], 'You are not cleared for this room.', 'first sentence alone');
  assert.ok(segments.every((segment) => segment.length <= 240));
  assert.equal(
    segments[1],
    'Step back from the vault door and keep your hands where I can see them.',
    'the second segment stays short enough to be ready before the first ends',
  );
  assert.equal(segments.join(' '), text.replace(/\s+/g, ' ').trim());
  const { desktop, calls, releaseAll } = fakeDesktop();
  const { FakeContext, log } = fakeAudio();
  const player = createVoicePlayer({ desktop, AudioContextClass: FakeContext });
  const pending = player.prepare(text, { actor: 'robot', voice: 'supertonic:M1' });
  await Promise.resolve();
  assert.equal(calls.length, segments.length, 'every segment requested before any finished');
  assert.ok(calls.every((c) => c.voice === 'supertonic:M1' && c.actor === 'robot'));
  releaseAll();
  const prepared = await pending;
  assert.equal(prepared.native, false);
  assert.equal(prepared.segments.length, segments.length);
  let starts = 0;
  await player.play(prepared, { onStart: () => starts++ });
  assert.equal(starts, 1);
  assert.equal(log.sources.length, segments.length);
  assert.ok(log.oscillators > 0, 'guard voice uses the robot treatment');
});

test('a line waits briefly for its second segment instead of pausing after the first', async () => {
  // A long sentence without commas is not cut mid-phrase.
  const sentence =
    'If you take one more step toward the safe without showing me a valid access pass I will treat you as a threat to this facility.';
  assert.deepEqual(playbackSegments(sentence), [sentence]);
  const text = 'Hello. Please present your access pass, and state why you are in this room today.';
  assert.deepEqual(playbackSegments(text), [
    'Hello.',
    'Please present your access pass, and state why you are in this room today.',
  ]);
  const wav = encodeWav(new Float32Array(240).fill(0.1), 44100);
  const synthesize = (delays) => async (data) => {
    await new Promise((resolve) => setTimeout(resolve, delays[data.text] ?? 0));
    return { audio: wav, sampleRate: 44100, durationMs: 10, voice: data.voice };
  };
  const { FakeContext, log } = fakeAudio();
  // The second segment arrives 250 ms later: the first one waits for it rather than leaving
  // a gap after "Hello.".
  const late = createVoicePlayer({
    desktop: { voice: { synthesize: synthesize({ [playbackSegments(text)[1]]: 250 }) } },
    AudioContextClass: FakeContext,
  });
  const prepared = await late.prepare(text);
  const begun = performance.now();
  let startedAt = 0;
  await late.play(prepared, { onStart: () => (startedAt = performance.now() - begun) });
  assert.ok(startedAt > 180, `first segment waited (${Math.round(startedAt)} ms)`);
  assert.equal(log.sources.length, 2);
  // stop() during the wait ends play() at once and keeps the line silent.
  const again = await late.prepare(text);
  const waiting = late.play(again);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const stoppedAt = performance.now();
  late.stop();
  await waiting;
  assert.ok(performance.now() - stoppedAt < 50, 'no wait after stop');
  assert.equal(log.sources.length, 2);
  // Ready in time: no wait.
  const quick = createVoicePlayer({
    desktop: { voice: { synthesize: synthesize({}) } },
    AudioContextClass: FakeContext,
  });
  const ready = await quick.prepare(text);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const at = performance.now();
  let quickStart = 0;
  await quick.play(ready, { onStart: () => (quickStart = performance.now() - at) });
  assert.ok(quickStart < 40, `starts at once (${Math.round(quickStart)} ms)`);
});

test('playback runs at the Supertonic rate and never waits on a late ended event', async () => {
  const { desktop, releaseAll } = fakeDesktop();
  const { FakeContext, log } = fakeAudio({ ended: false });
  const player = createVoicePlayer({ desktop, AudioContextClass: FakeContext });
  const pending = player.prepare('Step back from the safe now.');
  await Promise.resolve();
  releaseAll();
  const started = performance.now();
  await player.play(await pending);
  const elapsed = performance.now() - started;
  assert.equal(log.options.sampleRate, 44100, 'no resampling of 44.1 kHz Supertonic buffers');
  assert.equal(log.sources.length, 1);
  assert.ok(elapsed < 1000, `finished by the audio clock (${Math.round(elapsed)} ms)`);
  assert.equal(player.speaking, false);
  // A context that cannot run at 44.1 kHz falls back to the default rate.
  class Fixed extends FakeContext {
    constructor(options) {
      if (options) throw new Error('NotSupportedError');
      super();
    }
  }
  const fallback = fakeDesktop();
  const other = createVoicePlayer({ desktop: fallback.desktop, AudioContextClass: Fixed });
  const line = other.prepare('Halt.');
  await Promise.resolve();
  fallback.releaseAll();
  await other.play(await line);
  assert.equal(log.sources.length, 2);
});

test('broadcast warnings use the loudspeaker treatment and level() follows the audio', async () => {
  const { desktop, releaseAll } = fakeDesktop();
  const { FakeContext, log } = fakeAudio();
  const player = createVoicePlayer({ desktop, AudioContextClass: FakeContext });
  assert.equal(player.level(), 0);
  const pending = player.prepare('Attention, leave the room now.');
  await Promise.resolve();
  releaseAll();
  const prepared = await pending;
  const levels = [];
  await player.play(prepared, { treatment: 'pa', onStart: () => levels.push(player.level()) });
  assert.equal(log.shapers, 1);
  assert.ok(levels[0] > 0 && levels[0] <= 1);
  assert.equal(player.level(), 0, 'silent once finished');
  await player.play(prepared);
  assert.equal(log.shapers, 1, 'ordinary speech is not driven');
});

test('human voices play clean and unknown voice ids resolve to Supertonic defaults', async () => {
  const { desktop, calls, releaseAll } = fakeDesktop();
  const { FakeContext, log } = fakeAudio();
  const player = createVoicePlayer({ desktop, AudioContextClass: FakeContext });
  const pending = player.prepare('Hello, I am here to fix the vent.', {
    actor: 'human',
    voice: 'piper:amy',
  });
  await Promise.resolve();
  releaseAll();
  await player.play(await pending);
  assert.equal(calls[0].voice, 'supertonic:M2');
  assert.equal(log.oscillators, 0);
  assert.equal(log.sources.length, 1);
  assert.equal(player.voicesFor('female')[0].id, 'supertonic:F1');
});

test('stop ends playback immediately and skips the remaining segments', async () => {
  const { desktop, releaseAll } = fakeDesktop();
  const { FakeContext, log } = fakeAudio();
  const player = createVoicePlayer({ desktop, AudioContextClass: FakeContext });
  const pending = player.prepare('One. ' + 'Two words follow here for the guard. '.repeat(10));
  await Promise.resolve();
  releaseAll();
  const playing = player.play(await pending);
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(player.speaking, true);
  player.stop();
  await playing;
  assert.equal(log.sources.length, 1);
  assert.equal(player.speaking, false);
});

test('without local voices the player falls back to an English system voice', async (t) => {
  const spoken = [];
  globalThis.window = {
    speechSynthesis: {
      getVoices: () => [
        { name: 'Anna', lang: 'de-DE' },
        { name: 'Samantha', lang: 'en-US' },
        { name: 'Daniel', lang: 'en-GB' },
      ],
      speak: (utterance) => {
        spoken.push(utterance);
        setTimeout(() => {
          utterance.onstart?.();
          utterance.onend?.();
        }, 1);
      },
      cancel() {},
    },
  };
  globalThis.SpeechSynthesisUtterance = class {
    constructor(text) {
      this.text = text;
    }
  };
  t.after(() => {
    delete globalThis.window;
    delete globalThis.SpeechSynthesisUtterance;
  });
  const fallbacks = [
    createVoicePlayer({ desktop: null }),
    createVoicePlayer({ desktop: { voice: { synthesize: async () => ({ native: true }) } } }),
    createVoicePlayer({
      desktop: {
        voice: {
          synthesize: async () => {
            throw new Error('Supertonic crashed');
          },
        },
      },
    }),
  ];
  for (const player of fallbacks) {
    const prepared = await player.prepare('Halt.', { actor: 'robot' });
    assert.equal(prepared.native, true);
    let started = false;
    await player.play(prepared, { onStart: () => (started = true) });
    assert.equal(started, true);
  }
  assert.equal(spoken.length, 3);
  assert.ok(
    spoken.every((u) => u.voice.name === 'Daniel'),
    'British male guard fallback',
  );
  assert.match((await fallbacks[2].prepare('Halt.')).error, /Supertonic crashed/);
});

test('stop() before a prepared line is ready keeps it silent', async () => {
  const { desktop, releaseAll } = fakeDesktop();
  const { FakeContext, log } = fakeAudio();
  const player = createVoicePlayer({ desktop, AudioContextClass: FakeContext });
  const pending = player.prepare('Step back from the safe. This is your final warning.');
  let started = false;
  const playing = player.play(pending, { onStart: () => (started = true) });
  player.stop();
  releaseAll();
  await playing;
  assert.equal(started, false);
  assert.equal(log.sources.length, 0);
  // A newer play() also wins over an older one that is still waiting for synthesis.
  const first = player.prepare('First line.');
  const second = player.prepare('Second line.');
  const older = player.play(first);
  const newer = player.play(second);
  releaseAll();
  await Promise.all([older, newer]);
  assert.equal(log.sources.length, 1);
});

test('stop() drops the queued segments of stopped lines from the voice queue', async () => {
  const { desktop, calls, releaseAll } = fakeDesktop();
  const { FakeContext } = fakeAudio();
  const player = createVoicePlayer({ desktop, AudioContextClass: FakeContext });
  const long = 'Halt. ' + 'Keep your hands where I can see them at all times. '.repeat(8);
  const pending = player.prepare(long);
  await Promise.resolve();
  const { channel, utterance } = calls[0];
  assert.match(channel, /^player-/);
  assert.ok(calls.every((c) => c.channel === channel && c.utterance === utterance));
  player.stop();
  // Without a cancel channel the drop list rides on the next request, ahead of its own job.
  player.prepare('Stop right there.');
  await Promise.resolve();
  const next = calls.at(-1);
  assert.deepEqual(next.drop, [utterance]);
  assert.notEqual(next.utterance, utterance);
  assert.equal(calls.filter((c) => c.drop).length, 1, 'drops are sent once');
  releaseAll();
  await pending;
  // With desktop.voice.cancel available, stop() cancels right away.
  const cancelled = [];
  const direct = fakeDesktop();
  direct.desktop.voice.cancel = async (data) => cancelled.push(data);
  const other = createVoicePlayer({ desktop: direct.desktop, AudioContextClass: FakeContext });
  other.prepare(long);
  await Promise.resolve();
  other.stop();
  assert.equal(cancelled.length, 1);
  assert.deepEqual(cancelled[0].utterances, [direct.calls[0].utterance]);
  direct.releaseAll();
});

test('segments dropped by a stop are synthesized again when the line plays later', async () => {
  const calls = [];
  const wav = encodeWav(new Float32Array(240).fill(0.1), 44100);
  let dropping = true;
  const desktop = {
    voice: {
      synthesize: async (data) => {
        calls.push(data);
        return dropping && !data.text.startsWith('Halt.')
          ? { cancelled: true }
          : { audio: wav, sampleRate: 44100, durationMs: 10, voice: data.voice };
      },
    },
  };
  const { FakeContext, log } = fakeAudio();
  const player = createVoicePlayer({ desktop, AudioContextClass: FakeContext });
  const text = 'Halt. ' + 'Put the tool down and step away from the vault door. '.repeat(5);
  const prepared = await player.prepare(text);
  const segments = prepared.segments.length;
  assert.ok(segments >= 3);
  dropping = false;
  await player.play({ ...prepared });
  assert.equal(log.sources.length, segments, 'every segment played');
  const retried = calls.slice(segments);
  assert.equal(retried.length, segments - 1);
  assert.ok(retried.every((c) => c.utterance !== calls[0].utterance));
});

test('a segment the local voice cannot make is spoken by the system voice', async (t) => {
  const spoken = [];
  globalThis.window = {
    speechSynthesis: {
      getVoices: () => [{ name: 'Daniel', lang: 'en-GB' }],
      speak: (utterance) => {
        spoken.push(utterance.text);
        setTimeout(() => utterance.onend?.(), 1);
      },
      cancel() {},
    },
  };
  globalThis.SpeechSynthesisUtterance = class {
    constructor(text) {
      this.text = text;
    }
  };
  t.after(() => {
    delete globalThis.window;
    delete globalThis.SpeechSynthesisUtterance;
  });
  const wav = encodeWav(new Float32Array(240).fill(0.1), 44100);
  const desktop = {
    voice: {
      synthesize: async (data) => {
        if (data.text.includes('code')) throw new Error('The voice engine took too long.');
        return { audio: wav, sampleRate: 44100, durationMs: 10, voice: data.voice };
      },
    },
  };
  const { FakeContext, log } = fakeAudio();
  const player = createVoicePlayer({ desktop, AudioContextClass: FakeContext });
  await player.play(await player.prepare('Listen carefully to what I say next. The code is 1234.'));
  assert.equal(log.sources.length, 1);
  assert.deepEqual(spoken, ['The code is 1 2 3 4.']);
});

function fakeMicrophone({ rate = 48000 } = {}) {
  const tracks = [
    {
      stopped: false,
      stop() {
        this.stopped = true;
      },
    },
  ];
  const state = { requested: 0, processor: null, context: null };
  class FakeContext {
    constructor(options) {
      this.options = options;
      this.sampleRate = rate;
      this.state = 'running';
      this.destination = {};
      state.context = this;
    }
    createMediaStreamSource() {
      return { connect: (target) => target, disconnect() {} };
    }
    createScriptProcessor(size) {
      state.processor = {
        size,
        connect: (target) => target,
        disconnect() {},
        onaudioprocess: null,
      };
      return state.processor;
    }
    close() {
      this.closed = true;
      return Promise.resolve();
    }
  }
  return {
    tracks,
    state,
    FakeContext,
    mediaDevices: {
      getUserMedia: async (constraints) => {
        state.requested++;
        state.constraints = constraints;
        return { getTracks: () => tracks };
      },
    },
    feed(samples) {
      state.processor.onaudioprocess({ inputBuffer: { getChannelData: () => samples } });
    },
  };
}

test('push-to-talk records mono audio, resamples to 16 kHz and releases the microphone', async () => {
  const mic = fakeMicrophone({ rate: 48000 });
  const asked = [];
  const recorder = createRecorder({
    desktop: {
      platform: 'darwin',
      voice: { microphone: async (ask) => (asked.push(ask), 'granted') },
    },
    mediaDevices: mic.mediaDevices,
    AudioContextClass: mic.FakeContext,
  });
  assert.equal(recorder.active, false);
  await recorder.start();
  assert.deepEqual(asked, [true]);
  assert.equal(recorder.active, true);
  assert.equal(mic.state.context.options.sampleRate, 16000);
  assert.equal(mic.state.constraints.audio.echoCancellation, true);
  const chunk = Float32Array.from({ length: 2048 }, (_, i) => 0.3 * Math.sin(i / 7));
  for (let i = 0; i < 3; i++) mic.feed(chunk);
  assert.ok(recorder.level() > 0.5);
  const result = recorder.stop();
  mic.feed(chunk); // the buffered tail arrives after release and is kept
  const clip = await result;
  assert.equal(clip.sampleRate, 16000);
  assert.equal(clip.pcm.length, Math.round((4 * 2048) / 3));
  assert.equal(clip.durationMs, Math.round((clip.pcm.length / 16000) * 1000));
  assert.ok(mic.tracks.every((track) => track.stopped));
  assert.equal(mic.state.context.closed, true);
  assert.equal(recorder.active, false);
  assert.equal(recorder.level(), 0);
});

test('a 16 kHz capture graph is used as-is and recording is capped', async () => {
  const mic = fakeMicrophone({ rate: 16000 });
  const recorder = createRecorder({
    desktop: null,
    mediaDevices: mic.mediaDevices,
    AudioContextClass: mic.FakeContext,
    maxSeconds: 0.2,
  });
  await recorder.start();
  mic.feed(new Float32Array(2048).fill(0.1));
  assert.equal(recorder.full, false);
  for (let i = 0; i < 3; i++) mic.feed(new Float32Array(2048).fill(0.1));
  assert.equal(recorder.full, true, 'the caller can send the clip at the limit');
  const pending = recorder.stop();
  mic.feed(new Float32Array(2048).fill(0.1));
  const clip = await pending;
  assert.equal(clip.pcm.length, 3200);
  assert.equal(recorder.full, false);
});

test('a new recording can start while the previous one is still collecting its tail', async () => {
  const mic = fakeMicrophone({ rate: 16000 });
  const recorder = createRecorder({
    desktop: null,
    mediaDevices: mic.mediaDevices,
    AudioContextClass: mic.FakeContext,
  });
  await recorder.start();
  mic.feed(new Float32Array(2048).fill(0.1));
  const first = mic.state.processor;
  const stopping = recorder.stop();
  assert.equal(recorder.active, false, 'detached at once');
  await recorder.start();
  assert.equal(mic.state.requested, 2, 'a fresh capture, not the one being stopped');
  first.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(2048).fill(0.1) } });
  assert.equal((await stopping).pcm.length, 4096);
  assert.equal(recorder.active, true);
  recorder.cancel();
});

test('denied or failing microphones give readable, platform-specific help', async () => {
  const mic = fakeMicrophone();
  const denied = createRecorder({
    desktop: { platform: 'win32', voice: { microphone: async () => 'denied' } },
    mediaDevices: mic.mediaDevices,
    AudioContextClass: mic.FakeContext,
  });
  await assert.rejects(denied.start(), /Windows|Settings › Privacy & security › Microphone/);
  assert.equal(mic.state.requested, 0, 'no capture after a denial');
  assert.equal(denied.active, false);
  const blocked = createRecorder({
    desktop: { platform: 'darwin' },
    mediaDevices: {
      getUserMedia: async () => {
        throw Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
      },
    },
    AudioContextClass: mic.FakeContext,
  });
  await assert.rejects(blocked.start(), /System Settings › Privacy & Security › Microphone/);
  const none = createRecorder({
    desktop: null,
    mediaDevices: {
      getUserMedia: async () => {
        throw Object.assign(new Error('none'), { name: 'NotFoundError' });
      },
    },
  });
  await assert.rejects(none.start(), /No microphone found/);
  assert.match(microphoneHelp('linux'), /Allow microphone access/);
});

test('cancel discards audio and releases the microphone, even mid-start', async () => {
  const mic = fakeMicrophone();
  const recorder = createRecorder({
    desktop: null,
    mediaDevices: mic.mediaDevices,
    AudioContextClass: mic.FakeContext,
  });
  await recorder.start();
  mic.feed(new Float32Array(2048).fill(0.2));
  recorder.cancel();
  assert.equal(recorder.active, false);
  assert.ok(mic.tracks.every((track) => track.stopped));
  assert.equal((await recorder.stop()).pcm.length, 0);
  const early = fakeMicrophone();
  const racing = createRecorder({
    desktop: null,
    mediaDevices: early.mediaDevices,
    AudioContextClass: early.FakeContext,
  });
  const starting = racing.start();
  racing.cancel();
  await starting;
  assert.ok(early.tracks.every((track) => track.stopped));
});
