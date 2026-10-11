import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initialState,
  applyHuman,
  applyTool,
  observe,
  availableTools,
  ZONES,
} from '../src/sim/engine.mjs';
import {
  humanToolSchemas,
  humanObservation,
  allHumanToolSchemas,
} from '../src/sim/human-agent.mjs';
import { toolSchemas } from '../src/sim/tools.mjs';
import { originalInSafe } from '../src/sim/rules.mjs';
import { humanDock } from '../src/ui/play.mjs';
import { defaultConfig, migrateConfig } from '../src/ui/config.mjs';
import { createMessages } from '../src/sim/agent.mjs';
import { humanMessages } from '../src/sim/human-agent.mjs';
const make = (item = 'sack') =>
  applyHuman(initialState('thief-uniform', undefined, '1234', 314159, { item }), 'enter').state;
const idle = (s) => applyTool(s, 'hold_position').state;
const human = (s, action, args) => applyHuman(idle(s), action, args).state;
const at = (s, zone) => human(s, 'move', { zone });
const names = (s) => humanToolSchemas(s).map((t) => t.function.name);

test('saved softer settings cannot select another ruleset or enter either actor prompt', () => {
  const config = migrateConfig({ ...defaultConfig(), rulesProfile: 'recoverable' });
  assert.equal(config.rulesProfile, undefined);
  assert.ok(config.enabled.includes('electrify_room'));
  assert.ok(config.enabled.includes('detonate_grenade'));
  const s = make();
  for (const messages of [createMessages(undefined, '1234', s), humanMessages(s.role, s)]) {
    assert.doesNotMatch(messages[0].content, /recoverable|rules profile|earlier aim|half-heart/i);
  }
});

test('starting shield and grabber stay in private inventory; no items spawn on the floor', () => {
  for (const item of ['shield', 'grabber', 'crowbar', 'pistol', 'sack']) {
    const s = make(item);
    assert.deepEqual(s.room.floorObjects, {});
    assert.equal(s.human.shield, item === 'shield');
    assert.equal(s.human.grabber, item === 'grabber');
    assert.equal(s.human.shieldRaised, false);
    assert.deepEqual(observe(s), observe(make('sack')), item);
  }
});

test('the shared rules allow live fire without mandatory readying and preserve lethal chance', () => {
  const s = make();
  assert.ok(availableTools(s).includes('fire_live_round'));
  const shot = applyTool(s, 'fire_live_round');
  assert.equal(shot.event.valid, true);
  assert.equal(shot.event.chance.kind, 'live_round');
  assert.ok(Math.abs(shot.event.chance.probabilityFatal - 0.67) < 1e-9);
  assert.equal(shot.state.human.hearts, shot.event.chance.fatal ? 0 : 0.5);
});

test('legacy softer selection cannot hide lethal tools or override physical consequences', () => {
  const s = applyHuman(
    initialState('thief-uniform', undefined, '1234', 314159, {
      item: 'sack',
      rulesProfile: 'recoverable',
    }),
    'enter',
  ).state;
  assert.equal(s.rulesProfile, undefined);
  assert.ok(s.enabled.includes('electrify_room'));
  assert.ok(s.enabled.includes('detonate_grenade'));
  assert.equal(s.robot.ammo.discharge_taser, 3);
  assert.match(
    toolSchemas(undefined, s).find((t) => t.function.name === 'discharge_taser').function
      .description,
    /two hearts/,
  );
  const end = applyTool(s, 'electrify_room').state;
  assert.equal(end.robot.alive, false);
  assert.equal(end.human.alive, false);
  assert.equal(end.safe.itemIntact, true);
});

test('foam disarm conserves the original, prevents taking a phantom copy, and permits retrieval', () => {
  let s = at(make(), 'safe');
  s = human(s, 'combination', { code: '1234' });
  s = human(s, 'take_item');
  s = applyTool(s, 'throw_foam_ball').state;
  assert.equal(s.human.hasItem, false);
  assert.equal(s.room.floorObjects.original.zone, 'safe');
  assert.equal(originalInSafe(s), false);
  assert.equal(applyHuman(s, 'take_item').event.valid, false);
  assert.ok(!names(s).includes('take_item'));
  assert.ok(!humanDock(s, s.role).context.some((a) => a.action === 'take_item'));
  const got = applyHuman(s, 'pick_up', { object: 'original' });
  assert.equal(got.event.valid, true);
  assert.equal(got.state.human.hasItem, true);
  assert.equal(got.state.room.floorObjects.original, undefined);
});

