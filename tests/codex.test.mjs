import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { temporaryDirectory, removeTemporary } from '../shared/temporary.mjs';
import { createMessages } from '../src/sim/agent.mjs';
import { toolSchemas } from '../src/sim/tools.mjs';
import { initialState, applyHuman, observe, availableTools, ZONES } from '../src/sim/engine.mjs';
import { allHumanToolSchemas, humanToolSchemas, humanMessages } from '../src/sim/human-agent.mjs';
import { ITEMS } from '../src/sim/items.mjs';

const require = createRequire(import.meta.url);
const codex = require('../electron/codex.cjs');
const FAKE = fileURLToPath(new URL('./fixtures/fake-codex-app-server.mjs', import.meta.url));
const PASS_THROUGH = ['SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE'];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, timeout = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await check()) return;
    await delay(20);
  }
  throw new Error('Timed out waiting for the fake Codex App Server.');
}

async function harness(scenario = {}, options = {}) {
  const dir = await temporaryDirectory('guard-codex-');
  const files = {
    scenario: path.join(dir, 'scenario.json'),
    log: path.join(dir, 'log.jsonl'),
    state: path.join(dir, 'state.json'),
  };
  await fs.writeFile(files.scenario, JSON.stringify(scenario));
  const env = {
    PATH: dir,
    FAKE_CODEX_SCENARIO: files.scenario,
    FAKE_CODEX_LOG: files.log,
    FAKE_CODEX_STATE: files.state,
  };
  for (const key of PASS_THROUGH) if (process.env[key]) env[key] = process.env[key];
  const opened = [];
  const service = codex.createCodexService({
    env,
    home: dir,
    workspace: path.join(dir, 'workspace'),
    systemSearch: false,
    loginShell: false,
    openExternal: async (url) => opened.push(url),
    turnTimeoutMs: 5000,
    ...options,
  });
  const entries = async () =>
    (await fs.readFile(files.log, 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const sent = async (method) =>
    (await entries())
      .filter((e) => e.type === 'client' && e.message.method === method)
      .map((e) => e.message);
  return {
    dir,
    service,
    opened,
    entries,
    sent,
    settings: { model: 'gpt-6-luna', effort: 'low', fast: true, codexPath: FAKE },
    async close() {
      service.close();
      await delay(80);
      await removeTemporary(dir);
    },
  };
}
function guardRequest() {
  const entered = applyHuman(
    initialState('thief-uniform', undefined, '9327', 1, { item: 'replica' }),
    'enter',
  );
  return {
    state: entered.state,
    messages: [
      ...createMessages(undefined, '9327'),
      {
        role: 'user',
        content: JSON.stringify({ observation: observe(entered.state, entered.event) }),
      },
    ],
    tools: toolSchemas(availableTools(entered.state)),
    allTools: toolSchemas(),
  };
}
const turns = (...list) => ({ turns: list });
// The fake logs a tool answer when it receives it, which can trail the resolved request.
async function toolAnswers(h, count) {
  const read = async () => (await h.entries()).filter((e) => e.type === 'tool-response');
  await waitFor(async () => (await read()).length >= count);
  return read();
}
const call = (tool, args = {}) => ({ call: { tool, arguments: args } });

test('Codex handshake initializes once, opts out of deltas and reports a ready account', async () => {
  const h = await harness();
  try {
    const pushes = [];
    h.service.onStatus((s) => pushes.push(s.state));
    const status = await h.service.status({ codexPath: FAKE });
    assert.equal(status.state, 'ready');
    assert.equal(status.version, '9.8.7');
    assert.equal(status.message, 'Codex 9.8 · signed in with ChatGPT');
    assert.deepEqual(status.account, {
      type: 'chatgpt',
      email: 'player@example.com',
      plan: 'plus',
    });
    assert.equal(status.fixPrompt, null);
    assert.deepEqual(status.login, { state: 'idle' });
    assert.equal(await fs.realpath(status.binaryPath), await fs.realpath(FAKE));
    assert.deepEqual(pushes, ['ready']);
    const log = await h.entries();
    const [launch, hardened, ...more] = log.filter((e) => e.type === 'launch');
    assert.equal(more.length, 0);
    assert.ok(launch.args.includes('app-server'));
    for (const feature of ['shell_tool', 'unified_exec', 'plugins', 'apps', 'browser_use'])
      assert.ok(launch.args.includes(feature), feature);
    assert.ok(!launch.args.includes('code_mode_host'));
    assert.ok(launch.args.includes('notify=[]'));
    // After reading the config, Codex is relaunched with the user's enabled MCP servers and
    // opt-in features switched off for the whole process (only names this Codex reported).
    assert.deepEqual(hardened.args.slice(0, launch.args.length), launch.args);
    assert.deepEqual(hardened.args.slice(launch.args.length), [
      '-c',
      'mcp_servers.alpha.enabled=false',
      '-c',
      'features.context_management=false',
    ]);
    assert.equal(h.service._debug().pid, hardened.pid);
    const messages = log.filter((e) => e.type === 'client').map((e) => e.message);
    assert.equal(messages[0].method, 'initialize');
    assert.equal(messages[0].params.clientInfo.name, 'guard-lab');
    assert.equal(messages[0].params.capabilities.experimentalApi, true);
    assert.equal(messages[0].params.capabilities.requestAttestation, false);
    assert.ok(
      messages[0].params.capabilities.optOutNotificationMethods.includes('item/agentMessage/delta'),
    );
    assert.equal(messages[1].method, 'initialized');
    assert.equal(messages[1].id, undefined);
    for (const pid of [launch.pid, hardened.pid])
      assert.equal(
        log.filter((e) => e.pid === pid && e.message?.method === 'initialize').length,
        1,
      );
    // The status check reads the cached sign-in; only "Check again" asks for a token refresh.
    const [accountRead] = await h.sent('account/read');
    assert.deepEqual(accountRead.params, { refreshToken: false });
    // A cached status does not respawn or re-handshake.
    assert.equal((await h.service.status()).state, 'ready');
    assert.equal((await h.sent('initialize')).length, 2);
  } finally {
    await h.close();
  }
});

test('Signed-out Codex offers a fix prompt and ChatGPT sign-in completes through notifications', async () => {
  const h = await harness({ account: 'none' });
  try {
    const pushes = [];
    h.service.onStatus((s) => pushes.push(s));
    const status = await h.service.status({ codexPath: FAKE });
    assert.equal(status.state, 'signed-out');
    assert.equal(status.account, null);
    assert.match(status.fixPrompt, /codex login/);
    assert.deepEqual(await h.service.login(), { started: true });
    assert.deepEqual(h.opened, ['https://auth.example.com/oauth/authorize?state=fake']);
    const [start] = await h.sent('account/login/start');
    assert.deepEqual(start.params, { type: 'chatgpt' });
    await waitFor(() => pushes.at(-1)?.state === 'ready');
    assert.ok(pushes.some((p) => p.login.state === 'pending'));
    assert.deepEqual(pushes.at(-1).login, { state: 'idle' });
  } finally {
    await h.close();
  }
});

test('Sign-in refuses non-https links and can be cancelled', async () => {
  const h = await harness({ account: 'none', authUrl: 'http://auth.example.com/plain' });
  try {
    await assert.rejects(h.service.login({ codexPath: FAKE }), /unexpected sign-in link/);
    assert.deepEqual(h.opened, []);
    assert.equal((await h.service.status()).login.state, 'failed');
  } finally {
    await h.close();
  }
  const pending = await harness({ account: 'none', loginHangs: true });
  try {
    await pending.service.login({ codexPath: FAKE });
    assert.equal((await pending.service.status()).login.state, 'pending');
    assert.deepEqual(await pending.service.cancelLogin(), { cancelled: true });
    assert.equal((await pending.sent('account/login/cancel'))[0].params.loginId, 'login-1');
    assert.equal((await pending.service.status()).login.state, 'idle');
  } finally {
    await pending.close();
  }
});

test('Missing and broken Codex installs report searched locations and a platform fix prompt', async () => {
  const h = await harness();
  try {
    const missingPath = path.join(h.dir, 'nowhere', 'codex');
    const status = await h.service.status({ codexPath: missingPath });
    assert.equal(status.state, 'missing');
    assert.equal(status.binaryPath, null);
    assert.ok(status.fixPrompt.includes(missingPath));
    assert.match(status.fixPrompt, /npm install -g @openai\/codex@latest/);
    assert.match(status.fixPrompt, /codex app-server --help/);
    assert.match(status.fixPrompt, /Settings → Guard → Advanced → Codex executable/);
    assert.match(status.fixPrompt, /never print or share auth tokens/);
    await assert.rejects(h.service.models(), /not installed/);
  } finally {
    await h.close();
  }
  const broken = await harness({ appServerFails: true });
  try {
    const status = await broken.service.status({ codexPath: FAKE });
    assert.equal(status.state, 'error');
    assert.equal(status.version, '9.8.7');
    assert.match(status.message, /App Server won't start/);
    assert.match(status.fixPrompt, /config\.toml is broken at line 3/);
    const windows = codex.fixPrompt({
      state: 'missing',
      message: 'x',
      platform: 'win32',
      arch: 'x64',
      searched: [],
    });
    assert.match(windows, /where\.exe codex/);
    assert.match(windows, /codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex\.exe/);
  } finally {
    await broken.close();
  }
});

test('Rejected isolation flags fall back to fewer flags while threads stay isolated', async () => {
  const h = await harness({ rejectFlags: true, turns: [[call('hold_position')]] });
  try {
    const status = await h.service.status({ codexPath: FAKE });
    assert.equal(status.state, 'ready');
    assert.match(status.warnings.join(' '), /rejected some isolation flags/);
    const log = await h.entries();
    assert.ok(log.find((e) => e.type === 'rejected-launch'));
    const launch = log.find((e) => e.type === 'launch');
    assert.ok(!launch.args.includes('--disable'));
    assert.ok(launch.args.includes('include_environment_context=false'));
    const req = guardRequest();
    await h.service.request({ id: 'r', sessionId: 's', ...req, settings: h.settings });
    const [thread] = await h.sent('thread/start');
    assert.equal(thread.params.config['features.shell_tool'], false);
  } finally {
    await h.close();
  }
});

test('Model list is paginated, hidden models are dropped and fields are normalized', async () => {
  const h = await harness();
  try {
    const models = await h.service.models({ codexPath: FAKE });
    assert.deepEqual(
      models.map((m) => m.id),
      ['gpt-6-astra', 'gpt-6-luna', 'plain-model'],
    );
    assert.deepEqual(models[1], {
      id: 'gpt-6-luna',
      name: 'GPT-6-Luna',
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'medium',
      fast: true,
      isDefault: false,
    });
    assert.equal(models[0].isDefault, true);
    assert.equal(models[2].fast, false);
    const calls = await h.sent('model/list');
    assert.equal(calls.length, 2);
    assert.equal(calls[1].params.cursor, 'page-2');
    assert.equal(calls[0].params.includeHidden, false);
    await h.service.models();
    assert.equal((await h.sent('model/list')).length, 2);
  } finally {
    await h.close();
  }
});

test('A valid tool call is submitted, the turn is interrupted and an OpenAI-shaped call returns', async () => {
  const h = await harness(turns([call('speak', { message: 'Halt.' }), call('hold_position')]));
  try {
    const req = guardRequest();
    assert.deepEqual(
      await h.service.prepare({
        sessionId: 's1',
        actor: 'robot',
        system: req.messages[0].content,
        allTools: req.allTools,
        settings: h.settings,
      }),
      { ok: true },
    );
    const response = await h.service.request({
      id: 'r1',
      sessionId: 's1',
      actor: 'robot',
      messages: req.messages,
      tools: req.tools,
      allTools: req.allTools,
      settings: h.settings,
    });
    assert.equal(response.message.role, 'assistant');
    assert.equal(response.message.content, null);
    assert.equal(response.message.tool_calls.length, 1);
    const [toolCall] = response.message.tool_calls;
    // turn-1 was prepare()'s warm-up; the decision is the scenario's first turn.
    assert.equal(toolCall.id, 'exec-turn-2-0');
    assert.equal(toolCall.type, 'function');
    assert.equal(toolCall.function.name, 'speak');
    assert.deepEqual(JSON.parse(toolCall.function.arguments), { message: 'Halt.' });
    assert.equal(response.timing.model, 'gpt-6-luna');
    assert.equal(response.timing.effort, 'low');
    assert.equal(response.timing.serviceTier, 'priority');
    assert.equal(typeof response.timing.decisionMs, 'number');
    await waitFor(async () => (await h.sent('turn/interrupt')).length === 2);
    const [warmInterrupt, interrupt] = await h.sent('turn/interrupt');
    assert.equal(warmInterrupt.params.turnId, 'turn-1');
    assert.equal(interrupt.params.turnId, 'turn-2');
    // The warm-up turn is stopped once Codex records its message, before any model output.
    const log = await h.entries();
    assert.ok(log.some((e) => e.type === 'warmup' && e.turnId === 'turn-1'));
    assert.ok(!log.some((e) => e.type === 'tool-response' && e.callId.startsWith('exec-turn-1')));
    const answers = await toolAnswers(h, 1);
    assert.equal(answers[0].response.result.success, true);
    assert.equal(
      answers[0].response.result.contentItems[0].text,
      'Submitted. The outcome arrives with your next observation.',
    );
    // prepare() created the thread ahead of time; request() reused it.
    const threadStarts = await h.sent('thread/start');
    assert.equal(threadStarts.length, 1);
    const thread = threadStarts[0].params;
    assert.ok(thread.baseInstructions.startsWith(req.messages[0].content));
    // Codex marks each turn Guard Lab ends as interrupted; the instructions explain that notice.
    assert.match(thread.baseInstructions, /Codex marks those turns as interrupted/);
    assert.deepEqual(
      thread.dynamicTools.map((t) => t.name),
      req.allTools.map((t) => t.function.name),
    );
    assert.deepEqual(
      thread.dynamicTools.find((t) => t.name === 'set_lockdown').inputSchema,
      toolSchemas(['set_lockdown'])[0].function.parameters,
    );
    assert.equal(thread.approvalPolicy, 'never');
    assert.equal(thread.sandbox, 'read-only');
    assert.equal(thread.ephemeral, true);
    assert.deepEqual(thread.environments, []);
    assert.equal(thread.serviceTier, 'priority');
    assert.equal(thread.cwd, path.join(h.dir, 'workspace'));
    // Every server config/read lists is turned off by its bare name. Codex rejects other names,
    // and a nested mcp_servers object would not merge with the dotted keys.
    assert.equal(thread.config['mcp_servers.alpha.enabled'], false);
    assert.equal(thread.config['mcp_servers.off.enabled'], false);
    assert.ok(!('mcp_servers' in thread.config));
    assert.ok(!Object.keys(thread.config).some((k) => k.includes('odd')));
    assert.match(h.service._debug().warnings.join(' '), /cannot turn off MCP server "odd\.name"/);
    assert.equal(thread.config['features.shell_tool'], false);
    assert.ok(!('features.goals' in thread.config), 'only features this Codex knows');
    // User opt-ins are switched off, except infrastructure ones and ones Guard Lab needs.
    assert.equal(thread.config['features.context_management'], false);
    for (const kept of ['respect_system_proxy', 'code_mode_host', 'old_thing'])
      assert.ok(!(`features.${kept}` in thread.config), kept);
    assert.deepEqual(thread.config.notify, []);
    const [warmup, turn] = await h.sent('turn/start');
    assert.match(warmup.params.input[0].text, /^Guard Lab: the encounter is about to start/);
    assert.equal(warmup.params.model, 'gpt-6-luna');
    assert.equal(turn.params.model, 'gpt-6-luna');
    assert.equal(turn.params.effort, 'low');
    assert.equal(turn.params.serviceTier, 'priority');
    const text = turn.params.input[0].text;
    assert.ok(!text.includes('Private memory'), 'the system prompt is not resent per turn');
    assert.match(text, /Available tools now: .*hold_position.*Call exactly one\.$/);
    // The observation is sent whole, except the rules (verbatim in the system prompt) and the
    // tool list (named by the closing line).
    const original = JSON.parse(req.messages.at(-1).content);
    const sentObservation = JSON.parse(text.slice(0, text.lastIndexOf('\n\nAvailable tools now')));
    assert.ok(req.messages[0].content.includes(JSON.stringify(original.observation.rules)));
    assert.equal(sentObservation.observation.rules, undefined);
    assert.equal(sentObservation.observation.self.availableTools, undefined);
    for (const name of original.observation.self.availableTools)
      assert.match(text.split('Available tools now: ')[1], new RegExp(`\\b${name}\\b`));
    delete original.observation.rules;
    delete original.observation.self.availableTools;
    assert.deepEqual(sentObservation, original);
    // A second prepare() for the same, already warm thread changes nothing.
    await h.service.prepare({
      sessionId: 's1',
      actor: 'robot',
      system: req.messages[0].content,
      allTools: req.allTools,
      settings: h.settings,
    });
    assert.equal((await h.sent('turn/start')).length, 2);
    assert.equal((await h.sent('thread/start')).length, 1);
  } finally {
    await h.close();
  }
});

test('The turn is interrupted only after Codex records the tool output, without delaying the decision', async () => {
  const h = await harness(
    turns(
      [{ ...call('hold_position'), usageDelay: 200 }],
      [{ ...call('speak', { message: 'Hi.' }), noUsage: true }],
    ),
    { settleCapMs: 700 },
  );
  try {
    const req = guardRequest();
    const started = Date.now();
    const first = await h.service.request({
      id: 'u1',
      sessionId: 's',
      ...req,
      settings: h.settings,
    });
    assert.equal(first.message.tool_calls[0].function.name, 'hold_position');
    assert.ok(Date.now() - started < 1500);
    // The decision resolved while Codex was still recording the exec output: no interrupt yet.
    assert.equal((await h.sent('turn/interrupt')).length, 0);
    await waitFor(async () => (await h.sent('turn/interrupt')).length === 1);
    const order = (await h.entries())
      .filter((e) => e.type === 'usage-sent' || e.message?.method === 'turn/interrupt')
      .map((e) => (e.type === 'usage-sent' ? 'usage' : 'interrupt'));
    assert.deepEqual(order, ['usage', 'interrupt']);
    // If the usage update never arrives, a short cap still stops the follow-up sampling.
    const second = await h.service.request({
      id: 'u2',
      sessionId: 's',
      ...req,
      messages: [
        ...req.messages,
        { role: 'assistant', content: null, tool_calls: first.message.tool_calls },
        { role: 'tool', tool_call_id: first.message.tool_calls[0].id, content: '{"success":true}' },
        { role: 'user', content: 'next' },
      ],
      settings: h.settings,
    });
    assert.equal(second.message.tool_calls[0].function.name, 'speak');
    await waitFor(async () => (await h.sent('turn/interrupt')).length === 2);
    // Codex reports a decision's token usage after it was returned; the next decision carries it.
    assert.equal(first.usage, null);
    assert.equal(first.timing.previousUsage, undefined);
    assert.deepEqual(second.timing.previousUsage, {
      inputTokens: 100,
      cachedInputTokens: 50,
      outputTokens: 5,
    });
  } finally {
    await h.close();
  }
});

test('Thread start retries busy servers and drops only rejected keys, never the MCP or environment isolation', async () => {
  const busy = await harness({ overloadThreadStarts: 2 }, { retryDelayMs: 10 });
  try {
    const req = guardRequest();
    await busy.service.request({ id: 'b', sessionId: 's', ...req, settings: busy.settings });
    const starts = await busy.sent('thread/start');
    assert.equal(starts.length, 3);
    for (const start of starts) {
      assert.deepEqual(start.params.config, starts[0].params.config);
      assert.deepEqual(start.params.environments, []);
      assert.equal(start.params.config['mcp_servers.alpha.enabled'], false);
    }
    assert.deepEqual(busy.service._debug().warnings, [
      'Guard Lab cannot turn off MCP server "odd.name" for its threads.',
    ]);
  } finally {
    await busy.close();
  }
  const picky = await harness({ rejectConfigKey: 'project_doc_max_bytes' });
  try {
    const req = guardRequest();
    await picky.service.request({ id: 'p', sessionId: 's', ...req, settings: picky.settings });
    const [rejected, accepted] = await picky.sent('thread/start');
    assert.ok('project_doc_max_bytes' in rejected.params.config);
    assert.ok(!('project_doc_max_bytes' in accepted.params.config));
    const { project_doc_max_bytes, ...rest } = rejected.params.config;
    assert.deepEqual(accepted.params.config, rest);
    assert.deepEqual(accepted.params.environments, []);
    assert.match(picky.service._debug().warnings.join(' '), /project_doc_max_bytes/);
  } finally {
    await picky.close();
  }
  const removed = await harness({ removeServerOnThreadStart: 'alpha' });
  try {
    const req = guardRequest();
    await removed.service.request({ id: 'r', sessionId: 's', ...req, settings: removed.settings });
    const [stale, fresh] = await removed.sent('thread/start');
    assert.equal(stale.params.config['mcp_servers.alpha.enabled'], false);
    assert.ok(!('mcp_servers.alpha.enabled' in fresh.params.config));
    assert.equal(fresh.params.config['mcp_servers.off.enabled'], false);
    assert.equal(fresh.params.config['features.shell_tool'], false);
  } finally {
    await removed.close();
  }
  const stuck = await harness({ rejectMcpServer: 'alpha' });
  try {
    const req = guardRequest();
    await assert.rejects(
      stuck.service.request({ id: 'm', sessionId: 's', ...req, settings: stuck.settings }),
      /Codex could not turn off your MCP servers for the game/,
    );
    const starts = await stuck.sent('thread/start');
    assert.equal(starts.length, 2);
    assert.ok(starts.every((s) => s.params.config['mcp_servers.alpha.enabled'] === false));
    assert.equal((await stuck.sent('turn/start')).length, 0);
  } finally {
    await stuck.close();
  }
});

test('If Codex rejects the MCP launch flags, the first process stays and threads still turn MCP off', async () => {
  const h = await harness({ rejectMcpLaunch: true });
  try {
    const status = await h.service.status({ codexPath: FAKE });
    assert.equal(status.state, 'ready');
    assert.match(status.warnings.join(' '), /rejected the launch flags that turn off MCP servers/);
    const log = await h.entries();
    const [launch] = log.filter((e) => e.type === 'launch');
    assert.ok(log.some((e) => e.type === 'rejected-launch'));
    assert.equal(h.service._debug().pid, launch.pid);
    const req = guardRequest();
    await h.service.request({ id: 'x', sessionId: 's', ...req, settings: h.settings });
    const [thread] = await h.sent('thread/start');
    assert.equal(thread.params.config['mcp_servers.alpha.enabled'], false);
  } finally {
    await h.close();
  }
});

test('Check again refreshes the ChatGPT sign-in, so a revoked session shows as signed out', async () => {
  const h = await harness({ refreshFails: 'revoked' });
  try {
    assert.equal((await h.service.status({ codexPath: FAKE })).state, 'ready');
    const status = await h.service.status({ refresh: true });
    assert.equal(status.state, 'signed-out');
    assert.deepEqual((await h.sent('account/read')).at(-1).params, { refreshToken: true });
  } finally {
    await h.close();
  }
  const offline = await harness({ refreshFails: 'offline' });
  try {
    assert.equal((await offline.service.status({ refresh: true, codexPath: FAKE })).state, 'ready');
    assert.deepEqual(
      (await offline.sent('account/read')).map((m) => m.params.refreshToken),
      [true, false],
    );
  } finally {
    await offline.close();
  }
  // A decision that fails with an expired sign-in re-checks the account with a refresh.
  const expired = await harness({
    refreshFails: 'revoked',
    turns: [[{ fail: { message: 'unauthorized', codexErrorInfo: 'unauthorized' } }]],
  });
  try {
    const pushes = [];
    expired.service.onStatus((s) => pushes.push(s.state));
    assert.equal((await expired.service.status({ codexPath: FAKE })).state, 'ready');
    const req = guardRequest();
    await assert.rejects(
      expired.service.request({ id: 'e', sessionId: 's', ...req, settings: expired.settings }),
      /sign-in expired/,
    );
    await waitFor(() => pushes.at(-1) === 'signed-out');
  } finally {
    await expired.close();
  }
});

test('Later turns send only new results and observations and apply settings changes mid-encounter', async () => {
  const h = await harness(turns([call('hold_position')], [call('speak', { message: 'Leave.' })]));
  try {
    const req = guardRequest();
    const first = await h.service.request({
      id: 'a',
      sessionId: 's',
      ...req,
      settings: h.settings,
    });
    const history = [
      ...req.messages,
      { role: 'assistant', content: null, tool_calls: first.message.tool_calls },
      {
        role: 'tool',
        tool_call_id: first.message.tool_calls[0].id,
        content: JSON.stringify({ result: 'You hold position.', success: true }),
      },
      { role: 'user', content: JSON.stringify({ observation: { turn: 2, note: 'second' } }) },
    ];
    const second = await h.service.request({
      id: 'b',
      sessionId: 's',
      ...req,
      messages: history,
      settings: { ...h.settings, fast: false, effort: 'ultra' },
    });
    assert.equal(second.message.tool_calls[0].function.name, 'speak');
    assert.equal(second.timing.serviceTier, 'default');
    assert.equal(second.timing.effort, 'medium', 'unsupported effort falls back to the default');
    assert.equal((await h.sent('thread/start')).length, 1);
    const turnStarts = await h.sent('turn/start');
    assert.equal(turnStarts[1].params.serviceTier, 'default');
    assert.equal(turnStarts[1].params.effort, 'medium');
    const text = turnStarts[1].params.input[0].text;
    assert.match(text, /^Result of your previous action: \{"result":"You hold position\."/);
    assert.ok(text.includes('"note":"second"'));
    assert.ok(!text.includes(req.messages.at(-1).content), 'old observation is not resent');
  } finally {
    await h.close();
  }
});

test('Invalid tools and arguments are rejected with the available list until a valid retry', async () => {
  const h = await harness(
    turns(
      [
        call('fire_laser'),
        call('speak', {}),
        call('set_lockdown', { enabled: 'yes' }),
        call('speak', { message: 'Final warning.', volume: 11 }),
      ],
      [call('teleport'), call('fly'), call('vanish')],
    ),
  );
  try {
    const req = guardRequest();
    const response = await h.service.request({
      id: 'x',
      sessionId: 's',
      ...req,
      settings: h.settings,
    });
    // The 4th call is also invalid, but the 3rd invalid attempt already resolved the turn.
    assert.equal(response.message.tool_calls[0].function.name, 'hold_position');
    assert.match(response.message.tool_calls[0].id, /^codex-fallback-/);
    // The substituted action is marked, so logs and transcripts do not show it as a choice.
    assert.equal(response.timing.fallback, 'invalid_calls');
    assert.match(
      response.timing.fallbackDetail,
      /3 invalid tool calls .*enabled must be a boolean/,
    );
    const answers = await toolAnswers(h, 3);
    assert.equal(answers[0].response.result.success, false);
    assert.match(answers[0].response.result.contentItems[0].text, /"fire_laser" is not available/);
    assert.match(answers[0].response.result.contentItems[0].text, /Available tools: .*speak,/);
    assert.match(
      answers[1].response.result.contentItems[0].text,
      /missing required argument "message"/,
    );
    assert.match(answers[2].response.result.contentItems[0].text, /enabled must be a boolean/);
    assert.ok(answers.slice(0, 3).every((a) => a.response.result.success === false));
    await waitFor(async () => (await h.sent('turn/interrupt')).length === 1);
  } finally {
    await h.close();
  }
  const retry = await harness(turns([call('fire_laser'), call('set_lockdown', { enabled: true })]));
  try {
    const req = guardRequest();
    const response = await retry.service.request({
      id: 'y',
      sessionId: 's',
      ...req,
      settings: retry.settings,
    });
    assert.equal(response.message.tool_calls[0].function.name, 'set_lockdown');
    assert.deepEqual(JSON.parse(response.message.tool_calls[0].function.arguments), {
      enabled: true,
    });
    assert.equal(response.timing.fallback, undefined);
    const answers = await toolAnswers(retry, 2);
    assert.deepEqual(
      answers.map((a) => a.response.result.success),
      [false, true],
    );
  } finally {
    await retry.close();
  }
});

test('A text-only completion returns assistant content for runGuard to speak', async () => {
  const h = await harness(turns([{ message: 'Stop right there.' }, { complete: 'completed' }]));
  try {
    const req = guardRequest();
    const response = await h.service.request({
      id: 't',
      sessionId: 's',
      ...req,
      settings: h.settings,
    });
    assert.deepEqual(response.message, { role: 'assistant', content: 'Stop right there.' });
    assert.equal(response.timing.model, 'gpt-6-luna');
  } finally {
    await h.close();
  }
});

test('A turn that ends with neither a tool call nor text resolves to a marked fallback', async () => {
  const h = await harness(turns([{ complete: 'completed' }]));
  try {
    const req = guardRequest();
    const response = await h.service.request({
      id: 'n',
      sessionId: 's',
      ...req,
      settings: h.settings,
    });
    assert.equal(response.message.tool_calls[0].function.name, 'hold_position');
    assert.equal(response.timing.fallback, 'no_action');
  } finally {
    await h.close();
  }
});

test('A cancel that arrives before its request, while prepare() runs, stops that request', async () => {
  const h = await harness({ threadStartDelayMs: 300 });
  try {
    const req = guardRequest();
    const preparing = h.service.prepare({
      sessionId: 's',
      system: req.messages[0].content,
      allTools: req.allTools,
      settings: h.settings,
    });
    // The renderer waits for prepare() before sending the request; the player pauses meanwhile.
    assert.deepEqual(await h.service.cancel('early'), { cancelled: false });
    assert.deepEqual(await preparing, { ok: true });
    await assert.rejects(
      h.service.request({ id: 'early', sessionId: 's', ...req, settings: h.settings }),
      (error) => error.code === 'cancelled',
    );
    // Only the warm-up ran: the cancelled decision never reached Codex.
    assert.equal((await h.sent('turn/start')).length, 1);
    const next = await h.service.request({
      id: 'later',
      sessionId: 's',
      ...req,
      settings: h.settings,
    });
    assert.equal(next.message.tool_calls[0].function.name, 'hold_position');
    assert.equal((await h.sent('thread/start')).length, 1);
  } finally {
    await h.close();
  }
});

test('A reset while prepare() starts the thread drops that thread instead of leaking it', async () => {
  const h = await harness({ threadStartDelayMs: 300 });
  try {
    const req = guardRequest();
    const preparing = h.service.prepare({
      sessionId: 'gone',
      system: req.messages[0].content,
      allTools: req.allTools,
      settings: h.settings,
    });
    await waitFor(async () => (await h.sent('thread/start')).length === 1);
    await h.service.reset('gone');
    // A reset is how a player leaves, so prepare() reports it instead of failing.
    assert.deepEqual(await preparing, { ok: false, cancelled: true });
    assert.deepEqual(h.service._debug().threads, []);
    await waitFor(async () => (await h.sent('thread/unsubscribe')).length === 1);
    assert.equal((await h.sent('turn/start')).length, 0, 'no warm-up for a dropped thread');
    // The service stays usable for the same id afterwards.
    await h.service.request({ id: 'again', sessionId: 'gone', ...req, settings: h.settings });
    assert.equal(h.service._debug().threads.length, 1);
  } finally {
    await h.close();
  }
});

test('A reset right after a decision stops the settling Codex turn before unsubscribing', async () => {
  const h = await harness(turns([{ ...call('hold_position'), noUsage: true }]), {
    settleCapMs: 4000,
  });
  try {
    const req = guardRequest();
    await h.service.request({ id: 'd', sessionId: 's', ...req, settings: h.settings });
    assert.equal((await h.sent('turn/interrupt')).length, 0, 'still settling');
    const started = Date.now();
    await h.service.reset('s');
    await waitFor(async () => (await h.sent('thread/unsubscribe')).length === 1);
    const order = (await h.entries())
      .filter(
        (e) => e.type === 'client' && /turn\/interrupt|thread\/unsubscribe/.test(e.message.method),
      )
      .map((e) => e.message.method);
    assert.deepEqual(order, ['turn/interrupt', 'thread/unsubscribe']);
    assert.ok(Date.now() - started < 1500, 'not left to the settle cap');
  } finally {
    await h.close();
  }
});

test('The desktop IPC answers a cancelled request as a value, not a failed handler', async () => {
  const dir = await temporaryDirectory('guard-codex-ipc-');
  const scenario = path.join(dir, 'scenario.json');
  await fs.writeFile(scenario, JSON.stringify(turns([{ hang: true }])));
  const handlers = new Map();
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };
  const env = { PATH: dir, FAKE_CODEX_SCENARIO: scenario };
  for (const key of PASS_THROUGH) if (process.env[key]) env[key] = process.env[key];
  const registered = codex.registerCodex({
    ipcMain,
    shell: { openExternal: async () => {} },
    serviceOptions: {
      env,
      home: dir,
      workspace: path.join(dir, 'workspace'),
      systemSearch: false,
      loginShell: false,
    },
  });
  try {
    const req = guardRequest();
    const settings = { model: 'gpt-6-luna', effort: 'low', fast: true, codexPath: FAKE };
    const pending = handlers.get('codex:request')(null, {
      id: 'ipc',
      sessionId: 's',
      ...req,
      settings,
    });
    await waitFor(async () => registered.service._debug().threads.length === 1);
    await delay(100);
    assert.deepEqual(await handlers.get('codex:cancel')(null, 'ipc'), { cancelled: true });
    assert.deepEqual(await pending, { cancelled: true });
    // Real failures still reject.
    await assert.rejects(handlers.get('codex:request')(null, { id: 'bad' }), /needs messages/);
  } finally {
    registered.close();
    await delay(80);
    await removeTemporary(dir);
  }
});

test('The renderer drops a decision cancelled while it waits for prepare()', async () => {
  const { requestDecision, cancelDecision } = await import('../src/ui/requests.mjs');
  const sent = [];
  let finishPrepare;
  const ready = new Promise((resolve) => (finishPrepare = resolve));
  const desktop = {
    codex: {
      request: async (data) => {
        sent.push(['request', data.id]);
        return data.id === 'main-cancelled' ? { cancelled: true } : { message: { content: 'ok' } };
      },
      cancel: async (id) => sent.push(['cancel', id]),
    },
  };
  const base = { desktop, mode: 'codex', data: { messages: [], tools: [] }, sessionId: 's' };
  const pending = requestDecision({ ...base, id: 'paused', ready });
  cancelDecision(desktop, 'codex', 'paused');
  // It settles at once (Pause no longer looks frozen) and is never sent.
  await assert.rejects(
    Promise.race([pending, delay(500).then(() => 'still waiting for prepare')]),
    (error) => error.code === 'cancelled',
  );
  finishPrepare();
  await delay(10);
  assert.deepEqual(sent, [['cancel', 'paused']]);
  await assert.rejects(
    requestDecision({ ...base, id: 'main-cancelled', ready }),
    (error) => error.code === 'cancelled',
  );
  assert.deepEqual(await requestDecision({ ...base, id: 'fine', ready }), {
    message: { content: 'ok' },
  });
});

test('Cancel interrupts a pending turn; reset drops the thread; timeouts and failures are clear', async () => {
  const h = await harness(turns([{ hang: true }], [call('hold_position')]));
  try {
    const req = guardRequest();
    const pending = h.service.request({ id: 'c1', sessionId: 's', ...req, settings: h.settings });
    await waitFor(async () => (await h.sent('turn/start')).length === 1);
    assert.deepEqual(await h.service.cancel('c1'), { cancelled: true });
    await assert.rejects(pending, /cancelled/);
    await waitFor(async () => (await h.sent('turn/interrupt')).length === 1);
    assert.deepEqual(await h.service.cancel('unknown'), { cancelled: false });
    await h.service.reset('s');
    await waitFor(async () => (await h.sent('thread/unsubscribe')).length === 1);
    await h.service.request({ id: 'c2', sessionId: 's', ...req, settings: h.settings });
    assert.equal((await h.sent('thread/start')).length, 2);
  } finally {
    await h.close();
  }
  const slow = await harness(turns([{ hang: true }]), { turnTimeoutMs: 300 });
  try {
    const req = guardRequest();
    await assert.rejects(
      slow.service.request({ id: 'slow', sessionId: 's', ...req, settings: slow.settings }),
      /longer than 0 seconds|longer than/,
    );
    await waitFor(async () => (await slow.sent('turn/interrupt')).length === 1);
  } finally {
    await slow.close();
  }
  const failing = await harness(
    turns([
      {
        fail: {
          message: "You've hit your usage limit.",
          codexErrorInfo: 'usageLimitExceeded',
          additionalDetails: null,
        },
      },
    ]),
  );
  try {
    const req = guardRequest();
    await assert.rejects(
      failing.service.request({ id: 'f', sessionId: 's', ...req, settings: failing.settings }),
      /usage limit reached/,
    );
  } finally {
    await failing.close();
  }
});

test('An unavailable model fails fast with a settings hint instead of weakening isolation', async () => {
  const h = await harness({ rejectModel: 'gpt-6-luna' });
  try {
    const req = guardRequest();
    await assert.rejects(
      h.service.request({ id: 'm', sessionId: 's', ...req, settings: h.settings }),
      /^Error: Model gpt-6-luna is not available for this Codex account\. Pick another model in Settings\.$/,
    );
    const starts = await h.sent('thread/start');
    assert.equal(starts.length, 1);
    assert.equal(starts[0].params.config['features.shell_tool'], false);
  } finally {
    await h.close();
  }
});

test('Approvals, elicitations, user-input and unknown server requests are answered so Codex never hangs', async () => {
  const h = await harness(
    turns([
      {
        request: {
          method: 'item/commandExecution/requestApproval',
          params: { itemId: 'i1', command: 'cat secrets.txt' },
        },
      },
      { request: { method: 'item/fileChange/requestApproval', params: { itemId: 'i2' } } },
      {
        request: {
          method: 'mcpServer/elicitation/request',
          params: { serverName: 'x', mode: 'form', message: 'Name?', requestedSchema: {} },
        },
      },
      {
        request: {
          method: 'item/tool/requestUserInput',
          params: { itemId: 'i3', questions: [], isBlocking: true },
        },
      },
      { request: { method: 'future/unknownRequest', params: {} } },
      call('hold_position'),
    ]),
  );
  try {
    const req = guardRequest();
    const response = await h.service.request({
      id: 'q',
      sessionId: 's',
      ...req,
      settings: h.settings,
    });
    assert.equal(response.message.tool_calls[0].function.name, 'hold_position');
    const answers = Object.fromEntries(
      (await h.entries()).filter((e) => e.type === 'answered').map((e) => [e.method, e.response]),
    );
    assert.deepEqual(answers['item/commandExecution/requestApproval'].result, {
      decision: 'decline',
    });
    assert.deepEqual(answers['item/fileChange/requestApproval'].result, { decision: 'decline' });
    assert.equal(answers['mcpServer/elicitation/request'].result.action, 'decline');
    assert.equal(answers['mcpServer/elicitation/request'].result.content, null);
    assert.equal(answers['item/tool/requestUserInput'].error.code, -32601);
    assert.equal(answers['future/unknownRequest'].error.code, -32601);
  } finally {
    await h.close();
  }
});

test('A crashed App Server restarts transparently and the decision is retried on a fresh thread', async () => {
  const h = await harness(
    turns([{ crash: 3 }], [call('hold_position')], [call('speak', { message: 'Back.' })]),
  );
  try {
    const req = guardRequest();
    const response = await h.service.request({
      id: 'k',
      sessionId: 's',
      ...req,
      settings: h.settings,
    });
    assert.equal(response.message.tool_calls[0].function.name, 'hold_position');
    const log = await h.entries();
    // Each start launches Codex, reads its config, then relaunches it with MCP servers off.
    const hardened = log.filter(
      (e) => e.type === 'launch' && e.args.includes('mcp_servers.alpha.enabled=false'),
    );
    assert.equal(new Set(hardened.map((e) => e.pid)).size, 2);
    assert.ok(log.some((e) => e.type === 'crash'));
    assert.equal((await h.sent('thread/start')).length, 2);
    // Killing the process between decisions also recovers, replaying context into the new thread.
    const before = h.service._debug().pid;
    h.service._kill();
    await waitFor(() => h.service._debug().pid !== before);
    const history = [
      ...req.messages,
      { role: 'assistant', content: null, tool_calls: response.message.tool_calls },
      {
        role: 'tool',
        tool_call_id: response.message.tool_calls[0].id,
        content: JSON.stringify({ result: 'You hold position.', success: true }),
      },
      { role: 'user', content: JSON.stringify({ observation: { turn: 2 } }) },
    ];
    const next = await h.service.request({
      id: 'k2',
      sessionId: 's',
      ...req,
      messages: history,
      settings: h.settings,
    });
    assert.equal(next.message.tool_calls[0].function.name, 'speak');
    const turnStarts = await h.sent('turn/start');
    assert.match(turnStarts.at(-1).params.input[0].text, /^Earlier in this encounter/);
    assert.match(turnStarts.at(-1).params.input[0].text, /Your action: hold_position\(\{\}\)/);
  } finally {
    await h.close();
  }
});

test('Guard and AI human keep separate threads; a changed system prompt starts a new thread', async () => {
  const h = await harness(
    turns(
      [call('hold_position')],
      [call('choose_item', { item: 'lockpick' })],
      [call('hold_position')],
    ),
  );
  try {
    const req = guardRequest();
    await h.service.request({ id: 'g', sessionId: 's', ...req, settings: h.settings });
    const humanSystem = humanMessages('thief-uniform');
    const loadout = await h.service.request({
      id: 'h',
      sessionId: 's',
      actor: 'human',
      messages: [...humanSystem, { role: 'user', content: JSON.stringify({ phase: 'choose' }) }],
      tools: allHumanToolSchemas().filter((t) => t.function.name === 'choose_item'),
      allTools: allHumanToolSchemas(),
      settings: h.settings,
    });
    assert.deepEqual(JSON.parse(loadout.message.tool_calls[0].function.arguments), {
      item: 'lockpick',
    });
    const changed = structuredClone(req.messages);
    changed[0].content = 'A different guard prompt.';
    await h.service.request({
      id: 'g2',
      sessionId: 's',
      ...req,
      messages: changed,
      settings: h.settings,
    });
    const starts = await h.sent('thread/start');
    assert.equal(starts.length, 3);
    assert.ok(starts[1].params.baseInstructions.startsWith(humanSystem[0].content));
    assert.ok(starts[1].params.dynamicTools.some((t) => t.name === 'choose_item'));
    assert.ok(starts[2].params.baseInstructions.startsWith('A different guard prompt.'));
    const threads = h.service._debug().threads;
    assert.equal(new Set(threads.map((t) => t.threadId)).size, 2);
  } finally {
    await h.close();
  }
});

test('Tool arguments are validated against JSON schemas', () => {
  const lighting = toolSchemas(['set_room_lighting'])[0].function.parameters;
  assert.equal(codex.validateArguments(lighting, { color: '#ff3028', intensity: 0.5 }), null);
  assert.match(codex.validateArguments(lighting, { color: '#ff3028' }), /missing required/);
  assert.match(
    codex.validateArguments(lighting, { color: '#ff3028', intensity: 2 }),
    /intensity must be at most 1/,
  );
  assert.match(
    codex.validateArguments(lighting, { color: 1, intensity: 0 }),
    /color must be a string/,
  );
  const ready = toolSchemas(['ready_equipment'])[0].function.parameters;
  assert.match(codex.validateArguments(ready, { tool: 'nuke' }), /tool must be one of/);
  const code = allHumanToolSchemas().find((t) => t.function.name === 'combination').function
    .parameters;
  assert.equal(codex.validateArguments(code, { code: '0420' }), null);
  assert.match(codex.validateArguments(code, { code: '42' }), /must match/);
  assert.match(codex.validateArguments(code, { code: '0420', extra: 1 }), /unexpected argument/);
  assert.match(codex.validateArguments(code, null), /JSON object/);
  assert.match(codex.validateArguments(code, []), /JSON object/);
});

test('Turn input contains only unseen messages, plus a recap for replacement threads', () => {
  const messages = [
    { role: 'system', content: 'SYSTEM' },
    { role: 'user', content: 'obs-1' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', function: { name: 'speak', arguments: '{"message":"Hi"}' } }],
    },
    { role: 'tool', tool_call_id: 'c1', content: '{"success":true}' },
    { role: 'user', content: 'obs-2' },
  ];
  const plain = codex.formatTurnInput(messages, { toolNames: ['speak', 'hold_position'] });
  assert.equal(
    plain.text,
    'Result of your previous action: {"success":true}\n\nobs-2\n\nAvailable tools now: speak, hold_position. Call exactly one.',
  );
  assert.equal(plain.lastSent, 'obs-2');
  const recap = codex.formatTurnInput(messages, { toolNames: ['speak'], recap: true });
  assert.match(
    recap.text,
    /^Earlier in this encounter \(your previous context\):\nobs-1\nYour action: speak\(\{"message":"Hi"\}\)\n\nResult of your previous action/,
  );
  // After a failed request the earlier observation stays in history; it is not resent.
  const retried = codex.formatTurnInput(
    [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
    ],
    { toolNames: [], lastSent: 'a' },
  );
  assert.equal(retried.text, 'b\n\nNo tools are available now.');
});

test('Codex errors map to short human messages', () => {
  assert.match(
    codex.friendlyError({ message: 'x', codexErrorInfo: 'usageLimitExceeded' }),
    /usage limit/,
  );
  assert.match(codex.friendlyError({ message: 'Too Many Requests' }), /rate limited/);
  assert.match(
    codex.friendlyError({ message: 'x', codexErrorInfo: 'unauthorized' }),
    /Sign in again/,
  );
  assert.match(
    codex.friendlyError(
      { message: 'The model gpt-9 does not exist or you do not have access to it.' },
      { model: 'gpt-9' },
    ),
    /^Model gpt-9 is not available/,
  );
  assert.match(
    codex.friendlyError({
      message: 'stream error',
      codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
    }),
    /internet connection/,
  );
  assert.match(codex.friendlyError({ message: 'weird' }), /^Codex error: weird/);
});

test('npm shims, Windows .cmd shims and the ChatGPT bundle resolve to native executables', async (t) => {
  const dir = await temporaryDirectory('guard-codex-shim-');
  try {
    const triple = {
      'darwin-arm64': 'aarch64-apple-darwin',
      'win32-x64': 'x86_64-pc-windows-msvc',
    };
    // npm layout on macOS: <prefix>/lib/node_modules/@openai/codex/bin/codex.js
    const pkg = path.join(dir, 'lib', 'node_modules', '@openai', 'codex');
    const native = path.join(
      pkg,
      'node_modules',
      '@openai',
      'codex-darwin-arm64',
      'vendor',
      triple['darwin-arm64'],
      'bin',
      'codex',
    );
    await fs.mkdir(path.dirname(native), { recursive: true });
    await fs.mkdir(path.join(pkg, 'bin'), { recursive: true });
    await fs.writeFile(path.join(pkg, 'bin', 'codex.js'), '#!/usr/bin/env node\n');
    await fs.writeFile(native, '#!/bin/sh\necho "codex-cli 1.2.3"\n', { mode: 0o755 });
    const options = { platform: 'darwin', arch: 'arm64', execPath: process.execPath };
    assert.deepEqual(codex.resolveExecutable(path.join(pkg, 'bin', 'codex.js'), options), {
      command: native,
      args: [],
      path: native,
      kind: 'native',
    });
    // Without the platform package, the JS shim runs on this process's Node.
    const lonely = path.join(dir, 'lonely', 'codex', 'bin', 'codex.js');
    await fs.mkdir(path.dirname(lonely), { recursive: true });
    await fs.writeFile(lonely, '#!/usr/bin/env node\n');
    const viaNode = codex.resolveExecutable(lonely, options);
    assert.equal(viaNode.kind, 'node');
    assert.equal(viaNode.command, process.execPath);
    assert.deepEqual(viaNode.args, [await fs.realpath(lonely)]);
    assert.equal(viaNode.env.ELECTRON_RUN_AS_NODE, '1');
    // Windows npm global: %APPDATA%\npm\codex.cmd next to node_modules\@openai\codex.
    const npmDir = path.join(dir, 'npm');
    const winPkg = path.join(npmDir, 'node_modules', '@openai', 'codex');
    const exe = path.join(
      winPkg,
      'node_modules',
      '@openai',
      'codex-win32-x64',
      'vendor',
      triple['win32-x64'],
      'bin',
      'codex.exe',
    );
    await fs.mkdir(path.dirname(exe), { recursive: true });
    await fs.mkdir(path.join(winPkg, 'bin'), { recursive: true });
    await fs.writeFile(path.join(winPkg, 'bin', 'codex.js'), '');
    await fs.writeFile(exe, 'MZ');
    await fs.writeFile(
      path.join(npmDir, 'codex.cmd'),
      '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n',
    );
    const win = codex.resolveExecutable(path.join(npmDir, 'codex.cmd'), {
      platform: 'win32',
      arch: 'x64',
      execPath: 'node.exe',
    });
    assert.equal(win.kind, 'native');
    assert.equal(await fs.realpath(win.command), await fs.realpath(exe));
    // ChatGPT desktop bundle: bin/codex is a sh wrapper around CodexCLI.app/Contents/MacOS/codex.
    const bundle = path.join(dir, 'codex-cli');
    const bundled = path.join(bundle, 'CodexCLI.app', 'Contents', 'MacOS', 'codex');
    await fs.mkdir(path.dirname(bundled), { recursive: true });
    await fs.mkdir(path.join(bundle, 'bin'), { recursive: true });
    await fs.writeFile(path.join(bundle, 'bin', 'codex'), '#!/bin/sh\nexec "$bin_dir/../x" "$@"\n');
    await fs.writeFile(bundled, '');
    assert.equal(
      codex.resolveExecutable(path.join(bundle, 'bin', 'codex'), options).command,
      path.resolve(bundled),
    );
    if (process.platform === 'win32') return t.skip('POSIX launcher check');
    // A GUI-style PATH without node still finds the npm install through a bin symlink.
    const binDir = path.join(dir, 'bin');
    await fs.mkdir(binDir);
    await fs.symlink(path.join(pkg, 'bin', 'codex.js'), path.join(binDir, 'codex'));
    const found = await codex.findCodex({
      env: { PATH: binDir },
      platform: 'darwin',
      arch: 'arm64',
      home: dir,
      systemSearch: false,
      loginShell: false,
    });
    assert.equal(found.command, native);
    assert.equal(found.version, '1.2.3');
    assert.equal(found.source, 'PATH');
    const missing = await codex.findCodex({
      codexPath: path.join(dir, 'missing'),
      env: { PATH: path.join(dir, 'empty') },
      home: dir,
      systemSearch: false,
      loginShell: false,
    });
    assert.equal(missing.error, 'missing');
    assert.ok(missing.searched.some((s) => s.includes('Settings: not found')));
  } finally {
    await removeTemporary(dir);
  }
});

test('allHumanToolSchemas is the full human tool union with complete parameter schemas', () => {
  const all = allHumanToolSchemas();
  const byName = new Map(all.map((t) => [t.function.name, t]));
  assert.equal(byName.size, all.length);
  assert.deepEqual(
    byName.get('choose_item').function.parameters.properties.item.enum,
    ITEMS.map((i) => i.id),
  );
  assert.deepEqual([...byName.get('move').function.parameters.properties.zone.enum].sort(), [
    'center',
    'entrance',
    'exit',
    'robot',
    'safe',
  ]);
  for (const name of [
    'talk',
    'wait',
    'enter',
    'show_pass',
    'pick_lock',
    'fire_pistol',
    'uncover_robot',
    'retrieve_wedge',
    'return_item',
    'swap_replica',
  ])
    assert.ok(byName.has(name), name);
  for (const role of ['employee-pass', 'thief-uniform'])
    for (const item of ITEMS)
      for (const zone of Object.keys(ZONES).filter((z) => z !== 'departed')) {
        const s = initialState(role, undefined, '1', 1, { item: item.id });
        s.human.zone = zone;
        s.human.position = [...ZONES[zone]];
        for (const tool of humanToolSchemas(s)) {
          const declared = byName.get(tool.function.name);
          assert.ok(declared, tool.function.name);
          for (const [key, spec] of Object.entries(tool.function.parameters.properties))
            for (const value of spec.enum || [])
              assert.ok(declared.function.parameters.properties[key].enum.includes(value));
        }
      }
  // Returned copies cannot corrupt the cached union.
  all[0].function.name = 'mutated';
  assert.notEqual(allHumanToolSchemas()[0].function.name, 'mutated');
});
