import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeWav,
  decodeWav,
  resample,
  isSilent,
  cleanTranscript,
  speakableText,
  sentenceChunks,
  joinAudio,
  sizeLabel,
  spellNumbers,
  numberWords,
} from '../shared/voice-audio.mjs';
import {
  DEFAULT_VOICES,
  VOICES,
  voiceInfo,
  voiceStyle,
  resolveVoice,
  defaultVoice,
  voicesFor,
} from '../shared/voice-catalog.mjs';
import {
  TTS_CHUNK,
  TTS_HARD_LIMIT,
  speechPasses,
  supertonicText,
} from '../shared/voice-models.mjs';
import { APPEARANCES } from '../src/sim/items.mjs';

const tone = (frequency, rate, seconds, amplitude = 0.5) =>
  Float32Array.from(
    { length: Math.round(rate * seconds) },
    (_, i) => amplitude * Math.sin((2 * Math.PI * frequency * i) / rate),
  );
const rms = (samples, from = 0, to = samples.length) => {
  let sum = 0;
  for (let i = from; i < to; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / (to - from));
};
const crossings = (samples) => {
  let count = 0;
  for (let i = 1; i < samples.length; i++) if (samples[i - 1] < 0 !== samples[i] < 0) count++;
  return count;
};

test('WAV encoding is valid 16-bit mono PCM and decodes back losslessly enough', () => {
  const samples = Float32Array.from([0, 0.5, -0.5, 1, -1, 2, -2, 0.25]);
  const wav = encodeWav(samples, 24000);
  const view = new DataView(wav.buffer);
  assert.equal(String.fromCharCode(...wav.subarray(0, 4)), 'RIFF');
  assert.equal(String.fromCharCode(...wav.subarray(8, 12)), 'WAVE');
  assert.equal(view.getUint32(4, true), wav.length - 8);
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 24000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), samples.length * 2);
  const decoded = decodeWav(wav);
  assert.equal(decoded.sampleRate, 24000);
  assert.equal(decoded.samples.length, samples.length);
  const clipped = samples.map((v) => Math.max(-1, Math.min(1, v)));
  decoded.samples.forEach((v, i) => assert.ok(Math.abs(v - clipped[i]) < 1 / 16000));
  assert.throws(() => decodeWav(new Uint8Array(12)), /Not a WAV/);
});

test('float32 stereo WAV decodes to a mono mix', () => {
  const frames = 4,
    bytes = new Uint8Array(44 + frames * 8),
    view = new DataView(bytes.buffer);
  const ascii = (at, text) => [...text].forEach((c, i) => (bytes[at + i] = c.charCodeAt(0)));
  ascii(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, 48000, true);
  view.setUint32(28, 48000 * 8, true);
  view.setUint16(32, 8, true);
  view.setUint16(34, 32, true);
  ascii(36, 'data');
  view.setUint32(40, frames * 8, true);
  for (let i = 0; i < frames; i++) {
    view.setFloat32(44 + i * 8, 0.5, true);
    view.setFloat32(48 + i * 8, -0.1, true);
  }
  const { samples, sampleRate, channels } = decodeWav(bytes);
  assert.equal(sampleRate, 48000);
  assert.equal(channels, 2);
  samples.forEach((v) => assert.ok(Math.abs(v - 0.2) < 1e-6));
});

test('resampling to 16 kHz keeps speech-band tones and removes aliasing content', () => {
  const speech = resample(tone(440, 48000, 1), 48000, 16000);
  assert.equal(speech.length, 16000);
  assert.ok(Math.abs(rms(speech, 200, 15800) - 0.5 / Math.SQRT2) < 0.01);
  assert.ok(Math.abs(crossings(speech) - 880) <= 2, 'frequency preserved');
  const upper = resample(tone(6000, 48000, 0.5), 48000, 16000);
  assert.ok(rms(upper, 200, upper.length - 200) > 0.3, '6 kHz passes');
  const alias = resample(tone(12000, 48000, 0.5), 48000, 16000);
  assert.ok(rms(alias, 200, alias.length - 200) < 0.02, '12 kHz is filtered, not folded to 4 kHz');
  const dc = resample(new Float32Array(44100).fill(0.25), 44100, 16000);
  assert.equal(dc.length, 16000);
  assert.ok(dc.every((v) => Math.abs(v - 0.25) < 1e-4));
  const up = resample(tone(1000, 24000, 0.1), 24000, 48000);
  assert.equal(up.length, 4800);
  const same = Float32Array.from([1, 2, 3]);
  const copy = resample(same, 16000, 16000);
  assert.deepEqual([...copy], [1, 2, 3]);
  assert.notEqual(copy, same);
  assert.throws(() => resample(same, 0, 16000), /Invalid sample rate/);
});

test('silence detection avoids sending empty push-to-talk clips to Whisper', () => {
  assert.equal(isSilent(new Float32Array(16000)), true);
  assert.equal(isSilent(tone(300, 16000, 1, 0.0005)), true);
  assert.equal(isSilent(tone(300, 16000, 0.05, 0.5)), true, 'too short');
  assert.equal(isSilent(tone(300, 16000, 1, 0.1)), false);
});

