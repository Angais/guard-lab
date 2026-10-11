'use strict';
// Codex App Server client: the guard's (and an optional AI human's) brain.
// Speaks newline-delimited JSON-RPC (without the "jsonrpc" field) over stdio to `codex app-server`.
// Everything except registerCodex() is plain Node so it can be tested without Electron.
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

let VERSION = '0.0.0';
try {
  VERSION = require('../package.json').version;
} catch {}

const DEFAULT_SETTINGS = { model: 'gpt-6-luna', effort: 'low', fast: true };
const TURN_TIMEOUT_MS = 90000;
const START_TIMEOUT_MS = 20000;
const RPC_TIMEOUT_MS = 30000;
const LOGIN_TIMEOUT_MS = 10 * 60000;
const MAX_INVALID_CALLS = 3;
// After an accepted call, Codex must record the code-mode exec output before the turn is
// interrupted, or the model's history shows its action as aborted. thread/tokenUsage/updated
// arrives right after that output is recorded; this caps the wait if it never comes.
const SETTLE_CAP_MS = 2000;
const WARMUP_TIMEOUT_MS = 8000;
const SUBMITTED = 'Submitted. The outcome arrives with your next observation.';
const WARMUP_TEXT =
  'Guard Lab: the encounter is about to start. Do nothing yet; your first observation follows.';
const INTERFACE_NOTE =
  '\n\nInterface: each user message is your newest observation from the game. Respond by calling exactly one of the currently available game tools. Plain text without a tool call is spoken aloud as your action.' +
  ' Guard Lab ends each turn itself once it has your action (and ends the start-up turn before you reply), so Codex marks those turns as interrupted. That notice is part of the interface, not a game event: an action you called was received, and its outcome arrives with your next observation.';
// An id cancelled before its request arrived (the renderer may still send it) is refused.
const CANCEL_MEMORY_MS = 60000;

// Noisy streaming notifications Guard Lab never reads.
const OPT_OUT_NOTIFICATIONS = [
  'item/agentMessage/delta',
  'item/plan/delta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded',
  'item/reasoning/textDelta',
  'item/commandExecution/outputDelta',
  'item/commandExecution/terminalInteraction',
  'item/fileChange/outputDelta',
  'item/fileChange/patchUpdated',
  'item/mcpToolCall/progress',
  'command/exec/outputDelta',
  'process/outputDelta',
  'turn/diff/updated',
  'turn/plan/updated',
  'fs/changed',
  'skills/changed',
  'rawResponseItem/completed',
  'remoteControl/status/changed',
  'fuzzyFileSearch/sessionUpdated',
  'fuzzyFileSearch/sessionCompleted',
];
// Built-in capabilities that would let the model leave the game (shell, browser, files, MCP, ...).
// Do not add code_mode_host: dynamic tools stop being called without it.
const ISOLATION_FEATURES = [
  'plugins',
  'apps',
  'skill_search',
  'multi_agent',
  'browser_use',
  'computer_use',
  'image_generation',
  'shell_tool',
  'unified_exec',
  'goals',
  'hooks',
  'tool_suggest',
  'view_image',
  'in_app_browser',
  'sleep_tool',
  'memories',
];
// Off-by-default features that add model-facing tools or instructions. Only disabled per thread:
// an unknown --disable name is fatal at launch, while unknown per-thread feature keys are ignored.
const THREAD_ISOLATION_FEATURES = [
  'context_management',
  'multi_agent_v2',
  'token_budget',
  'rollout_budget',
  'current_time_reminder',
  'chronicle',
  'realtime_conversation',
];
// Never disable these: dynamic tools need code_mode_host, and Fast mode needs fast_mode.
const REQUIRED_FEATURES = new Set(['code_mode_host', 'fast_mode']);
// Features a user may opt into for their network, sign-in, sandbox or storage. Other opt-ins
// (enabled although off by default) are disabled for the game's threads.
const INFRASTRUCTURE_FEATURE =
  /sandbox|proxy|auth|identity|credential|compression|retries|connection|websocket|sqlite|store|rollout_migration|idle_sleep|metrics|landlock|bwrap|model_discovery|oauth/;
const ISOLATION_CONFIG = {
  include_apps_instructions: false,
  include_permissions_instructions: false,
  include_environment_context: false,
  include_collaboration_mode_instructions: false,
  'skills.include_instructions': false,
  'orchestrator.skills.enabled': false,
  'tools.update_plan.enabled': false,
  web_search: 'disabled',
  project_doc_max_bytes: 0,
  notify: [],
};
// JSON literals for these values (booleans, numbers, strings, []) are also valid TOML.
const CONFIG_ARGS = Object.entries(ISOLATION_CONFIG).flatMap(([key, value]) => [
  '-c',
  `${key}=${JSON.stringify(value)}`,
]);
const FEATURE_ARGS = ISOLATION_FEATURES.flatMap((name) => ['--disable', name]);
// Feature names change between Codex versions; an unknown flag is fatal, so retry with fewer.
const LAUNCH_LEVELS = [
  { name: 'isolated', args: [...FEATURE_ARGS, ...CONFIG_ARGS] },
  { name: 'config-only', args: CONFIG_ARGS },
  { name: 'plain', args: [] },
];
// Codex itself requires MCP server names (and feature names) to be bare TOML keys.
const BARE_KEY = /^[A-Za-z0-9_-]+$/;
/** Features from experimentalFeature/list the user turned on although they are off by default. */
function userOptInFeatures(list) {
  return (Array.isArray(list) ? list : [])
    .filter(
      (f) =>
        f &&
        typeof f.name === 'string' &&
        BARE_KEY.test(f.name) &&
        f.enabled === true &&
        f.defaultEnabled === false &&
        f.stage !== 'removed' &&
        !REQUIRED_FEATURES.has(f.name) &&
        !INFRASTRUCTURE_FEATURE.test(f.name),
    )
    .map((f) => f.name);
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isTransient = (error) =>
  error?.code === -32001 ||
  /overloaded|retry later|temporarily unavailable|try again later/i.test(String(error?.message));

// ---------- small helpers ----------
class CodexError extends Error {
  constructor(message, extra = {}) {
    super(message);
    Object.assign(this, extra);
  }
}
const stripAnsi = (text) => String(text || '').replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
const clip = (text, limit = 400) => {
  const value = String(text || '').trim();
  return value.length > limit ? value.slice(0, limit - 1) + '…' : value;
};
const cancelledError = () => new CodexError('Codex request cancelled.', { code: 'cancelled' });
const shortVersion = (version) => String(version || '').match(/\d+\.\d+/)?.[0] || version || '';
const isPlainObject = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new CodexError(message, { code: 'timeout' })), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// ---------- JSON-schema subset validation for tool arguments ----------
const typeMatches = (type, value) =>
  type === 'string'
    ? typeof value === 'string'
    : type === 'number'
      ? typeof value === 'number' && Number.isFinite(value)
      : type === 'integer'
        ? Number.isInteger(value)
        : type === 'boolean'
          ? typeof value === 'boolean'
          : type === 'object'
            ? isPlainObject(value)
            : type === 'array'
              ? Array.isArray(value)
              : type === 'null'
                ? value === null
                : true;
function validateValue(schema, value, name) {
  if (!isPlainObject(schema)) return null;
  const label = name || 'arguments';
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((v) => JSON.stringify(v) === JSON.stringify(value))
  )
    return `${label} must be one of: ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`;
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length && !types.some((type) => typeMatches(type, value)))
    return `${label} must be ${types.map((t) => (/^[aeiou]/.test(t) ? 'an ' : 'a ') + t).join(' or ')}`;
  if (typeof value === 'string') {
    if (schema.pattern) {
      let pattern;
      try {
        pattern = new RegExp(schema.pattern, 'u');
      } catch {}
      if (pattern && !pattern.test(value)) return `${label} must match ${schema.pattern}`;
    }
    if (schema.minLength !== undefined && value.length < schema.minLength)
      return `${label} must be at least ${schema.minLength} characters`;
    if (schema.maxLength !== undefined && value.length > schema.maxLength)
      return `${label} must be at most ${schema.maxLength} characters`;
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum)
      return `${label} must be at least ${schema.minimum}`;
    if (schema.maximum !== undefined && value > schema.maximum)
      return `${label} must be at most ${schema.maximum}`;
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum)
      return `${label} must be greater than ${schema.exclusiveMinimum}`;
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum)
      return `${label} must be less than ${schema.exclusiveMaximum}`;
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems)
      return `${label} needs at least ${schema.minItems} items`;
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      return `${label} allows at most ${schema.maxItems} items`;
    if (isPlainObject(schema.items))
      for (let i = 0; i < value.length; i++) {
        const error = validateValue(schema.items, value[i], `${label}[${i}]`);
        if (error) return error;
      }
  }
  if (
    isPlainObject(value) &&
    (schema.properties || schema.required || 'additionalProperties' in schema)
  ) {
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    const prefix = name ? name + '.' : '';
    for (const key of Array.isArray(schema.required) ? schema.required : [])
      if (!(key in value)) return `missing required argument "${prefix}${key}"`;
    for (const [key, item] of Object.entries(value)) {
      if (key in properties) {
        const error = validateValue(properties[key], item, prefix + key);
        if (error) return error;
      } else if (schema.additionalProperties === false)
        return `unexpected argument "${prefix}${key}"`;
      else if (isPlainObject(schema.additionalProperties)) {
        const error = validateValue(schema.additionalProperties, item, prefix + key);
        if (error) return error;
      }
    }
  }
  return null;
}
/** Returns null when `args` satisfies the tool's JSON schema, otherwise a short reason. */
function validateArguments(schema, args) {
  if (!isPlainObject(args)) return 'arguments must be a JSON object';
  return validateValue(schema || { type: 'object' }, args, '');
}
function parseArguments(raw) {
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

// ---------- tools and turn input ----------
const toolName = (tool) => tool?.function?.name || tool?.name;
function toDynamicTools(...lists) {
  const seen = new Map();
  for (const list of lists)
    for (const tool of Array.isArray(list) ? list : []) {
      const name = toolName(tool);
      if (!name || seen.has(name)) continue;
      const fn = tool.function || tool;
      seen.set(name, {
        type: 'function',
        name,
        description: String(fn.description || ''),
        inputSchema: fn.parameters ||
          fn.inputSchema || { type: 'object', properties: {}, additionalProperties: false },
      });
    }
  return [...seen.values()];
}
function contentText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (Array.isArray(message?.content))
    return message.content
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .join('');
  return '';
}
function describeEntry(message) {
  if (message.role === 'assistant') {
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (calls.length)
      return calls
        .map((c) => `Your action: ${c.function?.name}(${c.function?.arguments || '{}'})`)
        .join('\n');
    return `You said: ${contentText(message)}`;
  }
  if (message.role === 'tool') return `Result of your action: ${contentText(message)}`;
  return contentText(message);
}
/**
 * A Codex thread keeps every observation it is sent, so a turn leaves out exact repeats: the
 * physical rules when the system prompt already states them verbatim, and the observation's
 * tool list when the turn's closing line names the same tools. Everything else is unchanged.
 */
