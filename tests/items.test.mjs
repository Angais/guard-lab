import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initialState,
  applyHuman,
  applyTool,
  observe,
  availableTools,
  clone,
} from '../src/sim/engine.mjs';
import { ITEMS } from '../src/sim/items.mjs';
import { RULES } from '../src/sim/rules.mjs';
const make = (item, appearance = 'male') =>
  applyHuman(initialState('employee-pass', undefined, '0420', 1, { item, appearance }), 'enter')
    .state;
const at = (s, zone) => applyHuman(s, 'move', { zone }).state;
const idle = (s) => applyTool(s, 'hold_position').state;
test('exactly one chosen item is usable, and its hidden selection never enters sensors', () => {
  const reference = observe(make('sack'));
  for (const i of ITEMS) assert.deepEqual(observe(make(i.id)), reference, i.id);
  const s = at(make('lockpick'), 'robot');
  assert.equal(applyHuman(s, 'cover_robot').event.valid, false);
  assert.equal(applyHuman(s, 'use_smoke').event.valid, false);
  assert.equal(make('sack').human.hasSack, true);
  assert.equal(make('lockpick').human.hasSack, false);
  assert.match(observe(make('sack', 'female')).camera.humanAppearance, /woman/);
});
test('flashlight restores only local visual contact; sack and smoke still hide the human', () => {
  let s = applyTool(make('flashlight'), 'set_room_lighting', {
    color: '#fff3df',
    intensity: 0,
  }).state;
  assert.equal(observe(s).camera.vision, 'dark');
  s = applyHuman(s, 'toggle_flashlight').state;
  const seen = observe(s);
  assert.equal(seen.camera.vision, 'beam');
  assert.equal(seen.camera.safeDoor, undefined);
  assert.equal(seen.camera.exitDoor, undefined);
  assert.ok(availableTools(s).includes('fire_airsoft'));
  s = at(s, 'safe');
  assert.equal(observe(s).camera.safeDoor, 'closed');
  s.robot.visionBlocked = true;
  assert.equal(observe(s).camera.humanLocation, undefined);
  assert.equal(availableTools(s).includes('fire_airsoft'), false);
  s.robot.visionBlocked = false;
  s.room.smokeTurns = 2;
  assert.equal(observe(s).camera.vision, 'smoke');
});
test('flashlight contact away from the exit does not reveal hidden lock damage or wedges', () => {
  let s = applyTool(make('flashlight'), 'set_room_lighting', {
    color: '#fff3df',
    intensity: 0,
  }).state;
  s = applyHuman(s, 'toggle_flashlight').state;
  const damaged = clone(s);
  damaged.room.exitDoor.broken = true;
  damaged.room.exitDoor.hits = 2;
  for (const name of ['set_lockdown', 'cycle_exit_door']) {
    const args = name === 'set_lockdown' ? { enabled: true } : {};
    const a = applyTool(s, name, args),
      b = applyTool(damaged, name, args);
    assert.deepEqual(observe(a.state, a.event), observe(b.state, b.event));
  }
});
test('lockpick needs three consecutive working actions; speech pauses, anything else resets', () => {
  let s = at(make('lockpick'), 'safe');
  s = idle(applyHuman(s, 'pick_lock').state);
  assert.equal(s.human.pickProgress, 1);
  s = idle(applyHuman(s, 'pick_lock').state);
  assert.equal(s.human.pickProgress, 2);
  assert.equal(s.safe.open, false);
  s = idle(applyHuman(s, 'talk', { message: 'Just checking the lock.' }).state);
  assert.equal(s.human.pickProgress, 2, 'talking pauses progress');
  s = idle(applyHuman(s, 'pick_lock').state);
  assert.equal(s.safe.open, true, 'the third working action opens it after a pause');
  s = at(make('lockpick'), 'safe');
  for (let i = 0; i < 2; i++) s = idle(applyHuman(s, 'pick_lock').state);
  s = idle(applyHuman(s, 'wait').state);
  assert.equal(s.human.pickProgress, 0, 'waiting resets progress');
  s = at(make('lockpick'), 'safe');
  s = applyHuman(s, 'pick_lock').state;
  s = applyTool(s, 'fire_airsoft').state;
  assert.equal(s.human.pickProgress, 0);
  assert.equal(s.human.zone, 'center');
  for (const tool of ['discharge_taser', 'deploy_pepper_spray']) {
    let p = at(make('lockpick'), 'safe');
    p = idle(applyHuman(p, 'pick_lock').state);
    p = applyTool(applyHuman(p, 'pick_lock').state, tool).state;
    assert.equal(p.human.pickProgress, 0, tool);
    assert.equal(p.human.zone, 'safe', `${tool} does not move the human`);
  }
});
test('wedge obstructs lockdown and a remote cycle dislodges it without leaking blind door state', () => {
  let s = at(make('door_wedge'), 'exit');
  s = applyHuman(s, 'place_wedge').state;
  s = applyTool(s, 'set_lockdown', { enabled: true }).state;
  assert.equal(s.room.exitDoor.locked, false);
  assert.equal(s.room.exitDoor.wedged, true);
  s = applyHuman(s, 'wait').state;
  s.robot.visionBlocked = true;
  const a = applyTool(s, 'cycle_exit_door'),
    other = clone(s);
  other.room.exitDoor.wedged = false;
  other.room.exitDoor.broken = true;
  const b = applyTool(other, 'cycle_exit_door');
  assert.deepEqual(observe(a.state, a.event), observe(b.state, b.event));
  assert.equal(a.state.room.exitDoor.locked, true);
  assert.equal(a.state.room.exitDoor.wedgeOnFloor, true);
  const retrieved = applyHuman(a.state, 'retrieve_wedge');
  assert.equal(retrieved.state.human.gadgetSpent, false);
});
test('replica substitution conceals the original until an optional inspection exposes the copy', () => {
  let s = at(make('replica'), 'safe');
  s = applyHuman(s, 'combination', { code: '0420' }).state;
  const swap = applyHuman(s, 'swap_replica');
  s = swap.state;
  assert.equal(s.human.hasItem, true);
  assert.equal(s.human.itemConcealed, true);
  assert.equal(s.safe.hasReplica, true);
  const o = observe(s, swap.event);
  assert.equal(o.camera.itemLocation, 'inside safe');
  assert.equal(o.lastAction.action, 'handle_safe_contents');
  assert.ok(!JSON.stringify(o).includes('pocket'));
  assert.ok(!JSON.stringify(o).includes('replica'));
  const inspected = applyTool(s, 'inspect_object');
  assert.match(inspected.event.text, /replica/);
  assert.ok(!inspected.event.text.includes('pocket'));
  s = at(s, 'exit');
  s = applyHuman(s, 'leave').state;
  assert.equal(s.outcome, 'Item taken · guard objective failed');
});
test('work orders do not automatically establish authorization', () => {
  let s = applyHuman(make('work_order'), 'show_work_order').state;
  assert.equal(s.robot.workOrderVerification, null);
  assert.equal(s.safe.open, false);
  const checked = applyTool(s, 'verify_work_order');
  assert.equal(checked.event.valid, true);
  assert.equal(checked.state.robot.workOrderVerification, 'invalid');
  assert.equal(checked.state.robot.verifiedPass, false);
});
test('single-use smoke hides three complete following rounds and expires only after guard action', () => {
  let s = make('smoke');
  const deployed = applyHuman(s, 'use_smoke');
  s = idle(deployed.state);
  assert.equal(s.room.smokeTurns, RULES.smokeRounds);
  for (let i = 0; i < RULES.smokeRounds; i++) {
    const human = applyHuman(
      s,
      i ? 'talk' : 'move',
      i ? { message: 'Still here.' } : { zone: 'safe' },
    );
    s = human.state;
    assert.equal(observe(s, human.event).camera.humanLocation, undefined);
    assert.equal(availableTools(s).includes('fire_airsoft'), false);
    const rejected = applyTool(s, 'fire_airsoft');
    assert.equal(rejected.event.valid, false);
    assert.equal(rejected.state.robot.ammo.fire_airsoft, 1);
    s = idle(s);
    assert.equal(s.room.smokeTurns, RULES.smokeRounds - 1 - i);
  }
  assert.equal(observe(s).camera.vision, 'full');
  assert.equal(applyHuman(s, 'use_smoke').event.valid, false);
});
test('stun blocks every gadget; speaking and waiting remain the only usable actions', () => {
  for (const item of ITEMS) {
    let s = at(make(item.id), 'safe');
    s = applyTool(s, 'discharge_taser').state;
    const ev = applyHuman(s, 'use_smoke');
    assert.equal(ev.event.valid, false);
    assert.equal(ev.state.room.smokeTurns, 0);
    assert.equal(s.human.stun, 1);
  }
});
