import { TOOLS, DEFAULT_PROMPT, LEGACY_DEFAULT_PROMPT } from '../sim/tools.mjs';
export const TOOL_VERSION = 6;
export const CONFIG_VERSION = 2;
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
  guardVoice: 'kokoro:bm_george',
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
  if (saved.prompt === LEGACY_DEFAULT_PROMPT) config.prompt = DEFAULT_PROMPT;
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
    credential: false,
    item: 'sack',
    toolVersion: TOOL_VERSION,
    combination: '',
    codex: { ...DEFAULT_CODEX },
    voice: { ...DEFAULT_VOICE },
    showHints: true,
  };
}

const kokoro = (id) => (typeof id === 'string' && id.startsWith('kokoro:') ? id : '');

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
    config.voice.guardVoice = kokoro(stored.robotVoice) || DEFAULT_VOICE.guardVoice;
    config.voice.humanVoice = kokoro(stored.humanVoice);
  }
  if (!PUSH_TO_TALK_KEYS.some((k) => k.code === config.voice.pushToTalkKey))
    config.voice.pushToTalkKey = DEFAULT_VOICE.pushToTalkKey;
  delete config.robotVoice;
  delete config.humanVoice;
  if (!['male', 'female'].includes(config.appearance)) config.appearance = 'male';
  if (!['employee-pass', 'thief-uniform'].includes(config.role)) config.role = 'employee-pass';
  if (typeof config.showHints !== 'boolean') config.showHints = true;
  if (!/^(\d{4})?$/.test(config.combination || '')) config.combination = '';
  delete config.rulesProfile;
  config.credential = config.credential === true;
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
  const model = models.find((m) => m.id === settings.model);
  const name = model?.name || prettyModel(settings.model);
  return [name, effortLabel(settings.effort), settings.fast ? 'Fast' : null]
    .filter(Boolean)
    .join(' · ');
}

export function prettyModel(id = '') {
  return id
    .split('-')
    .map((part) => (/^gpt$/i.test(part) ? 'GPT' : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ')
    .replace(/^GPT (\d)/, 'GPT-$1');
}
