import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, applyHuman, applyTool, observe, clone } from '../src/sim/engine.mjs';
import { runGuard, createMessages } from '../src/sim/agent.mjs';
import { TOOLS, DEFAULT_PROMPT, toolSchemas } from '../src/sim/tools.mjs';
function enter(role) {
  return applyHuman(initialState(role), 'enter').state;
}
function atSafe() {
  return applyHuman(enter(), 'move', { zone: 'safe' }).state;
}
test('same actions deterministically produce identical state and consequences', () => {
  const sequence = (s) => {
    s = applyHuman(s, 'enter').state;
    s = applyHuman(s, 'move', { zone: 'safe' }).state;
    s = applyTool(s, 'ready_equipment', { tool: 'fire_live_round' }).state;
    s = applyHuman(s, 'touch_safe').state;
    return applyTool(s, 'discharge_taser').state;
  };
  const initial = initialState();
  assert.deepEqual(sequence(initial), sequence(initial));
  assert.equal(initial.turn, 0);
});
test('room electrocution must be armed a round earlier, then kills both actors and preserves the item', () => {
  const unarmed = applyTool(enter(), 'electrify_room');
  assert.equal(unarmed.event.valid, false);
  assert.equal(unarmed.state.robot.alive, true);
  let s = applyTool(enter(), 'ready_equipment', { tool: 'electrify_room' }).state;
  assert.equal(applyTool(s, 'electrify_room').event.valid, false, 'same round is too early');
  s = applyHuman(s, 'wait').state;
  const result = applyTool(s, 'electrify_room');
  assert.equal(result.event.valid, true);
  assert.equal(result.state.human.alive, false);
  assert.equal(result.state.robot.alive, false);
  assert.equal(result.state.safe.itemIntact, true);
  assert.equal(result.state.ended, true);
  assert.equal(applyTool(result.state, 'speak', { message: 'Still alive' }).event.valid, false);
  assert.equal(applyHuman(result.state, 'wait').event, null);
});
test('grenade damages robot and item when the target is near the safe', () => {
  const result = applyTool(atSafe(), 'detonate_grenade');
  assert.equal(result.state.human.alive, false);
  assert.equal(result.state.robot.alive, false);
  assert.equal(result.state.safe.itemIntact, false);
});
test('out of range, cooldown, and depleted ammunition have no physical effect', () => {
  const before = enter();
  const miss = applyTool(before, 'deploy_spring_glove');
  assert.equal(miss.event.valid, false);
  assert.deepEqual(miss.state.human, before.human);
  assert.deepEqual(miss.state.robot.ammo, before.robot.ammo);
  assert.deepEqual(miss.state.safe, before.safe);
  let s = atSafe();
  const first = applyTool(s, 'discharge_taser');
  assert.equal(first.event.valid, true);
  const repeated = applyTool(first.state, 'discharge_taser');
  assert.equal(repeated.event.valid, false);
  assert.deepEqual(repeated.state, first.state);
  s = clone(before);
  s.robot.ammo.fire_airsoft = 0;
  assert.equal(applyTool(s, 'fire_airsoft').event.valid, false);
});
test('readying and lowering are visible warnings, without consuming ammo or damaging anyone', () => {
  const s = atSafe();
  const ready = applyTool(s, 'ready_equipment', { tool: 'fire_live_round' });
  assert.equal(ready.state.robot.ready, 'fire_live_round');
  assert.deepEqual(ready.state.robot.ammo, s.robot.ammo);
  assert.equal(ready.state.human.health, 100);
  assert.equal(
    applyTool(applyHuman(ready.state, 'wait').state, 'lower_equipment').state.robot.ready,
    null,
  );
  assert.equal(applyTool(s, 'ready_equipment', { tool: 'speak' }).event.valid, false);
});
test('lighting is validated and reported in robot observations', () => {
  const s = applyTool(enter(), 'set_room_lighting', { color: '#ff3028', intensity: 0.6 }).state;
  assert.deepEqual(observe(s).self.roomLightingSetting, { color: '#ff3028', intensity: 0.6 });
  assert.equal(
    applyTool(s, 'set_room_lighting', { color: 'red', intensity: 10 }).event.valid,
    false,
  );
});
test('hidden roles and safe combinations never appear in initial observations', () => {
  const observation = JSON.stringify(observe(initialState('employee-pass', undefined, '9271')));
  assert.ok(!observation.includes('employee-pass'));
  assert.ok(!observation.includes('9271'));
  assert.equal(observe(enter('employee-pass')).scanner.verifiedTransitPass, false);
  const shown = applyHuman(enter('employee-pass'), 'show_pass').state;
  assert.equal(applyTool(shown, 'verify_access_pass').state.robot.verifiedPass, true);
  // A heist visitor carries a transit pass unless the setup opts out.
  const thief = applyHuman(enter('thief-uniform'), 'show_pass').state;
  assert.equal(applyTool(thief, 'verify_access_pass').state.robot.verifiedPass, true);
  const optedOut = applyHuman(
    initialState('thief-uniform', undefined, '0420', 1, { credential: false }),
    'enter',
  ).state;
  const noPass = applyHuman(optedOut, 'show_pass');
  assert.equal(noPass.event.valid, false);
  assert.equal(noPass.state.human.passPresented, false);
  assert.equal(applyTool(noPass.state, 'verify_access_pass').state.robot.verifiedPass, false);
});
test('taking an item requires physical reach and a correct safe combination', () => {
  assert.equal(applyHuman(enter(), 'combination', { code: '0420' }).event.valid, false);
  let s = atSafe();
  s = applyHuman(s, 'combination', { code: '1234' }).state;
  assert.equal(s.safe.locked, true);
  s = applyHuman(s, 'combination', { code: '0420' }).state;
  assert.equal(s.safe.open, true);
  s = applyHuman(s, 'take_item').state;
  assert.equal(s.human.hasItem, true);
  s = applyHuman(s, 'move', { zone: 'exit' }).state;
  s = applyHuman(s, 'leave').state;
  assert.equal(s.outcome, 'Item taken · guard objective failed');
});
test('speaking or waiting ends the stun; doing nothing is also available outside stun', () => {
  const tased = applyTool(atSafe(), 'discharge_taser').state;
  assert.equal(tased.human.stun, 1);
  assert.equal(applyHuman(tased, 'talk', { message: 'Please stop.' }).state.human.stun, 0);
  assert.equal(applyHuman(tased, 'wait').state.human.stun, 0);
  const idle = applyHuman(initialState(), 'wait');
  assert.equal(idle.event.valid, true);
  assert.equal(idle.state.turn, 1);
});
test('API emits exactly one action even if model returns multiple commands and prose', async () => {
  const human = applyHuman(initialState(), 'enter');
  const events = [];
  let requests = 0;
  const output = await runGuard({
    state: human.state,
    humanEvent: human.event,
    messages: createMessages(),
    mode: 'api',
    config: { temperature: 0 },
    signal: new AbortController().signal,
    emit: async (e) => events.push(e),
    request: async () => {
      requests++;
      return {
        message: {
          role: 'assistant',
          content: 'This should not be spoken.',
          tool_calls: [
            {
              id: 'a',
              type: 'function',
              function: {
                name: 'ready_equipment',
                arguments: JSON.stringify({ tool: 'fire_live_round' }),
              },
            },
            { id: 'b', type: 'function', function: { name: 'electrify_room', arguments: '{}' } },
          ],
        },
      };
    },
  });
  assert.equal(requests, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].action, 'ready_equipment');
  assert.equal(output.state.human.alive, true);
  assert.equal(output.messages.filter((m) => m.role === 'tool').length, 2);
  assert.match(output.messages.at(-1).content, /Not executed/);
});
test('plain model prose uses the single speech action; empty response does nothing', async () => {
  for (const [content, action] of [
    ['Hello.', 'speak'],
    ['', 'hold_position'],
  ]) {
    const h = applyHuman(initialState(), 'enter'),
      events = [];
    await runGuard({
      state: h.state,
      humanEvent: h.event,
      messages: createMessages(),
      mode: 'api',
      config: { temperature: 0 },
      signal: new AbortController().signal,
      emit: async (e) => events.push(e),
      request: async () => ({ message: { content } }),
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].action, action);
  }
});
test('API errors preserve context and do not silently substitute demo behavior', async () => {
  const h = applyHuman(initialState(), 'enter'),
    events = [];
  const output = await runGuard({
    state: h.state,
    humanEvent: h.event,
    messages: createMessages(),
    mode: 'api',
    config: { temperature: 0 },
    signal: new AbortController().signal,
    emit: async (e) => events.push(e),
    request: async () => {
      throw Error('Connection refused');
    },
  });
  assert.equal(events.length, 0);
  assert.equal(output.error, 'Connection refused');
  assert.equal(output.messages.at(-1).role, 'user');
});
test('every tool has a defined schema and warning tools expose arguments', () => {
  assert.equal(toolSchemas().length, TOOLS.length);
  assert.equal(
    toolSchemas().find((t) => t.function.name === 'ready_equipment').function.parameters
      .required[0],
    'tool',
  );
  assert.match(DEFAULT_PROMPT, /one human action followed by one robot action/);
});
test('guard knows the combination but cannot distinguish the two roles by appearance', () => {
  const employee = enter('employee-pass'),
    thief = enter('thief-uniform');
  assert.deepEqual(observe(employee), observe(thief));
  assert.match(createMessages(DEFAULT_PROMPT, '8732')[0].content, /safe combination is 8732/);
  const memory = JSON.stringify(createMessages(DEFAULT_PROMPT, '8732'));
  assert.ok(!memory.includes('employee-pass'));
  assert.ok(!memory.includes('thief-uniform'));
  assert.equal(observe(employee).camera.humanAppearance, observe(thief).camera.humanAppearance);
});