function withoutRepeats(text, { system, toolNames }) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  if (!isPlainObject(parsed)) return text;
  const observation = isPlainObject(parsed.observation) ? parsed.observation : parsed;
  let changed = false;
  if (isPlainObject(observation.rules) && system.includes(JSON.stringify(observation.rules))) {
    delete observation.rules;
    changed = true;
  }
  const listed = observation.self?.availableTools;
  if (
    Array.isArray(listed) &&
    listed.length === toolNames.length &&
    [...listed].sort().join() === [...toolNames].sort().join()
  ) {
    delete observation.self.availableTools;
    changed = true;
  }
  return changed ? JSON.stringify(parsed) : text;
}
/**
 * Builds the text for one Codex turn from OpenAI-chat-shaped `messages` (messages[0] is the
 * system prompt). Only messages the thread has not seen yet are sent: those after the last
 * assistant message, skipping anything up to `lastSent`. `recap` replays earlier context into a
 * fresh thread (for example after a restart) so the actor keeps its memory.
 */
function formatTurnInput(messages, { toolNames = [], recap = false, lastSent = null } = {}) {
  const body = (Array.isArray(messages) ? messages : []).slice(1);
  let lastAssistant = -1;
  body.forEach((message, index) => {
    if (message?.role === 'assistant') lastAssistant = index;
  });
  let fresh = body.slice(lastAssistant + 1);
  if (lastSent !== null) {
    const seen = fresh.findLastIndex((m) => m?.role !== 'tool' && contentText(m) === lastSent);
    if (seen !== -1 && seen < fresh.length - 1) fresh = fresh.slice(seen + 1);
  }
  const parts = [];
  if (recap && lastAssistant >= 0)
    parts.push(
      'Earlier in this encounter (your previous context):\n' +
        body
          .slice(0, lastAssistant + 1)
          .map(describeEntry)
          .join('\n'),
    );
  for (const message of fresh.filter((m) => m?.role === 'tool'))
    parts.push(`Result of your previous action: ${contentText(message)}`);
  const observations = fresh.filter((m) => m?.role !== 'tool' && m?.role !== 'system');
  const system = contentText(messages?.[0]);
  for (const message of observations)
    parts.push(withoutRepeats(contentText(message), { system, toolNames }));
  parts.push(
    toolNames.length
      ? `Available tools now: ${toolNames.join(', ')}. Call exactly one.`
      : 'No tools are available now.',
  );
  return {
    text: parts.join('\n\n'),
    lastSent: observations.length ? contentText(observations.at(-1)) : lastSent,
  };
}

// ---------- errors ----------
function friendlyError(error, { model } = {}) {
  const info = error?.codexErrorInfo;
  const kind = typeof info === 'string' ? info : isPlainObject(info) ? Object.keys(info)[0] : '';
  const raw = stripAnsi(error?.message || error?.error?.message || String(error || ''));
  const text = raw + ' ' + (error?.additionalDetails || '');
  const status = isPlainObject(info) ? Object.values(info)[0]?.httpStatusCode : null;
  if (kind === 'usageLimitExceeded' || /usage limit/i.test(text))
    return 'Codex usage limit reached. Wait for it to reset or pick another model in Settings.';
  if (kind === 'rateLimitExceeded' || status === 429 || /rate.?limit|too many requests/i.test(text))
    return 'Codex is rate limited right now. Try again in a moment.';
  if (kind === 'serverOverloaded' || error?.code === -32001 || /overloaded/i.test(text))
    return 'Codex servers are busy. Try again in a moment.';
  if (
    kind === 'unauthorized' ||
    status === 401 ||
    /unauthori[sz]ed|not logged in|not signed in|log in again|sign in again/i.test(text)
  )
    return 'Codex sign-in expired. Sign in again in Settings.';
  if (kind === 'contextWindowExceeded' || /context window/i.test(text))
    return 'This encounter no longer fits in the model context. Start a new encounter.';
  if (
    /model[^.]{0,80}(?:not supported|not available|not found|does not exist|unknown|unsupported|no access|not allowed)|(?:unknown|unsupported|invalid) model/i.test(
      text,
    )
  )
    return `Model ${model || ''} is not available for this Codex account. Pick another model in Settings.`.replace(
      '  ',
      ' ',
    );
  if (
    [
      'httpConnectionFailed',
      'responseStreamConnectionFailed',
      'responseStreamDisconnected',
    ].includes(kind) ||
    /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|network error|failed to connect|connection (?:refused|reset|failed)|stream disconnected/i.test(
      text,
    )
  )
    return 'Codex could not reach OpenAI. Check your internet connection.';
  if (kind === 'cyberPolicy' || kind === 'misalignmentPolicyViolation')
    return 'Codex declined this turn: ' + clip(raw, 200);
  if (/^Codex\b/.test(raw)) return clip(raw, 300);
  return 'Codex error: ' + clip(raw || kind || 'unknown error', 300);
}