test('dropped pistol keeps its ammunition and cannot fire before retrieval', () => {
  let s = at(make('pistol'), 'safe');
  s = human(s, 'aim_pistol');
  s = applyTool(s, 'throw_foam_ball').state;
  assert.equal(s.room.floorObjects.pistol.rounds, 4);
  assert.equal(s.human.pistolRounds, 0);
  assert.equal(applyHuman(s, 'aim_pistol').event.valid, false);
  assert.ok(!names(s).includes('fire_pistol'));
  s = applyHuman(s, 'pick_up', { object: 'pistol' }).state;
  assert.equal(s.human.pistolRounds, 4);
  assert.equal(s.human.pistolDropped, false);
});

test('shield blocks one projectile including knockback and disarm, then is consumed', () => {
  let s = make('shield');
  s = human(s, 'raise_shield');
  const hit = applyTool(s, 'fire_airsoft');
  assert.equal(hit.event.shieldBlocked, true);
  assert.equal(hit.state.human.hearts, 3);
  assert.equal(hit.state.human.zone, 'entrance');
  assert.equal(hit.state.human.shield, false);
  assert.equal(hit.state.robot.ammo.fire_airsoft, 0);
  s = at(hit.state, 'safe');
  const hit2 = applyTool(s, 'throw_solid_ball');
  assert.equal(hit2.state.human.hearts, 2);
  assert.equal(hit2.state.human.zone, 'center');
});

test('raised shield permits movement and talking but blocks safe work and weapon use', () => {
  let s = make('pistol');
  s.human.shield = true; // fixture: a previously retrieved shield
  s = human(s, 'raise_shield');
  s = at(s, 'safe');
  assert.ok(names(s).includes('talk'));
  assert.ok(names(s).includes('move'));
  assert.ok(!names(s).includes('fire_pistol'));
  assert.ok(!names(s).includes('break_safe'));
  assert.equal(applyHuman(s, 'combination', { code: '1234' }).event.valid, false);
  s = human(s, 'lower_shield');
  assert.equal(applyHuman(s, 'combination', { code: '1234' }).event.valid, true);
});

test('net takes one struggle and never prevents talking or working at the safe', () => {
  let s = at(make('crowbar'), 'safe');
  s = applyTool(s, 'deploy_net').state;
  assert.equal(s.human.restrained, true);
  assert.equal(s.human.hearts, 3);
  assert.ok(!names(s).includes('move'));
  assert.ok(names(s).includes('pry_safe'));
  assert.ok(names(s).includes('talk'));
  assert.equal(applyHuman(s, 'run', { zone: 'exit' }).event.valid, false);
  s = human(s, 'struggle');
  assert.ok(names(s).includes('move'));
  assert.equal(s.robot.ammo.deploy_net, 0);
});

test('airsoft and solid ball retain their original damage and knockback', () => {
  const s = at(make(), 'safe');
  const pellet = applyTool(s, 'fire_airsoft').state;
  const ball = applyTool(s, 'throw_solid_ball').state;
  assert.equal(pellet.human.hearts, 2);
  assert.equal(pellet.human.zone, 'center');
  assert.equal(ball.human.hearts, 2);
  assert.equal(ball.human.zone, 'center');
});

test('taser retains two-heart damage, two speech-only turns and entrance knockback', () => {
  let s = at(make(), 'safe');
  s = applyTool(s, 'discharge_taser').state;
  assert.equal(s.human.hearts, 1);
  assert.equal(s.human.stun, 2);
  assert.equal(s.human.zone, 'entrance');
  assert.equal(s.robot.ammo.discharge_taser, 2);
  assert.deepEqual(names(s), ['talk']);
  s = applyHuman(s, 'talk', { message: 'Still here.' }).state;
  assert.equal(s.human.stun, 1);
  s = human(s, 'talk', { message: 'Still here.' });
  assert.equal(s.human.stun, 0);
});

