import { TOOLS, DEFAULT_PROMPT, migratePrompt } from '../sim/tools.mjs';
import { cleanError } from './requests.mjs';
import { DEFAULT_VOICES, voiceInfo } from '../../shared/voice-catalog.mjs';
export const TOOL_VERSION = 6;
// 3: heist visitors carry a transit pass by default; Supertonic voices replace Kokoro.
export const CONFIG_VERSION = 3;
export const CONFIG_KEY = 'cinema-v2-guard-config';
export const SETUP_KEY = 'guard-lab-setup-v1';
export const MODES = ['codex', 'api', 'live', 'demo'];
export const DEFAULT_CODEX = Object.freeze({
  model: 'gpt-6-luna',
  effort: 'low',
  fast: true,
  path: '',
});
export const DEFAULT_VOICE = Object.freeze({
  speech: true,
  guardVoice: DEFAULT_VOICES.robot,
  // Empty means "follow the chosen appearance".
  humanVoice: '',
  input: true,
  pushToTalkKey: 'Space',
});
export const PUSH_TO_TALK_KEYS = [
  { code: 'Space', label: 'Space' },
  { code: 'KeyV', label: 'V' },
  { code: 'KeyB', label: 'B' },
  { code: 'Backquote', label: '`' },
];
export const keyLabel = (code) => PUSH_TO_TALK_KEYS.find((k) => k.code === code)?.label || code;

export function migrateToolConfig(saved = {}, defaults) {
  const config = { ...defaults, ...saved };
  // A saved copy of any earlier built-in prompt follows the current one; custom prompts stay.
  config.prompt =
    typeof config.prompt === 'string' && config.prompt.trim()
      ? migratePrompt(config.prompt)
      : DEFAULT_PROMPT;
  const names = TOOLS.map((tool) => tool.name);
  const enabled = Array.isArray(config.enabled)
    ? config.enabled.filter((name) => names.includes(name))
    : names;
  const additions = ['speak', 'hold_position'];
  if ((saved.toolVersion || 0) < 3)
    additions.push('verify_work_order', 'inspect_object', 'cycle_exit_door');
  if ((saved.toolVersion || 0) < 4) additions.push('remove_camera_cover');
  // Lockdown predated the versioned migrations and was never added to old saves.
  if ((saved.toolVersion || 0) < 5) additions.push('set_lockdown');
  if ((saved.toolVersion || 0) < 6) additions.push('deploy_net', 'recover_item', 'call_security');
  config.enabled = [...new Set([...enabled, ...additions])];
  config.toolVersion = TOOL_VERSION;
  if (config.item === 'recording') config.item = 'pistol';
  return config;
}

export function defaultConfig({ desktop = false } = {}) {
  const mode = desktop ? 'codex' : 'demo';
  return {
    configVersion: CONFIG_VERSION,
    sessionType: 'human',
    humanAI: { mode, endpoint: 'http://localhost:11434/v1', model: '' },
    mode,
    endpoint: 'http://localhost:11434/v1',
    model: '',
    temperature: 0,
    prompt: DEFAULT_PROMPT,
    enabled: TOOLS.map((t) => t.name),
    appearance: 'male',
    role: 'thief-uniform',
    // Heist visitors carry a valid transit pass unless the player leaves it behind.
    credential: true,
    // Playing the guard: pick the visitor's objective yourself instead of a secret draw.
    chooseVisitor: false,
    item: 'sack',
    toolVersion: TOOL_VERSION,
    combination: '',
    codex: { ...DEFAULT_CODEX },
    voice: { ...DEFAULT_VOICE },
    showHints: true,
  };
}

// A local voice from the current catalog, or a named system voice; anything else (earlier
// releases' Kokoro and Piper ids) returns to the default.
const knownVoice = (id) =>
  typeof id === 'string' && (voiceInfo(id) || /^native:./.test(id)) ? id : '';