// ---------- binary discovery ----------
const TRIPLES = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
};
function statFile(file) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}
function readHead(file, bytes = 512) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read);
  } catch {
    return Buffer.alloc(0);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
function realpath(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
}
function listDirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}
function findFiles(root, names, depth) {
  const found = [];
  const walk = (dir, level) => {
    if (level > depth || found.length > 4) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isFile() && names.includes(entry.name.toLowerCase())) found.push(file);
      else if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
        walk(file, level + 1);
    }
  };
  walk(root, 0);
  return found;
}
/** Extra directories GUI apps miss because Finder/Explorer do not load the shell PATH. */
function extraBinDirs({ platform, env, home }) {
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [
      path.join(appData, 'npm'),
      path.join(local, 'pnpm'),
      path.join(local, 'Volta', 'bin'),
      path.join(home, '.bun', 'bin'),
      path.join(local, 'Programs', 'OpenAI', 'Codex', 'bin'),
      path.join(local, 'Programs', 'Codex', 'bin'),
      path.join(local, 'OpenAI', 'Codex', 'bin'),
      path.join(home, '.codex', 'bin'),
      ...(env.NVM_SYMLINK ? [env.NVM_SYMLINK] : []),
      ...(env.ProgramFiles ? [path.join(env.ProgramFiles, 'nodejs')] : []),
    ];
  }
  const dirs = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    path.join(home, '.local', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.npm', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.codex', 'bin'),
    path.join(home, 'bin'),
    ...(env.PNPM_HOME ? [env.PNPM_HOME] : []),
    ...(env.NPM_CONFIG_PREFIX ? [path.join(env.NPM_CONFIG_PREFIX, 'bin')] : []),
  ];
  if (platform === 'darwin') dirs.push(path.join(home, 'Library', 'pnpm'));
  else dirs.push(path.join(home, '.local', 'share', 'pnpm'));
  for (const root of [path.join(home, '.nvm', 'versions', 'node')])
    for (const version of listDirs(root).sort().reverse()) dirs.push(path.join(version, 'bin'));
  for (const root of [
    path.join(home, '.local', 'share', 'fnm', 'node-versions'),
    path.join(home, 'Library', 'Application Support', 'fnm', 'node-versions'),
  ])
    for (const version of listDirs(root).sort().reverse())
      dirs.push(path.join(version, 'installation', 'bin'));
  return dirs;
}
function augmentedPath({ platform, env, home, extras = true }) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  const separator = platform === 'win32' ? ';' : ':';
  const current = String(env[key] || '')
    .split(separator)
    .filter(Boolean);
  const all = [...current, ...(extras ? extraBinDirs({ platform, env, home }) : [])];
  return { key, value: [...new Set(all)].join(separator), dirs: [...new Set(all)] };
}
function nativeFromPackage(packageRoot, { platform, arch }) {
  const triple = TRIPLES[`${platform}-${arch}`];
  if (!triple) return null;
  const exe = platform === 'win32' ? 'codex.exe' : 'codex';
  const platformPackage = `codex-${platform}-${arch}`;
  const candidates = [
    path.join(
      packageRoot,
      'node_modules',
      '@openai',
      platformPackage,
      'vendor',
      triple,
      'bin',
      exe,
    ),
    path.join(path.dirname(packageRoot), platformPackage, 'vendor', triple, 'bin', exe),
    path.join(packageRoot, 'vendor', triple, 'bin', exe),
    path.join(packageRoot, 'vendor', triple, 'codex', exe),
  ];
  return candidates.find(statFile) || null;
}
/** Finds the codex.js an npm/pnpm/bun shim (codex.cmd, codex.ps1, sh wrapper) points at. */
function scriptTarget(file, text) {
  const dir = path.dirname(file);
  const match = text.match(
    /(\$basedir|%~?dp0%?|\$PSScriptRoot)?[\\/]?((?:[^"'\s$%]*?[\\/])?node_modules[\\/]@openai[\\/]codex[\\/]bin[\\/]codex\.js)/,
  );
  if (match) {
    const target = match[1] || !path.isAbsolute(match[2]) ? path.join(dir, match[2]) : match[2];
    if (statFile(target)) return target;
  }
  const conventional = path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  return statFile(conventional) ? conventional : null;
}
/**
 * Turns a found file into a spawnable command. Native binaries are spawned directly. JavaScript
 * shims are resolved to the native binary from the npm package layout, or else run with this
 * process's own Node (ELECTRON_RUN_AS_NODE) because GUI apps often have no `node` on PATH.
 */
function resolveExecutable(file, { platform, arch, execPath }) {
  const real = realpath(file);
  if (!statFile(real)) return { error: 'not found' };
  const ext = path.extname(real).toLowerCase();
  const firstLine = readHead(real).toString('utf8').split('\n')[0];
  const runJs = (js) => {
    const native = nativeFromPackage(path.dirname(path.dirname(js)), { platform, arch });
    if (native) return { command: native, args: [], path: native, kind: 'native' };
    return {
      command: execPath,
      args: [js],
      path: js,
      kind: 'node',
      env: { ELECTRON_RUN_AS_NODE: '1' },
    };
  };
  if (['.js', '.mjs', '.cjs'].includes(ext)) return runJs(real);
  if (firstLine.startsWith('#!') && /\bnode\b/.test(firstLine)) return runJs(real);
  const isShim = ['.cmd', '.bat', '.ps1'].includes(ext);
  if (isShim || firstLine.startsWith('#!')) {
    // ChatGPT desktop bundle: bin/codex is a sh wrapper around CodexCLI.app/Contents/MacOS/codex.
    const bundled = path.resolve(
      path.dirname(real),
      '..',
      'CodexCLI.app',
      'Contents',
      'MacOS',
      'codex',
    );
    if (!isShim && statFile(bundled))
      return { command: bundled, args: [], path: bundled, kind: 'native' };
    let text = '';
    try {
      text = fs.readFileSync(real, 'utf8');
    } catch {}
    const js = scriptTarget(real, text);
    if (js) return runJs(js);
    const exe = path.join(path.dirname(real), 'codex.exe');
    if (platform === 'win32' && statFile(exe))
      return { command: exe, args: [], path: exe, kind: 'native' };
    if (isShim || platform === 'win32') return { error: 'shim target not found' };
    return { command: real, args: [], path: real, kind: 'script' };
  }
  return { command: real, args: [], path: real, kind: 'native' };
}
function defaultLocations({ platform, env, home }) {
  if (platform === 'darwin')
    return [
      '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
      '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
      path.join(
        home,
        'Applications',
        'ChatGPT.app',
        'Contents',
        'Resources',
        'codex-cli',
        'bin',
        'codex',
      ),
      '/Applications/Codex.app/Contents/Resources/codex',
      path.join(home, 'Applications', 'Codex.app', 'Contents', 'Resources', 'codex'),
    ];
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const found = [];
    for (const root of [
      path.join(local, 'Programs', 'ChatGPT'),
      path.join(local, 'Programs', 'Codex'),
      path.join(local, 'Programs', 'OpenAI'),
      path.join(local, 'OpenAI'),
      path.join(home, '.codex', 'packages'),
    ])
      found.push(...findFiles(root, ['codex.exe'], 6));
    return found;
  }
  return ['/opt/codex/bin/codex', '/usr/lib/codex/codex'];
}
function runQuiet(spawnImpl, command, args, { env, timeout = 8000 } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let child;
    let timer;
    const finish = (result) => {
      clearTimeout(timer);
      resolve(result);
    };
    try {
      child = spawnImpl(command, args, {
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      return finish({ ok: false, error: error.message });
    }
    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      finish({ ok: false, error: 'timed out', stdout: out, stderr: err });
    }, timeout);
    child.stdout?.on('data', (d) => (out += d));
    child.stderr?.on('data', (d) => (err += d));
    child.on('error', (error) => finish({ ok: false, error: error.message }));
    child.on('close', (code) =>
      finish({ ok: code === 0, code, stdout: out, stderr: err, error: code ? `exit ${code}` : '' }),
    );
  });
}
/**
 * Locates a working Codex CLI. Order: explicit setting → GUARD_LAB_CODEX → PATH (augmented with
 * common install folders) → desktop app bundles → the user's login shell.
 */
async function findCodex({
  codexPath,
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  home = os.homedir(),
  execPath = process.execPath,
  spawnImpl = childProcess.spawn,
  systemSearch = true,
  loginShell = true,
} = {}) {
  const searched = [];
  const tried = new Set();
  const pathInfo = augmentedPath({ platform, env, home: home || '', extras: systemSearch });
  const childEnv = { ...env, [pathInfo.key]: pathInfo.value };
  const names = platform === 'win32' ? ['codex.exe', 'codex.cmd', 'codex.ps1', 'codex'] : ['codex'];
  const attempt = async (file, source) => {
    if (!file) return null;
    const key = realpath(file);
    if (tried.has(key)) return null;
    tried.add(key);
    if (!statFile(file)) {
      if (source !== 'PATH') searched.push(`${file} (${source}: not found)`);
      return null;
    }
    const resolved = resolveExecutable(file, { platform, arch, execPath });
    if (resolved.error) {
      searched.push(`${file} (${source}: ${resolved.error})`);
      return null;
    }
    const runEnv = { ...childEnv, ...(resolved.env || {}) };
    const check = await runQuiet(spawnImpl, resolved.command, [...resolved.args, '--version'], {
      env: runEnv,
    });
    const version = String(check.stdout || '').match(/\d+\.\d+\.\d+[^\s]*/)?.[0] || null;
    if (!check.ok || !version) {
      searched.push(
        `${file} (${source}: --version failed: ${clip(stripAnsi(check.stderr || check.error), 160)})`,
      );
      return null;
    }
    searched.push(`${file} (${source}: ok, ${version})`);
    return { ...resolved, env: resolved.env || {}, version, source, found: file, searched };
  };
  const explicit = [
    [codexPath, 'Settings'],
    [env.GUARD_LAB_CODEX, 'GUARD_LAB_CODEX'],
  ];
  for (const [file, source] of explicit) {
    const result = await attempt(file && path.resolve(String(file)), source);
    if (result) return result;
  }
  for (const dir of pathInfo.dirs)
    for (const name of names) {
      const result = await attempt(path.join(dir, name), 'PATH');
      if (result) return result;
    }
  searched.push(`PATH and common install folders (${pathInfo.dirs.length} folders): no codex`);
  if (systemSearch)
    for (const file of defaultLocations({ platform, env, home }) || []) {
      const result = await attempt(file, 'desktop app');
      if (result) return result;
    }
  if (loginShell && platform !== 'win32') {
    const shell = env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/sh');
    const check = await runQuiet(spawnImpl, shell, ['-ilc', 'command -v codex'], {
      env,
      timeout: 3000,
    });
    const line = String(check.stdout || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith('/'))
      .at(-1);
    if (line) {
      const result = await attempt(line, 'login shell');
      if (result) return result;
    } else searched.push(`${shell} -ilc 'command -v codex' (login shell: no codex)`);
  }
  return { error: 'missing', searched, pathKey: pathInfo.key, pathValue: pathInfo.value };
}

// ---------- fix prompt ----------
function fixPrompt({
  state,
  message,
  error,
  searched = [],
  platform = process.platform,
  arch = process.arch,
  version,
}) {
  const osName = platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : 'Linux';
  const win = platform === 'win32';
  const triple = TRIPLES[`${platform}-${arch}`] || '<target-triple>';
  const nativeHint = win
    ? `%APPDATA%\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-${arch}\\vendor\\${triple}\\bin\\codex.exe`
    : `$(npm prefix -g)/lib/node_modules/@openai/codex/node_modules/@openai/codex-${platform}-${arch}/vendor/${triple}/bin/codex`;
  const desktopHint =
    platform === 'darwin'
      ? 'If the ChatGPT desktop app is installed, its bundled CLI at /Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex also works.'
      : win
        ? 'If the ChatGPT desktop app is installed, it may bundle codex.exe under %LOCALAPPDATA%\\Programs\\ChatGPT; search there if npm is not an option.'
        : '';
  const lines = [
    'Please fix the Codex CLI on this computer so the desktop game Guard Lab can use it. Guard Lab starts `codex app-server` (Codex App Server over stdio) and signs in with ChatGPT. Run the commands yourself, verify each step, and keep my existing Codex configuration and sign-in.',
    '',
    `Problem Guard Lab reported: ${message}`,
    `Error details: ${clip(stripAnsi(error), 1200) || 'none'}`,
    `Operating system: ${osName} (${arch})${version ? `; detected Codex ${version}` : ''}`,
    'Locations Guard Lab searched:',
    ...(searched.length ? searched.slice(0, 25).map((s) => `- ${s}`) : ['- (none)']),
    '',
    'Steps:',
    `1. Confirm the OS and shell, then check for Codex: ${win ? '`where.exe codex`' : '`command -v codex`'} and \`codex --version\`.`,
    `2. If Codex is missing, broken or too old to have \`codex app-server\`, install or update the official CLI with \`npm install -g @openai/codex@latest\` (needs Node.js 22 or newer; install Node.js from https://nodejs.org or the system package manager first if needed)${platform === 'darwin' ? ', or with Homebrew: `brew install --cask codex`' : ''}. ${desktopHint}`.trim(),
    '3. Run `codex login status`. If it is not signed in, run `codex login` and finish the ChatGPT sign-in in the browser.',
    '4. Verify that `codex --version` and `codex app-server --help` both succeed.',
    `5. Print the absolute path of the working native codex executable (resolve symlinks and npm shims; for an npm install it is usually ${nativeHint}). Tell me to paste that path into Guard Lab → Settings → Guard → Advanced → Codex executable.`,
    '',
    'Do not modify Guard Lab files, and never print or share auth tokens or the contents of auth.json.',
  ];
  if (state === 'signed-out')
    lines.splice(
      2,
      0,
      'Codex is installed but not signed in. Usually only step 3 is needed, then press Sign in or Check again in Guard Lab.',
    );
  return lines.join('\n');
}

