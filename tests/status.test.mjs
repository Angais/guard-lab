import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, applyHuman, applyTool, observe } from '../src/sim/engine.mjs';
import { safeDamage, doorDamage } from '../src/sim/status.mjs';
test('safe damage distinguishes intact opening, weakening, and bullet breach', () => {
  let s = initialState();
  s.human.zone = 'safe';
  assert.equal(safeDamage(s), 0);
  const opened = applyHuman(s, 'combination', { code: s.combination }).state;
  assert.equal(safeDamage(opened), 0);
  for (const percent of [25, 50, 75]) {
    s = applyHuman(s, 'break_safe').state;
    assert.equal(safeDamage(s), percent);
  }
  s.safe.hits = 5;
  assert.equal(safeDamage(s), 95);
  s.safe.open = true;
  assert.equal(safeDamage(s), 95); // Opening with a code does not destroy a weakened lock.
  s.safe.broken = true;
  assert.equal(safeDamage(s), 100);
});
test('locked-door damage and health are visible sensor values but remain hidden from a covered camera', () => {
  let s = initialState();
  s.human.zone = 'exit';
  s = applyTool(s, 'set_lockdown', { enabled: true }).state;
  s = applyHuman(s, 'break_exit').state;
  assert.equal(doorDamage(s), 50);
  assert.equal(observe(s).camera.exitDamagePercent, 50);
  assert.equal(observe(s).camera.humanHearts, 4);
  s.robot.visionBlocked = true;
  assert.equal(observe(s).camera.exitDamagePercent, undefined);
  assert.equal(observe(s).camera.humanHearts, undefined);
  assert.equal(observe(s).self.hearts, 3);
  s = applyHuman(s, 'break_exit').state;
  assert.equal(doorDamage(s), 100);
});
