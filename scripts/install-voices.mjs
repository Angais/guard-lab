// Install, check, test or remove the local speech models (the app's setup screen does the same).
//   npm run voices:install                 Supertonic voices + Whisper speech-to-text
//   npm run voices:install -- --tts        only Supertonic (text to speech)
//   npm run voices:install -- --stt        only Whisper (speech to text)
//   --from=DIR   copy from a local folder instead of downloading: a <data>/models directory, a
//                mirror of the Hugging Face repos (<org>/<repo>/...) or folders of downloaded repos
//   --status     print status only     --remove   delete the selected models
//   --test       synthesize a sentence with Supertonic and transcribe it with Whisper
// HF_ENDPOINT overrides https://huggingface.co (a mirror with the same layout).
import {
  KINDS,
  MODELS,
  readStatus,
  installModel,
  removeModel,
  modelsDirectory,
  loadModel,
  unloadModel,
  synthesizeSpeech,
  transcribeSpeech,
  decodeWav,
  sizeLabel,
} from '../shared/voice-models.mjs';
import { DEFAULT_VOICES } from '../shared/voice-catalog.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes('--' + name);
const option = (name) =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) || null;
const unknown = args.filter(
  (arg) => !/^--(tts|stt|status|remove|test|help)$/.test(arg) && !/^--from=/.test(arg),
);
if (flag('help') || unknown.length) {
  console.log(
    'Usage: npm run voices:install [-- --tts|--stt] [--from=DIR] [--status|--remove|--test]',
  );
  process.exit(unknown.length ? 1 : 0);
}
const kinds = KINDS.filter((kind) => flag(kind));
const selected = kinds.length ? kinds : KINDS;
const dir = modelsDirectory();
const tty = process.stdout.isTTY;

async function printStatus() {
  const status = Object.fromEntries(
    await Promise.all(KINDS.map(async (kind) => [kind, await readStatus(kind, { dir })])),
  );
  console.log(JSON.stringify({ directory: dir, ...status }, null, 2));
}

async function install(kind) {
  const spec = MODELS[kind];
  let shown = -1;
  const started = Date.now();
  const line = (text) => (tty ? process.stdout.write('\r\x1b[2K' + text) : console.log(text));
  await installModel(kind, {
    dir,
    source: option('from'),
    onProgress: ({ phase, progress, bytes, totalBytes, message }) => {
      const percent = Math.floor(progress * 100);
      if (!tty && percent < shown + 10 && phase === 'downloading') return;
      shown = percent;
      line(
        `${spec.title}: ${message} · ${percent}%` +
          (phase === 'downloading' ? ` (${sizeLabel(bytes)} of ${sizeLabel(totalBytes)})` : ''),
      );
    },
    // The installer's own load check keeps the CLI honest; unload afterwards.
  }).then(({ model }) => unloadModel(model));
  if (tty) process.stdout.write('\n');
  console.log(
    `${spec.title} ready (${sizeLabel(spec.files.reduce((s, f) => s + f.size, 0))}, ${Math.round((Date.now() - started) / 1000)} s).`,
  );
}

async function roundTrip() {
  for (const kind of KINDS)
    if ((await readStatus(kind, { dir })).state !== 'ready')
      throw new Error(`${MODELS[kind].title} is not installed. Run npm run voices:install.`);
  const sentence = 'Please step away from the safe. The code is 9327.';
  let started = Date.now();
  const tts = await loadModel('tts', { dir });
  console.log(`Supertonic loaded in ${Date.now() - started} ms.`);
  started = Date.now();
  const speech = await synthesizeSpeech(tts, { text: sentence, voice: DEFAULT_VOICES.robot });
  console.log(
    `Synthesized ${speech.durationMs} ms of audio in ${Date.now() - started} ms (${speech.voice}).`,
  );
  await unloadModel(tts);
  started = Date.now();
  const asr = await loadModel('stt', { dir });
  console.log(`Whisper loaded in ${Date.now() - started} ms.`);
  const { samples, sampleRate } = decodeWav(speech.wav);
  const heard = await transcribeSpeech(asr, { pcm: samples, sampleRate });
  await unloadModel(asr);
  console.log(`Transcribed in ${heard.ms} ms: ${JSON.stringify(heard.text)}`);
  const words = (text) =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, '')
      .split(/\s+/);
  const expected = words('Please step away from the safe');
  const missed = expected.filter((word) => !words(heard.text).includes(word));
  // Allow one dropped word: a synthetic voice is not word-perfect on every take.
  if (missed.length > 1)
    throw new Error('Round trip transcript did not match the spoken sentence.');
  console.log('OK: Supertonic and Whisper round trip.');
}

try {
  if (flag('status')) await printStatus();
  else if (flag('remove')) {
    for (const kind of selected) {
      await removeModel(kind, { dir });
      console.log(`${MODELS[kind].title} removed.`);
    }
  } else if (flag('test')) await roundTrip();
  else {
    console.log(`Installing local speech models into ${dir}`);
    for (const kind of selected) await install(kind);
    console.log('Speech models are ready. They stay on this computer and work offline.');
  }
} catch (error) {
  if (tty) process.stdout.write('\n');
  console.error(error.message);
  process.exitCode = 1;
}
