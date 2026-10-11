// Dialogue playback: local Supertonic WAVs through WebAudio, with system speech as the fallback.
// The guard gets a light "speaker" treatment (band-limit, faint ring modulation and a short
// metallic comb); human voices play clean.
import { nativeSpeech } from './speech.mjs';
import { decodeWav, sentencePieces, TTS_SAMPLE_RATE } from '../../shared/voice-audio.mjs';
import {
  VOICES,
  DEFAULT_VOICES,
  defaultVoice,
  resolveVoice,
  voicesFor as catalogVoicesFor,
} from '../../shared/voice-catalog.mjs';

export { VOICES, DEFAULT_VOICES, defaultVoice };

// The context runs at the voice model's output rate (Supertonic: 44.1 kHz). Playing buffers in a
// context at another rate makes Chromium resample them, and the resampling source can fire
// 'ended' up to a buffer length late (Electron 44 at 48 kHz), which left silent gaps between
// sentences and held up the turn.
const SPEECH_RATE = TTS_SAMPLE_RATE;
// Synthesis-time model for one segment: a fixed cost per synthesis request plus a per-character
// cost learned from segments synthesized back to back. A line whose second segment would not be
// ready when the first ends starts up to LEAD_MAX_MS later instead of pausing mid-line.
const PASS_MS = 200;
const LEAD_MAX_MS = 1500;

/**
 * Segments for playback: the first sentence alone so speech starts quickly, then groups that
 * grow with what is already queued. Supertonic runs faster than real time, so each segment is
 * normally ready before the previous one finishes playing. Sentences are split (at clauses, then
 * at words above 240 characters) only when longer than 140 characters.
 */
export function playbackSegments(text) {
  const pieces = sentencePieces(text, 140, 240);
  if (pieces.length <= 1) return pieces;
  const segments = [pieces[0]];
  let current = '';
  for (const piece of pieces.slice(1)) {
    const budget = Math.min(240, Math.max(40, segments.at(-1).length * 1.8));
    if (current && current.length + 1 + piece.length > budget) {
      segments.push(current);
      current = piece;
    } else current = current ? current + ' ' + piece : piece;
  }
  if (current) segments.push(current);
  return segments;
}

// Soft saturation for the public-address treatment of broadcast warnings.
let paCurve = null;
function saturation() {
  if (!paCurve) {
    paCurve = new Float32Array(1024);
    for (let i = 0; i < paCurve.length; i++) {
      const x = (i / (paCurve.length - 1)) * 2 - 1;
      paCurve[i] = Math.tanh(1.8 * x) / Math.tanh(1.8);
    }
  }
  return paCurve;
}
// Coarse quantization (≈5-bit) for the faint digital texture on the guard's highs.
let quantCurve = null;
function quantizer() {
  if (!quantCurve) {
    quantCurve = new Float32Array(2048);
    for (let i = 0; i < quantCurve.length; i++) {
      const x = (i / (quantCurve.length - 1)) * 2 - 1;
      quantCurve[i] = Math.round(x * 16) / 16;
    }
  }
  return quantCurve;
}

