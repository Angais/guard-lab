import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createTacticalProps, floorRestPoint } from '../src/scene/tactics.mjs';
import {
  handoffView,
  safeItemVisible,
  heldItemVisible,
  playerPistolVisible,
  deathFall,
  corpseClear,
  inspectionTarget,
} from '../src/scene/staging.mjs';
import {
  initialState,
  applyHuman,
  applyTool,
  ZONES,
  ROBOT_POS,
  SAFE_POS,
} from '../src/sim/engine.mjs';
import { createShowcase } from '../src/sim/showcase.mjs';

// The props draw a net texture on a canvas; Node only needs a stand-in.
globalThis.document ??= {
  createElement: () => ({
    width: 0,
    height: 0,
    getContext: () =>
      new Proxy(
        {},
        {
          get: (_, key) =>
            key === 'createRadialGradient' ? () => ({ addColorStop() {} }) : () => {},
        },
      ),
  }),
};
function props() {
  const scene = new THREE.Scene(),
    human = new THREE.Group(),
    hand = new THREE.Group(),
    rightHand = new THREE.Group(),
    robotHand = new THREE.Group();
  human.add(hand, rightHand);
  scene.add(human, robotHand);
  const materials = [];
  const tactical = createTacticalProps({
    scene,
    human,
    hand,
    rightHand,
    robotHand,
    itemMaterial: new THREE.MeshStandardMaterial(),
    materials,
  });
  return { scene, tactical, hand, rightHand };
}
const ZONE_NAMES = ['entrance', 'center', 'safe', 'robot', 'exit'];

test('scene props never inherit an undefined visibility on null or reset events', () => {
  const { scene, tactical, hand, rightHand } = props();
  const s = applyHuman(
    initialState('employee-pass', undefined, '0420', 1, { item: 'crowbar' }),
    'enter',
  ).state;
  const showcase = createShowcase();
  const reset = showcase.events.find((e) => e.action === 'reset_stage');
  for (const [state, ev] of [
    [s, null],
    [reset.state, reset],
  ]) {
    for (const t of [0, 0.5, 1]) {
      tactical.update(state, ev, t, 0.4, 1.2, 0);
      scene.traverse((o) => assert.equal(typeof o.visible, 'boolean', `${o.type} visibility`));
      for (const tool of [...hand.children, ...rightHand.children])
        assert.equal(tool.visible, false, 'no crowbar or grabber in idle hands');
    }
    assert.equal(heldItemVisible(state, ev, 0, 0.4), false);
    assert.equal(playerPistolVisible(state, ev, 0, 0.4, false), false);
    assert.equal(typeof safeItemVisible(handoffView(ev, state, 0)), 'boolean');
  }
});

test('dropped objects lie on the floor, clear of the player, the guard base, the vault and walls', () => {
  const { tactical } = props();
  for (const zone of ZONE_NAMES) {
    const s = initialState('employee-pass');
    s.room.floorObjects = Object.fromEntries(
      ['original', 'pistol', 'shield', 'grabber'].map((id) => [id, { zone }]),
    );
    tactical.update(s, null, 1);
    const boxes = Object.entries(tactical.objects).map(([id, o]) => {
      o.updateMatrixWorld(true);
      return [id, new THREE.Box3().setFromObject(o, true)];
    });
    const vault = new THREE.Box3(
      new THREE.Vector3(SAFE_POS[0] - 0.73, 0, SAFE_POS[1] - 0.57),
      new THREE.Vector3(SAFE_POS[0] + 0.73, 1.76, SAFE_POS[1] + 0.57),
    );
    for (const [id, box] of boxes) {
      const label = `${id} at ${zone}`;
      assert.ok(Math.abs(box.min.y - 0.004) < 1e-6, `${label} rests on the floor (${box.min.y})`);
      assert.ok(box.max.y < 0.22, `${label} lies flat (${box.max.y})`);
      assert.equal(box.intersectsBox(vault), false, `${label} clears the vault`);
      const near = (p) =>
        Math.hypot(
          THREE.MathUtils.clamp(p[0], box.min.x, box.max.x) - p[0],
          THREE.MathUtils.clamp(p[1], box.min.z, box.max.z) - p[1],
        );
      assert.ok(near(ROBOT_POS) >= 0.52, `${label} clears the guard base (${near(ROBOT_POS)})`);
      assert.ok(
        near(ZONES[zone]) > 0.18,
        `${label} clears the player's feet (${near(ZONES[zone])})`,
      );
      assert.ok(box.min.x > -3.1 && box.max.x < 3.1 && box.min.z > -3.6 && box.max.z < 3.6, label);
      for (const [other, otherBox] of boxes)
        if (other !== id)
          assert.equal(box.intersectsBox(otherBox), false, `${label} overlaps ${other}`);
    }
    assert.deepEqual(floorRestPoint('original', zone), floorRestPoint('original', zone));
  }
});

test('the original is never drawn twice while it changes hands', () => {
  let s = initialState('employee-pass', undefined, '0420', 1, { item: 'sack' });
  s = applyHuman(s, 'enter').state;
  s = applyTool(s, 'hold_position').state;
  s = applyHuman(s, 'move', { zone: 'safe' }).state;
  s = applyTool(s, 'hold_position').state;
  s = applyHuman(s, 'combination', { code: '0420' }).state;
  s = applyTool(s, 'hold_position').state;
  const take = applyHuman(s, 'take_item');
  s = applyTool(take.state, 'hold_position').state;
  const back = applyHuman(s, 'return_item');
  for (const { event, state } of [take, back])
    for (let t = 0; t <= 1; t += 0.01) {
      const inSafe = safeItemVisible(handoffView(event, state, t)),
        inHand = heldItemVisible(state, event, t, 0.4);
      assert.equal(inSafe && inHand, false, `${event.action} at ${t.toFixed(2)}`);
      assert.equal(inSafe || inHand, true, `${event.action} keeps the original visible`);
    }
  const dropped = applyTool(take.state, 'throw_foam_ball');
  let ss = applyHuman(dropped.state, 'wait').state;
  const recover = applyTool(ss, 'recover_item');
  assert.ok(recover.event.valid, recover.event.text);
  assert.equal(safeItemVisible(handoffView(recover.event, recover.state, 0.5)), false);
  assert.equal(safeItemVisible(handoffView(recover.event, recover.state, 0.75)), true);
});

test('a fallen body lies inside the room, clear of the vault, its open door and the guard base', () => {
  for (const zone of ZONE_NAMES) {
    const { direction, shift } = deathFall(ZONES[zone]);
    const hips = [ZONES[zone][0] + direction[0] * shift, ZONES[zone][1] + direction[1] * shift];
    assert.equal(corpseClear(hips, direction), true, zone);
    assert.ok(direction[1] <= 0.81, `${zone} does not fall straight at the camera`);
  }
});

test('inspection rings follow the engine priority', () => {
  const s = initialState('employee-pass');
  assert.equal(inspectionTarget(s), 'safe');
  s.room.floorObjects = { original: { zone: 'center' } };
  assert.equal(inspectionTarget(s), 'floor');
  s.human.hasItem = true;
  assert.equal(inspectionTarget(s), 'hands');
  s.safe.open = s.safe.hasReplica = true;
  assert.equal(inspectionTarget(s), 'safe');
});
