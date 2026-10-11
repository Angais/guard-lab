import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, applyHuman, applyTool } from '../src/sim/engine.mjs';
import {
  humanObservation,
  humanToolSchemas,
  chooseHumanLoadout,
  humanDecision,
  humanMessages,
} from '../src/sim/human-agent.mjs';
import { ITEMS } from '../src/sim/items.mjs';
const make = (item) =>
  applyHuman(initialState('thief-uniform', undefined, '9276', 1, { item }), 'enter').state;
test('human AI chooses its item from the catalogue without receiving the safe combination', async () => {
  let payload;
  const item = await chooseHumanLoadout({
    role: 'thief-uniform',
    mode: 'api',
    signal: new AbortController().signal,
    request: async (p) => {
      payload = p;
      return {
        message: {
          tool_calls: [{ function: { name: 'choose_item', arguments: '{"item":"pistol"}' } }],
        },
      };
    },
  });
  assert.equal(item, 'pistol');
  assert.equal(payload.tools[0].function.parameters.properties.item.enum.length, 11);
  assert.ok(!JSON.stringify(payload).includes('9276'));
});
test('human observes own role and items but cannot see the private code or hidden guard choices', () => {
  const s = make('pistol'),
    o = humanObservation(s);
  assert.equal(o.self.role, 'thief-uniform');
  assert.equal(o.self.pistolRounds, 4);
  assert.equal(o.camera.robotHearts, 3);
  assert.ok(!JSON.stringify(o).includes('9276'));
  s.room.lighting.intensity = 0;
  const blind = humanObservation(s, {
    speech: 'I can hear you.',
    action: 'ready_equipment',
    text: 'Hidden equipment.',
  });
  assert.equal(blind.camera.robotHearts, undefined);
  assert.equal(blind.lastRobotAction, null);
  assert.equal(blind.microphone, 'I can hear you.');
});
test('human action schemas cover all gadgets, gun targets and stun speech-only rules', () => {
  const actions = new Set();
  for (const item of ITEMS) {
    const s = make(item.id);
    s.human.zone = item.id === 'sack' ? 'robot' : item.id === 'door_wedge' ? 'exit' : 'safe';
    s.safe.open = item.id === 'replica';
    for (const t of humanToolSchemas(s)) actions.add(t.function.name);
  }
  for (const name of [
    'cover_robot',
    'toggle_flashlight',
    'place_wedge',
    'pick_lock',
    'swap_replica',
    'show_work_order',
    'use_smoke',
    'aim_pistol',
    'fire_pistol',
    'fire_pistol_at_safe',
    'break_safe',
    'combination',
    'talk',
    'wait',
    'move',
    'run',
  ])
    assert.ok(actions.has(name), name);
  const close = applyHuman(make('pistol'), 'move', { zone: 'center' }).state,
    s = applyTool(close, 'discharge_taser').state;
  assert.deepEqual(
    humanToolSchemas(s).map((t) => t.function.name),
    ['talk', 'wait'],
  );
});
test('human AI takes only the first call and hearing robot dialogue can convey a deliberately spoken code', async () => {
  const s = make('pistol');
  const result = await humanDecision({
    state: s,
    messages: humanMessages(s.role),
    lastRobotEvent: { speech: 'The code is 9276.' },
    mode: 'api',
    signal: new AbortController().signal,
    request: async (p) => {
      assert.equal(JSON.parse(p.messages.at(-1).content).microphone, 'The code is 9276.');
      return {
        message: {
          tool_calls: [
            { id: 'one', function: { name: 'aim_pistol', arguments: '{}' } },
            { id: 'two', function: { name: 'fire_pistol', arguments: '{}' } },
          ],
        },
      };
    },
  });
  assert.equal(result.state.human.pistolAimed, true);
  assert.equal(result.state.human.pistolRounds, 4);
  assert.equal(result.state.turn, s.turn + 1);
  assert.equal(result.messages.at(-1).tool_call_id, 'one');
});
