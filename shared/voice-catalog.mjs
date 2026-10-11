// Pure voice metadata shared by the renderer, the Electron voice worker and the CLI.
// Supertonic 2 voice styles are part of the Supertonic model download, so every listed voice
// works offline once the model is installed.

export const DEFAULT_VOICES = Object.freeze({
  robot: 'supertonic:M1',
  male: 'supertonic:M2',
  female: 'supertonic:F1',
});

const entry = (style, name, gender) =>
  Object.freeze({ id: 'supertonic:' + style, name, gender, style });

// The ten Supertonic 2 English voice styles; the game's defaults first within each group.
export const VOICES = Object.freeze([
  entry('M1', 'Voice M1', 'male'),
  entry('M2', 'Voice M2', 'male'),
  entry('M3', 'Voice M3', 'male'),
  entry('M4', 'Voice M4', 'male'),
  entry('M5', 'Voice M5', 'male'),
  entry('F1', 'Voice F1', 'female'),
  entry('F2', 'Voice F2', 'female'),
  entry('F3', 'Voice F3', 'female'),
  entry('F4', 'Voice F4', 'female'),
  entry('F5', 'Voice F5', 'female'),
]);

const byId = new Map(VOICES.map((voice) => [voice.id, voice]));

export function voiceInfo(id) {
  return byId.get(String(id || '')) || null;
}

/** Supertonic's style name (e.g. "M1", the voice_styles/M1.json file) for a catalog id, or null. */
export function voiceStyle(id) {
  return voiceInfo(id)?.style || null;
}

function appearanceGender(appearance) {
  const value =
    typeof appearance === 'string' ? appearance : appearance?.id || appearance?.voice || '';
  if (/^(robot|guard|g-01)$/i.test(value)) return 'robot';
  // Earlier Kokoro ids ("kokoro:af_heart") keep their gender.
  if (/female|woman|supertonic:F|kokoro:[ab]f_/i.test(value)) return 'female';
  return 'male';
}

/** Default voice id for an actor ('robot' | 'human') and optional appearance. */
export function defaultVoice(actor = 'robot', appearance) {
  if (actor === 'robot') return DEFAULT_VOICES.robot;
  return appearanceGender(appearance) === 'female' ? DEFAULT_VOICES.female : DEFAULT_VOICES.male;
}

/**
 * A valid catalog id: the requested one when known, otherwise the actor's default (an earlier
 * Kokoro id falls back to the default of its gender).
 */
export function resolveVoice(id, actor = 'robot', appearance) {
  if (voiceInfo(id)) return String(id);
  if (actor !== 'robot' && /^kokoro:/.test(String(id || ''))) return defaultVoice(actor, id);
  return defaultVoice(actor, appearance);
}

/**
 * Voices suited to an appearance ('male' | 'female' | 'robot' | an APPEARANCES entry), with
 * the default first, then matching gender, then the rest. Every voice remains selectable.
 */
export function voicesFor(appearance) {
  const kind = appearanceGender(appearance);
  const preferred =
    kind === 'robot'
      ? DEFAULT_VOICES.robot
      : kind === 'female'
        ? DEFAULT_VOICES.female
        : DEFAULT_VOICES.male;
  const gender = kind === 'female' ? 'female' : 'male';
  const rank = (voice) => (voice.id === preferred ? 0 : voice.gender === gender ? 1 : 2);
  return [...VOICES].sort((a, b) => rank(a) - rank(b));
}