export function robotChain(context, destination, { pa = false } = {}) {
  const nodes = [];
  const node = (value) => (nodes.push(value), value);
  const filter = (type, frequency, q, gain) => {
    const f = node(context.createBiquadFilter());
    f.type = type;
    f.frequency.value = frequency;
    f.Q.value = q;
    if (gain !== undefined) f.gain.value = gain;
    return f;
  };
  const level = (value) => {
    const g = node(context.createGain());
    g.gain.value = value;
    return g;
  };
  // Full-band, clean EQ first: the voice must stay crisp. A broadcast warning goes through the
  // room's loudspeaker instead: louder, narrower and driven.
  const input = level(pa ? 1.35 : 1),
    highpass = filter('highpass', pa ? 280 : 110, 0.7),
    mud = filter('peaking', 280, 1, pa ? -1 : -2.5),
    presence = filter('peaking', pa ? 2600 : 3200, 0.8, pa ? 5 : 2.5),
    air = filter('highshelf', 8500, 0.7, pa ? -6 : 2),
    top = filter('lowpass', pa ? 6800 : 15000, 0.5),
    mix = level(1);
  input.connect(highpass).connect(mud).connect(presence).connect(air);
  if (pa) {
    const shaper = node(context.createWaveShaper());
    shaper.curve = saturation();
    shaper.oversample = '4x';
    air.connect(shaper).connect(top);
  } else air.connect(top);
  top.connect(level(pa ? 0.8 : 0.86)).connect(mix);
  // Metallic chassis sheen: a very short bright comb in parallel (≈1.15 ms → resonances every
  // ≈870 Hz), band-limited so it adds shine without muddying or hollowing the dry voice.
  const comb = node(context.createDelay(0.01)),
    combFeedback = level(0.42),
    combTone = filter('bandpass', 2600, 0.7);
  comb.delayTime.value = 0.00115;
  top.connect(comb).connect(combFeedback).connect(comb);
  comb
    .connect(combTone)
    .connect(level(pa ? 0.14 : 0.24))
    .connect(mix);
  // A whisper of digital texture on the highs only (quantized copy above 2.5 kHz).
  const grit = node(context.createWaveShaper());
  grit.curve = quantizer();
  grit.oversample = 'none';
  top
    .connect(filter('highpass', 2500, 0.7))
    .connect(grit)
    .connect(level(0.035))
    .connect(mix);
  // Light synthetic shimmer: shallow amplitude modulation, far too subtle to sound like a buzz.
  const shimmer = level(1),
    carrier = node(context.createOscillator()),
    depth = level(pa ? 0.03 : 0.05);
  carrier.frequency.value = 52;
  carrier.connect(depth).connect(shimmer.gain);
  mix.connect(shimmer).connect(destination);
  carrier.start();
  return {
    input,
    dispose() {
      try {
        carrier.stop();
      } catch {}
      for (const n of nodes) n.disconnect();
    },
  };
}

function decodeResult(result) {
  if (result?.cancelled) return { cancelled: true };
  if (!result || result.native) return { native: true };
  const { samples, sampleRate } = decodeWav(result.audio);
  return {
    samples,
    sampleRate,
    durationMs: result.durationMs ?? Math.round((samples.length / sampleRate) * 1000),
    voice: result.voice,
  };
}

// What a prepared line needs to re-request a segment; survives `{ ...prepared }` copies.
const LINE = Symbol('guard-lab.voice-line');
let players = 0;

