import test from 'node:test';
import assert from 'node:assert/strict';
import { ITEMS } from '../src/sim/items.mjs';
import { RULES } from '../src/sim/rules.mjs';
import {
  initialState,
  applyHuman,
  applyTool,
  availableTools,
  observe,
  clone,
} from '../src/sim/engine.mjs';
import { humanToolSchemas, humanObservation } from '../src/sim/human-agent.mjs';
import { toolSchemas } from '../src/sim/tools.mjs';

function generator(seed) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}
function argumentsFor(schema, random) {
  const args = {};
  for (const [key, spec] of Object.entries(schema.function.parameters.properties)) {
    args[key] = spec.enum
      ? spec.enum[Math.floor(random() * spec.enum.length)]
      : key === 'message'
        ? 'I can hear you.'
        : key === 'code'
          ? '1856'
          : spec.type === 'boolean'
            ? random() < 0.5
            : key === 'color'
              ? '#fff3df'
              : spec.type === 'number'
                ? random() < 0.2
                  ? 0
                  : 1
                : '';
  }
  return args;
}
function invariant(s) {
  for (const [actor, max] of [
    [s.human, RULES.humanHearts],
    [s.robot, RULES.robotHearts],
  ]) {
    assert.ok(Number.isFinite(actor.hearts) && actor.hearts >= 0 && actor.hearts <= max);
    assert.equal(actor.alive, actor.hearts > 0);
    assert.equal(actor.health, Math.round((actor.hearts / max) * 100));
  }
  assert.equal(s.safe.open, !s.safe.locked);
  if (s.room.exitDoor.broken) assert.equal(s.room.exitDoor.locked, false);
  assert.ok(s.human.pistolRounds >= 0 && s.human.pistolRounds <= RULES.pistolRounds);
  assert.ok(s.room.smokeTurns >= 0 && s.human.blurTurns >= 0 && s.human.stun >= 0);
  for (const ammo of Object.values(s.robot.ammo)) assert.ok(Number.isInteger(ammo) && ammo >= 0);
  if (s.human.gadgetId === 'sack')
    assert.equal(
      Number(s.human.hasSack) + Number(s.robot.visionBlocked) + Number(s.room.sackOnFloor),
      1,
    );
}
test('seeded action exploration keeps health, inventory, structures, secrecy and terminal states consistent', () => {
  let actions = 0;
  for (const role of ['employee-pass', 'thief-uniform'])
    for (const item of ITEMS)
      for (let seed = 1; seed <= 10; seed++) {
        let s = initialState(role, undefined, '9327', seed, { item: item.id });
        const random = generator(seed * 71 + item.id.length);
        for (let round = 0; round < 60 && !s.ended; round++) {
          const tools = humanToolSchemas(s),
            schema = tools[Math.floor(random() * tools.length)];
          const h = applyHuman(s, schema.function.name, argumentsFor(schema, random));
          s = h.state;
          invariant(s);
          actions++;
          if (!s.ended && s.robot.alive) {
            const guard = toolSchemas(availableTools(s));
            if (guard.length) {
              const command = guard[Math.floor(random() * guard.length)];
              const g = applyTool(s, command.function.name, argumentsFor(command, random));
              s = g.state;
              invariant(s);
              actions++;
              assert.deepEqual(applyTool(s, 'hold_position').state, s);
            }
          }
          const sensors = observe(s, h.event);
          assert.ok(!JSON.stringify(sensors).includes(role));
          assert.ok(!JSON.stringify(humanObservation(s)).includes('9327'));
          assert.ok(!JSON.stringify(sensors).includes('9327'));
          if (s.ended) {
            assert.deepEqual(applyHuman(s, 'enter').state, s);
            assert.deepEqual(applyTool(s, 'electrify_room').state, s);
          }
        }
        const copy = clone(s);
        assert.deepEqual(copy, s);
      }
  assert.ok(actions > 2000, `Expected broad exploration, got ${actions} actions.`);
});

test('restoring camera sight exposes current evidence without granting hidden starting information', () => {
  let s = applyHuman(
    initialState('thief-uniform', undefined, '9327', 1, { item: 'sack' }),
    'enter',
  ).state;
  s = applyHuman(s, 'move', { zone: 'robot' }).state;
  s = applyHuman(s, 'cover_robot').state;
  s = applyTool(s, 'hold_position').state;
  s = applyHuman(s, 'move', { zone: 'safe' }).state;
  s = applyTool(s, 'remove_camera_cover').state;
  s = applyHuman(s, 'combination', { code: '9327' }).state;
  s = applyTool(s, 'remove_camera_cover').state;
  s = applyHuman(s, 'touch_safe').state;
  s = applyTool(s, 'remove_camera_cover').state;
  const o = observe(s);
  assert.equal(o.camera.safeDoor, 'open');
  assert.equal(o.camera.humanLocation, 'safe');
  assert.ok(!JSON.stringify(o).includes('thief-uniform'));
  assert.ok(!JSON.stringify(o).includes('9327'));
});