test('transcripts drop Whisper non-speech annotations', () => {
  assert.equal(cleanTranscript(' [BLANK_AUDIO]'), '');
  assert.equal(cleanTranscript(' Hello (music) there *coughs* [Silence]  '), 'Hello there');
  assert.equal(cleanTranscript('Open the vault.'), 'Open the vault.');
  assert.equal(cleanTranscript(undefined), '');
});

test('speakable text reads codes digit by digit and keeps other numbers', () => {
  assert.equal(speakableText('The code is 9327.'), 'The code is 9 3 2 7.');
  assert.equal(speakableText('Badge 4815, door 12'), 'Badge 4 8 1 5, door 12');
  assert.equal(speakableText('Pay 1,000 or 3.14159'), 'Pay 1,000 or 3.14159');
  assert.equal(speakableText('**Stop** right   _there_'), 'Stop right there');
  assert.equal(speakableText('The code is **4271** .'), 'The code is 4 2 7 1.');
  assert.equal(speakableText('x'.repeat(5000)).length, 2000);
});

test('codes written with dashes, dots or commas are read digit by digit, not as ranges', () => {
  // Kokoro reads "4-2-7-1" as "4 to 2 to 7 to 1" and "4,2,7,1" as one large number.
  assert.equal(speakableText('The code is 4-2-7-1.'), 'The code is 4 2 7 1.');
  assert.equal(speakableText('Try 0-4-2-0'), 'Try 0 4 2 0');
  assert.equal(speakableText('Is it 4,2,7,1?'), 'Is it 4 2 7 1?');
  assert.equal(speakableText('Code 4.2.7.1, then exit.'), 'Code 4 2 7 1, then exit.');
  assert.equal(speakableText('Code 4 – 2 – 7 – 1 now'), 'Code 4 2 7 1 now');
  assert.equal(speakableText('Code 4, 2, 7, 1 now'), 'Code 4, 2, 7, 1 now', 'spaced commas pause');
  // Ranges, amounts and decimals are untouched.
  assert.equal(speakableText('Wait 10-12 rounds, or 1-2.'), 'Wait 10-12 rounds, or 1-2.');
  assert.equal(speakableText('Pay 1,000 or 3.14 or 4.2.7.15'), 'Pay 1,000 or 3.14 or 4.2.7.15');
});

test('money, quantities and introduced years keep their normal reading', () => {
  assert.equal(
    speakableText('I will pay you $500 to look away.'),
    'I will pay you $500 to look away.',
  );
  assert.equal(speakableText('£2500 now, €1200 later'), '£2500 now, €1200 later');
  assert.equal(speakableText('Take 500 dollars, or 750 bucks.'), 'Take 500 dollars, or 750 bucks.');
  assert.equal(speakableText('Wait 120 seconds. 300% sure.'), 'Wait 120 seconds. 300% sure.');
  assert.equal(speakableText('Built in 1998, open since 2024.'), 'Built in 1998, open since 2024.');
  assert.equal(
    speakableText('$500 for the code 0427, it is 2026.'),
    '$500 for the code 0 4 2 7, it is 2 0 2 6.',
  );
  assert.equal(speakableText('Code 2024 opens it.'), 'Code 2 0 2 4 opens it.');
});

test('long text splits at sentence, clause and word boundaries without losing words', () => {
  const text =
    'Stop. ' +
    'This vault is closed to all visitors, contractors and staff without written approval. '.repeat(
      8,
    ) +
    'Leave now';
  const chunks = sentenceChunks(text, 120);
  assert.ok(chunks.length > 4);
  assert.ok(chunks.every((chunk) => chunk.length <= 120));
  assert.equal(chunks.join(' '), text.replace(/\s+/g, ' ').trim());
  const word = 'a'.repeat(300);
  const hard = sentenceChunks(word, 100);
  assert.ok(hard.every((chunk) => chunk.length <= 100));
  assert.equal(hard.join(''), word);
  assert.deepEqual(sentenceChunks('   '), []);
  // A long sentence without commas stays one synthesis pass until the hard limit.
  const sentence =
    'If you take one more step toward the safe without showing me a valid access pass I will treat you as a threat to this facility.';
  assert.ok(sentence.length > 120);
  assert.deepEqual(sentenceChunks(sentence, TTS_CHUNK, TTS_HARD_LIMIT), [sentence]);
  assert.deepEqual(sentenceChunks(sentence + ' Leave now.', 100, 300), [sentence, 'Leave now.']);
  const clauses =
    'Stop right there, ' + 'keep your hands where I can see them, '.repeat(7) + 'now.';
  assert.ok(clauses.length > TTS_CHUNK);
  const split = sentenceChunks(clauses, TTS_CHUNK, TTS_HARD_LIMIT);
  assert.ok(split.length > 1 && split.every((c) => c.length <= TTS_CHUNK));
  assert.ok(
    split.slice(0, -1).every((c) => c.endsWith(',')),
    'split only at clauses',
  );
  const run = 'word '.repeat(80).trim();
  const words = sentenceChunks(run, TTS_CHUNK, TTS_HARD_LIMIT);
  assert.ok(words.length === 2 && words.every((c) => c.length <= TTS_HARD_LIMIT));
  assert.equal(words.join(' '), run);
  const joined = joinAudio([new Float32Array(10).fill(1), new Float32Array(5).fill(1)], 100, 0.1);
  assert.equal(joined.length, 25);
  assert.equal(joined[12], 0);
  assert.equal(sizeLabel(100103562), '100 MB');
  assert.equal(sizeLabel(1.5e9), '1.5 GB');
});

