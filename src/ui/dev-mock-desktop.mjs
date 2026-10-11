// DEV ONLY. Simulates window.desktop in the browser so every screen state can be previewed:
//   ?mock=ready | signed-out | missing | error | checking
//   &voice=ready | missing | error      (default: ready for mock=ready, otherwise missing)
//   &mic=denied   &session=live | showcase   &setup=1 (show first-run setup again)
//   &reset=1 (forget saved settings, setup and first-game hints)
//   &prepare=2500 (slow Codex warm-up, to try Pause or New game while it runs)
// window.__mockCodex records the Codex calls (prepared, sent, cancelled, reset) for checks.
// main.jsx imports this only when import.meta.env.DEV is true, so builds never include it.
import { VOICES as VOICE_CATALOG } from '../../shared/voice-catalog.mjs';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const FIX_PROMPT =
  'Guard Lab could not use the Codex app server on my computer. Please check that the Codex CLI is installed and on my PATH, that `codex app-server` starts, and that I am signed in with ChatGPT. Fix what is missing, then tell me to press Check again in Guard Lab.';

const MODELS = [
  {
    id: 'gpt-6-luna',
    // Codex's own display name for the default model.
    name: 'GPT-6-Luna',
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'low',
    fast: true,
    isDefault: true,
  },
  {
    id: 'gpt-6',
    name: 'GPT-6',
    efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'medium',
    fast: true,
    isDefault: false,
  },
  {
    id: 'gpt-6-mini',
    name: 'GPT-6 mini',
    efforts: ['low', 'medium'],
    defaultEffort: 'low',
    fast: false,
    isDefault: false,
  },
];

const VOICES = VOICE_CATALOG.map((voice) => ({ ...voice }));

const GUARD_LINES = [
  'I hear you. Please show a valid access pass, or tell me why you are here.',
  'My responsibility is the item in this safe. What do you need?',
  'Keep your distance from the safe, please.',
  'Understood. You may cross to the exit.',
];
const HEARD = [
  'Hi there, I am just passing through to the exit.',
  'I was told to collect something from the safe.',
  'Can you tell me the code?',
];

function decide(messages, tools, actor) {
  const names = tools.map((t) => t.function?.name);
  const call = (name, args = {}) => ({
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'call_' + Math.random().toString(36).slice(2, 10),
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  });
  let packet = {};
  try {
    packet = JSON.parse(messages.at(-1)?.content || '{}');
  } catch {}
  if (actor === 'human') {
    if (names.includes('choose_item')) return call('choose_item', { item: 'lockpick' });
    const o = packet,
      zone = o.self?.position;
    if (names.includes('enter')) return call('enter');
    if (names.includes('take_item')) return call('take_item');
    if (names.includes('pick_lock')) return call('pick_lock');
    if (o.self?.hasProtectedItem && names.includes('leave')) return call('leave');
    if (o.self?.hasProtectedItem && names.includes('run')) return call('run', { zone: 'exit' });
    if (zone !== 'safe' && names.includes('move')) return call('move', { zone: 'safe' });
    return call(names.includes('wait') ? 'wait' : 'talk', { message: 'Hello?' });
  }
  const o = packet.observation || {};
  const last = o.lastAction?.action;
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  if (last === 'show_pass' && names.includes('verify_access_pass'))
    return call('verify_access_pass');
  if (o.microphone && names.includes('speak')) return call('speak', { message: pick(GUARD_LINES) });
  if (last === 'enter' && names.includes('speak'))
    return call('speak', {
      message:
        'Hello. Please present your access pass. I am responsible for the item in this safe.',
    });
  if (
    ['break_safe', 'pick_lock', 'combination'].includes(last) &&
    names.includes('broadcast_warning')
  )
    return call('broadcast_warning', { message: 'Step away from the safe. This is your warning.' });
  return call('hold_position');
}