// ---------- JSON-RPC connection ----------
class Connection {
  constructor({ command, args, env, cwd, spawnImpl, onNotification, onRequest, onExit }) {
    this.pending = new Map();
    this.nextId = 1;
    this.dead = false;
    this.stderr = '';
    this.exited = new Promise((resolve) => (this.resolveExit = resolve));
    this.onNotification = onNotification;
    this.onRequest = onRequest;
    this.onExit = onExit;
    this.child = spawnImpl(command, args, {
      env,
      cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdin.on('error', () => {});
    this.child.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + stripAnsi(chunk)).slice(-6000);
    });
    readline.createInterface({ input: this.child.stdout }).on('line', (line) => this.receive(line));
    this.child.on('error', (error) => this.exit(null, error));
    this.child.on('exit', (code, signal) => this.exit(code, signal ? new Error(signal) : null));
  }
  receive(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!isPlainObject(message)) return;
    if (message.id !== undefined && message.id !== null && !message.method) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error)
        entry.reject(
          new CodexError(String(message.error.message || 'Codex request failed'), {
            code: message.error.code,
            data: message.error.data,
            method: entry.method,
          }),
        );
      else entry.resolve(message.result);
      return;
    }
    if (message.method && message.id !== undefined && message.id !== null) {
      Promise.resolve()
        .then(() => this.onRequest(message))
        .catch((error) =>
          this.respondError(message.id, -32603, error?.message || 'Guard Lab could not answer.'),
        );
      return;
    }
    if (message.method) this.onNotification(message);
  }
  write(payload) {
    if (this.dead) return false;
    try {
      this.child.stdin.write(JSON.stringify(payload) + '\n');
      return true;
    } catch {
      return false;
    }
  }
  request(method, params, timeoutMs = RPC_TIMEOUT_MS) {
    if (this.dead) return Promise.reject(new CodexError('Codex is not running.', { code: 'dead' }));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new CodexError(`Codex did not answer ${method} in time.`, { code: 'timeout', method }),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.write({ id, method, ...(params === undefined ? {} : { params }) });
    });
  }
  notify(method, params) {
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }
  respond(id, result) {
    this.write({ id, result });
  }
  respondError(id, code, message) {
    this.write({ id, error: { code, message } });
  }
  exit(code, error) {
    if (this.dead) return;
    this.dead = true;
    this.exitCode = code;
    const reason = new CodexError(
      'Codex stopped unexpectedly' +
        (code !== null && code !== undefined ? ` (exit ${code})` : '') +
        (error?.message ? `: ${error.message}` : '') +
        '.',
      { code: 'dead', stderr: this.stderr },
    );
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(reason);
    }
    this.pending.clear();
    this.resolveExit(reason);
    this.onExit?.(reason);
  }
  kill() {
    if (this.dead) return;
    this.closing = true;
    try {
      this.child.stdin.end();
    } catch {}
    try {
      this.child.kill();
    } catch {}
  }
}

// ---------- service ----------
function normalizeModels(list) {
  return (Array.isArray(list) ? list : [])
    .filter((m) => m && !m.hidden && (m.id || m.model))
    .map((m) => {
      const efforts = (m.supportedReasoningEfforts || [])
        .map((e) => (typeof e === 'string' ? e : e?.reasoningEffort))
        .filter(Boolean);
      const tiers = [
        ...(m.serviceTiers || []).map((t) => (typeof t === 'string' ? t : t?.id)),
        ...(m.additionalSpeedTiers || []),
      ];
      return {
        id: String(m.id || m.model),
        name: String(m.displayName || m.id || m.model),
        efforts,
        defaultEffort: m.defaultReasoningEffort || efforts[0] || null,
        fast: tiers.includes('priority') || tiers.includes('fast'),
        isDefault: Boolean(m.isDefault),
      };
    });
}