export function createVoicePlayer({
  desktop = globalThis.window?.desktop,
  AudioContextClass,
} = {}) {
  const api = desktop?.voice;
  // Synthesis requests carry this player's channel and an utterance number, so segments of a
  // stopped line can be dropped from the voice queue before they delay the next line.
  const channel = `player-${(++players).toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const outstanding = new Map(),
    drops = new Set();
  let msPerChar = 45, // learned synthesis speed
    context = null,
    output = null,
    meter = null,
    meterData = null,
    current = null,
    utterances = 0,
    plays = 0,
    stops = 0;

  function cancelUtterances(ids) {
    const list = [...new Set(ids)].filter(Number.isSafeInteger);
    if (!list.length || !api?.synthesize) return;
    for (const id of list) outstanding.delete(id);
    if (typeof api.cancel === 'function') {
      try {
        Promise.resolve(api.cancel({ channel, utterances: list })).catch(() => {});
        return;
      } catch {}
    }
    // Otherwise the drop list rides along with the next synthesis request.
    for (const id of list) drops.add(id);
    while (drops.size > 256) drops.delete(drops.values().next().value);
  }

  function request(text, { voice, actor, speed }, utterance) {
    const drop = [...drops];
    drops.clear();
    outstanding.set(utterance, (outstanding.get(utterance) || 0) + 1);
    let call;
    try {
      call = Promise.resolve(
        api.synthesize({
          text,
          voice,
          actor,
          ...(speed ? { speed } : {}),
          channel,
          utterance,
          ...(drop.length ? { drop } : {}),
        }),
      );
    } catch (error) {
      call = Promise.reject(error);
    }
    const task = call
      .then(decodeResult)
      .then((result) => ({ ...result, readyAt: performance.now() }))
      .finally(() => {
        const left = (outstanding.get(utterance) || 0) - 1;
        if (left > 0) outstanding.set(utterance, left);
        else outstanding.delete(utterance);
      });
    task.catch(() => {});
    return task;
  }

  function audio() {
    if (!context) {
      const Context = AudioContextClass || globalThis.AudioContext || globalThis.webkitAudioContext;
      try {
        context = new Context({ sampleRate: SPEECH_RATE, latencyHint: 'interactive' });
      } catch {
        context = new Context();
      }
      output = context.createDynamicsCompressor();
      output.threshold.value = -16;
      output.knee.value = 10;
      output.ratio.value = 2;
      output.attack.value = 0.006;
      output.release.value = 0.18;
      // Headroom below full scale; dialogue sits around -17 dBFS, under the loudest effects.
      const trim = context.createGain();
      trim.gain.value = 0.8;
      output.connect(trim).connect(context.destination);
      meter = context.createAnalyser?.() || null;
      if (meter) {
        meter.fftSize = 1024;
        meterData = new Float32Array(meter.fftSize);
        trim.connect(meter);
      }
    }
    if (context.state === 'suspended') context.resume().catch(() => {});
    return context;
  }

  /** Start synthesizing now; resolves once the first segment is ready (or speech is native). */
  function prepare(text, { actor = 'robot', voice, speed } = {}) {
    const clean = String(text ?? '').trim();
    actor = actor === 'human' ? 'human' : 'robot';
    const chosen = String(voice || '').startsWith('native:') ? voice : resolveVoice(voice, actor);
    const base = { text: clean, actor, voice: chosen, native: false, segments: [] };
    if (!clean) return Promise.resolve(base);
    if (!api?.synthesize) return Promise.resolve({ ...base, native: true });
    try {
      audio(); // Create the output graph now; the first AudioContext takes a moment.
    } catch {}
    const utterance = ++utterances,
      texts = playbackSegments(clean),
      options = { voice: chosen, actor, speed };
    const segments = texts.map((segment) => request(segment, options, utterance));
    // Each segment is synthesized right after the previous one: learn the speed per character.
    segments.slice(1).forEach((task, index) =>
      Promise.all([segments[index], task])
        .then(([previous, result]) => {
          const sample = (result.readyAt - previous.readyAt - PASS_MS) / texts[index + 1].length;
          // Cache hits arrive almost at once and say nothing about synthesis speed.
          if (result.samples && sample > 8)
            msPerChar = Math.min(200, Math.max(15, msPerChar * 0.7 + sample * 0.3));
        })
        .catch(() => {}),
    );
    return segments[0].then(
      (first) =>
        first.native
          ? { ...base, native: true }
          : {
              ...base,
              voice: first.voice || chosen,
              segments,
              [LINE]: { utterance, texts, options },
            },
      // Local synthesis failed: speak with the system voice rather than stay silent.
      (error) => {
        cancelUtterances([utterance]);
        return { ...base, native: true, error: error?.message || String(error) };
      },
    );
  }

  function playSegment(part, actor, playback, started) {
    return new Promise((resolve) => {
      const ctx = audio();
      const buffer = ctx.createBuffer(1, part.samples.length, part.sampleRate);
      buffer.getChannelData(0).set(part.samples);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const chain = actor === 'robot' ? robotChain(ctx, output, playback.treatment) : null;
      source.connect(chain ? chain.input : output);
      const seconds = part.samples.length / part.sampleRate;
      let done = false,
        timer = null;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          source.stop();
        } catch {}
        source.disconnect();
        // Let the comb tail ring out briefly before tearing the chain down.
        if (chain) setTimeout(() => chain.dispose(), 120);
        resolve();
      };
      source.onended = finish;
      playback.finish = finish;
      const from = ctx.currentTime,
        deadline = Date.now() + seconds * 2000 + 1000;
      source.start();
      started();
      // 'ended' can arrive late, or never (a lost output device or a suspended context). Finish
      // by the audio clock instead, so a line can never stall the turn.
      const watch = () => {
        const left = from + seconds - ctx.currentTime;
        if (left > 0.02 && ctx.state === 'running' && Date.now() < deadline)
          timer = setTimeout(watch, left * 1000 + 100);
        else finish();
      };
      timer = setTimeout(watch, seconds * 1000 + 150);
    });
  }

  /**
   * When the second segment is still being synthesized and would arrive after the first one has
   * finished playing, wait (at most LEAD_MAX_MS) so the line plays without a pause in it.
   */
  async function leadIn(first, next, chars, playback) {
    const pending = {};
    if ((await Promise.race([next, pending]).catch(() => null)) !== pending) return;
    const ready = first.readyAt + PASS_MS + msPerChar * chars,
      wait = Math.min(LEAD_MAX_MS, ready - performance.now() - first.durationMs);
    if (wait > 40)
      await Promise.race([
        next.catch(() => {}),
        new Promise((done) => setTimeout(done, wait)),
        new Promise((done) => (playback.finish = done)), // stop() ends the wait
      ]);
  }

  function speakNatively(text, voice, actor, playback, started) {
    return nativeSpeech(
      text,
      voice,
      actor,
      (handle) => {
        playback.finish = handle.finish;
        if (playback.stopped) handle.finish();
      },
      started,
    );
  }

  /** Stop the current playback and drop its queued segments (except `keep`'s). */
  function halt(keep) {
    const playback = current;
    current = null;
    if (!playback) return;
    playback.stopped = true;
    playback.finish();
    cancelUtterances(playback.utterances.filter((id) => id !== keep));
  }

  /**
   * Play a prepared line (or the promise from prepare()). Resolves when it finishes or is
   * stopped. A stop() or a newer play() issued while the line is still being prepared wins.
   */
  async function play(prepared, { onStart, treatment } = {}) {
    const ticket = ++plays,
      stopped = stops;
    if (typeof prepared?.then === 'function') prepared = await prepared;
    if (ticket !== plays || stopped !== stops) return;
    const line = prepared?.[LINE];
    halt(line?.utterance);
    if (!prepared?.text) return;
    const playback = {
      stopped: false,
      native: Boolean(prepared.native),
      treatment: { pa: treatment === 'pa' },
      finish: () => {},
      utterances: line ? [line.utterance] : [],
    };
    current = playback;
    let announced = false;
    const started = () => {
      if (announced) return;
      announced = true;
      onStart?.();
    };
    try {
      if (prepared.native) {
        await speakNatively(prepared.text, prepared.voice, prepared.actor, playback, started);
        return;
      }
      const parts = prepared.segments.slice();
      let retry = null;
      for (let index = 0; index < parts.length; index++) {
        let part;
        try {
          part = await parts[index];
        } catch (error) {
          part = { failed: error };
        }
        if (playback.stopped) return;
        if (part?.cancelled && line) {
          // Dropped from the queue by an earlier stop(): synthesize the rest again now.
          if (!retry) {
            retry = ++utterances;
            playback.utterances.push(retry);
            for (let next = index; next < parts.length; next++)
              parts[next] = Promise.resolve(parts[next]).then((result) =>
                result?.cancelled ? request(line.texts[next], line.options, retry) : result,
              );
          }
          try {
            part = await parts[index];
          } catch (error) {
            part = { failed: error };
          }
          if (playback.stopped) return;
        }
        if (part?.samples?.length) {
          if (index === 0 && parts.length > 1 && line) {
            await leadIn(part, parts[1], line.texts[1].length, playback);
            if (playback.stopped) return;
          }
          await playSegment(part, prepared.actor, playback, started);
        } else if ((part?.failed || part?.native) && line) {
          // The local voice failed for this segment: the words matter, so use the system voice.
          playback.native = true;
          try {
            await speakNatively(
              line.texts[index],
              prepared.voice,
              prepared.actor,
              playback,
              started,
            );
          } catch {}
        }
        if (playback.stopped) return;
      }
    } finally {
      if (current === playback) current = null;
    }
  }

  /** Stop speaking and drop every queued segment this player requested. */
  function stop() {
    stops++;
    halt();
    cancelUtterances([...outstanding.keys()]);
  }

  return {
    prepare,
    play,
    stop,
    /** Voices suited to an appearance id / APPEARANCES entry / 'robot', default first. */
    voicesFor: (appearance) => catalogVoicesFor(appearance),
    voices: VOICES,
    get speaking() {
      return Boolean(current);
    },
    /**
     * Loudness of the line now playing, 0..1, for speech animation: 0 between words and when
     * silent, null while the system voice speaks (its audio cannot be measured).
     */
    level() {
      if (!current) return 0;
      if (current.native) return null;
      if (!meter) return 0;
      meter.getFloatTimeDomainData(meterData);
      let sum = 0;
      for (const value of meterData) sum += value * value;
      const db = 10 * Math.log10(sum / meterData.length + 1e-12);
      return Math.min(1, Math.max(0, (db + 50) / 38));
    },
    close() {
      stop();
      context?.close?.().catch?.(() => {});
      context = null;
      output = null;
      meter = null;
    },
  };
}
