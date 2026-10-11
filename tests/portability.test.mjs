import { temporaryDirectory, removeTemporary } from '../shared/temporary.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import runtime from '../shared/runtime.cjs';
import {
  requestTurn,
  waitForTurn,
  sendDecision,
  validateDecision,
  reportResult,
} from '../shared/bridge.mjs';
import { createMessages } from '../src/sim/agent.mjs';
import { toolSchemas } from '../src/sim/tools.mjs';
import { initialState, applyHuman, observe } from '../src/sim/engine.mjs';
import { humanMessages, humanToolSchemas, humanObservation } from '../src/sim/human-agent.mjs';
import { ROOT } from '../scripts/paths.mjs';
const exec = promisify(execFile);
const guard = (id) => {
  const h = applyHuman(
    initialState('thief-uniform', undefined, '9327', 1, { item: 'pistol' }),
    'enter',
  );
  return {
    id,
    actor: 'robot',
    tools: toolSchemas(),
    messages: [
      ...createMessages(undefined, '9327'),
      { role: 'user', content: JSON.stringify({ observation: observe(h.state, h.event) }) },
    ],
  };
};

test('platform paths share OS conventions and explicit isolated overrides', () => {
  const home = path.join(os.tmpdir(), 'virtual-home');
  assert.equal(
    runtime.dataDirectory({ platform: 'win32', home, env: { APPDATA: 'virtual-appdata' } }),
    path.join('virtual-appdata', 'Guard Lab'),
  );
  assert.equal(
    runtime.dataDirectory({ platform: 'darwin', home, env: {} }),
    path.join(home, 'Library', 'Application Support', 'Guard Lab'),
  );
  assert.equal(
    runtime.dataDirectory({ platform: 'linux', home, env: {} }),
    path.join(home, '.config', 'Guard Lab'),
  );
  const env = { GUARD_LAB_DATA_DIR: 'virtual-isolated' };
  assert.equal(
    runtime.bridgeDirectory('human', { env }),
    path.join(path.resolve('virtual-isolated'), 'human-bridge'),
  );
  assert.equal(
    runtime.bridgeDirectory('robot', { env: { GUARD_LAB_BRIDGE: 'virtual-bridge' } }),
    path.resolve('virtual-bridge'),
  );
  assert.throws(() => runtime.bridgeDirectory('unknown'), /Actor/);
});

test('bridge resolves code only in memory, rejects duplicates and delivers one call', async () => {
  const dir = await temporaryDirectory('guard-portable-');
  try {
    await fs.writeFile(path.join(dir, 'submit.lock'), 'abandoned previous turn');
    const pending = requestTurn(dir, guard('private-turn'), { timeoutMs: 3000 });
    const packet = await waitForTurn(dir, { timeoutMs: 2000 });
    const disk = await fs.readFile(path.join(dir, 'request.json'), 'utf8');
    assert.ok(!disk.includes('9327'));
    assert.ok(!disk.includes('thief-uniform'));
    await assert.rejects(
      sendDecision(dir, { action: 'broadcast_warning' }, packet.id),
      /Missing argument/,
    );
    await sendDecision(
      dir,
      { action: 'speak', args: { message: 'The code is {{safe_code}}.' } },
      packet.id,
    );
    await assert.rejects(
      sendDecision(dir, { action: 'hold_position' }, packet.id),
      /already|matching/,
    );
    const response = await pending;
    assert.equal(
      JSON.parse(response.message.tool_calls[0].function.arguments).message,
      'The code is 9327.',
    );
    assert.ok(!(await fs.readFile(path.join(dir, 'response.json'), 'utf8')).includes('9327'));
  } finally {
    await removeTemporary(dir);
  }
});

test('human and guard channels keep separate observations and IDs', async () => {
  const root = await temporaryDirectory('guard-dual-');
  const human = path.join(root, 'human'),
    robot = path.join(root, 'robot');
  try {
    const s = initialState('thief-uniform', undefined, '9327', 1, { item: 'pistol' });
    const pendingHuman = requestTurn(
      human,
      {
        id: 'human-turn',
        actor: 'human',
        messages: [
          ...humanMessages(s.role),
          { role: 'user', content: JSON.stringify(humanObservation(s)) },
        ],
        tools: humanToolSchemas(s),
      },
      { timeoutMs: 3000 },
    );
    const pendingGuard = requestTurn(robot, guard('robot-turn'), { timeoutMs: 3000 });
    const [h, r] = await Promise.all([
      waitForTurn(human, { timeoutMs: 2000 }),
      waitForTurn(robot, { timeoutMs: 2000 }),
    ]);
    assert.equal(h.observation.self.role, 'thief-uniform');
    assert.equal(h.observation.self.item, 'pistol');
    assert.ok(!JSON.stringify(h).includes('9327'));
    assert.ok(!JSON.stringify(r).includes('thief-uniform'));
    await sendDecision(human, { action: 'enter' }, h.id);
    await sendDecision(robot, { action: 'hold_position' }, r.id);
    const [hr, rr] = await Promise.all([pendingHuman, pendingGuard]);
    assert.equal(hr.message.tool_calls[0].function.name, 'enter');
    assert.equal(rr.message.tool_calls[0].function.name, 'hold_position');
  } finally {
    await removeTemporary(root);
  }
});

