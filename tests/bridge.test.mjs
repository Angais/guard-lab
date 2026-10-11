import { temporaryDirectory, removeTemporary } from '../shared/temporary.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  sensorPacket,
  waitForTurn,
  listenForTurn,
  sendDecision,
  requestTurn,
} from '../scripts/bridge.mjs';
import { createMessages, compactContext } from '../src/sim/agent.mjs';
import { initialState, applyHuman, observe } from '../src/sim/engine.mjs';
import { toolSchemas } from '../src/sim/tools.mjs';
import { allHumanToolSchemas, humanMessages } from '../src/sim/human-agent.mjs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { ROOT } from '../scripts/paths.mjs';
const request = (id = 'turn-1') => {
  const h = applyHuman(
    initialState('thief-uniform', undefined, '9327', 1, { item: 'replica' }),
    'enter',
  );
  return {
    id,
    messages: [
      ...createMessages(undefined, '9327'),
      { role: 'user', content: JSON.stringify({ observation: observe(h.state, h.event) }) },
    ],
    tools: toolSchemas(),
  };
};
test('agent listener stays active across idle waits and returns the next permitted packet', async () => {
  const directory = await temporaryDirectory('guard-listener-');
  const controller = new AbortController();
  try {
    let completed = false;
    const listening = listenForTurn(directory, { timeoutMs: 20, signal: controller.signal }).then(
      (packet) => {
        completed = true;
        return packet;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 90));
    assert.equal(completed, false, 'idle intervals must not finish the agent listener');
    const r = request('delayed-human-move');
    await fs.writeFile(path.join(directory, 'request.json'), JSON.stringify(r));
    await fs.writeFile(
      path.join(directory, 'status.json'),
      JSON.stringify({ id: r.id, state: 'waiting' }),
    );
    const packet = await listening;
    assert.equal(packet.id, r.id);
    assert.ok(!JSON.stringify(packet).includes('9327'));
  } finally {
    controller.abort();
    await removeTemporary(directory);
  }
});
test('agent listener stops on encounter end or cancellation and rejects busy-spin waits', async () => {
  const directory = await temporaryDirectory('guard-listener-end-');
  try {
    await assert.rejects(listenForTurn(directory, { timeoutMs: 0 }), /greater than 0/);
    const controller = new AbortController();
    controller.abort();
    assert.equal(
      (await listenForTurn(directory, { signal: controller.signal })).status,
      'cancelled',
    );
    await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify({ ended: true }));
    assert.equal((await listenForTurn(directory)).status, 'ended');
  } finally {
    await removeTemporary(directory);
  }
});
test('bridge packet preserves compacted dialogue and hides private combination and loadout', () => {
  const r = request();
  r.messages.splice(
    1,
    0,
    {
      role: 'user',
      content: JSON.stringify({
        observation: {
          turn: 0,
          lastAction: { actor: 'human', action: 'talk', result: 'I have permission.' },
          camera: {},
          scanner: {},
        },
      }),
    },
    { role: 'assistant', content: 'Show me your pass.' },
  );
  r.messages = compactContext(r.messages);
  const packet = sensorPacket(r);
  assert.equal(packet.recentHistory[0].result, 'I have permission.');
  assert.equal(packet.recentHistory[1].speech, 'Show me your pass.');
  assert.equal(packet.hasCombinationMemory, true);
  assert.ok(!JSON.stringify(packet).includes('9327'));
  assert.ok(!JSON.stringify(packet).includes('thief-uniform'));
  assert.ok(!JSON.stringify(packet.observation).includes('replica'));
  assert.equal(packet.tools.length, toolSchemas().length);
  assert.ok(packet.instructions.includes('{{safe_code}}'));
});
test('bridge detects a turn, rejects stale replies, and atomically sends one response', async () => {
  const directory = await temporaryDirectory('guard-bridge-');
  try {
    const r = request();
    const waiting = waitForTurn(directory, { timeoutMs: 1200 });
    await fs.writeFile(path.join(directory, 'request.json'), JSON.stringify(r));
    await fs.writeFile(
      path.join(directory, 'status.json'),
      JSON.stringify({ id: r.id, state: 'waiting' }),
    );
    assert.equal((await waiting).id, r.id);
    await assert.rejects(
      sendDecision(directory, { action: 'speak', args: { message: 'Hello' } }, 'stale'),
      /matching/,
    );
    await assert.rejects(sendDecision(directory, { action: 'unknown' }, r.id), /Unavailable/);
    const sent = await sendDecision(
      directory,
      { action: 'speak', args: { message: 'The code is {{safe_code}}.' } },
      r.id,
    );
    assert.equal(sent.status, 'sent');
    const reply = JSON.parse(await fs.readFile(path.join(directory, 'response.json')));
    assert.equal(reply.args.message, 'The code is {{safe_code}}.');
    assert.equal(typeof reply.sentAt, 'number');
    await assert.rejects(sendDecision(directory, { action: 'hold_position' }, r.id), /already/);
    assert.equal(
      (await waitForTurn(directory, { timeoutMs: 20, afterId: r.id })).status,
      'awaiting_next_turn',
    );
  } finally {
    await removeTemporary(directory);
  }
});
test('custom prompt examples cannot shadow the actual private combination memory', async () => {
  const directory = await temporaryDirectory('guard-code-memory-');
  try {
    const r = request('memory-turn');
    r.messages[0].content = 'An obsolete safe combination is 1111.\n' + r.messages[0].content;
    const pending = requestTurn(directory, r, { timeoutMs: 3000 });
    const packet = await waitForTurn(directory, { timeoutMs: 3000 });
    assert.ok(!JSON.stringify(packet).includes('9327'));
    await sendDecision(
      directory,
      { action: 'speak', args: { message: '{{safe_code}}' } },
      packet.id,
    );
    assert.equal(
      JSON.parse((await pending).message.tool_calls[0].function.arguments).message,
      '9327',
    );
  } finally {
    await removeTemporary(directory);
  }
});
test('every tool that needs arguments has a CLI shortcut; pick_up takes its object', async () => {
  const directory = await temporaryDirectory('guard-pickup-');
  try {
    const id = '00000003-1111-4111-8111-111111111111';
    const pending = requestTurn(
      directory,
      {
        id,
        actor: 'human',
        messages: [
          ...humanMessages('thief-uniform'),
          { role: 'user', content: JSON.stringify({ turn: 3 }) },
        ],
        tools: allHumanToolSchemas().filter((t) => ['pick_up', 'wait'].includes(t.function.name)),
      },
      { timeoutMs: 5000 },
    );
    await waitForTurn(directory, { timeoutMs: 1000 });
    const child = spawn(
      process.execPath,
      ['scripts/robot-link.mjs', 'act', 'pick_up', 'original', '--id=00000003', '--actor=human'],
      {
        cwd: ROOT,
        env: { ...process.env, GUARD_LAB_HUMAN_BRIDGE: directory },
        windowsHide: true,
        stdio: 'ignore',
      },
    );
    assert.equal((await once(child, 'close'))[0], 0);
    const call = (await pending).message.tool_calls[0].function;
    assert.equal(call.name, 'pick_up');
    assert.deepEqual(JSON.parse(call.arguments), { object: 'original' });
    // Every argument-taking tool is covered by a positional shortcut in robot-link.mjs.
    const source = await fs.readFile(path.join(ROOT, 'scripts', 'robot-link.mjs'), 'utf8');
    for (const tool of [...allHumanToolSchemas(), ...toolSchemas()])
      if (tool.function.parameters?.required?.length)
        assert.ok(
          source.includes(`'${tool.function.name}'`),
          `${tool.function.name} needs a positional shortcut in scripts/robot-link.mjs`,
        );
  } finally {
    await removeTemporary(directory);
  }
});