function createCodexService({
  openExternal = async () => {},
  spawnImpl = childProcess.spawn,
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  home = os.homedir(),
  execPath = process.execPath,
  workspace,
  systemSearch = true,
  loginShell = true,
  turnTimeoutMs = TURN_TIMEOUT_MS,
  startTimeoutMs = START_TIMEOUT_MS,
  settleCapMs = SETTLE_CAP_MS,
  warmupTimeoutMs = WARMUP_TIMEOUT_MS,
  retryDelayMs = 400,
  now = () => performance.now(),
} = {}) {
  const listeners = new Set();
  const threads = new Map();
  const locks = new Map();
  // Requests by id (for cancel), and every unfinished request or prepare (for reset).
  const active = new Map();
  const inflight = new Set();
  const cancelledIds = new Map();
  let connection = null;
  let starting = null;
  let binary = null;
  let generation = 0;
  let codexPathHint = '';
  let modelsCache = null;
  // Every MCP server name config/read lists (enabled or not); each thread disables them all.
  let mcpServers = [];
  let knownFeatures = null;
  let optInFeatures = [];
  let launchLevel = 0;
  let launchArgs = [];
  let warnings = [];
  let crashes = [];
  let statusCheck = null;
  let closed = false;
  let login = { state: 'idle' };
  let loginId = null;
  let loginTimer = null;
  let lastStatus = {
    state: 'checking',
    binaryPath: null,
    version: null,
    account: null,
    message: 'Checking Codex',
    fixPrompt: null,
    login: { ...login },
  };

  const workspaceDir = () => {
    let dir = workspace;
    if (!dir) {
      try {
        dir = path.join(require('../shared/runtime.cjs').dataDirectory({ env }), 'codex-workspace');
      } catch {
        dir = path.join(os.tmpdir(), 'guard-lab-codex-workspace');
      }
    }
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch {}
    return dir;
  };

  function publish(status) {
    const next = { ...status, login: { ...login } };
    const changed = JSON.stringify(next) !== JSON.stringify(lastStatus);
    lastStatus = next;
    if (changed)
      for (const listener of listeners)
        try {
          listener(structuredClone(next));
        } catch {}
    return structuredClone(next);
  }
  const setLogin = (value) => {
    login = value;
    publish(lastStatus);
  };

  // --- server → client traffic ---
  function onNotification({ method, params = {} }) {
    if (method === 'account/login/completed') {
      // Ignore completions of logins we cancelled or never started.
      if (!loginId || (params.loginId && loginId !== true && params.loginId !== loginId)) return;
      clearTimeout(loginTimer);
      loginId = null;
      if (params.success) {
        login = { state: 'idle' };
        refreshStatus();
      } else
        setLogin({ state: 'failed', error: clip(params.error || 'Sign-in did not finish.', 200) });
      return;
    }
    if (method === 'account/updated') {
      if (!loginId) refreshStatus();
      return;
    }
    const thread =
      params.threadId && [...threads.values()].find((t) => t.threadId === params.threadId);
    const current = thread?.turn;
    // Ignore events from an earlier turn of the same thread (for example a late warm-up event).
    const turn =
      current && (!params.turnId || !current.id || params.turnId === current.id) ? current : null;
    if (method === 'thread/tokenUsage/updated' && turn) {
      turn.usage = params.tokenUsage?.last || null;
      // Codex reports a tool call's usage just after the decision has been returned, so it is
      // attached to this actor's next decision instead.
      if (turn.accepted && !turn.usageNoted && isPlainObject(turn.usage)) {
        turn.usageNoted = true;
        thread.previousUsage = Object.fromEntries(
          Object.entries(turn.usage).filter(([, value]) => Number.isFinite(value)),
        );
      }
      turn.onEvent?.('usage');
    } else if (method === 'thread/settings/updated' && thread)
      thread.reportedTier = params.threadSettings?.serviceTier ?? thread.reportedTier;
    else if (method === 'error' && turn && !params.willRetry) turn.error = params.error;
    else if (method === 'item/started' && turn) turn.onEvent?.('item', params.item?.type);
    else if (method === 'item/completed' && turn) {
      const item = params.item || {};
      if (item.type === 'agentMessage' && typeof item.text === 'string') turn.text = item.text;
    } else if (method === 'turn/completed' && thread) {
      const completed = params.turn || {};
      if (turn && (!turn.id || !completed.id || completed.id === turn.id)) turn.complete(completed);
      else if (!current) thread.idleResolve?.();
    }
  }
  async function onRequest(message) {
    const { id, method, params = {} } = message;
    const conn = this;
    if (method === 'item/tool/call') return handleToolCall(conn, id, params);
    if (
      method === 'item/commandExecution/requestApproval' ||
      method === 'item/fileChange/requestApproval'
    )
      return conn.respond(id, { decision: 'decline' });
    if (method === 'execCommandApproval' || method === 'applyPatchApproval')
      return conn.respond(id, {
        decision: { denied: { rejection: 'Guard Lab does not allow this.' } },
      });
    if (method === 'item/permissions/requestApproval')
      return conn.respond(id, { permissions: {}, scope: 'turn' });
    if (method === 'mcpServer/elicitation/request')
      return conn.respond(id, { action: 'decline', content: null, _meta: null });
    if (method === 'currentTime/read')
      return conn.respond(id, { currentTimeAt: Math.floor(Date.now() / 1000) });
    return conn.respondError(id, -32601, `Guard Lab does not support ${method}.`);
  }
  function handleToolCall(conn, id, params) {
    const thread = [...threads.values()].find((t) => t.threadId === params.threadId);
    const turn = thread?.turn;
    const reply = (text, success) =>
      conn.respond(id, { contentItems: [{ type: 'inputText', text }], success });
    if (turn?.accepted) return reply('Not executed: you already acted this round.', false);
    if (!turn || turn.done || turn.warmup)
      return reply('No Guard Lab decision is pending. Wait for the next observation.', false);
    const name = String(params.tool || '');
    const available = turn.tools;
    const tool = available.find((t) => toolName(t) === name);
    const args = parseArguments(params.arguments);
    const names = available.map(toolName).join(', ') || 'none';
    const reason = !tool
      ? `"${name}" is not available right now`
      : validateArguments(tool.function?.parameters || tool.inputSchema, args);
    if (reason) {
      turn.invalid += 1;
      if (turn.invalid >= MAX_INVALID_CALLS) {
        reply(`Rejected: ${reason}. Your turn has been resolved for you.`, false);
        return turn.fallback(`Codex made ${turn.invalid} invalid tool calls (last: ${reason}).`);
      }
      return reply(
        `Rejected: ${reason}. Nothing happened. Available tools: ${names}. Call exactly one with valid arguments.`,
        false,
      );
    }
    reply(SUBMITTED, true);
    turn.accept({
      id: String(params.callId || `codex-${crypto.randomUUID()}`),
      name,
      args,
      requestId: id,
    });
  }

  // --- process lifecycle ---
  function onExit(conn, reason) {
    for (const thread of threads.values())
      if (thread.generation === conn.generation) {
        thread.dead = true;
        thread.turn?.crash(reason);
      }
    if (connection !== conn) return;
    connection = null;
    if (conn.closing || closed) return;
    crashes = [...crashes.filter((t) => Date.now() - t < 60000), Date.now()];
    if (loginId) {
      loginId = null;
      clearTimeout(loginTimer);
      login = { state: 'failed', error: 'Codex stopped during sign-in.' };
    }
    if (crashes.length >= 3)
      publish(
        errorStatus(
          'Codex keeps stopping unexpectedly.',
          (reason.stderr || reason.message || '').slice(-1500),
        ),
      );
    else setTimeout(() => !closed && refreshStatus(), 250);
  }
  function errorStatus(message, error) {
    return {
      state: 'error',
      binaryPath: binary?.path || null,
      version: binary?.version || null,
      account: null,
      message,
      fixPrompt: fixPrompt({
        state: 'error',
        message,
        error,
        searched: binary?.searched || [],
        platform,
        arch,
        version: binary?.version,
      }),
      warnings,
    };
  }
  async function discover({ refresh, codexPath } = {}) {
    if (codexPath !== undefined && codexPath !== null) {
      const hint = String(codexPath || '').trim();
      if (hint !== codexPathHint) {
        codexPathHint = hint;
        binary = null;
      }
    }
    if (binary && !refresh) return binary;
    const found = await findCodex({
      codexPath: codexPathHint,
      env,
      platform,
      arch,
      home,
      execPath,
      spawnImpl,
      systemSearch,
      loginShell,
    });
    if (found.error) {
      binary = null;
      throw new CodexError('Codex is not installed.', {
        kind: 'missing',
        searched: found.searched,
      });
    }
    if (!binary || binary.path !== found.path || binary.version !== found.version) launchLevel = 0;
    binary = found;
    return binary;
  }
  function noteMcpServers(config) {
    const servers = config?.config?.mcp_servers;
    if (!isPlainObject(servers)) return;
    const names = Object.keys(servers);
    const odd = names.filter((name) => !BARE_KEY.test(name));
    if (odd.length)
      warnings = [
        ...new Set([
          ...warnings,
          `Guard Lab cannot turn off MCP server ${odd.map((n) => JSON.stringify(n)).join(', ')} for its threads.`,
        ]),
      ];
    mcpServers = names.filter((name) => BARE_KEY.test(name));
  }
  function startProcess(bin, args, childEnv, cwd) {
    const conn = new Connection({
      command: bin.command,
      args,
      env: childEnv,
      cwd,
      spawnImpl,
      onNotification: (message) => connection === conn && onNotification(message),
      onRequest: (message) => onRequest.call(conn, message),
      onExit: (reason) => onExit(conn, reason),
    });
    const exited = conn.exited.then((reason) => {
      throw new CodexError('Codex App Server exited during startup.', {
        stderr: conn.stderr || reason?.stderr,
      });
    });
    exited.catch(() => {});
    return Promise.race([
      conn.request(
        'initialize',
        {
          clientInfo: { name: 'guard-lab', title: 'Guard Lab', version: VERSION },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
            optOutNotificationMethods: OPT_OUT_NOTIFICATIONS,
          },
        },
        startTimeoutMs,
      ),
      exited,
    ]).then(
      (init) => {
        conn.notify('initialized', {});
        conn.info = init || {};
        conn.args = args;
        return conn;
      },
      (error) => {
        conn.kill();
        error.stderr = error.stderr || conn.stderr || '';
        throw error;
      },
    );
  }
  async function launch(bin) {
    const pathInfo = augmentedPath({ platform, env, home, extras: systemSearch });
    const childEnv = { ...env, [pathInfo.key]: pathInfo.value, ...bin.env };
    if (bin.kind !== 'node') delete childEnv.ELECTRON_RUN_AS_NODE;
    const cwd = workspaceDir();
    let lastError;
    for (let level = launchLevel; level < LAUNCH_LEVELS.length; level++) {
      const args = [...bin.args, 'app-server', ...LAUNCH_LEVELS[level].args];
      let conn;
      try {
        conn = await startProcess(bin, args, childEnv, cwd);
      } catch (error) {
        lastError = error;
        continue;
      }
      warnings =
        level > 0
          ? [
              `Codex rejected some isolation flags, so it started with "${LAUNCH_LEVELS[level].name}" settings. Per-thread isolation still applies.`,
            ]
          : [];
      launchLevel = level;
      mcpServers = [];
      const [config, features] = await Promise.all([
        conn.request('config/read', {}, 10000).catch(() => null),
        conn.request('experimentalFeature/list', { limit: 500 }, 10000).catch(() => null),
      ]);
      noteMcpServers(config);
      const list = Array.isArray(features?.data) ? features.data : null;
      knownFeatures = list ? new Set(list.map((f) => f?.name).filter(Boolean)) : null;
      optInFeatures = userOptInFeatures(list);
      // Defense in depth: relaunch with the user's enabled MCP servers and opt-in features
      // switched off for the whole process, using names this Codex just reported (an unknown
      // MCP server name in a launch flag is fatal). Per-thread config disables them too.
      const servers = config?.config?.mcp_servers || {};
      const enabledServers = mcpServers.filter(
        (name) => !isPlainObject(servers[name]) || servers[name].enabled !== false,
      );
      const overrides = [
        ...enabledServers.flatMap((name) => ['-c', `mcp_servers.${name}.enabled=false`]),
        ...optInFeatures.flatMap((name) => ['-c', `features.${name}=false`]),
      ];
      launchArgs = args;
      if (!overrides.length) return conn;
      try {
        const hardened = await startProcess(bin, [...args, ...overrides], childEnv, cwd);
        conn.kill();
        launchArgs = hardened.args;
        return hardened;
      } catch {
        warnings = [
          ...warnings,
          'Codex rejected the launch flags that turn off MCP servers; per-thread isolation still turns them off.',
        ];
        return conn;
      }
    }
    throw new CodexError('Codex App Server could not start.', {
      kind: 'error',
      detail: clip(`${lastError?.message || ''}\n${lastError?.stderr || ''}`, 1500),
    });
  }
  async function ensureConnection({ refresh = false, codexPath } = {}) {
    if (closed) throw new CodexError('Codex service is closed.');
    if (refresh || codexPath !== undefined || !binary) await discover({ refresh, codexPath });
    if (connection && !connection.dead && connection.binaryPath === binary.path) return connection;
    if (!starting)
      starting = (async () => {
        const bin = binary || (await discover({}));
        if (connection) {
          connection.kill();
          connection = null;
        }
        const conn = await launch(bin);
        if (closed) {
          conn.kill();
          throw new CodexError('Codex service is closed.');
        }
        generation += 1;
        conn.generation = generation;
        conn.binaryPath = bin.path;
        connection = conn;
        return conn;
      })().finally(() => {
        starting = null;
      });
    return starting;
  }

  // --- status / login / models ---
  async function checkStatus(options = {}) {
    if (statusCheck)
      return options.refreshToken ? statusCheck.then(() => checkStatus(options)) : statusCheck;
    options = { ...options };
    // An explicit "Check again" or a failed decision asks Codex to refresh the sign-in, so an
    // expired or revoked ChatGPT session shows as signed out instead of a cached account.
    const refreshToken = Boolean(options.refresh || options.refreshToken);
    if (lastStatus.state === 'missing' || lastStatus.state === 'error') options.refresh = true;
    if (lastStatus.state !== 'ready')
      publish({ ...lastStatus, state: 'checking', message: 'Checking Codex' });
    statusCheck = (async () => {
      try {
        const conn = await ensureConnection(options);
        const result = await readAccount(conn, refreshToken);
        const account = isPlainObject(result?.account)
          ? {
              type: result.account.type,
              email: result.account.email ?? null,
              plan: result.account.planType ?? null,
            }
          : null;
        const version = binary?.version || null;
        const base = {
          binaryPath: binary?.path || null,
          version,
          account,
          warnings,
        };
        if (!account && result?.requiresOpenaiAuth !== false) {
          const message = 'Sign in with ChatGPT to use Codex.';
          return publish({
            ...base,
            state: 'signed-out',
            message,
            fixPrompt: fixPrompt({
              state: 'signed-out',
              message,
              error: '',
              searched: binary?.searched,
              platform,
              arch,
              version,
            }),
          });
        }
        const how =
          account?.type === 'chatgpt'
            ? 'signed in with ChatGPT'
            : account?.type === 'apiKey'
              ? 'using an API key'
              : account?.type === 'amazonBedrock'
                ? 'using Amazon Bedrock'
                : 'using a custom provider';
        return publish({
          ...base,
          state: 'ready',
          message: `Codex ${shortVersion(version)} · ${how}`,
          fixPrompt: null,
        });
      } catch (error) {
        if (error.kind === 'missing') {
          const message = "Codex isn't installed or couldn't be found.";
          return publish({
            state: 'missing',
            binaryPath: null,
            version: null,
            account: null,
            message,
            fixPrompt: fixPrompt({
              state: 'missing',
              message,
              error: 'codex executable not found',
              searched: error.searched,
              platform,
              arch,
            }),
            warnings,
          });
        }
        return publish(
          errorStatus(
            error.kind === 'error'
              ? "Codex is installed but its App Server won't start."
              : friendlyError(error),
            error.detail || error.stderr || error.message,
          ),
        );
      }
    })().finally(() => {
      statusCheck = null;
    });
    return statusCheck;
  }
  async function readAccount(conn, refreshToken) {
    if (!refreshToken) return conn.request('account/read', { refreshToken: false }, 15000);
    try {
      return await conn.request('account/read', { refreshToken: true }, 15000);
    } catch (error) {
      if (error.code === 'dead') throw error;
      // A rejected refresh means the session is gone; anything else (offline) keeps the cache.
      if (friendlyError(error).startsWith('Codex sign-in expired'))
        return { account: null, requiresOpenaiAuth: true };
      return conn.request('account/read', { refreshToken: false }, 15000);
    }
  }
  function refreshStatus(options = {}) {
    return checkStatus(options).catch(() => {});
  }
  async function status(options = {}) {
    const { refresh = false, codexPath } = options || {};
    if (!refresh && codexPath === undefined && lastStatus.state !== 'checking' && !statusCheck)
      return structuredClone(lastStatus);
    return checkStatus({ refresh, codexPath });
  }
  async function startLogin(options = {}) {
    const conn = await ensureConnection(options || {});
    if (loginId) await cancelLogin();
    const result = await conn.request('account/login/start', { type: 'chatgpt' }, 20000);
    let url;
    try {
      url = new URL(String(result?.authUrl || ''));
    } catch {}
    if (!url || url.protocol !== 'https:') {
      setLogin({ state: 'failed', error: 'Codex returned an unexpected sign-in link.' });
      throw new CodexError('Codex returned an unexpected sign-in link.');
    }
    loginId = result.loginId || true;
    clearTimeout(loginTimer);
    loginTimer = setTimeout(() => {
      cancelLogin().then(() => setLogin({ state: 'failed', error: 'Sign-in timed out.' }));
    }, LOGIN_TIMEOUT_MS);
    setLogin({ state: 'pending' });
    try {
      await openExternal(url.toString());
    } catch (error) {
      setLogin({
        state: 'failed',
        error: 'Could not open the browser: ' + clip(error.message, 120),
      });
      throw error;
    }
    return { started: true };
  }
  async function cancelLogin() {
    clearTimeout(loginTimer);
    const id = loginId;
    loginId = null;
    if (typeof id === 'string' && connection && !connection.dead)
      await connection.request('account/login/cancel', { loginId: id }, 5000).catch(() => {});
    setLogin({ state: 'idle' });
    return { cancelled: Boolean(id) };
  }
  async function models(options = {}) {
    const { refresh = false, codexPath } = options || {};
    if (modelsCache && !refresh && codexPath === undefined) return structuredClone(modelsCache);
    const conn = await ensureConnection({ codexPath });
    const all = [];
    let cursor = null;
    try {
      for (let page = 0; page < 10; page++) {
        const result = await conn.request(
          'model/list',
          { includeHidden: false, ...(cursor ? { cursor } : {}) },
          20000,
        );
        all.push(...(result?.data || []));
        cursor = result?.nextCursor || null;
        if (!cursor) break;
      }
    } catch (error) {
      throw new CodexError(friendlyError(error));
    }
    modelsCache = normalizeModels(all);
    return structuredClone(modelsCache);
  }

  // --- threads and turns ---
  function chooseSettings(settings) {
    const merged = { ...DEFAULT_SETTINGS, ...(isPlainObject(settings) ? settings : {}) };
    const model = String(merged.model || DEFAULT_SETTINGS.model);
    const known = modelsCache?.find((m) => m.id === model);
    let effort = String(merged.effort || DEFAULT_SETTINGS.effort);
    if (known?.efforts?.length && !known.efforts.includes(effort))
      effort = known.defaultEffort || known.efforts[0];
    const fast = merged.fast !== false && (!known || known.fast);
    return {
      model,
      effort,
      serviceTier: fast ? 'priority' : 'default',
      codexPath: merged.codexPath,
      requested: merged,
    };
  }
  // Per-thread overrides keep the actor inside the game even when process flags were rejected.
  // MCP servers are always turned off; other keys are dropped only when Codex rejects them.
  function threadConfig({ dropped = new Set(), features = true, isolation = true } = {}) {
    const config = {};
    for (const name of mcpServers) config[`mcp_servers.${name}.enabled`] = false;
    if (isolation) Object.assign(config, ISOLATION_CONFIG);
    if (features) {
      for (const feature of [...ISOLATION_FEATURES, ...THREAD_ISOLATION_FEATURES])
        if (!knownFeatures || knownFeatures.has(feature)) config[`features.${feature}`] = false;
      for (const feature of optInFeatures) config[`features.${feature}`] = false;
    }
    for (const key of Object.keys(config))
      if (
        !key.startsWith('mcp_servers.') &&
        [...dropped].some((d) => key === d || key.startsWith(d + '.'))
      )
        delete config[key];
    return config;
  }
  async function refreshMcpServers(conn) {
    const config = await conn.request('config/read', {}, 10000).catch(() => null);
    if (config) noteMcpServers(config);
  }
  async function startThread(conn, { system, dynamicTools, chosen }) {
    // Re-read the user's MCP servers so ones added since launch are turned off as well.
    await refreshMcpServers(conn);
    const base = {
      model: chosen.model,
      serviceTier: chosen.serviceTier,
      cwd: workspaceDir(),
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ephemeral: true,
      // Never omitted: an empty list keeps the thread away from any execution environment.
      environments: [],
      dynamicTools,
      baseInstructions: system + INTERFACE_NOTE,
    };
    const dropped = new Set();
    let features = true;
    let isolation = true;
    let personality = true;
    let rereadMcp = false;
    let transient = 0;
    let rejected = null;
    let lastError;
    for (let attempt = 0; attempt < 16; attempt++) {
      const config = threadConfig({ dropped, features, isolation });
      const params = { ...base, ...(personality ? { personality: 'none' } : {}), config };
      try {
        const result = await conn.request('thread/start', params, 30000);
        if (!result?.thread?.id) throw new CodexError('Codex did not create a thread.');
        const relaxed = [
          ...dropped,
          ...(features ? [] : ['features']),
          ...(isolation ? [] : ['instruction settings']),
          ...(personality ? [] : ['personality']),
        ];
        if (relaxed.length)
          warnings = [
            ...new Set([
              ...warnings,
              `Codex rejected part of the per-thread isolation config (${relaxed.join(', ')}); MCP servers stay off.`,
            ]),
          ];
        return { threadId: result.thread.id, reportedTier: result.serviceTier ?? null };
      } catch (error) {
        lastError = error;
        rejected = null;
        if (
          error.code === 'dead' ||
          error.code === 'timeout' ||
          friendlyError(error).startsWith('Model ')
        )
          break;
        // Busy servers: retry the same, fully isolated request.
        if (isTransient(error)) {
          if (transient >= 3) break;
          await delay(retryDelayMs * 2 ** transient++);
          continue;
        }
        // Only invalid-request errors can mean a config key this Codex does not accept.
        if (error.code !== -32600 && error.code !== -32602) break;
        const text = String(error.message || '');
        const key = text.match(/in `([^`]+)`/)?.[1] || '';
        rejected = key.startsWith('mcp_servers') ? 'mcp' : 'isolation';
        if (rejected === 'mcp') {
          // A server removed since config/read: read again once, never start without the keys.
          if (rereadMcp) break;
          rereadMcp = true;
          await refreshMcpServers(conn);
          continue;
        }
        if (personality && /personality|unknown variant `none`/i.test(text)) {
          personality = false;
          continue;
        }
        if (
          key &&
          !dropped.has(key) &&
          Object.keys(config).some((k) => k === key || k.startsWith(key + '.'))
        ) {
          dropped.add(key);
          continue;
        }
        if (features) features = false;
        else if (isolation) isolation = false;
        else if (personality) personality = false;
        else break;
      }
    }
    if (rejected)
      throw new CodexError(
        (rejected === 'mcp'
          ? 'Codex could not turn off your MCP servers for the game: '
          : 'Codex rejected the settings that keep the game isolated: ') +
          clip(stripAnsi(lastError?.message), 200),
        { code: lastError?.code },
      );
    throw new CodexError(friendlyError(lastError, { model: chosen.model }), {
      code: lastError?.code,
    });
  }
  function lock(key, task) {
    const previous = locks.get(key) || Promise.resolve();
    const run = previous.catch(() => {}).then(task);
    const tail = run.catch(() => {});
    locks.set(key, tail);
    tail.then(() => locks.get(key) === tail && locks.delete(key));
    return run;
  }
  async function ensureThread({ key, system, allTools, tools, chosen, sessionId, actor, record }) {
    const conn = await ensureConnection({ codexPath: chosen.codexPath });
    const existing = threads.get(key);
    // The thread is tied to the system prompt and the declared tool set (allTools).
    const declared = toDynamicTools(allTools);
    const signature = crypto
      .createHash('sha256')
      .update(String(system))
      .update(JSON.stringify(declared))
      .digest('hex');
    const sameContext = existing && existing.signature === signature;
    const names = new Set((existing?.dynamicTools || []).map((t) => t.name));
    const missing = (tools || []).some((t) => !names.has(toolName(t)));
    if (sameContext && !missing && !existing.dead && existing.generation === conn.generation)
      return existing;
    if (existing && !existing.dead && existing.generation === conn.generation)
      conn.request('thread/unsubscribe', { threadId: existing.threadId }, 5000).catch(() => {});
    const dynamicTools = toDynamicTools(declared, tools, sameContext ? existing.dynamicTools : []);
    if (!modelsCache) {
      await models().catch(() => {});
      Object.assign(chosen, chooseSettings(chosen.requested));
    }
    const started = await startThread(conn, { system, dynamicTools, chosen });
    // The encounter was reset while its thread was starting: nothing will reset it again.
    if (record?.reset) {
      conn.request('thread/unsubscribe', { threadId: started.threadId }, 5000).catch(() => {});
      throw cancelledError();
    }
    const thread = {
      key,
      sessionId,
      actor,
      system,
      signature,
      dynamicTools,
      generation: conn.generation,
      threadId: started.threadId,
      reportedTier: started.reportedTier,
      turns: 0,
      lastSent: null,
      idle: Promise.resolve(),
      // A fresh thread replacing an earlier one replays the conversation so far.
      recap: Boolean(existing),
    };
    threads.set(key, thread);
    return thread;
  }
  function fallbackTool(actor, tools) {
    const names = tools.map(toolName);
    const preferred = actor === 'human' ? ['wait', 'hold_position'] : ['hold_position', 'wait'];
    return preferred.find((name) => names.includes(name)) || null;
  }
  async function runTurn(request, thread, conn, chosen, record) {
    const tools = Array.isArray(request.tools) ? request.tools : [];
    const toolNames = tools.map(toolName).filter(Boolean);
    const input = formatTurnInput(request.messages, {
      toolNames,
      recap: thread.recap && thread.turns === 0,
      lastSent: thread.lastSent,
    });
    await withTimeout(thread.idle, 10000, 'previous turn did not finish').catch(() => {});
    let idleResolve;
    thread.idle = new Promise((resolve) => (idleResolve = resolve));
    thread.idleResolve = idleResolve;
    return new Promise((resolve, reject) => {
      let timer;
      const turn = {
        id: null,
        tools,
        invalid: 0,
        accepted: null,
        done: false,
        text: null,
        usage: null,
        error: null,
        settled: false,
        onEvent: null,
      };
      const finish = (error, value) => {
        if (turn.done) return;
        turn.done = true;
        clearTimeout(timer);
        record.turn = null;
        if (error) reject(error);
        else resolve(value);
      };
      const interrupt = () => {
        if (!turn.id || turn.interrupted) return;
        turn.interrupted = true;
        conn
          .request('turn/interrupt', { threadId: thread.threadId, turnId: turn.id }, 10000)
          .catch(() => {});
      };
      // `fallback` marks an action Guard Lab chose because the model gave none it could use.
      const resolveCall = (call, fallback) =>
        finish(null, {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.args) },
              },
            ],
          },
          usage: turn.usage,
          timing: timing(fallback),
        });
      const timing = (fallback) => {
        const value = {
          decisionMs: Math.round(now() - record.started),
          model: chosen.model,
          effort: chosen.effort,
          serviceTier: chosen.serviceTier,
          reportedServiceTier: thread.reportedTier ?? null,
          ...(thread.previousUsage ? { previousUsage: thread.previousUsage } : {}),
          ...(fallback ? { fallback: fallback.kind, fallbackDetail: fallback.detail } : {}),
        };
        thread.previousUsage = null;
        return value;
      };
      // The decision is already resolved; stop Codex's follow-up sampling only once it has
      // recorded the code-mode exec output (signalled by the token usage update), or once the
      // model starts writing again. Interrupting earlier aborts the exec and the model's own
      // history then says its action was cancelled.
      const stop = () => {
        if (turn.settled) return;
        turn.settled = true;
        clearTimeout(turn.cap);
        interrupt();
      };
      const stopWhenSettled = () => {
        turn.onEvent = (kind, type) => {
          if (kind === 'usage' || (type && type !== 'dynamicToolCall' && type !== 'userMessage'))
            stop();
        };
        turn.cap = setTimeout(stop, settleCapMs);
      };
      turn.accept = (call) => {
        turn.accepted = call;
        thread.lastSent = input.lastSent;
        resolveCall(call);
        stopWhenSettled();
      };
      turn.fallback = (reason) => {
        const name = fallbackTool(request.actor, tools);
        if (!name) {
          finish(new CodexError(`${reason} No fallback action was available.`));
          interrupt();
          return;
        }
        turn.accepted = { id: `codex-fallback-${crypto.randomUUID()}`, name, args: {} };
        thread.lastSent = input.lastSent;
        resolveCall(turn.accepted, { kind: 'invalid_calls', detail: reason });
        stopWhenSettled();
      };
      turn.complete = (completed) => {
        thread.turn = null;
        clearTimeout(turn.cap);
        idleResolve();
        if (turn.accepted || turn.done) return finish();
        thread.lastSent = input.lastSent;
        if (record.cancelled) return finish(cancelledError());
        if (completed.status === 'failed' || turn.error)
          return finish(
            new CodexError(friendlyError(completed.error || turn.error, { model: chosen.model })),
          );
        if (completed.status === 'interrupted')
          return finish(new CodexError('Codex stopped before choosing an action.'));
        const text = typeof turn.text === 'string' ? turn.text.trim() : '';
        if (text)
          return finish(null, {
            message: { role: 'assistant', content: text },
            usage: turn.usage,
            timing: timing(),
          });
        const name = fallbackTool(request.actor, tools);
        if (name)
          return resolveCall(
            { id: `codex-fallback-${crypto.randomUUID()}`, name, args: {} },
            { kind: 'no_action', detail: 'Codex finished its turn without a tool call or text.' },
          );
        return finish(new CodexError('Codex finished without choosing an action.'));
      };
      turn.crash = (reason) => {
        thread.turn = null;
        clearTimeout(turn.cap);
        idleResolve();
        finish(reason);
      };
      turn.cancel = () => {
        interrupt();
        finish(cancelledError());
        setTimeout(() => thread.turn === turn && turn.complete({ status: 'interrupted' }), 5000);
      };
      // reset(): the thread is being dropped, and its notifications (including the settle signal
      // of a decision that is already resolved) stop with the unsubscribe. Stop Codex now.
      turn.drop = () => {
        stop();
        turn.crash(cancelledError());
      };
      record.turn = turn;
      thread.turn = turn;
      timer = setTimeout(() => {
        interrupt();
        finish(
          new CodexError(
            `Codex took longer than ${Math.round(turnTimeoutMs / 1000)} seconds to decide. Try again, or pick a faster model or lower reasoning effort in Settings.`,
            { code: 'timeout' },
          ),
        );
        setTimeout(() => thread.turn === turn && turn.complete({ status: 'interrupted' }), 5000);
      }, turnTimeoutMs);
      const params = {
        threadId: thread.threadId,
        input: [{ type: 'text', text: input.text, text_elements: [] }],
        model: chosen.model,
        effort: chosen.effort,
        serviceTier: chosen.serviceTier,
        summary: 'none',
      };
      conn
        .request('turn/start', params, 30000)
        .catch((error) => {
          if (error.code === 'dead' || turn.done) throw error;
          const { summary, ...minimal } = params;
          return conn.request('turn/start', minimal, 30000);
        })
        .then((result) => {
          turn.id = result?.turn?.id || null;
          thread.turns += 1;
          // A cancel, timeout or settled decision can land before turn/start answers.
          if (record.cancelled || turn.settled || (turn.done && !turn.accepted)) interrupt();
        })
        .catch((error) => {
          thread.turn = null;
          idleResolve();
          finish(
            error.code === 'dead'
              ? error
              : new CodexError(friendlyError(error, { model: chosen.model })),
          );
        });
    });
  }
  async function request(data = {}) {
    const {
      id,
      sessionId = 'default',
      actor = 'robot',
      messages,
      tools = [],
      allTools = [],
      settings,
    } = data || {};
    if (!Array.isArray(messages) || !messages.length)
      throw new CodexError('Codex request needs messages.');
    if (id !== undefined && cancelledIds.delete(id)) throw cancelledError();
    const key = `${sessionId}\u0000${actor}`;
    const record = { id, key, started: now(), cancelled: false, reset: false, turn: null };
    if (id !== undefined) active.set(id, record);
    inflight.add(record);
    try {
      return await lock(key, async () => {
        for (let attempt = 0; ; attempt++) {
          if (record.cancelled) throw cancelledError();
          const chosen = chooseSettings(settings);
          let conn, thread;
          try {
            thread = await ensureThread({
              key,
              system: contentText(messages[0]),
              allTools,
              tools,
              chosen,
              sessionId,
              actor,
              record,
            });
            conn = connection;
            if (!conn || conn.generation !== thread.generation)
              throw new CodexError('Codex restarted.', { code: 'dead' });
            if (record.cancelled) throw cancelledError();
            return await runTurn({ messages, tools, actor }, thread, conn, chosen, record);
          } catch (error) {
            // A crashed App Server restarts transparently: retry once on a fresh process/thread.
            if (error.code === 'dead' && attempt === 0 && !record.cancelled && !closed) continue;
            if (error.code === 'dead')
              throw new CodexError(
                friendlyError(error) + ' Guard Lab restarts it on the next decision.',
              );
            if (/sign-in expired/.test(error.message)) refreshStatus({ refreshToken: true });
            throw error;
          }
        }
      });
    } finally {
      inflight.delete(record);
      if (id !== undefined && active.get(id) === record) active.delete(id);
    }
  }
  async function prepare(data = {}) {
    const { sessionId = 'default', actor = 'robot', system, allTools = [], settings } = data || {};
    const key = `${sessionId}\u0000${actor}`;
    const chosen = chooseSettings(settings);
    const record = { key, cancelled: false, reset: false, turn: null };
    inflight.add(record);
    try {
      await lock(key, async () => {
        if (record.cancelled) return;
        const thread = await ensureThread({
          key,
          system: String(system || ''),
          allTools,
          tools: [],
          chosen,
          sessionId,
          actor,
          record,
        });
        if (!record.cancelled) await warmUp(thread, chosen);
      });
    } catch (error) {
      if (error.code !== 'cancelled') throw error;
    } finally {
      inflight.delete(record);
    }
    // A reset during prepare() is normal (the player left); it is not an error.
    return record.cancelled ? { ok: false, cancelled: true } : { ok: true };
  }
  /**
   * Codex sets up a thread's session lazily on its first turn (1-2 s before the model is even
   * called). A warm-up turn pays that cost during prepare(): it is interrupted as soon as Codex
   * records its message, before the model answers, so it costs no model output.
   */
  async function warmUp(thread, chosen) {
    const conn = connection;
    if (thread.warmed || thread.turns > 0 || thread.turn || !conn || conn.dead) return;
    if (conn.generation !== thread.generation) return;
    thread.warmed = true;
    await withTimeout(thread.idle, 5000, 'previous turn did not finish').catch(() => {});
    let idleResolve;
    thread.idle = new Promise((resolve) => (idleResolve = resolve));
    thread.idleResolve = idleResolve;
    await new Promise((resolve) => {
      let timer;
      const turn = { id: null, warmup: true, tools: [], done: false, settled: false };
      const finish = () => {
        if (turn.done) return;
        turn.done = true;
        clearTimeout(timer);
        resolve();
      };
      const interrupt = () => {
        turn.settled = true;
        if (!turn.id || turn.interrupted) return;
        turn.interrupted = true;
        conn
          .request('turn/interrupt', { threadId: thread.threadId, turnId: turn.id }, 10000)
          .catch(() => {});
      };
      turn.onEvent = (kind, type) => kind === 'item' && type === 'userMessage' && interrupt();
      turn.complete = () => {
        thread.turn = null;
        idleResolve();
        finish();
      };
      turn.crash = turn.complete;
      // reset() during a warm-up: stop it now rather than leave a turn running in Codex.
      turn.cancel = () => {
        interrupt();
        turn.complete();
      };
      turn.drop = turn.cancel;
      thread.turn = turn;
      timer = setTimeout(() => {
        interrupt();
        // Give Codex a moment to confirm, then let the encounter continue regardless.
        setTimeout(() => thread.turn === turn && turn.complete(), 3000);
      }, warmupTimeoutMs);
      conn
        .request(
          'turn/start',
          {
            threadId: thread.threadId,
            input: [{ type: 'text', text: WARMUP_TEXT, text_elements: [] }],
            model: chosen.model,
            effort: chosen.effort,
            serviceTier: chosen.serviceTier,
            summary: 'none',
          },
          30000,
        )
        .then((result) => {
          turn.id = result?.turn?.id || null;
          if (turn.settled) interrupt();
        })
        .catch(() => thread.turn === turn && turn.complete());
    });
  }
  async function cancel(id) {
    const record = active.get(id);
    if (!record) {
      // The request may still be on its way (the renderer waits for prepare() first).
      if (id !== undefined && id !== null) {
        const time = Date.now();
        for (const [old, at] of cancelledIds)
          if (time - at > CANCEL_MEMORY_MS) cancelledIds.delete(old);
        cancelledIds.set(id, time);
      }
      return { cancelled: false };
    }
    record.cancelled = true;
    record.turn?.cancel();
    return { cancelled: true };
  }
  async function reset(sessionId) {
    const all = sessionId === undefined || sessionId === null;
    for (const record of inflight)
      if (all || record.key.startsWith(`${sessionId}\u0000`)) {
        record.cancelled = true;
        record.reset = true;
        record.turn?.cancel();
      }
    for (const [key, thread] of threads)
      if (all || thread.sessionId === sessionId) {
        // Also stops a resolved decision that Codex is still settling, before the unsubscribe.
        thread.turn?.drop();
        threads.delete(key);
        if (connection && !connection.dead && thread.generation === connection.generation)
          connection
            .request('thread/unsubscribe', { threadId: thread.threadId }, 5000)
            .catch(() => {});
      }
    return { ok: true };
  }
  function onStatus(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
  function close() {
    closed = true;
    clearTimeout(loginTimer);
    // The process is about to stop, so end every turn here (and its timers) without interrupts.
    for (const record of inflight) {
      record.cancelled = true;
      record.turn?.crash(cancelledError());
    }
    for (const thread of threads.values()) thread.turn?.crash(cancelledError());
    threads.clear();
    connection?.kill();
    connection = null;
  }
  return {
    status,
    login: startLogin,
    cancelLogin,
    models,
    prepare,
    request,
    cancel,
    reset,
    onStatus,
    close,
    // Diagnostics for tests and the doctor script.
    _debug: () => ({
      pid: connection?.child?.pid ?? null,
      generation,
      launchLevel,
      launchArgs: [...launchArgs],
      mcpServers: [...mcpServers],
      optInFeatures: [...optInFeatures],
      threads: [...threads.values()].map((t) => ({
        key: t.key,
        threadId: t.threadId,
        turns: t.turns,
      })),
      binary: binary && { path: binary.path, kind: binary.kind, version: binary.version },
      warnings: [...warnings],
    }),
    _kill: () => connection?.child?.kill(),
  };
}

function registerCodex({ ipcMain, getWindow, shell, serviceOptions } = {}) {
  const opener = shell || require('electron').shell;
  const service = createCodexService({
    ...serviceOptions,
    openExternal: (url) => {
      if (!/^https:\/\//i.test(url)) throw new Error('Refusing to open a non-https sign-in link.');
      return opener.openExternal(url);
    },
  });
  service.onStatus((status) => {
    const window = getWindow?.();
    if (window && !window.isDestroyed()) window.webContents.send('codex:status', status);
  });
  ipcMain.handle('codex:status', (_, options) => service.status(options || {}));
  ipcMain.handle('codex:login', (_, options) => service.login(options || {}));
  ipcMain.handle('codex:cancel-login', () => service.cancelLogin());
  ipcMain.handle('codex:models', (_, options) => service.models(options || {}));
  ipcMain.handle('codex:prepare', (_, data) => service.prepare(data || {}));
  // Pausing, restarting or quitting cancels requests all the time; answer that as a value so
  // Electron does not log it as a failed handler. src/ui/requests.mjs turns it back into an error.
  ipcMain.handle('codex:request', (_, data) =>
    service.request(data || {}).catch((error) => {
      if (error?.code === 'cancelled') return { cancelled: true };
      throw error;
    }),
  );
  ipcMain.handle('codex:cancel', (_, id) => service.cancel(id));
  ipcMain.handle('codex:reset', (_, sessionId) => service.reset(sessionId));
  return { service, close: () => service.close() };
}

module.exports = {
  createCodexService,
  registerCodex,
  findCodex,
  resolveExecutable,
  validateArguments,
  formatTurnInput,
  friendlyError,
  fixPrompt,
  normalizeModels,
  toDynamicTools,
  DEFAULT_SETTINGS,
};
