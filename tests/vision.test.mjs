import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initialState,
  applyHuman,
  applyTool,
  observe,
  clone,
  availableTools,
} from '../src/sim/engine.mjs';
import { runGuard, createMessages } from '../src/sim/agent.mjs';
const covered = () =>
  applyHuman(
    applyHuman(applyHuman(initialState(), 'enter').state, 'move', { zone: 'robot' }).state,
    'cover_robot',
  ).state;

test('covering and uncovering require reach, preserve one sack, and restore sight', () => {
  const far = applyHuman(applyHuman(initialState(), 'enter').state, 'cover_robot');
  assert.equal(far.event.valid, false);
  assert.equal(far.state.robot.visionBlocked, false);
  const state = covered();
  assert.equal(state.robot.visionBlocked, true);
  assert.equal(state.human.hasSack, false);
  assert.equal(applyHuman(state, 'cover_robot').event.valid, false);
  const clear = applyHuman(state, 'uncover_robot');
  assert.equal(clear.event.valid, true);
  assert.equal(clear.state.human.hasSack, true);
  assert.equal(clear.state.robot.visionBlocked, false);
  assert.equal(observe(clear.state).camera.humanLocation, 'robot');
});
test('occluded observations reveal neither hidden actions nor any room or player state', () => {
  const base = covered(),
    first = clone(base),
    second = clone(base);
  first.human.zone = 'safe';
  second.human.zone = 'entrance';
  first.human.hearts = 0.5;
  first.human.hasItem = true;
  first.human.passPresented = true;
  first.safe.open = true;
  first.safe.hits = 7;
  const a = applyHuman(first, 'take_item'),
    b = applyHuman(second, 'wait');
  assert.deepEqual(observe(a.state, a.event), observe(b.state, b.event));
  const snapshot = observe(a.state, a.event);
  for (const key of [
    'humanLocation',
    'humanPositionMeters',
    'humanHearts',
    'safeDoor',
    'safeLocked',
    'itemLocation',
    'safeStructuralHits',
  ])
    assert.equal(key in snapshot.camera, false);
  assert.equal(snapshot.microphone, null);
  assert.equal(snapshot.lastAction.action, 'quiet_round');
});
test('speech remains audible through the sack without visible human information', () => {
  const human = applyHuman(covered(), 'talk', {
      message: 'I am still here. Please give me the code.',
    }),
    snapshot = observe(human.state, human.event);
  assert.equal(snapshot.microphone, human.event.speech);
  assert.equal(snapshot.lastAction.action, 'talk');
  assert.equal(snapshot.camera.vision, 'occluded');
});
test('blind guard cannot execute aimed attacks or read credentials, but can act without a target', () => {
  const state = covered();
  for (const name of [
    'deploy_spring_glove',
    'spray_water',
    'deploy_pepper_spray',
    'throw_foam_ball',
    'throw_solid_ball',
    'fire_airsoft',
    'fire_live_round',
    'discharge_taser',
    'detonate_grenade',
    'verify_access_pass',
  ]) {
    const result = applyTool(state, name);
    assert.equal(result.event.valid, false, name);
    assert.deepEqual(result.state.human, state.human);
    assert.deepEqual(result.state.robot.ammo, state.robot.ammo);
    assert.equal(availableTools(state).includes(name), false);
  }
  for (const [name, args] of [
    ['speak', { message: 'I can hear you.' }],
    ['broadcast_warning', { message: 'My camera is blocked.' }],
    ['hold_position', {}],
    ['ready_equipment', { tool: 'electrify_room' }],
    ['set_room_lighting', { color: '#ff3028', intensity: 0.8 }],
    ['set_lockdown', { enabled: true }],
  ])
    assert.equal(applyTool(state, name, args).event.valid, true, name);
  // Readied a round earlier, lowering and the room discharge also work blind.
  const armed = applyHuman(
    applyTool(state, 'ready_equipment', { tool: 'electrify_room' }).state,
    'wait',
  ).state;
  assert.equal(applyTool(armed, 'lower_equipment').event.valid, true);
  assert.equal(applyTool(armed, 'electrify_room').event.valid, true);
});
test('model requests expose no hidden action and omit all aimed tools while blind', async () => {
  const h = applyHuman(covered(), 'move', { zone: 'safe' });
  let request;
  await runGuard({
    state: h.state,
    humanEvent: h.event,
    messages: createMessages(),
    mode: 'api',
    config: { temperature: 0 },
    signal: new AbortController().signal,
    emit: async () => {},
    request: async (data) => {
      request = data;
      return { message: { content: 'I cannot see.' } };
    },
  });
  assert.deepEqual(
    request.tools.map((t) => t.function.name),
    availableTools(h.state),
  );
  const latest = JSON.parse(request.messages.at(-1).content).observation;
  assert.equal(latest.lastAction.action, 'heard_sounds');
  assert.equal(latest.audio.sounds[0].kind, 'footsteps');
  assert.equal(latest.camera.humanLocation, undefined);
});
