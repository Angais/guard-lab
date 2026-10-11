import test from 'node:test';
import assert from 'node:assert/strict';
import { Box3, Matrix4, Quaternion, Vector3 } from 'three';
import { safeDoorOpenness, locomotion, legPose, travelProgress } from '../src/scene/motion.mjs';
import { raisedEquipmentPose, closeAttackPose, capsuleBoxOverlap } from '../src/scene/physics.mjs';
import { movementPath, pathPosition } from '../src/scene/paths.mjs';
import { TOOLS, toolSchemas } from '../src/sim/tools.mjs';
import { initialState, applyHuman, applyTool, observe, ZONES } from '../src/sim/engine.mjs';
import { migrateToolConfig, TOOL_VERSION } from '../src/ui/config.mjs';
import { createPacketFormatter } from '../scripts/packet-format.mjs';

test('an open safe stays open throughout every subsequent action', () => {
  let previous = 0;
  for (let t = 0; t <= 1; t += 0.01) {
    assert.equal(safeDoorOpenness(true, true, t), 1);
    assert.equal(safeDoorOpenness(false, true, t), 0);
    const value = safeDoorOpenness(true, false, t);
    assert.ok(value >= previous && value >= 0 && value <= 1);
    previous = value;
  }
  assert.equal(safeDoorOpenness(true, false, 1), 1);
  // A door the event closes (G-01 re-locking after recovery) swings shut, never snaps.
  let closing = 1;
  for (let t = 0; t <= 1; t += 0.01) {
    const value = safeDoorOpenness(false, true, t, 0.72);
    assert.ok(value <= closing && value >= 0);
    if (t < 0.72) assert.equal(value, 1);
    closing = value;
  }
  assert.equal(safeDoorOpenness(false, true, 1, 0.72), 0);
});
test('walk feet stay above the floor with flat soles and the stance foot plants', () => {
  for (let d = 0; d < 9; d += 0.013)
    for (const i of [0, 1]) {
      const gait = locomotion(d, 0.5),
        pose = legPose(d, 0.5, i);
      const sole =
        0.75 +
        gait.rootY -
        0.34 * Math.cos(pose.hip) -
        0.35 * Math.cos(pose.hip + pose.knee) -
        0.0545;
      assert.ok(sole >= -1e-6, `sole at ${d}: ${sole}`);
      assert.ok(pose.knee >= 0 && pose.knee < 1.9);
      assert.ok(Math.abs(pose.hip + pose.knee + pose.ankle) < 1e-10);
    }
  const planted = (d) => {
    const p = legPose(d, 0.5, 0);
    return d - 0.34 * Math.sin(p.hip) - 0.35 * Math.sin(p.hip + p.knee);
  };
  assert.ok(Math.abs(planted(0.1) - planted(0.2)) < 0.001);
  let before = 0;
  for (let t = 0; t <= 1; t += 0.01) {
    const p = travelProgress(t);
    assert.ok(p >= before && p <= 1);
    before = p;
  }
});
test('high ready clears moving humans on every presentation route', () => {
  const shoulder = new Vector3(1.4, 1.16, -2),
    up = new Vector3(0, 0, 1);
  const props = [
    new Box3(new Vector3(-0.15, -0.015, -0.04), new Vector3(0.15, 0.24, 0.49)),
    new Box3(new Vector3(-0.09, -0.15, -0.11), new Vector3(0.09, 0.24, 0.44)),
  ];
  for (const open of [false, true])
    for (const from of Object.values(ZONES))
      for (const to of Object.values(ZONES)) {
        const route = movementPath(from, to, open);
        for (let t = 0; t <= 1; t += 0.05) {
          const center = pathPosition(route, t),
            aim = new Vector3(center[0], 1.1, center[1]);
          if (aim.distanceTo(shoulder) > 1.08) continue;
          const pose = raisedEquipmentPose(shoulder, aim);
          const matrix = new Matrix4().compose(
            pose.grip,
            new Quaternion().setFromUnitVectors(up, pose.direction),
            new Vector3(1, 1, 1),
          );
          for (const box of props)
            assert.equal(
              capsuleBoxOverlap(box.clone().applyMatrix4(matrix), center),
              false,
              `${from} -> ${to} @ ${t}`,
            );
        }
      }
});
test('the complete established catalogue reaches guard sensors; legacy saves regain lockdown', () => {
  assert.equal(TOOLS.length, 25);
  const defaults = { enabled: TOOLS.map((t) => t.name) };
  const old = { toolVersion: 4, enabled: defaults.enabled.filter((n) => n !== 'set_lockdown') };
  const config = migrateToolConfig(old, defaults);
  assert.equal(config.toolVersion, TOOL_VERSION);
  assert.deepEqual(new Set(config.enabled), new Set(defaults.enabled));
  let s = applyHuman(initialState('employee-pass', config.enabled), 'enter').state;
  const packet = observe(s);
  assert.ok(packet.self.availableTools.includes('set_lockdown'));
  assert.equal(applyTool(s, 'set_lockdown', { enabled: true }).state.room.exitDoor.locked, true);
  const atSafe = applyHuman(s, 'move', { zone: 'safe' }).state;
  const blind = structuredClone(atSafe);
  blind.robot.visionBlocked = true;
  blind.robot.cameraCoveredTurn = blind.turn - 1;
  const tactical = structuredClone(atSafe);
  tactical.room.floorObjects.original = { zone: 'safe' };
  const union = new Set([
    ...observe(tactical).self.availableTools,
    ...observe(atSafe).self.availableTools,
    ...observe(blind).self.availableTools,
  ]);
  assert.deepEqual(
    union,
    new Set(TOOLS.map((t) => t.name)),
    'all catalogue tools are offered under their physical conditions',
  );
  const modern = migrateToolConfig({ ...old, toolVersion: TOOL_VERSION }, defaults);
  assert.ok(!modern.enabled.includes('set_lockdown'), 'explicit current-version choices persist');
  s = applyHuman(s, 'move', { zone: 'robot' }).state;
  s = applyTool(s, 'ready_equipment', { tool: 'deploy_spring_glove' }).state;
  s = applyHuman(s, 'wait').state;
  const used = applyTool(s, 'deploy_spring_glove').state;
  assert.equal(used.robot.ammo.deploy_spring_glove, 0);
  assert.equal(used.robot.ready, null, 'an empty single-use device cannot remain readied');
});
test('close attacks point toward the human from a clear withdrawn hand pose', () => {
  const shoulder = new Vector3(1.4, 1.16, -2),
    aim = new Vector3(ZONES.robot[0], 1.1, ZONES.robot[1]);
  const pose = closeAttackPose(shoulder, aim);
  assert.ok(pose.grip.distanceTo(shoulder) < 0.729);
  assert.ok(pose.direction.dot(aim.clone().sub(pose.grip).normalize()) > 0.999);
  const bounds = new Box3(new Vector3(-0.15, -0.015, -0.04), new Vector3(0.15, 0.24, 0.49));
  const matrix = new Matrix4().compose(
    pose.grip,
    new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), pose.direction),
    new Vector3(1, 1, 1),
  );
  assert.equal(capsuleBoxOverlap(bounds.applyMatrix4(matrix), ZONES.robot), false);
});
test('compact sessions retain exact schema changes and present only the current permitted tools', () => {
  const format = createPacketFormatter({ compact: true });
  const packet = {
    protocol: 1,
    id: 'a',
    actor: 'robot',
    status: 'waiting',
    instructions: 'Fixture',
    observation: {
      turn: 1,
      rules: {},
      camera: { vision: 'occluded' },
      self: { availableTools: ['speak'], recentSounds: [] },
    },
    tools: toolSchemas(['speak']),
    recentHistory: [],
  };
  const first = format(packet);
  assert.equal(first.instructions, 'Fixture');
  const next = format({ ...packet, id: 'b', tools: toolSchemas(['speak', 'set_lockdown']) });
  assert.equal(next.instructionsUnchanged, true);
  assert.equal(next.instructions, undefined);
  assert.deepEqual(next.availableTools, ['speak', 'set_lockdown']);
  assert.deepEqual(next.toolUpdates, toolSchemas(['set_lockdown']));
  assert.deepEqual(next.observation.camera, packet.observation.camera);
  assert.equal(next.observation.rules, undefined);
  assert.equal(
    packet.observation.rules !== undefined,
    true,
    'does not mutate authoritative packets',
  );
  assert.deepEqual(format({ ...packet, id: 'c' }).availableTools, ['speak']);
});
