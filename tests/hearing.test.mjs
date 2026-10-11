import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initialState,
  applyHuman,
  applyTool,
  observe,
  clone,
  ZONES,
  availableTools,
} from '../src/sim/engine.mjs';
import { createMessages, compactContext, runGuard } from '../src/sim/agent.mjs';
import { sensorPacket } from '../scripts/bridge.mjs';
const covered = () =>
  applyHuman(
    applyHuman(
      applyHuman(initialState('thief-uniform', undefined, '9873', 1), 'enter').state,
      'move',
      { zone: 'robot' },
    ).state,
    'cover_robot',
  ).state;
const atSafe = () => applyHuman(covered(), 'move', { zone: 'safe' }).state;
test('blind microphones hear safe impacts without revealing damage counts or target coordinates', () => {
  const base = atSafe(),
    other = clone(base);
  other.safe.hits = 3;
  const first = applyHuman(base, 'break_safe'),
    fourth = applyHuman(other, 'break_safe'),
    a = observe(first.state, first.event),
    b = observe(fourth.state, fourth.event);
  assert.equal(a.audio.sounds[0].kind, 'heavy_metal_impact');
  assert.equal(a.audio.sounds[0].sourceHint, 'near the safe');
  assert.equal(a.lastAction.action, 'heard_sounds');
  assert.deepEqual(a, b);
  assert.equal(a.camera.humanPositionMeters, undefined);
  assert.equal(a.camera.safeStructuralHits, undefined);
  assert.equal(a.camera.itemLocation, undefined);
  assert.ok(!JSON.stringify(a).includes('break_safe'));
  assert.ok(!JSON.stringify(a).includes('thief-uniform'));
  assert.ok(!JSON.stringify(a).includes('9873'));
});
test('door attack and a broken lock have distinct sounds but no hidden door status', () => {
  let s = applyTool(covered(), 'set_lockdown', { enabled: true }).state;
  s = applyHuman(s, 'move', { zone: 'exit' }).state;
  const first = applyHuman(s, 'break_exit'),
    second = applyHuman(first.state, 'break_exit');
  assert.deepEqual(
    observe(first.state, first.event).audio.sounds.map((x) => x.kind),
    ['door_impact'],
  );
  assert.deepEqual(
    observe(second.state, second.event).audio.sounds.map((x) => x.kind),
    ['door_impact', 'lock_crack'],
  );
  assert.equal(observe(second.state, second.event).camera.exitDoor, undefined);
});
test('recent sounds survive quiet rounds, while silent item theft stays hidden', () => {
  const hit = applyHuman(atSafe(), 'break_safe');
  let s = applyTool(hit.state, 'hold_position').state;
  const remembered = clone(s.robot.soundMemory),
    quiet = applyHuman(s, 'wait');
  assert.deepEqual(quiet.state.robot.soundMemory, remembered);
  assert.match(observe(quiet.state, quiet.event).lastAction.result, /Quiet actions may still/);
  s.safe.open = true;
  s.safe.locked = false;
  const taken = applyHuman(s, 'take_item'),
    idle = applyHuman(s, 'wait');
  assert.equal(taken.state.human.hasItem, true);
  assert.deepEqual(observe(taken.state, taken.event), observe(idle.state, idle.event));
});
test('footsteps give no destination, and failed physical actions produce no noise', () => {
  const s = covered(),
    a = applyHuman(s, 'move', { zone: 'safe' }),
    b = applyHuman(s, 'move', { zone: 'center' });
  assert.deepEqual(observe(a.state, a.event), observe(b.state, b.event));
  const invalid = applyHuman(s, 'break_safe');
  assert.equal(invalid.event.valid, false);
  assert.equal(observe(invalid.state, invalid.event).audio.sounds.length, 0);
  assert.deepEqual(invalid.state.robot.soundMemory, s.robot.soundMemory);
});
test('hearing alone cannot grant aimed attacks or consume their ammunition', () => {
  const h = applyHuman(atSafe(), 'break_safe');
  for (const name of [
    'fire_airsoft',
    'fire_live_round',
    'deploy_pepper_spray',
    'discharge_taser',
  ]) {
    assert.equal(availableTools(h.state).includes(name), false);
    const fired = applyTool(h.state, name);
    assert.equal(fired.event.valid, false);
    assert.deepEqual(fired.state.robot.ammo, h.state.robot.ammo);
  }
});
test('camera removal waits the initial response then requires three consecutive rounds', () => {
  let s = covered();
  assert.equal(applyTool(s, 'remove_camera_cover').event.valid, false);
  s = applyTool(s, 'hold_position').state;
  for (let i = 1; i <= 2; i++) {
    s = applyHuman(s, 'wait').state;
    const step = applyTool(s, 'remove_camera_cover');
    assert.equal(step.event.valid, true);
    s = step.state;
    assert.equal(s.robot.visionBlocked, true);
    assert.equal(s.robot.coverRemovalProgress, i);
    assert.equal(s.room.sackOnFloor, false);
    assert.equal(applyTool(s, 'remove_camera_cover').event.valid, false);
  }
  s = applyHuman(s, 'wait').state;
  const last = applyTool(s, 'remove_camera_cover');
  s = last.state;
  assert.equal(s.robot.visionBlocked, false);
  assert.equal(s.room.sackOnFloor, true);
  assert.equal(observe(s).camera.vision, 'full');
  const retrieved = applyHuman(s, 'retrieve_sack');
  assert.equal(retrieved.event.valid, true);
  assert.equal(retrieved.state.human.hasSack, true);
  assert.equal(retrieved.state.room.sackOnFloor, false);
  const far = applyHuman(applyHuman(s, 'move', { zone: 'safe' }).state, 'retrieve_sack');
  assert.equal(far.event.valid, false);
  const covering = applyHuman(applyHuman(s, 'wait').state, 'cover_robot');
  assert.equal(covering.event.valid, false);
  assert.match(covering.event.text, /on the floor/);
});
test('another robot action interrupts sack removal without uncovering the camera', () => {
  let s = applyHuman(covered(), 'wait').state;
  s = applyTool(s, 'remove_camera_cover').state;
  s = applyHuman(s, 'wait').state;
  s = applyTool(s, 'speak', { message: 'Stop.' }).state;
  assert.equal(s.robot.coverRemovalProgress, 0);
  assert.equal(s.robot.visionBlocked, true);
  s = applyHuman(s, 'wait').state;
  s = applyTool(s, 'remove_camera_cover').state;
  assert.equal(s.robot.coverRemovalProgress, 1);
  assert.equal(s.robot.visionBlocked, true);
});
test('removing a sack leaves darkness and smoke intact and lowers weapons', () => {
  for (const obstruction of ['dark', 'smoke']) {
    let s = covered();
    s.robot.ready = 'fire_live_round';
    s.robot.cameraCoveredTurn = s.turn - 1;
    if (obstruction === 'dark') s.room.lighting.intensity = 0;
    else {
      s.room.smokeTurns = 10;
      s.room.smokeStartedTurn = s.turn;
    }
    s = applyTool(s, 'remove_camera_cover').state;
    assert.equal(s.robot.ready, null);
    for (let i = 0; i < 2; i++) {
      s = applyHuman(s, 'wait').state;
      s = applyTool(s, 'remove_camera_cover').state;
    }
    assert.equal(s.robot.visionBlocked, false);
    assert.equal(observe(s).camera.vision, obstruction);
    assert.equal(availableTools(s).includes('fire_live_round'), false);
  }
});
test('API and live history preserve hearing without forcing a camera-clearing decision', async () => {
  const h = applyHuman(atSafe(), 'break_safe');
  let payload;
  const output = await runGuard({
    state: h.state,
    humanEvent: h.event,
    messages: createMessages(),
    mode: 'api',
    config: { temperature: 0 },
    signal: new AbortController().signal,
    emit: async () => {},
    request: async (data) => {
      payload = data;
      return {
        message: {
          tool_calls: [{ id: 'one', function: { name: 'hold_position', arguments: '{}' } }],
        },
      };
    },
  });
  assert.equal(output.state.robot.visionBlocked, true);
  const o = JSON.parse(payload.messages.at(-1).content).observation;
  assert.equal(o.audio.sounds[0].kind, 'heavy_metal_impact');
  assert.ok(payload.tools.some((t) => t.function.name === 'remove_camera_cover'));
  const history = [
    ...createMessages(),
    { role: 'user', content: JSON.stringify({ observation: o }) },
    { role: 'assistant', content: 'I hear impacts.' },
    { role: 'user', content: JSON.stringify({ observation: observe(output.state) }) },
  ];
  const compact = compactContext(history);
  assert.equal(JSON.parse(compact[1].content).audio.sounds[0].kind, 'heavy_metal_impact');
  const packet = sensorPacket({ id: 'fixture', messages: compact });
  assert.equal(packet.recentHistory[0].audio.sounds[0].kind, 'heavy_metal_impact');
});