// Upgrades every earlier save. The scripted demo used to be the default, so version 1
// saves that never chose a model move to Codex in the desktop app.
export function migrateConfig(saved, { desktop = false } = {}) {
  const stored = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  const defaults = defaultConfig({ desktop });
  const config = migrateToolConfig(stored, defaults);
  const legacy = (stored.configVersion || 1) < 2;
  if (!MODES.includes(config.mode) || (legacy && desktop && config.mode === 'demo'))
    config.mode = defaults.mode;
  config.humanAI = { ...defaults.humanAI, ...(stored.humanAI || {}) };
  if (!MODES.includes(config.humanAI.mode) || (legacy && desktop && config.humanAI.mode === 'demo'))
    config.humanAI.mode = defaults.humanAI.mode;
  if (!['human', 'guard', 'duel'].includes(config.sessionType)) config.sessionType = 'human';
  config.codex = { ...DEFAULT_CODEX, ...(stored.codex || {}) };
  if (typeof config.codex.fast !== 'boolean') config.codex.fast = DEFAULT_CODEX.fast;
  config.voice = { ...DEFAULT_VOICE, ...(stored.voice || {}) };
  if (legacy) {
    config.voice.guardVoice = stored.robotVoice;
    config.voice.humanVoice = stored.humanVoice;
  }
  config.voice.guardVoice = knownVoice(config.voice.guardVoice) || DEFAULT_VOICE.guardVoice;
  config.voice.humanVoice = knownVoice(config.voice.humanVoice);
  if (!PUSH_TO_TALK_KEYS.some((k) => k.code === config.voice.pushToTalkKey))
    config.voice.pushToTalkKey = DEFAULT_VOICE.pushToTalkKey;
  delete config.robotVoice;
  delete config.humanVoice;
  if (!['male', 'female'].includes(config.appearance)) config.appearance = 'male';
  if (!['employee-pass', 'thief-uniform'].includes(config.role)) config.role = 'employee-pass';
  if (typeof config.showHints !== 'boolean') config.showHints = true;
  if (!/^(\d{4})?$/.test(config.combination || '')) config.combination = '';
  delete config.rulesProfile;
  // Before version 3 a heist had no pass by default; those saves take the new default.
  config.credential = (stored.configVersion || 1) < 3 ? true : config.credential !== false;
  config.chooseVisitor = config.chooseVisitor === true;
  config.configVersion = CONFIG_VERSION;
  return config;
}

// Codex, API and terminal agents need the desktop app; the browser preview runs the demo.
export const effectiveMode = (mode, desktop) => (desktop || mode === 'demo' ? mode : 'demo');

// Picks a model the account actually offers; falls back to the catalogue default.
export function resolveCodexSettings(codex = DEFAULT_CODEX, models = []) {
  const wanted = { ...DEFAULT_CODEX, ...codex };
  const model =
    models.find((m) => m.id === wanted.model) || models.find((m) => m.isDefault) || models[0];
  if (!model)
    return {
      model: wanted.model,
      effort: wanted.effort,
      fast: Boolean(wanted.fast),
      ...(wanted.path ? { codexPath: wanted.path } : {}),
    };
  const sameModel = model.id === wanted.model;
  const efforts = Array.isArray(model.efforts) ? model.efforts : [];
  const effort =
    sameModel && efforts.includes(wanted.effort)
      ? wanted.effort
      : model.defaultEffort || efforts[0] || wanted.effort;
  return {
    model: model.id,
    effort,
    fast: Boolean(model.fast && wanted.fast),
    ...(wanted.path ? { codexPath: wanted.path } : {}),
  };
}

const EFFORT_LABELS = { none: 'None', minimal: 'Minimal', xhigh: 'Extra high' };
export const effortLabel = (effort = '') =>
  EFFORT_LABELS[effort] || effort.charAt(0).toUpperCase() + effort.slice(1);

export function guardLabel(config, models = []) {
  if (config.mode === 'demo') return 'Practice guard (no AI)';
  if (config.mode === 'api')
    return config.model ? `Your model · ${config.model}` : 'Your own model';
  if (config.mode === 'live') return 'Terminal agent';
  const settings = resolveCodexSettings(config.codex, models);
  return [
    modelName(settings.model, models),
    effortLabel(settings.effort),
    settings.fast ? 'Fast' : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

// Codex's own display names (“GPT-6-Luna”), remembered so a label never changes once the
// list arrives. Before any list was seen, the id is spelled the same way.
const MODEL_NAMES_KEY = 'guard-lab-model-names';
let knownNames;
function modelNames() {
  if (!knownNames)
    try {
      knownNames = JSON.parse(globalThis.window?.localStorage?.getItem(MODEL_NAMES_KEY)) || {};
    } catch {
      knownNames = {};
    }
  return knownNames;
}
export function rememberModelNames(models = []) {
  const names = modelNames();
  const fresh = (Array.isArray(models) ? models : []).filter(
    (m) => m?.id && m.name && names[m.id] !== m.name,
  );
  if (!fresh.length) return;
  knownNames = { ...names, ...Object.fromEntries(fresh.map((m) => [m.id, m.name])) };
  try {
    globalThis.window?.localStorage?.setItem(MODEL_NAMES_KEY, JSON.stringify(knownNames));
  } catch {}
}
export const modelName = (id = '', models = []) =>
  models.find((m) => m.id === id)?.name || modelNames()[id] || prettyModel(id);

export function prettyModel(id = '') {
  return id
    .split('-')
    .map((part) => (/^gpt$/i.test(part) ? 'GPT' : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('-');
}

export const isOllamaEndpoint = (endpoint) => {
  try {
    return new URL(endpoint).port === '11434';
  } catch {
    return false;
  }
};

// A failed connection test in words a player can act on, never the raw IPC message.
export function connectionError(error, endpoint) {
  const message = cleanError(error);
  if (!/fetch failed|failed to fetch|ECONNREFUSED|ENOTFOUND|network/i.test(message)) return message;
  let host = endpoint;
  try {
    host = new URL(endpoint).host;
  } catch {}
  return isOllamaEndpoint(endpoint)
    ? `Ollama isn’t running at ${host}. Start it, then refresh.`
    : `Nothing answered at ${host}. Check the URL and that the server is running.`;
}
