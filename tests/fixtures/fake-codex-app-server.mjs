// Scripted stand-in for `codex app-server` used by tests/codex.test.mjs.
// Speaks the same newline-delimited JSON-RPC (no "jsonrpc" field) over stdio.
// FAKE_CODEX_SCENARIO: JSON file { account, turns: [[step, ...], ...], ... }
// FAKE_CODEX_LOG: JSONL file receiving every client message and server event.
// FAKE_CODEX_STATE: JSON file that survives restarts (turn counter, sign-in state).
import fs from 'node:fs';
import readline from 'node:readline';

const env = process.env;
const args = process.argv.slice(2);
const scenario = env.FAKE_CODEX_SCENARIO
  ? JSON.parse(fs.readFileSync(env.FAKE_CODEX_SCENARIO, 'utf8'))
  : {};
const log = (entry) => {
  if (env.FAKE_CODEX_LOG)
    fs.appendFileSync(env.FAKE_CODEX_LOG, JSON.stringify({ pid: process.pid, ...entry }) + '\n');
};
const readState = () => {
  try {
    return JSON.parse(fs.readFileSync(env.FAKE_CODEX_STATE, 'utf8'));
  } catch {
    return { turn: 0, thread: 0, signedIn: scenario.account !== 'none' };
  }
};
const writeState = (state) =>
  env.FAKE_CODEX_STATE && fs.writeFileSync(env.FAKE_CODEX_STATE, JSON.stringify(state));

if (args.includes('--version')) {
  process.stdout.write('codex-cli 9.8.7\n');
  process.exit(0);
}
if (args[0] !== 'app-server') {
  process.stderr.write('fake codex: unsupported command\n');
  process.exit(2);
}
if (scenario.appServerFails) {
  process.stderr.write('fatal: config.toml is broken at line 3\n');
  process.exit(1);
}
if (scenario.rejectFlags && args.includes('--disable')) {
  log({ type: 'rejected-launch', args });
  process.stderr.write('Error: Unknown feature flag: shell_tool\n');
  process.exit(2);
}
// Like the real server, an MCP override for a server that does not exist is fatal at launch.
const SERVERS = ['alpha', 'odd.name', 'off'];
const mcpFlags = args.filter((a) => a.startsWith('mcp_servers.'));
const unknownServer = mcpFlags.find((a) => !SERVERS.includes(a.split('.')[1]));
if ((scenario.rejectMcpLaunch && mcpFlags.length) || unknownServer) {
  log({ type: 'rejected-launch', args });
  process.stderr.write(
    `Error: invalid transport in \`mcp_servers.${(unknownServer || mcpFlags[0]).split('.')[1]}\`\n`,
  );
  process.exit(1);
}
log({ type: 'launch', args });

const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const notify = (method, params) => send({ method, params });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let initialized = false;
let serverRequestId = 1000;
const waiting = new Map();
let activeTurn = null;
let threadStarts = 0;
const removedServers = new Set();
const models = scenario.models || [
  {
    id: 'gpt-6-astra',
    displayName: 'GPT-6-Astra',
    hidden: false,
    supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }],
    defaultReasoningEffort: 'medium',
    serviceTiers: [{ id: 'priority', name: 'Fast' }],
    isDefault: true,
  },
  {
    id: 'secret-internal',
    displayName: 'Hidden',
    hidden: true,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: 'low',
    serviceTiers: [],
    isDefault: false,
  },
  {
    id: 'gpt-6-luna',
    displayName: 'GPT-6-Luna',
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: 'low' },
      { reasoningEffort: 'medium' },
      { reasoningEffort: 'high' },
    ],
    defaultReasoningEffort: 'medium',
    serviceTiers: [{ id: 'priority', name: 'Fast' }],
    isDefault: false,
  },
  {
    id: 'plain-model',
    displayName: 'Plain',
    hidden: false,
    supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
    defaultReasoningEffort: 'low',
    serviceTiers: [],
    additionalSpeedTiers: [],
    isDefault: false,
    someFutureField: { ignored: true },
  },
];

