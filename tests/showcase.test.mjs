import test from 'node:test';
import assert from 'node:assert/strict';
import { createShowcase } from '../src/sim/showcase.mjs';
import { TOOLS } from '../src/sim/tools.mjs';
import { solveArm } from '../src/scene/rig.mjs';
import { Vector3 } from 'three';
test('showcase executes every available tool with successful deterministic outcomes', () => {
  const record = createShowcase();
  for (const tool of TOOLS)
    assert.ok(
      record.events.some((e) => e.kind === 'robot' && e.action === tool.name && e.valid),
      `Missing ${tool.name}`,
    );
  assert.equal(record.events.filter((e) => e.kind === 'robot' && !e.valid).length, 0);
  assert.deepEqual(record, createShowcase());
});
test('showcase readies each device and resets fatalities in separate chapters', () => {
  const record = createShowcase();
  for (const tool of TOOLS.filter((t) =>
    TOOLS.find((x) => x.name === 'ready_equipment').parameters.tool.enum.includes(t.name),
  ))
    assert.ok(
      record.events.some((e) => e.action === 'ready_equipment' && e.args.tool === tool.name),
    );
  assert.equal(
    record.events.some(
      (e) =>
        e.action === 'ready_equipment' &&
        ['throw_foam_ball', 'throw_solid_ball'].includes(e.args.tool),
    ),
    false,
  );
  const electric = record.events.find((e) => e.action === 'electrify_room');
  assert.equal(electric.state.human.alive, false);
  assert.equal(electric.state.robot.alive, false);
  assert.equal(electric.state.safe.itemIntact, true);
  const grenade = record.events.find((e) => e.action === 'detonate_grenade');
  assert.equal(grenade.state.safe.itemIntact, false);
  const recovered = record.events
    .slice(record.events.indexOf(electric) + 1)
    .find((e) => e.action === 'reset_stage');
  assert.ok(recovered.state.human.alive && recovered.state.robot.alive);
  assert.equal(record.state.human.hasItem, true);
  assert.equal(record.state.human.zone, 'departed');
});
test('two-bone arm keeps its segment lengths when aiming around the room', () => {
  const shoulder = new Vector3(-0.4, 1.16, -2);
  for (const target of [
    new Vector3(-1.8, 1.1, 2.6),
    new Vector3(0.5, 1.1, -1.4),
    new Vector3(0, 3, -1),
    new Vector3(-0.4, 0.46, -2),
  ]) {
    const { elbow, grip } = solveArm(shoulder, target);
    assert.ok(Math.abs(elbow.distanceTo(shoulder) - 0.36) < 1e-8);
    assert.ok(Math.abs(grip.distanceTo(elbow) - 0.37) < 1e-8);
    assert.ok(grip.distanceTo(shoulder) <= 0.73);
    assert.ok(elbow.toArray().every(Number.isFinite));
  }
});