export function installDevDesktop(search = location.search) {
  const params = new URLSearchParams(search);
  const scenario = params.get('mock') || 'ready';
  if (params.has('setup')) localStorage.removeItem('guard-lab-setup-v1');
  if (params.has('reset'))
    for (const key of Object.keys(localStorage))
      if (key.startsWith('guard-lab') || key.startsWith('cinema-v2')) localStorage.removeItem(key);
  const listeners = { codex: new Set(), voice: new Set() };
  const emit = (kind, value) => listeners[kind].forEach((cb) => cb(structuredClone(value)));
  const subscribe = (kind) => (cb) => {
    listeners[kind].add(cb);
    return () => listeners[kind].delete(cb);
  };

  const signedIn = {
    state: 'ready',
    binaryPath: 'codex',
    version: '0.155.0',
    account: { type: 'chatgpt', email: 'player@example.com', plan: 'pro' },
    message: 'Codex 0.155 · signed in with ChatGPT',
    fixPrompt: null,
    login: { state: 'idle' },
  };
  const codexStates = {
    ready: signedIn,
    checking: { ...signedIn, state: 'checking', account: null, message: 'Looking for Codex…' },
    'signed-out': {
      ...signedIn,
      state: 'signed-out',
      account: null,
      message: 'Codex is installed but not signed in.',
      fixPrompt: FIX_PROMPT,
    },
    missing: {
      ...signedIn,
      state: 'missing',
      binaryPath: null,
      version: null,
      account: null,
      message: 'Codex isn’t installed on this computer.',
      fixPrompt: FIX_PROMPT,
    },
    error: {
      ...signedIn,
      state: 'error',
      account: null,
      message: 'Codex app server exited during startup (code 1).',
      fixPrompt: FIX_PROMPT,
    },
  };
  let codex = structuredClone(codexStates[scenario] || signedIn);

  const voiceScenario = params.get('voice') || (scenario === 'ready' ? 'ready' : 'missing');
  const component = (kind, state) => ({
    state,
    progress: state === 'ready' ? 1 : 0,
    bytes: 0,
    totalBytes: kind === 'tts' ? 100.1e6 : 138.9e6,
    sizeLabel: kind === 'tts' ? '100 MB' : '139 MB',
    model: kind === 'tts' ? 'Supertonic 2' : 'Whisper base.en',
    message: state === 'error' ? 'Download interrupted. Check your connection.' : '',
    ...(kind === 'tts'
      ? {
          license: {
            name: 'OpenRAIL-M',
            url: 'https://huggingface.co/Supertone/supertonic-2/blob/main/LICENSE',
          },
        }
      : {}),
  });
  let voice = {
    tts: component('tts', voiceScenario),
    stt: component('stt', voiceScenario),
    microphone: params.get('mic') === 'denied' ? 'denied' : 'granted',
  };
  const installs = {};

  async function install(kind) {
    if (installs[kind]) return installs[kind];
    installs[kind] = (async () => {
      const total = voice[kind].totalBytes;
      for (let p = 0; p <= 1.0001; p += 0.05) {
        voice = {
          ...voice,
          [kind]: {
            ...voice[kind],
            state: 'installing',
            progress: p,
            bytes: Math.round(p * total),
          },
        };
        emit('voice', voice);
        await wait(kind === 'tts' ? 160 : 220);
      }
      voice = { ...voice, [kind]: { ...voice[kind], state: 'ready', progress: 1, bytes: total } };
      emit('voice', voice);
      delete installs[kind];
      return structuredClone(voice);
    })();
    return installs[kind];
  }

  const pendingDecisions = new Map();
  const calls = (window.__mockCodex = { prepared: [], sent: [], cancelled: [], reset: [] });
  async function decideLater(id, data, actor, ms = 900) {
    const cancel = new Promise((_, reject) =>
      pendingDecisions.set(id, () => reject(new Error('Request cancelled.'))),
    );
    try {
      await Promise.race([wait(ms + Math.random() * 500), cancel]);
      return {
        message: decide(data.messages || [], data.tools || [], actor),
        timing: { decisionMs: ms, model: 'gpt-6-luna', effort: 'low', serviceTier: 'priority' },
      };
    } finally {
      pendingDecisions.delete(id);
    }
  }

  window.desktop = {
    platform: params.get('platform') || 'darwin',
    __mock: scenario,
    configureModel: async () => true,
    testModel: async () => ({ ok: true, models: ['llama3.2:3b', 'qwen3:8b'] }),
    requestModel: (data) => decideLater(data.id, data, data.actor || 'robot', 700),
    requestRobot: (data) => decideLater(data.id, data, data.actor || 'robot', 1200),
    reportResult: async () => true,
    resetBridge: async () => true,
    sessionMode: async () => params.get('session'),
    cancelModel: async (id) => pendingDecisions.get(id)?.(),
    exportRecord: async () => true,
    // Kept in memory so previews never touch the real clipboard.
    copyText: async (text) => {
      window.__mockClipboard = String(text);
      return true;
    },
    codex: {
      status: async ({ refresh } = {}) => {
        if (refresh) {
          await wait(700);
          if (codex.state !== 'ready' && params.get('fix') === 'yes')
            codex = structuredClone(signedIn);
        }
        return structuredClone(codex);
      },
      onStatus: subscribe('codex'),
      login: async () => {
        codex = { ...codex, login: { state: 'pending' } };
        emit('codex', codex);
        setTimeout(() => {
          codex = structuredClone(signedIn);
          emit('codex', codex);
        }, 2200);
        return { started: true };
      },
      cancelLogin: async () => {
        codex = { ...codex, login: { state: 'idle' } };
        emit('codex', codex);
      },
      models: async () => {
        await wait(250);
        return structuredClone(MODELS);
      },
      prepare: async ({ sessionId } = {}) => {
        await wait(Number(params.get('prepare')) || 300);
        calls.prepared.push(sessionId);
        return { ok: true };
      },
      request: (data) => {
        calls.sent.push(data.id);
        if (codex.state !== 'ready')
          return Promise.reject(
            new Error('Codex is not signed in. Sign in with ChatGPT in Settings.'),
          );
        return decideLater(data.id, data, data.actor, 800);
      },
      cancel: async (id) => {
        calls.cancelled.push(id);
        pendingDecisions.get(id)?.();
      },
      reset: async (sessionId) => {
        calls.reset.push(sessionId);
        return true;
      },
    },
    voice: {
      status: async () => structuredClone(voice),
      onStatus: subscribe('voice'),
      install,
      remove: async (kind) => {
        voice = { ...voice, [kind]: component(kind, 'missing') };
        emit('voice', voice);
        return structuredClone(voice);
      },
      voices: async () => structuredClone(VOICES),
      synthesize: async () => ({ native: true }),
      transcribe: async () => {
        if (voice.stt.state !== 'ready') throw new Error('Voice input is not installed.');
        await wait(650);
        return { text: HEARD[Math.floor(Math.random() * HEARD.length)], ms: 650 };
      },
      microphone: async () => voice.microphone,
    },
  };

  // A fake recorder so push-to-talk can be previewed without microphone permission.
  globalThis.__guardLabDevRecorder = () => {
    let started = 0,
      active = false;
    return {
      get active() {
        return active;
      },
      start: async () => {
        await wait(60);
        started = performance.now();
        active = true;
      },
      stop: async () => {
        active = false;
        const durationMs = performance.now() - started;
        return {
          pcm: new Float32Array(Math.round(durationMs * 16)),
          sampleRate: 16000,
          durationMs,
        };
      },
      cancel: () => {
        active = false;
      },
      level: () => (active ? 0.25 + Math.abs(Math.sin(performance.now() / 140)) * 0.5 : 0),
    };
  };
}
