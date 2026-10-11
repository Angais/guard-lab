import { useCallback, useEffect, useRef, useState } from 'react';
import { APPEARANCES } from '../sim/items.mjs';
import { resolveVoice } from '../../shared/voice-catalog.mjs';
import { playSound } from '../audio/sfx.mjs';
import { MAX_RECORDING_SECONDS } from '../audio/push-to-talk.mjs';
import { makeRecorder, makeVoicePlayer } from './audio-bridge.mjs';

const desktop = () => globalThis.window?.desktop;
const CHECKING = {
  state: 'checking',
  message: 'Looking for Codex…',
  fixPrompt: null,
  account: null,
  login: { state: 'idle' },
};

export function useCodex(codexPath) {
  const codex = desktop()?.codex;
  const path = useRef(codexPath);
  path.current = codexPath;
  const [status, setStatus] = useState(codex ? CHECKING : null);
  const [models, setModels] = useState([]);
  const fail = (error) =>
    setStatus((old) => ({
      ...(old || CHECKING),
      state: 'error',
      message: error?.message || 'Codex did not respond.',
    }));
  useEffect(() => {
    if (!codex) return;
    let live = true;
    const off = codex.onStatus?.((next) => live && next && setStatus(next));
    codex
      .status(path.current ? { codexPath: path.current } : {})
      .then((next) => live && setStatus(next))
      .catch((error) => live && fail(error));
    return () => {
      live = false;
      off?.();
    };
  }, []);
  const ready = status?.state === 'ready';
  useEffect(() => {
    if (!codex || !ready) return;
    let live = true;
    codex
      .models()
      .then((list) => live && setModels(Array.isArray(list) ? list : []))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [ready, status?.account?.email]);
  const refresh = useCallback(async () => {
    if (!codex) return;
    setStatus((old) => ({ ...(old || CHECKING), state: 'checking', message: CHECKING.message }));
    try {
      setStatus(await codex.status({ refresh: true, codexPath: path.current || '' }));
    } catch (error) {
      fail(error);
    }
  }, []);
  const login = useCallback(async () => {
    if (!codex) return;
    setStatus((old) => ({ ...(old || CHECKING), login: { state: 'pending' } }));
    try {
      await codex.login();
    } catch (error) {
      setStatus((old) => ({
        ...(old || CHECKING),
        login: { state: 'failed', error: error?.message || 'Sign-in failed.' },
      }));
    }
  }, []);
  const cancelLogin = useCallback(() => {
    codex?.cancelLogin?.().catch?.(() => {});
    setStatus((old) => (old ? { ...old, login: { state: 'idle' } } : old));
  }, []);
  return { available: Boolean(codex), status, models, refresh, login, cancelLogin };
}

export function useVoice() {
  const voice = desktop()?.voice;
  const [status, setStatus] = useState(null);
  const [voices, setVoices] = useState([]);
  useEffect(() => {
    if (!voice) return;
    let live = true;
    const off = voice.onStatus?.((next) => live && next && setStatus(next));
    voice
      .status()
      .then((next) => live && setStatus(next))
      .catch(() => {});
    return () => {
      live = false;
      off?.();
    };
  }, []);
  const ttsReady = status?.tts?.state === 'ready';
  useEffect(() => {
    if (!voice) return;
    let live = true;
    voice
      .voices()
      .then((list) => live && setVoices(Array.isArray(list) ? list : []))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [ttsReady]);
  const install = useCallback(async (kind) => {
    if (!voice) return;
    setStatus((old) =>
      old ? { ...old, [kind]: { ...old[kind], state: 'installing', progress: 0 } } : old,
    );
    try {
      const next = await voice.install(kind);
      if (next) setStatus(next);
    } catch (error) {
      setStatus((old) =>
        old
          ? {
              ...old,
              [kind]: {
                ...old[kind],
                state: 'error',
                message: error?.message || 'Download failed.',
              },
            }
          : old,
      );
    }
  }, []);
  const remove = useCallback(async (kind) => {
    if (!voice) return;
    try {
      const next = await voice.remove(kind);
      if (next) setStatus(next);
    } catch {}
  }, []);
  return { available: Boolean(voice), status, voices, install, remove };
}

// Records one utterance and returns its transcript. Shared by push-to-talk and mic tests.
// `phase` is 'idle' | 'listening' | 'transcribing'. While listening, `live` turns true once the
// microphone is actually recording (opening it can take most of a second); a soft blip marks it.
export function useVoiceCapture({ onText, onError } = {}) {
  const [phase, setPhase] = useState('idle');
  const [live, setLive] = useState(false);
  const [level, setLevel] = useState(0);
  const recorder = useRef(null),
    starting = useRef(null),
    ending = useRef(false),
    session = useRef(0),
    meter = useRef(0),
    handlers = useRef({});
  handlers.current = { onText, onError };
  const stopMeter = () => {
    cancelAnimationFrame(meter.current);
    setLevel(0);
    setLive(false);
  };
  const cancel = useCallback(() => {
    session.current++;
    ending.current = false;
    stopMeter();
    try {
      recorder.current?.cancel();
    } catch {}
    setPhase('idle');
  }, []);
  const begin = useCallback(async () => {
    const token = ++session.current;
    ending.current = false;
    setPhase('listening');
    setLive(false);
    try {
      recorder.current ||= makeRecorder();
      if (!recorder.current) throw new Error('Voice input is unavailable in this build.');
      starting.current = recorder.current.start();
      await starting.current;
      if (token !== session.current || ending.current) return;
      setLive(true);
      playSound('mic-ready');
      const tick = () => {
        if (recorder.current?.full) {
          // At the length limit: send what was said rather than silently dropping the rest.
          handlers.current.onError?.(
            Object.assign(
              new Error(`Voice input stops at ${MAX_RECORDING_SECONDS} seconds. Sending it now.`),
              { notice: true },
            ),
          );
          end();
          return;
        }
        setLevel(Math.max(0, Math.min(1, recorder.current?.level?.() || 0)));
        meter.current = requestAnimationFrame(tick);
      };
      tick();
    } catch (error) {
      if (token !== session.current) return;
      session.current++;
      stopMeter();
      setPhase('idle');
      handlers.current.onError?.(error);
    }
  }, []);
  const end = useCallback(async () => {
    // Already sending (for example after the length limit); the key release changes nothing.
    if (ending.current) return;
    const token = session.current;
    if (!recorder.current || !starting.current) return cancel();
    ending.current = true;
    stopMeter();
    setPhase('transcribing');
    try {
      await starting.current;
      if (token !== session.current) return;
      const clip = await recorder.current.stop();
      if (token !== session.current) return;
      if (!clip?.pcm?.length || (clip.durationMs ?? 1000) < 300) {
        setPhase('idle');
        handlers.current.onError?.(new Error('Hold the key while you talk.'));
        return;
      }
      const result = await desktop().voice.transcribe({
        pcm: clip.pcm,
        sampleRate: clip.sampleRate,
      });
      if (token !== session.current) return;
      setPhase('idle');
      const text = String(result?.text || '').trim();
      if (text) handlers.current.onText?.(text);
      else handlers.current.onError?.(new Error('Didn’t catch that. Try again.'));
    } catch (error) {
      if (token !== session.current) return;
      setPhase('idle');
      handlers.current.onError?.(error);
    } finally {
      if (token === session.current) {
        starting.current = null;
        ending.current = false;
      }
    }
  }, []);
  useEffect(
    () => () => {
      session.current++;
      cancelAnimationFrame(meter.current);
      try {
        recorder.current?.cancel();
      } catch {}
    },
    [],
  );
  return { phase, live, level, begin, end, cancel };
}

// Lines the player has just said into the microphone: shown as subtitles, but not voiced again
// (the player already heard themselves say them). Keyed by actor and text; entries expire, and
// the player's own line uses its entry up, so the other side may still say the same words.
const SPOKEN_MS = 120000;
const spoken = new Map();
const spokenKey = (actor, text) =>
  actor +
  '|' +
  String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
function rememberSpoken(actor, text) {
  const now = Date.now();
  for (const [key, at] of spoken) if (now - at > SPOKEN_MS || spoken.size > 16) spoken.delete(key);
  spoken.set(spokenKey(actor, text), now);
}
function saidAloud(ev, consume = false) {
  const key = spokenKey(ev.kind === 'robot' ? 'robot' : 'human', ev.speech),
    at = spoken.get(key);
  if (!at || Date.now() - at > SPOKEN_MS) return false;
  if (consume) spoken.delete(key);
  return true;
}

export const isTyping = (element) =>
  Boolean(
    element &&
    (element.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName)),
  );

// The talk pill's phase: 'starting' while the key is held but the microphone is not yet recording,
// so "Listening…" only appears once speech is actually captured.
export const talkPhase = ({ phase, live } = {}) =>
  phase === 'listening' && !live ? 'starting' : phase || 'idle';

// Hold a key to talk; release to transcribe and send. Esc cancels. `actor` is the side the player
// speaks for ('human', or 'robot' when playing the guard); its echo of the line is not voiced.
// `phase` is 'idle' | 'starting' | 'listening' | 'transcribing' (see talkPhase).
export function usePushToTalk({
  enabled,
  code = 'Space',
  ready,
  actor = 'human',
  onText,
  onUnavailable,
  onError,
}) {
  const capture = useVoiceCapture({
    onText: (text) => {
      rememberSpoken(actor, text);
      onText?.(text);
    },
    onError,
  });
  const held = useRef(false),
    state = useRef({});
  state.current = { ready, onUnavailable, capture };
  useEffect(() => {
    if (!enabled) return;
    const down = (event) => {
      if (event.code === 'Escape' && held.current) {
        event.preventDefault();
        event.stopPropagation();
        held.current = false;
        state.current.capture.cancel();
        return;
      }
      if (event.code !== code || isTyping(event.target)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      // Without voice input, leave Space to focused buttons; elsewhere it opens the say box.
      if (!state.current.ready && event.target?.closest?.('button, a, [role="button"]')) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat || held.current) return;
      if (!state.current.ready) {
        state.current.onUnavailable?.();
        return;
      }
      held.current = true;
      state.current.capture.begin();
    };
    const up = (event) => {
      if (event.code !== code) return;
      if (!held.current) {
        if (!isTyping(event.target) && state.current.ready) event.preventDefault();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      held.current = false;
      state.current.capture.end();
    };
    const abandon = () => {
      if (!held.current) return;
      held.current = false;
      state.current.capture.cancel();
    };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    window.addEventListener('blur', abandon);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
      window.removeEventListener('blur', abandon);
      abandon();
    };
  }, [enabled, code]);
  return { ...capture, phase: talkPhase(capture) };
}

export function useVoicePlayer() {
  const player = useRef(null);
  if (!player.current) player.current = makeVoicePlayer(desktop());
  return player.current;
}

export const appearanceVoice = (appearance) =>
  APPEARANCES.find((a) => a.id === appearance)?.voice || APPEARANCES[0]?.voice;

// Chooses each event's voice: recordings carry their own; the human follows appearance.
export function voiceForEvent(ev, voiceConfig = {}, fallbackAppearance = 'male') {
  // A recording made with Kokoro (earlier releases) plays with the Supertonic default of its gender.
  if (ev?.voice && /^(?:supertonic|kokoro):/.test(ev.voice))
    return resolveVoice(ev.voice, ev.kind === 'robot' ? 'robot' : 'human');
  if (ev?.kind === 'robot') return voiceConfig.guardVoice;
  return (
    voiceConfig.humanVoice || appearanceVoice(ev?.state?.human?.appearance || fallbackAppearance)
  );
}

// How an event's line is played: broadcast warnings start after their chime (about 0.35 s) and
// sound like the room's loudspeaker.
export function speechStyle(ev) {
  return ev?.kind === 'robot' && ev.action === 'broadcast_warning'
    ? { treatment: 'pa', leadMs: 380 }
    : { treatment: null, leadMs: 0 };
}

// Plays event speech with pre-synthesis, cancellation and a speaking indicator. `speaking` is
// the actor whose voice is audible now: it is set when the audio starts, not while synthesizing.
export function useSpeaker({ enabled, voiceConfig, appearance }) {
  const player = useVoicePlayer();
  const [speaking, setSpeaking] = useState(null);
  const cache = useRef(new Map()),
    generation = useRef(0),
    calls = useRef(0),
    audible = useRef(0),
    settings = useRef({});
  settings.current = { enabled, voiceConfig, appearance };
  const prepare = useCallback((ev) => {
    const { enabled, voiceConfig, appearance } = settings.current;
    if (!enabled || !ev?.speech || saidAloud(ev)) return null;
    const voice = voiceForEvent(ev, voiceConfig, appearance),
      actor = ev.kind === 'robot' ? 'robot' : 'human',
      key = `${actor}|${voice}|${ev.speech}`;
    if (!cache.current.has(key)) {
      const pending = Promise.resolve(player.prepare(ev.speech, { actor, voice }));
      pending.catch(() => {});
      cache.current.set(key, pending);
      if (cache.current.size > 24) cache.current.delete(cache.current.keys().next().value);
    }
    return cache.current.get(key);
  }, []);
  const speak = useCallback(async (ev, prepared, { onStart } = {}) => {
    if (!settings.current.enabled || !ev?.speech || saidAloud(ev, true)) return;
    const token = generation.current,
      call = ++calls.current,
      begun = performance.now();
    const actor = ev.kind === 'robot' ? 'robot' : 'human',
      { treatment, leadMs } = speechStyle(ev);
    const current = () => token === generation.current && settings.current.enabled;
    try {
      const ready = await (prepared || prepare(ev));
      if (!current() || !ready) return;
      const lead = leadMs - (performance.now() - begun);
      if (lead > 0) await new Promise((resolve) => setTimeout(resolve, lead));
      if (!current()) return;
      await player.play(ready, {
        treatment,
        onStart: () => {
          if (current()) {
            audible.current = call;
            setSpeaking(actor);
          }
          onStart?.();
        },
      });
    } finally {
      // Only this line's indicator: a newer line may already be audible.
      if (audible.current === call) {
        audible.current = 0;
        setSpeaking(null);
      }
    }
  }, []);
  const stop = useCallback(() => {
    generation.current++;
    audible.current = 0;
    try {
      player.stop();
    } catch {}
    setSpeaking(null);
  }, []);
  useEffect(() => stop, []);
  return { speaking, prepare, speak, stop, player };
}

export function useDismiss(active, onDismiss) {
  const handler = useRef(onDismiss);
  handler.current = onDismiss;
  useEffect(() => {
    if (!active) return;
    const close = (event) => {
      if (event.key === 'Escape') handler.current?.(event);
    };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [active]);
}