function ask(method, params) {
  const id = serverRequestId++;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    send({ id, method, params });
  });
}
function completeTurn(turn, status, error = null) {
  if (turn.completed) return;
  turn.completed = true;
  if (activeTurn === turn) activeTurn = null;
  log({ type: 'turn-completed', turnId: turn.id, status });
  notify('turn/completed', {
    threadId: turn.threadId,
    turn: { id: turn.id, items: [], status, error, startedAt: null, completedAt: null },
  });
}
async function runTurn(turn, text) {
  notify('turn/started', { threadId: turn.threadId, turn: { id: turn.id, status: 'inProgress' } });
  const userItem = {
    type: 'userMessage',
    id: 'user-' + turn.id,
    content: [{ type: 'text', text }],
  };
  notify('item/started', { threadId: turn.threadId, turnId: turn.id, item: userItem });
  notify('item/completed', { threadId: turn.threadId, turnId: turn.id, item: userItem });
  // Guard Lab's warm-up turn: the real server would call the model next; it gets interrupted.
  if (text.startsWith('Guard Lab: the encounter is about to start')) {
    log({ type: 'warmup', turnId: turn.id });
    if (scenario.warmupCompletesMs !== undefined) {
      await delay(scenario.warmupCompletesMs);
      completeTurn(turn, 'completed');
    }
    return;
  }
  const state = readState();
  const index = state.turn;
  writeState({ ...state, turn: index + 1 });
  const steps = scenario.turns?.[index] || [{ call: { tool: 'hold_position' } }];
  for (const step of steps) {
    if (turn.completed) return;
    if (step.wait) await delay(step.wait);
    if (step.crash !== undefined) {
      log({ type: 'crash' });
      process.exit(step.crash);
    }
    if (step.hang) return;
    if (step.message)
      notify('item/completed', {
        threadId: turn.threadId,
        turnId: turn.id,
        item: { type: 'agentMessage', id: 'msg-' + turn.id, text: step.message, phase: null },
      });
    if (step.notify) notify(step.notify.method, step.notify.params);
    if (step.request) {
      const response = await ask(step.request.method, {
        threadId: turn.threadId,
        turnId: turn.id,
        ...step.request.params,
      });
      log({ type: 'answered', method: step.request.method, response });
    }
    if (step.call) {
      const callId = `exec-${turn.id}-${turn.calls++}`;
      const params = {
        threadId: turn.threadId,
        turnId: turn.id,
        callId,
        namespace: null,
        tool: step.call.tool,
        arguments: step.call.arguments ?? {},
      };
      const response = await ask('item/tool/call', params);
      log({ type: 'tool-response', callId, tool: step.call.tool, response });
      notify('item/completed', {
        threadId: turn.threadId,
        turnId: turn.id,
        item: {
          type: 'dynamicToolCall',
          id: callId,
          tool: step.call.tool,
          arguments: params.arguments,
          status: response?.result?.success ? 'completed' : 'failed',
        },
      });
      // The real server reports usage once the code-mode exec output is recorded.
      if (!step.noUsage) {
        if (step.usageDelay) await delay(step.usageDelay);
        log({ type: 'usage-sent', turnId: turn.id, callId });
        notify('thread/tokenUsage/updated', {
          threadId: turn.threadId,
          turnId: turn.id,
          tokenUsage: {
            last: { inputTokens: 100, cachedInputTokens: 50, outputTokens: 5 },
            total: { inputTokens: 100, cachedInputTokens: 50, outputTokens: 5 },
          },
        });
      }
    }
    if (step.fail) {
      notify('error', {
        threadId: turn.threadId,
        turnId: turn.id,
        willRetry: false,
        error: step.fail,
      });
      return completeTurn(turn, 'failed', step.fail);
    }
    if (step.complete) return completeTurn(turn, step.complete);
  }
  // Like a real model that keeps sampling: wait for an interrupt, then finish on its own.
  await delay(scenario.idleCompleteMs ?? 1500);
  completeTurn(turn, 'completed');
}

