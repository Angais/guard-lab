// Push-to-talk capture: opens the microphone only while recording, returns mono 16 kHz PCM
// for local Whisper transcription (desktop.voice.transcribe). Nothing is stored. Recordings
// stop growing at `maxSeconds`; the `full` flag lets the caller send what it has.
import { resample, STT_SAMPLE_RATE } from '../../shared/voice-audio.mjs';

const BUFFER_SIZE = 2048;
/** Longest recording kept; the caller sends the clip when `full` turns true. */
export const MAX_RECORDING_SECONDS = 30;

export function microphoneHelp(platform) {
  if (platform === 'darwin')
    return 'Microphone access is off. Allow Guard Lab in System Settings › Privacy & Security › Microphone.';
  if (platform === 'win32')
    return 'Microphone access is off. Turn on Settings › Privacy & security › Microphone, including access for desktop apps.';
  return 'Microphone access is blocked. Allow microphone access for Guard Lab and try again.';
}

function captureError(error, platform) {
  const name = error?.name || '';
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return new Error(microphoneHelp(platform));
  if (name === 'NotFoundError' || name === 'OverconstrainedError')
    return new Error('No microphone found. Connect one and try again.');
  if (name === 'NotReadableError' || name === 'AbortError')
    return new Error(
      platform === 'win32'
        ? 'The microphone is unavailable. Check that another app is not using it and that microphone access is on in Windows Settings.'
        : 'The microphone is unavailable. Check that another app is not using it.',
    );
  return error instanceof Error ? error : new Error(String(error));
}

function teardown(session) {
  try {
    if (session.processor) session.processor.onaudioprocess = null;
    session.processor?.disconnect();
    session.source?.disconnect();
  } catch {}
  for (const track of session.stream?.getTracks?.() || []) track.stop();
  session.context?.close?.()?.catch?.(() => {});
}

export function createRecorder({
  desktop = globalThis.window?.desktop,
  mediaDevices = globalThis.navigator?.mediaDevices,
  AudioContextClass,
  maxSeconds = MAX_RECORDING_SECONDS,
} = {}) {
  const platform = desktop?.platform || '';
  let session = null,
    smoothed = 0;

  /** Open the microphone and start capturing. Rejects with a readable message on failure. */
  function start() {
    if (session) return session.ready;
    const current = { chunks: [], length: 0, rate: 0, rms: 0, cancelled: false };
    session = current;
    current.ready = (async () => {
      const access = await Promise.resolve(desktop?.voice?.microphone?.(true)).catch(
        () => 'unknown',
      );
      if (access === 'denied') throw new Error(microphoneHelp(platform));
      if (!mediaDevices?.getUserMedia) throw new Error('No microphone is available.');
      let stream;
      try {
        stream = await mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
      } catch (error) {
        throw captureError(error, platform);
      }
      current.stream = stream;
      if (current.cancelled) return teardown(current);
      const Context = AudioContextClass || globalThis.AudioContext || globalThis.webkitAudioContext;
      let context;
      try {
        // Chromium resamples the microphone into a 16 kHz graph directly.
        context = new Context({ sampleRate: STT_SAMPLE_RATE, latencyHint: 'interactive' });
      } catch {
        context = new Context();
      }
      current.context = context;
      current.rate = context.sampleRate;
      if (context.state === 'suspended') await context.resume?.().catch?.(() => {});
      const limit = Math.round(maxSeconds * current.rate);
      current.source = context.createMediaStreamSource(stream);
      current.processor = context.createScriptProcessor(BUFFER_SIZE, 1, 1);
      current.processor.onaudioprocess = (event) => {
        const data = event.inputBuffer.getChannelData(0);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
        current.rms = Math.sqrt(sum / (data.length || 1));
        if (current.length < limit) {
          const copy = data.slice(0, Math.min(data.length, limit - current.length));
          current.chunks.push(copy);
          current.length += copy.length;
        } else current.full = true;
        current.tick?.();
      };
      current.source.connect(current.processor);
      current.processor.connect(context.destination);
      if (current.cancelled) teardown(current);
    })();
    current.ready.catch(() => {
      teardown(current);
      if (session === current) session = null;
    });
    return current.ready;
  }

  /** Stop and return { pcm: Float32Array (mono), sampleRate: 16000, durationMs }. */
  async function stop() {
    const current = session;
    if (!current) return { pcm: new Float32Array(0), sampleRate: STT_SAMPLE_RATE, durationMs: 0 };
    // Detach first: a start() while the tail is collected opens a fresh capture.
    session = null;
    smoothed = 0;
    await current.ready;
    if (current.processor && !current.cancelled)
      // Collect the audio still inside the processor buffer so the last word is kept.
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, Math.ceil((BUFFER_SIZE / current.rate) * 1000) + 60);
        current.tick = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    teardown(current);
    const merged = new Float32Array(current.length);
    let offset = 0;
    for (const chunk of current.chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    const pcm =
      current.rate && current.rate !== STT_SAMPLE_RATE
        ? resample(merged, current.rate, STT_SAMPLE_RATE)
        : merged;
    return {
      pcm,
      sampleRate: STT_SAMPLE_RATE,
      durationMs: Math.round((pcm.length / STT_SAMPLE_RATE) * 1000),
    };
  }

  /** Discard the recording and release the microphone. */
  function cancel() {
    const current = session;
    session = null;
    smoothed = 0;
    if (!current) return;
    current.cancelled = true;
    current.tick?.();
    teardown(current);
  }

  /** Input level 0..1 for a meter (smoothed, roughly -55 dB..-10 dB). */
  function level() {
    if (!session) return 0;
    const db = 20 * Math.log10(Math.max(1e-6, session.rms));
    const target = Math.min(1, Math.max(0, (db + 55) / 45));
    smoothed = Math.max(target, smoothed * 0.85);
    return smoothed;
  }

  return {
    start,
    stop,
    cancel,
    level,
    get active() {
      return Boolean(session);
    },
    /** True once the recording has reached `maxSeconds`; later audio is not kept. */
    get full() {
      return Boolean(session?.full);
    },
  };
}
