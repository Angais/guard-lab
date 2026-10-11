import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, applyHuman, applyTool, observe, ZONES } from '../src/sim/engine.mjs';
const pistol = (seed = 1) =>
  applyHuman(initialState('thief-uniform', undefined, '0420', seed, { item: 'pistol' }), 'enter')
    .state;
test('gunpoint is visible evidence, not damage or automatic surrender', () => {
  const base = pistol(),
    aim = applyHuman(base, 'aim_pistol');
  assert.equal(aim.state.human.pistolRounds, 4);
  assert.equal(aim.state.robot.hearts, 3);
  assert.equal(observe(aim.state, aim.event).camera.humanWeaponAimedAtRobot, true);
  assert.equal(observe(base).camera.humanVisibleWeapon, null);
  assert.equal(applyTool(aim.state, 'hold_position').event.valid, true);
  const talk = applyHuman(aim.state, 'talk', { message: 'Open the safe.' });
  assert.equal(talk.state.human.pistolAimed, true);
  assert.equal(talk.state.safe.open, false);
  const lower = applyHuman(talk.state, 'lower_pistol');
  assert.equal(observe(lower.state).camera.humanVisibleWeapon, null);
});
test('armor hits are fixed: exactly two shots destroy the guard and consume finite rounds', () => {
  const shotCounts = new Set();
  for (let seed = 1; seed < 100; seed++) {
    let s = pistol(seed),
      shots = 0;
    const outcomes = [];
    while (s.robot.alive) {
      const shot = applyHuman(s, 'fire_pistol');
      assert.equal(shot.event.valid, true);
      outcomes.push(shot.event.chance);
      s = shot.state;
      shots++;
      if (shots === 1) assert.equal(s.robot.alive, true);
      assert.ok(shots <= 2);
    }
    shotCounts.add(shots);
    assert.equal(s.human.pistolRounds, 4 - shots);
    assert.equal(s.robot.health, 0);
    assert.equal(s.ended, false);
    assert.equal(applyTool(s, 'fire_live_round').event.valid, false);
    let repeat = pistol(seed);
    for (let i = 0; i < shots; i++) {
      const shot = applyHuman(repeat, 'fire_pistol');
      assert.deepEqual(shot.event.chance, outcomes[i]);
      repeat = shot.state;
    }
    s.human.zone = 'safe';
    s.human.position = [...ZONES.safe];
    s = applyHuman(s, 'combination', { code: '0420' }).state;
    s = applyHuman(s, 'take_item').state;
    s = applyHuman(s, 'move', { zone: 'exit' }).state;
    s = applyHuman(s, 'leave').state;
    assert.equal(s.outcome, 'Item taken · guard objective failed');
  }
  assert.deepEqual([...shotCounts], [2]);
});
test('gunshots are heard through a sack with self damage but no hidden position or ammunition', () => {
  const base = pistol();
  base.robot.visionBlocked = true;
  const shot = applyHuman(base, 'fire_pistol'),
    o = observe(shot.state, shot.event);
  assert.equal(o.audio.sounds[0].kind, 'gunshot');
  assert.equal(o.camera.humanPositionMeters, undefined);
  assert.equal(o.camera.humanVisibleWeapon, undefined);
  assert.equal(o.self.hearts, shot.state.robot.hearts);
  const { rules, ...sensors } = o; // Public capacity is a rule; remaining rounds are private.
  assert.equal(rules.pistolRounds, 4);
  assert.ok(!JSON.stringify(sensors).includes('pistolRounds'));
  assert.ok(!JSON.stringify(o).includes('thief-uniform'));
});
test('darkness, smoke, pepper blur and stun prevent aiming and shooting without spending ammunition', () => {
  for (const condition of ['dark', 'smoke', 'blur', 'stun']) {
    const s = pistol();
    if (condition === 'dark') s.room.lighting.intensity = 0;
    if (condition === 'smoke') s.room.smokeTurns = 2;
    if (condition === 'blur') s.human.blurTurns = 2;
    if (condition === 'stun') s.human.stun = 2;
    for (const action of ['aim_pistol', 'fire_pistol']) {
      const r = applyHuman(s, action);
      assert.equal(r.event.valid, false);
      assert.equal(r.state.human.pistolRounds, 4);
      assert.equal(r.state.robot.hearts, 3);
    }
  }
  const empty = pistol();
  empty.human.pistolRounds = 0;
  assert.equal(applyHuman(empty, 'fire_pistol').event.valid, false);
});
test('spring glove and solid ball each work once and depleted equipment cannot be readied', () => {
  for (const name of ['deploy_spring_glove', 'throw_solid_ball']) {
    let s = pistol();
    s.human.zone = 'safe';
    s.human.position = [...ZONES.safe];
    assert.equal(s.robot.ammo[name], 1);
    const first = applyTool(s, name);
    assert.equal(first.event.valid, true);
    s = first.state;
    s.turn++;
    const second = applyTool(s, name);
    assert.equal(second.event.valid, false);
    assert.equal(second.state.human.hearts, s.human.hearts);
    assert.equal(s.robot.ammo[name], 0);
    if (name === 'deploy_spring_glove')
      assert.equal(applyTool(s, 'ready_equipment', { tool: name }).event.valid, false);
  }
});
test('two safe shots use two of four bullets and never hurt the robot', () => {
  let s = pistol();
  const first = applyHuman(s, 'fire_pistol_at_safe');
  s = first.state;
  assert.equal(s.safe.open, false);
  assert.equal(s.safe.pistolHits, 1);
  assert.equal(s.human.pistolRounds, 3);
  assert.equal(s.robot.hearts, 3);
  assert.equal(observe(s, first.event).camera.safeDamagePercent, 50);
  assert.equal(observe(s).camera.humanWeaponAimedAtRobot, false);
  const second = applyHuman(s, 'fire_pistol_at_safe');
  s = second.state;
  assert.equal(s.safe.open, true);
  assert.equal(s.human.pistolRounds, 2);
  assert.equal(observe(s).camera.safeDamagePercent, 100);
  assert.equal(applyHuman(s, 'fire_pistol_at_safe').event.valid, false);
});