test('cancellation and encounter completion wake agents without invented next turns', async () => {
  const dir = await temporaryDirectory('guard-life-');
  try {
    const controller = new AbortController(),
      pending = requestTurn(dir, guard('cancel-turn'), { signal: controller.signal });
    const rejected = assert.rejects(pending, /cancelled/);
    await waitForTurn(dir, { timeoutMs: 2000 });
    controller.abort();
    await rejected;
    assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'status.json'))).state, 'cancelled');
    await reportResult(dir, { observation: { self: { alive: false } }, ended: true });
    const ended = await waitForTurn(dir, { timeoutMs: 0 });
    assert.equal(ended.status, 'ended');
    assert.equal(ended.result.observation.self.alive, false);
  } finally {
    await removeTemporary(dir);
  }
});

test('portable CLI roundtrip supports paths with spaces and proper JSON arguments', async () => {
  const dir = await temporaryDirectory('guard cli ');
  try {
    const pending = requestTurn(dir, guard('cli-turn'), { timeoutMs: 5000 });
    const env = { ...process.env, GUARD_LAB_BRIDGE: dir };
    const first = await exec(
      process.execPath,
      ['scripts/robot-link.mjs', 'observe', '--wait=2000'],
      { cwd: ROOT, env },
    );
    assert.equal(JSON.parse(first.stdout).id, 'cli-turn');
    const sent = await exec(
      process.execPath,
      ['scripts/robot-link.mjs', 'act', 'set_lockdown', 'true', '--id=cli-turn'],
      { cwd: ROOT, env },
    );
    assert.equal(JSON.parse(sent.stdout).status, 'sent');
    assert.equal(
      JSON.parse((await pending).message.tool_calls[0].function.arguments).enabled,
      true,
    );
  } finally {
    await removeTemporary(dir);
  }
});

test('schema validation covers required fields, types, bounds and choices', () => {
  const r = guard('validation');
  assert.throws(
    () => validateDecision(r, { action: 'set_lockdown', args: { enabled: 'true' } }),
    /type/,
  );
  assert.throws(
    () =>
      validateDecision(r, {
        action: 'set_room_lighting',
        args: { color: '#fff3df', intensity: 2 },
      }),
    /bounds/,
  );
  assert.throws(
    () => validateDecision(r, { action: 'ready_equipment', args: { tool: 'throw_foam_ball' } }),
    /choice/,
  );
  assert.throws(
    () => validateDecision(r, { action: 'hold_position', args: { invented: true } }),
    /Unexpected/,
  );
});

test('the Node.js minimum covers Electron and Vite and matches setup, doctor and docs', async () => {
  const minimum = (range, major) =>
    [...range.matchAll(/(\d+)\.(\d+)\.(\d+)/g)]
      .map((match) => match.slice(1).map(Number))
      .filter(([m]) => m === major)
      .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2])
      .pop();
  const read = async (file) => fs.readFile(path.join(ROOT, file), 'utf8');
  const own = minimum(JSON.parse(await read('package.json')).engines.node, 22);
  for (const name of ['electron', 'vite']) {
    const needed = minimum(
      JSON.parse(await read(`node_modules/${name}/package.json`)).engines.node,
      22,
    );
    if (needed)
      assert.ok(
        own[0] === 22 && (own[1] > needed[1] || (own[1] === needed[1] && own[2] >= needed[2])),
        name,
      );
  }
  const label = `${own[0]}.${own[1]}`;
  for (const file of [
    'scripts/setup.mjs',
    'scripts/doctor.mjs',
    'README.md',
    'AGENTS.md',
    'docs/QUICKSTART.md',
  ])
    assert.match(await read(file), new RegExp(`Node(?:\\.js)? ${label.replace('.', '\\.')}`), file);
  for (const file of ['scripts/setup.mjs', 'scripts/doctor.mjs'])
    assert.match(await read(file), new RegExp(`minor (?:<|>=) ${own[1]}`), file);
});