function handle(message) {
  log({ type: 'client', message });
  if (message.id !== undefined && !message.method) {
    const resolve = waiting.get(message.id);
    waiting.delete(message.id);
    resolve?.(message);
    return;
  }
  const { id, method, params = {} } = message;
  const reply = (result) => send({ id, result });
  const fail = (code, text) => send({ id, error: { code, message: text } });
  if (id === undefined) return;
  if (method === 'initialize') {
    if (initialized) return fail(-32600, 'Already initialized');
    initialized = true;
    return reply({
      userAgent: 'fake/9.8.7',
      codexHome: '/tmp/fake-codex-home',
      platformFamily: 'unix',
      platformOs: 'fake',
    });
  }
  if (!initialized) return fail(-32002, 'Not initialized');
  const state = readState();
  if (method === 'account/read') {
    if (params.refreshToken && scenario.refreshFails === 'revoked')
      return fail(
        -32603,
        'Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.',
      );
    if (params.refreshToken && scenario.refreshFails === 'offline')
      return fail(-32603, 'failed to connect to auth.openai.com: network error');
  }
  if (method === 'account/read')
    return reply(
      state.signedIn
        ? {
            account: { type: 'chatgpt', email: 'player@example.com', planType: 'plus' },
            requiresOpenaiAuth: true,
          }
        : { account: null, requiresOpenaiAuth: true },
    );
  if (method === 'account/login/start') {
    reply({
      type: 'chatgpt',
      loginId: 'login-1',
      authUrl: scenario.authUrl || 'https://auth.example.com/oauth/authorize?state=fake',
    });
    if (!scenario.loginHangs)
      setTimeout(() => {
        writeState({ ...readState(), signedIn: true });
        notify('account/login/completed', { loginId: 'login-1', success: true, error: null });
      }, 40);
    return;
  }
  if (method === 'account/login/cancel') {
    reply({ status: 'canceled' });
    return notify('account/login/completed', {
      loginId: params.loginId,
      success: false,
      error: 'Login was cancelled',
    });
  }
  if (method === 'model/list') {
    if (!params.cursor) return reply({ data: models.slice(0, 2), nextCursor: 'page-2' });
    return reply({ data: models.slice(2), nextCursor: null });
  }
  if (method === 'config/read') {
    const servers = {
      alpha: { command: 'alpha', enabled: !args.includes('mcp_servers.alpha.enabled=false') },
      'odd.name': { url: 'https://mcp.example.com' },
      off: { command: 'off', enabled: false },
    };
    for (const name of removedServers) delete servers[name];
    return reply({ config: { mcp_servers: servers }, origins: {}, layers: null });
  }
  if (method === 'experimentalFeature/list')
    return reply({
      data: [
        ...['plugins', 'apps', 'shell_tool', 'unified_exec', 'memories'].map((name) => ({
          name,
          stage: 'stable',
          enabled: true,
          defaultEnabled: true,
        })),
        { name: 'code_mode_host', stage: 'stable', enabled: true, defaultEnabled: true },
        // User opt-ins: one that adds model-facing context, one for their network.
        {
          name: 'context_management',
          stage: 'underDevelopment',
          enabled: !args.includes('features.context_management=false'),
          defaultEnabled: false,
        },
        {
          name: 'respect_system_proxy',
          stage: 'underDevelopment',
          enabled: true,
          defaultEnabled: false,
        },
        { name: 'old_thing', stage: 'removed', enabled: true, defaultEnabled: false },
      ],
      nextCursor: null,
    });
  if (method === 'thread/start') {
    threadStarts += 1;
    const config = params.config || {};
    if (threadStarts <= (scenario.overloadThreadStarts || 0))
      return fail(-32001, 'Server overloaded; retry later.');
    if (scenario.rejectThreadFeatures && 'features.plugins' in config)
      return fail(-32602, 'Invalid params: unknown feature in thread config');
    if (scenario.rejectConfigKey && scenario.rejectConfigKey in config)
      return fail(
        -32600,
        `failed to load configuration: invalid type: string, expected usize\nin \`${scenario.rejectConfigKey}\`\n`,
      );
    for (const key of Object.keys(config)) {
      const name = key.match(/^mcp_servers\.([^.]+)\.enabled$/)?.[1];
      if (!name) continue;
      // The user removed this server after Guard Lab read the config.
      if (scenario.removeServerOnThreadStart === name) removedServers.add(name);
      if (!SERVERS.includes(name) || removedServers.has(name) || scenario.rejectMcpServer === name)
        return fail(
          -32600,
          `failed to load configuration: invalid transport\nin \`mcp_servers.${name}\`\n`,
        );
    }
    if (scenario.rejectModel && params.model === scenario.rejectModel)
      return fail(-32600, `The model ${params.model} does not exist or you do not have access.`);
    const number = state.thread + 1;
    writeState({ ...state, thread: number });
    // A real thread/start can take a second or more (the window prepare() covers).
    const answer = scenario.threadStartDelayMs
      ? (result) => setTimeout(() => reply(result), scenario.threadStartDelayMs)
      : reply;
    return answer({
      thread: { id: `thr-${process.pid}-${number}`, ephemeral: true },
      model: params.model,
      modelProvider: 'openai',
      serviceTier: params.serviceTier === undefined ? 'priority' : params.serviceTier,
      cwd: params.cwd,
      instructionSources: [],
      approvalPolicy: params.approvalPolicy,
      sandbox: { type: 'readOnly' },
      reasoningEffort: null,
    });
  }
  if (method === 'turn/start') {
    const number = (state.turnIds || 0) + 1;
    writeState({ ...state, turnIds: number });
    const turn = { id: `turn-${number}`, threadId: params.threadId, calls: 0 };
    activeTurn = turn;
    reply({ turn: { id: turn.id, items: [], status: 'inProgress', error: null } });
    runTurn(turn, String(params.input?.[0]?.text || ''));
    return;
  }
  if (method === 'turn/interrupt') {
    reply({});
    if (activeTurn && activeTurn.id === params.turnId) completeTurn(activeTurn, 'interrupted');
    return;
  }
  if (method === 'thread/unsubscribe') return reply({ status: 'unsubscribed' });
  fail(-32601, `Method not found: ${method}`);
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  handle(message);
});
process.stdin.on('end', () => process.exit(0));