test('voice catalog: Supertonic guard M1, male M2, female F1; earlier ids resolve', () => {
  assert.deepEqual(DEFAULT_VOICES, {
    robot: 'supertonic:M1',
    male: 'supertonic:M2',
    female: 'supertonic:F1',
  });
  for (const id of Object.values(DEFAULT_VOICES)) assert.ok(voiceInfo(id));
  for (const appearance of APPEARANCES)
    assert.equal(
      resolveVoice(appearance.voice, 'human', appearance),
      defaultVoice('human', appearance),
      appearance.voice,
    );
  assert.equal(VOICES.length, 10);
  assert.ok(VOICES.every((v) => /^supertonic:[MF][1-5]$/.test(v.id)));
  assert.ok(VOICES.every((v) => v.gender === (v.style[0] === 'F' ? 'female' : 'male')));
  assert.equal(voiceStyle('supertonic:M1'), 'M1');
  assert.equal(voiceStyle('supertonic:../../x'), null);
  assert.equal(resolveVoice('piper:lessac', 'robot'), 'supertonic:M1');
  assert.equal(resolveVoice('piper:ryan', 'human'), 'supertonic:M2');
  assert.equal(resolveVoice('', 'human', 'female'), 'supertonic:F1');
  assert.equal(resolveVoice('supertonic:F3', 'robot'), 'supertonic:F3');
  // Saved Kokoro choices (earlier releases) fall back to the defaults, keeping the gender.
  assert.equal(resolveVoice('kokoro:bm_george', 'robot'), 'supertonic:M1');
  assert.equal(resolveVoice('kokoro:af_heart', 'human'), 'supertonic:F1');
  assert.equal(resolveVoice('kokoro:am_michael', 'human', 'female'), 'supertonic:M2');
  assert.equal(defaultVoice('human', APPEARANCES[1]), 'supertonic:F1');
  assert.equal(voicesFor('female')[0].id, 'supertonic:F1');
  assert.equal(voicesFor('female')[1].gender, 'female');
  assert.equal(voicesFor('robot')[0].id, 'supertonic:M1');
  assert.equal(voicesFor(APPEARANCES[0])[0].id, 'supertonic:M2');
  assert.equal(voicesFor('male').length, VOICES.length);
});

test('numbers are spelled out for Supertonic, codes digit by digit', () => {
  const said = (text) => spellNumbers(speakableText(text));
  assert.equal(said('The code is 4271.'), 'The code is four two seven one.');
  assert.equal(said('Is it 4-2-7-1?'), 'Is it four two seven one?');
  assert.equal(said('Code 0419.'), 'Code zero four one nine.');
  assert.equal(said('I will pay you $500.'), 'I will pay you five hundred dollars.');
  assert.equal(
    said('$1 or $2.50 or $5k'),
    'one dollar or two dollars and fifty cents or five thousand dollars',
  );
  assert.equal(said('I will pay 1,200 dollars.'), 'I will pay one thousand two hundred dollars.');
  assert.equal(
    said('Badge 4271, 30 seconds, 2 guards.'),
    'Badge four two seven one, thirty seconds, two guards.',
  );
  assert.equal(
    said('Open since 1999, built in 2005.'),
    'Open since nineteen ninety-nine, built in two thousand five.',
  );
  assert.equal(
    said('At 3:45 or 9:00, the 21st and 2nd.'),
    "At three forty-five or nine o'clock, the twenty-first and second.",
  );
  assert.equal(
    said('Wait 10-12 minutes, 3.5 meters, 40%.'),
    'Wait ten to twelve minutes, three point five meters, forty percent.',
  );
  assert.equal(numberWords(1000001), 'one million one');
  assert.equal(numberWords(999), 'nine hundred ninety-nine');
  assert.doesNotMatch(said('Codes 12, 345, 6789 and $1,000,000.'), /\d/);
  // The game's text path: markdown and digits are gone before the model sees the text.
  assert.deepEqual(speechPasses('**Stop.** The code is 4271.'), [
    'Stop. The code is four two seven one.',
  ]);
  assert.equal(supertonicText('Hello — “world” #1'), '<en>Hello - "world" 1.</en>');
  assert.equal(supertonicText('Wait!'), '<en>Wait!</en>');
});
