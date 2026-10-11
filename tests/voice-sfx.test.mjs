import test from 'node:test';
import assert from 'node:assert/strict';

// A minimal WebAudio stand-in that records the graph sfx.mjs builds.
function installFakeAudio() {
  const log = { contexts: [], convolvers: [], sources: 0, gains: [] };
  const param = (value = 0) => {
    const p = {
      value,
      events: [],
      setValueAtTime: (v, t) => p.events.push(['set', v, t]),
      exponentialRampToValueAtTime: (v, t) => p.events.push(['ramp', v, t]),
      setTargetAtTime: (v, t) => p.events.push(['target', v, t]),
    };
    return p;
  };
  const node = (extra = {}) => ({ connect: (target) => target, disconnect() {}, ...extra });
  globalThis.AudioContext = class {
    constructor() {
      this.sampleRate = 48000;
      this.currentTime = 0;
      this.state = 'running';
      this.destination = node();
      log.contexts.push(this);
    }
    resume() {
      return Promise.resolve();
    }
    createGain() {
      const gain = node({ gain: param(1) });
      log.gains.push(gain);
      return gain;
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
    createConvolver() {
      const convolver = node({ buffer: null });
      log.convolvers.push(convolver);
      return convolver;
    }
    createBiquadFilter() {
      return node({ type: '', frequency: param(), Q: param() });
    }
    createStereoPanner() {
      return node({ pan: param() });
    }
    createBuffer(channels, length, sampleRate) {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      return { numberOfChannels: channels, length, sampleRate, getChannelData: (c) => data[c] };
    }
    createOscillator() {
      log.sources++;
      return node({ type: '', frequency: param(), start() {}, stop() {} });
    }
    createBufferSource() {
      log.sources++;
      return node({ buffer: null, start() {}, stop() {} });
    }
  };
  return log;
}

const energy = (data, from = 0, to = data.length) => {
  let sum = 0;
  for (let i = from; i < to; i++) sum += data[i] * data[i];
  return sum;
};

// Share of spectral energy below `limit` Hz in one Hann-windowed frame.
function lowShare(data, rate, limit, size = 2048) {
  let low = 0,
    total = 0;
  for (let k = 1; k < size / 2; k++) {
    let re = 0,
      im = 0;
    for (let i = 0; i < size; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size),
        a = (2 * Math.PI * k * i) / size;
      re += data[i] * w * Math.cos(a);
      im -= data[i] * w * Math.sin(a);
    }
    const power = re * re + im * im;
    total += power;
    if ((k * rate) / size < limit) low += power;
  }
  return low / total;
}

test('the effects room is a dark, decaying, decorrelated noise response', async () => {
  const log = installFakeAudio();
  const { unlockAudio } = await import('../src/audio/sfx.mjs?room');
  unlockAudio();
  const impulse = log.convolvers[0].buffer;
  assert.equal(impulse.numberOfChannels, 2);
  const [left, right] = [impulse.getChannelData(0), impulse.getChannelData(1)];
  const rate = impulse.sampleRate,
    start = Math.round(rate * 0.01);
  // The previous impulse was two ultrasonic sine products: no energy below 8 kHz at all.
  assert.ok(lowShare(left.subarray(start), rate, 8000) > 0.85, 'energy sits below 8 kHz');
  const early = energy(left, 0, rate * 0.1),
    late = energy(left, rate * 0.4, rate * 0.5);
  assert.ok(late < early / 300, 'decays by more than 25 dB within 0.4 s');
  let cross = 0;
  for (let i = 0; i < left.length; i++) cross += left[i] * right[i];
  assert.ok(Math.abs(cross) / Math.sqrt(energy(left) * energy(right)) < 0.2, 'stereo width');
});

test('every cue plays, including the new microphone and security sounds', async () => {
  const log = installFakeAudio();
  const { playSound, setSoundEnabled } = await import('../src/audio/sfx.mjs?cues');
  const names = [
    'footstep',
    'gunshot',
    'explosion',
    'keypad',
    'warning',
    'mic-ready',
    'siren',
    'security-tick',
    'security-arrival',
    'slip',
  ];
  for (const name of names) {
    const before = log.sources;
    playSound(name);
    assert.ok(log.sources > before, name);
  }
  const before = log.sources;
  playSound('no-such-sound');
  setSoundEnabled(false);
  playSound('gunshot');
  assert.equal(log.sources, before, 'unknown names and muted sound stay silent');
  setSoundEnabled(true);
  // The mix: a gunshot's loudest layer is far louder than a footstep's.
  const peak = (name) => {
    const from = log.gains.length;
    playSound(name);
    return Math.max(
      ...log.gains
        .slice(from)
        .flatMap((g) => g.gain.events.filter((e) => e[0] === 'ramp').map((e) => e[1])),
    );
  };
  assert.ok(peak('gunshot') > peak('footstep') * 4);
  assert.ok(peak('footstep') > 0.2, 'footsteps are audible');
});