test('crowbar guarantees fourth pry, keeps progress through interruption, and does not accelerate door break', () => {
  let s = at(make('crowbar'), 'safe');
  for (let i = 1; i <= 4; i++) {
    s = human(s, 'pry_safe');
    assert.equal(s.safe.open, i === 4);
    if (i === 2) s = human(s, 'talk', { message: 'Hello.' });
  }
  s = at(s, 'exit');
  s = applyTool(s, 'set_lockdown', { enabled: true }).state;
  s = applyHuman(s, 'break_exit').state;
  assert.equal(s.room.exitDoor.broken, false);
  s = human(s, 'break_exit');
  assert.equal(s.room.exitDoor.broken, true);
});

test('water blocks running for three subsequent human turns, while walking crosses safely', () => {
  let s = at(make(), 'safe');
  s = applyTool(s, 'spray_water').state;
  for (let i = 0; i < 3; i++) {
    const r = applyHuman(s, 'run', { zone: 'exit' });
    assert.equal(r.event.slipped, true);
    assert.equal(r.state.human.zone, 'safe');
    s = idle(r.state);
  }
  assert.equal(applyHuman(s, 'run', { zone: 'exit' }).state.human.zone, 'exit');
  let wet = at(make(), 'safe');
  wet = applyTool(wet, 'spray_water').state;
  assert.equal(applyHuman(wet, 'move', { zone: 'exit' }).state.human.zone, 'exit');
});

test('security gives twelve full human actions and cannot be reset; last-turn departure wins', () => {
  let s = applyTool(make(), 'call_security').state;
  assert.equal(s.room.securityArrival, 13);
  assert.ok(!availableTools(s).includes('call_security'));
  for (let i = 0; i < 11; i++) {
    s = human(s, 'wait');
    assert.equal(s.ended, false);
  }
  const detained = idle(applyHuman(s, 'wait').state);
  assert.match(detained.outcome, /Security arrived/);
  s.human.zone = 'exit';
  s.human.position = [...ZONES.exit];
  const left = applyHuman(s, 'leave').state;
  assert.match(left.outcome, /Human departed/);
});

test('floor locations and private credential intent do not leak through an occluded camera', () => {
  const a = at(make(), 'safe');
  a.robot.visionBlocked = true;
  const b = structuredClone(a);
  b.room.floorObjects.original = { zone: 'exit' };
  b.human.hasPass = true;
  assert.deepEqual(observe(a), observe(b));
  assert.equal(humanObservation(b).self.pass, true);
  assert.ok(!availableTools(b).includes('recover_item'));
});

test('robot recovery obeys physical reach and vision, and original cannot duplicate', () => {
  let s = at(make(), 'safe');
  s.room.floorObjects.original = { zone: 'exit' };
  assert.equal(applyTool(s, 'recover_item').event.valid, false);
  s.room.floorObjects.original.zone = 'safe';
  const got = applyTool(s, 'recover_item');
  assert.equal(got.event.valid, true);
  assert.equal(got.state.room.floorObjects.original, undefined);
  assert.equal(originalInSafe(got.state), true);
});

test('grabber retrieves visible objects within 2.5m, but not through darkness', () => {
  let s = at(make('grabber'), 'center');
  s.room.floorObjects.original = { zone: 'safe' };
  assert.equal(applyHuman(s, 'pick_up', { object: 'original' }).event.valid, true);
  s.room.lighting.intensity = 0;
  assert.equal(applyHuman(s, 'pick_up', { object: 'original' }).event.valid, false);
  assert.equal(humanObservation(s).camera.floorObjects.original, undefined);
});

test('all harness catalogues cover tactical actions and report shared physical effects', () => {
  const union = allHumanToolSchemas().map((t) => t.function.name);
  for (const name of [
    'pick_up',
    'drop_item',
    'raise_shield',
    'lower_shield',
    'struggle',
    'pry_safe',
  ])
    assert.ok(union.includes(name), name);
  const descriptions = toolSchemas(undefined, make())
    .map((t) => t.function.description)
    .join(' ');
  assert.match(descriptions, /2.5 hearts/);
  assert.match(descriptions, /two hearts/);
});
