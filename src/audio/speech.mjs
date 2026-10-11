// System speech (speechSynthesis) fallback used when the local Supertonic voices are not installed.
import { DEFAULT_VOICES, voiceInfo } from '../../shared/voice-catalog.mjs';
import { speakableText } from '../../shared/voice-audio.mjs';

const INSTALL_HINT = 'Install Supertonic voices in Settings for local speech.';
// System voice names by gender, best first (macOS, Windows, common Linux/Chromium voices).
const FEMALE =
  'samantha zira victoria karen moira serena kate hazel susan aria ava allison tessa female';
const MALE =
  'daniel george arthur oliver ryan alex aaron evan nathan tom reed eddy david mark guy fred male';
const rank = (names, voice) =>
  names
    .split(' ')
    .findIndex((name) => new RegExp(`(?:^|\\W)${name}(?:$|\\W)`, 'i').test(voice.name));

/**
 * English system voice for a catalog voice id: same gender, the same accent when available, and
 * not `avoid` (the guard's voice) when another one fits.
 */
export function selectEnglishVoice(voices, voiceId, actor, { avoid } = {}) {
  const english = voices.filter((v) => /^en(?:[-_]|$)/i.test(v.lang));
  const named = voiceId?.startsWith('native:') && english.find((v) => v.name === voiceId.slice(7));
  if (named) return named;
  const info = voiceInfo(voiceId);
  // The guard defaults to a British male voice; legacy ids keep their old gender.
  const female = info
    ? info.gender === 'female'
    : /amy|female|supertonic:F|kokoro:[ab]f_/i.test(voiceId || '') ||
      (actor === 'robot' && /lessac/i.test(voiceId || ''));
  const names = female ? FEMALE : MALE;
  const accent = { British: /^en[-_]GB/i, American: /^en[-_]US/i }[info?.accent];
  const ranked = english
    .filter((v) => rank(names, v) >= 0)
    .sort(
      (a, b) =>
        (accent ? Number(!accent.test(a.lang)) - Number(!accent.test(b.lang)) : 0) ||
        rank(names, a) - rank(names, b),
    );
  return ranked.find((v) => v.name !== avoid) || ranked[0] || english[0] || null;
}

// The system voice the guard last spoke with; the human avoids it so the two sound different.
let guardVoice = null;

export async function nativeSpeech(text, voiceId, actor, onPlayback, onStarted) {
  const synthesis = globalThis.window?.speechSynthesis;
  if (!synthesis) throw new Error('Speech is unavailable. ' + INSTALL_HINT);
  if (!synthesis.getVoices().length) {
    await new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        synthesis.removeEventListener?.('voiceschanged', finish);
        resolve();
      };
      const timer = setTimeout(finish, 1500);
      synthesis.addEventListener?.('voiceschanged', finish);
    });
  }
  const voices = synthesis.getVoices();
  const avoid =
    actor === 'robot'
      ? null
      : guardVoice || selectEnglishVoice(voices, DEFAULT_VOICES.robot, 'robot')?.name;
  const voice = selectEnglishVoice(voices, voiceId, actor, { avoid });
  if (!voice) throw new Error('No English system voice is installed. ' + INSTALL_HINT);
  if (actor === 'robot') guardVoice = voice.name;
  return new Promise((resolve, reject) => {
    // Same text preparation as local speech: codes read digit by digit, markdown symbols dropped.
    const utterance = new SpeechSynthesisUtterance(speakableText(text));
    utterance.lang = voice.lang || 'en-US';
    utterance.voice = voice;
    let ended = false;
    const finish = (error) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      synthesis.cancel();
      finish();
    }, 90000);
    onPlayback?.({
      finish: () => {
        synthesis.cancel();
        finish();
      },
    });
    utterance.onend = () => finish();
    utterance.onstart = () => onStarted?.();
    utterance.onerror = (event) =>
      finish(
        event.error !== 'canceled' && event.error !== 'interrupted'
          ? new Error('System speech failed. ' + INSTALL_HINT)
          : null,
      );
    synthesis.speak(utterance);
  });
}
