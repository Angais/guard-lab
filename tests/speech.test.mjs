import test from 'node:test';
import assert from 'node:assert/strict';
import { selectEnglishVoice, nativeSpeech } from '../src/audio/speech.mjs';

test('speech selection never falls back to a German/default voice', () => {
  const german = { name: 'Anna', lang: 'de-DE', default: true };
  const male = { name: 'David', lang: 'en-US' };
  const female = { name: 'Zira', lang: 'en-US' };
  assert.equal(selectEnglishVoice([german], 'native:Anna', 'robot'), null);
  assert.equal(selectEnglishVoice([german, male, female], 'supertonic:M2', 'human'), male);
  assert.equal(selectEnglishVoice([german, male, female], 'supertonic:F1', 'human'), female);
  assert.equal(selectEnglishVoice([german, male, female], 'supertonic:M1', 'robot'), male);
  // Saved settings from the Kokoro era keep their voice gender.
  assert.equal(selectEnglishVoice([german, male, female], 'kokoro:af_heart', 'human'), female);
  assert.equal(selectEnglishVoice([german, male, female], undefined, 'robot'), male);
  assert.equal(selectEnglishVoice([german, male], 'native:Anna', 'human'), male);
  assert.equal(
    selectEnglishVoice([german, male, female], 'native:Zira', 'robot'),
    female,
    'an explicit system voice wins',
  );
  // Saved settings from the Piper era keep their voice gender.
  assert.equal(selectEnglishVoice([german, male, female], 'piper:ryan', 'human'), male);
  assert.equal(selectEnglishVoice([german, male, female], 'piper:lessac', 'robot'), female);
  assert.equal(
    selectEnglishVoice([{ name: 'English', lang: 'en' }], null, 'human').name,
    'English',
  );
});

test('missing English voices produce an actionable error without speaking', async () => {
  let spoken = false;
  globalThis.window = {
    speechSynthesis: {
      getVoices: () => [{ name: 'Anna', lang: 'de-DE' }],
      speak: () => {
        spoken = true;
      },
    },
  };
  try {
    await assert.rejects(
      nativeSpeech('Hello.', 'supertonic:M1', 'robot'),
      /No English system voice.*Supertonic/,
    );
    assert.equal(spoken, false);
  } finally {
    delete globalThis.window;
  }
});

test('system voices: the guard and human sound different', () => {
  const voices = [
    { name: 'Fred', lang: 'en-US' },
    { name: 'Eddy (English (US))', lang: 'en-US' },
    { name: 'Daniel (English (UK))', lang: 'en-GB' },
    { name: 'Samantha (English (US))', lang: 'en-US' },
    { name: 'Google UK English Female', lang: 'en-GB' },
  ];
  const guard = selectEnglishVoice(voices, 'supertonic:M1', 'robot');
  assert.equal(guard.name, 'Daniel (English (UK))');
  assert.equal(
    selectEnglishVoice(voices, 'supertonic:M2', 'human', { avoid: guard.name }).name,
    'Eddy (English (US))',
    'American male, ranked above the older Fred voice',
  );
  assert.equal(
    selectEnglishVoice(voices, 'supertonic:M3', 'human', { avoid: guard.name }).name,
    'Eddy (English (US))',
    'another male voice rather than the guard’s',
  );
  assert.equal(
    selectEnglishVoice(voices.slice(2), 'supertonic:M3', 'human', { avoid: guard.name }).name,
    guard.name,
    'the only male voice is shared',
  );
  assert.equal(selectEnglishVoice(voices, 'supertonic:F2', 'human').name, voices[3].name);
  assert.equal(selectEnglishVoice(voices, 'supertonic:F1', 'human').name, voices[3].name);
});

test('system speech reads codes digit by digit and gives the human a different voice', async () => {
  const spoken = [];
  globalThis.window = {
    speechSynthesis: {
      getVoices: () => [
        { name: 'Daniel', lang: 'en-GB' },
        { name: 'Reed (English (US))', lang: 'en-US' },
        { name: 'Arthur', lang: 'en-GB' },
      ],
      speak: (utterance) => {
        spoken.push(utterance);
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
  try {
    await nativeSpeech('The code is **4271**.', 'supertonic:M1', 'robot');
    await nativeSpeech('Is it 4-2-7-1?', 'supertonic:M3', 'human');
    assert.deepEqual(
      spoken.map((u) => u.text),
      ['The code is 4 2 7 1.', 'Is it 4 2 7 1?'],
    );
    assert.equal(spoken[0].voice.name, 'Daniel');
    assert.equal(spoken[1].voice.name, 'Arthur', 'a British male voice other than the guard’s');
  } finally {
    delete globalThis.window;
    delete globalThis.SpeechSynthesisUtterance;
  }
});
