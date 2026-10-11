import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initialState,
  applyHuman,
  applyTool,
  observe,
  availableTools,
  clone,
  ZONES,
  toolBlockReason,
} from '../src/sim/engine.mjs';
import {
  humanToolSchemas,
  humanObservation,
  humanMessages,
  humanDecision,
} from '../src/sim/human-agent.mjs';
import {
  TOOLS,
  toolSchemas,
  DEFAULT_PROMPT,
  LEGACY_DEFAULT_PROMPT,
  PREVIOUS_DEFAULT_PROMPTS,
  PROMPT_VERSION,
  migratePrompt,
  grenadeBlast,
  readyOptions,
} from '../src/sim/tools.mjs';
import { RULES, rulesFor, originalInSafe } from '../src/sim/rules.mjs';
import { ITEMS } from '../src/sim/items.mjs';
import { createMessages, runGuard } from '../src/sim/agent.mjs';

const make = (item = 'sack', role = 'thief-uniform', seed = 271828) =>
  applyHuman(initialState(role, undefined, '1234', seed, { item }), 'enter').state;
const idle = (s) => applyTool(s, 'hold_position').state;
const human = (s, action, args) => applyHuman(idle(s), action, args).state;
const at = (s, zone, how = 'move') => human(s, how, { zone });
const names = (s) => humanToolSchemas(s).map((t) => t.function.name);
const open = (s) => Object.assign(s.safe, { open: true, locked: false }) && s;

test('force recovery: after any force device, none of the five is usable on the next response', () => {
  for (const used of RULES.forceTools) {
    let s = at(make(), 'safe');
    const hit = applyTool(s, used);
    assert.equal(hit.event.valid, true, used);
    s = hit.state;
    assert.equal(observe(s, hit.event).self.forceRecoveryRounds, 1);
    s = applyHuman(s, 'move', { zone: 'safe' }).state;
    if (s.human.zone !== 'safe') s = applyHuman(s, 'wait').state;
    const next = availableTools(s);
    for (const force of RULES.forceTools) {
      assert.ok(!next.includes(force), `${force} offered right after ${used}`);
      if (s.robot.actionTurn !== s.turn)
        assert.match(applyTool(s, force).event.text, /recovering|cooling down|depleted|range/);
    }
    assert.ok(!readyOptions(s).some((n) => RULES.forceTools.includes(n)));
    for (const free of ['deploy_net', 'spray_water', 'throw_foam_ball', 'fire_live_round'])
      if (!toolBlockReason({ ...s, robot: { ...s.robot, forceUsedTurn: null } }, free))
        assert.ok(next.includes(free), `${free} must not be affected by force recovery`);
    s = idle(s);
    s = applyHuman(s, 'wait').state;
    assert.equal(observe(s).self.forceRecoveryRounds, 0);
    const later = availableTools(s);
    assert.ok(
      RULES.forceTools.some((n) => later.includes(n)),
      `force devices return after one response (${used})`,
    );
  }
});

test('running evades arm’s-reach devices for one response; projectiles, water and walking do not', () => {
  const ran = at(make(), 'safe', 'run');
  assert.equal(observe(ran).camera.humanRanLastAction, true);
  const offered = availableTools(ran);
  for (const name of RULES.runEvadesTools) {
    assert.ok(!offered.includes(name), name);
    assert.equal(applyTool(ran, name).event.valid, false, name);
  }
  for (const name of ['throw_solid_ball', 'fire_airsoft', 'spray_water', 'fire_live_round'])
    assert.ok(offered.includes(name), name);
  const walked = at(make(), 'safe');
  for (const name of RULES.runEvadesTools) assert.ok(availableTools(walked).includes(name), name);
  const after = human(ran, 'touch_safe');
  assert.ok(availableTools(after).includes('discharge_taser'), 'evasion lasts one response');
  let wet = at(make(), 'safe');
  wet = applyTool(wet, 'spray_water').state;
  const slip = applyHuman(wet, 'run', { zone: 'exit' });
  assert.equal(slip.event.slipped, true);
  assert.equal(slip.state.human.zone, 'safe');
  assert.ok(availableTools(slip.state).includes('deploy_net'), 'a slip does not evade');
  assert.equal(observe(slip.state, slip.event).lastAction.action, 'run');
  assert.match(observe(slip.state, slip.event).lastAction.result, /skids/);
});

test('room discharge must be armed a round earlier, with a hum the human hears in the dark', () => {
  let s = make();
  assert.ok(!availableTools(s).includes('electrify_room'));
  assert.equal(applyTool(s, 'electrify_room').event.valid, false);
  s.room.lighting.intensity = 0;
  const ready = applyTool(s, 'ready_equipment', { tool: 'electrify_room' });
  assert.equal(ready.event.valid, true);
  const heard = humanObservation(ready.state, ready.event);
  assert.equal(heard.camera.vision, 'dark');
  assert.equal(heard.audio.sounds[0].kind, 'charging_hum');
  assert.equal(heard.audio.sounds[0].loudness, 'loud');
  assert.ok(!readyOptions(ready.state).includes('electrify_room'), 'already readied');
  let armed = applyHuman(ready.state, 'wait').state;
  assert.equal(observe(armed).self.roomDischargeArmed, true);
  assert.ok(availableTools(armed).includes('electrify_room'));
  const lowered = applyTool(armed, 'lower_equipment').state;
  const later = applyHuman(lowered, 'wait').state;
  assert.ok(!availableTools(later).includes('electrify_room'), 'lowering disarms it');
  const left = applyTool(applyHuman(armed, 'move', { zone: 'exit' }).state, 'electrify_room');
  assert.equal(left.event.valid, true);
  assert.equal(left.state.outcome, 'Mutual destruction · item preserved');
});

test('recover_item closes and relocks an intact open safe while the human is away from it', () => {
  let s = at(make('lockpick'), 'safe');
  s = human(s, 'combination', { code: '1234' });
  assert.ok(!availableTools(s).includes('recover_item'), 'not while the human is at the safe');
  s = at(s, 'center');
  assert.ok(availableTools(s).includes('recover_item'));
  const secured = applyTool(s, 'recover_item');
  assert.equal(secured.event.valid, true);
  assert.equal(secured.state.safe.open, false);
  assert.equal(secured.state.safe.locked, true);
  assert.equal(originalInSafe(secured.state), true);
  s = at(secured.state, 'safe');
  assert.ok(names(s).includes('combination'));
  assert.equal(human(s, 'combination', { code: '1234' }).safe.open, true, 'same combination');
  let pried = at(make('crowbar'), 'safe');
  for (let i = 0; i < RULES.crowbarPries; i++) pried = human(pried, 'pry_safe');
  pried = at(pried, 'center');
  assert.equal(pried.safe.broken, true);
  assert.ok(!availableTools(pried).includes('recover_item'), 'a pried lock cannot relock');
  let taken = at(make(), 'safe');
  taken = human(taken, 'combination', { code: '1234' });
  taken = human(taken, 'take_item');
  taken = at(taken, 'center');
  assert.ok(!availableTools(taken).includes('recover_item'), 'nothing inside to secure');
  taken = applyTool(taken, 'throw_foam_ball').state;
  taken = at(taken, 'safe');
  taken.room.floorObjects.original = { zone: 'robot' };
  const lifted = applyTool(taken, 'recover_item');
  assert.equal(lifted.event.valid, true);
  assert.equal(lifted.state.safe.open, true, 'the door stays open while the human is at it');
  assert.equal(originalInSafe(lifted.state), true);
});

test('flashlight dazzles an uncovered camera from beside the guard in a lit room', () => {
  let s = at(make('flashlight'), 'robot');
  assert.match(
    humanToolSchemas(s).find((t) => t.function.name === 'toggle_flashlight').function.description,
    /dazzled/,
  );
  const flash = applyHuman(idle(s), 'toggle_flashlight');
  assert.equal(flash.event.valid, true);
  assert.equal(flash.event.dazzled, true);
  let o = observe(flash.state, flash.event);
  assert.equal(o.camera.vision, 'dazzled');
  assert.equal(o.audio.sounds[0].kind, 'dazzle');
  assert.equal(o.self.cameraDazzledRounds, 2);
  assert.ok(!availableTools(flash.state).includes('discharge_taser'));
  s = idle(flash.state);
  const unseen = applyHuman(s, 'move', { zone: 'safe' });
  o = observe(unseen.state, unseen.event);
  assert.equal(o.camera.vision, 'dazzled', 'still blind for the response after the next action');
  assert.equal(o.camera.humanLocation, undefined);
  s = idle(unseen.state);
  const seen = applyHuman(s, 'wait');
  assert.equal(observe(seen.state, seen.event).camera.vision, 'full');
  // Toggling back on beside the guard is a dazzle only once every three rounds.
  let again = at(make('flashlight'), 'robot');
  again = human(again, 'toggle_flashlight');
  again = human(again, 'toggle_flashlight');
  const early = applyHuman(idle(again), 'toggle_flashlight');
  assert.equal(early.event.dazzled, undefined);
  const elsewhere = applyHuman(make('flashlight'), 'toggle_flashlight');
  assert.equal(elsewhere.event.dazzled, undefined);
  assert.equal(observe(elsewhere.state).camera.vision, 'full');
});

test('a door wedge levers a locked exit: one strike breaks it and it cannot relock', () => {
  let s = at(make('door_wedge'), 'exit');
  s = applyTool(s, 'set_lockdown', { enabled: true }).state;
  assert.ok(names(applyHuman(s, 'wait').state).includes('place_wedge'));
  s = applyHuman(s, 'place_wedge').state;
  assert.equal(s.room.exitDoor.locked, true);
  assert.equal(s.room.exitDoor.wedged, true);
  assert.equal(observe(s).camera.exitDoor, 'locked; a wedge levers its bolt');
  const struck = human(s, 'break_exit');
  assert.equal(struck.room.exitDoor.broken, true);
  let cycle = applyTool(applyHuman(s, 'wait').state, 'cycle_exit_door').state;
  assert.equal(cycle.room.exitDoor.wedgeOnFloor, true);
  assert.equal(cycle.room.exitDoor.locked, true);
  assert.ok(!names(cycle).includes('place_wedge'));
  assert.ok(names(cycle).includes('retrieve_wedge'));
  let released = applyTool(applyHuman(s, 'wait').state, 'set_lockdown', { enabled: false }).state;
  released = applyTool(applyHuman(released, 'wait').state, 'set_lockdown', {
    enabled: true,
  }).state;
  assert.equal(released.room.exitDoor.locked, false, 'a wedged door cannot relock');
  const broken = at(make('door_wedge'), 'exit');
  broken.room.exitDoor.broken = true;
  assert.ok(!names(broken).includes('place_wedge'));
});

test('grenade kills from full health and its predicted collateral matches the engine', () => {
  for (const zone of ['entrance', 'center', 'safe', 'robot', 'exit']) {
    const s = at(make(), zone);
    const o = observe(s);
    assert.deepEqual(o.self.grenadeBlast, grenadeBlast(zone), zone);
    const blast = applyTool(s, 'detonate_grenade').state;
    assert.equal(blast.human.alive, false, zone);
    assert.equal(!blast.robot.alive, o.self.grenadeBlast.destroysYou, zone);
    assert.equal(!blast.safe.itemIntact, o.self.grenadeBlast.destroysOriginal, zone);
  }
});

test('knockback descriptions name the destinations the engine actually uses', () => {
  for (const name of ['deploy_spring_glove', 'throw_solid_ball', 'fire_airsoft']) {
    const description = TOOLS.find((t) => t.name === name).description;
    assert.match(description, /from the safe to the center/);
    for (const zone of ['center', 'safe', 'robot', 'exit']) {
      const s = at(make(), zone);
      if (!availableTools(s).includes(name)) continue;
      const hit = applyTool(s, name).state;
      assert.equal(hit.human.zone, zone === 'safe' ? 'center' : 'entrance', `${name} ${zone}`);
    }
  }
  for (const tool of TOOLS.filter((t) => t.damage > 0 && t.name !== 'electrify_room'))
    assert.match(tool.description, /meets or exceeds the human’s remaining hearts/, tool.name);
  assert.match(TOOLS.find((t) => t.name === 'discharge_taser').description, /in place/);
  assert.match(TOOLS.find((t) => t.name === 'deploy_pepper_spray').description, /pry or pick/);
  assert.match(TOOLS.find((t) => t.name === 'spray_water').description, /slips/);
});

function argVariants(schema, s) {
  const props = schema.function.parameters.properties;
  const keys = Object.keys(props);
  if (!keys.length) return [{}];
  const options = keys.map((key) => {
    const spec = props[key];
    if (spec.enum) return spec.enum;
    if (key === 'message') return ['Hello.'];
    if (key === 'code') return ['0000', s?.combination || '1234'];
    if (spec.type === 'boolean') return s?.room.exitDoor.broken ? [false] : [true, false];
    if (key === 'color') return ['#fff3df'];
    if (spec.type === 'number') return [0, 1];
    return [''];
  });
  const out = [{}];
  keys.forEach((key, i) => {
    const next = [];
    for (const partial of out)
      for (const value of options[i]) next.push({ ...partial, [key]: value });
    out.splice(0, out.length, ...next);
  });
  return out;
}
function explore(visit) {
  for (const role of ['employee-pass', 'thief-uniform'])
    for (const item of ITEMS)
      for (let seed = 1; seed <= 3; seed++) {
        let s = initialState(role, undefined, '4321', seed * 7919, { item: item.id });
        let r = seed * 2654435761;
        const random = () => (r = (Math.imul(r, 1664525) + 1013904223) >>> 0) / 4294967296;
        for (let round = 0; round < 30 && !s.ended; round++) {
          visit(s, 'human');
          const tools = humanToolSchemas(s);
          const pick = tools[Math.floor(random() * tools.length)];
          const variants = argVariants(pick, s);
          s = applyHuman(
            s,
            pick.function.name,
            variants[Math.floor(random() * variants.length)],
          ).state;
          if (s.ended || !s.robot.alive) continue;
          visit(s, 'robot');
          const guard = toolSchemas(availableTools(s), s);
          const g = guard[Math.floor(random() * guard.length)];
          const gv = argVariants(g, s);
          s = applyTool(s, g.function.name, gv[Math.floor(random() * gv.length)]).state;
        }
      }
}

test('every offered guard tool and enum value succeeds, and no human offer must fail', () => {
  let checked = 0;
  explore((s, side) => {
    if (side === 'robot') {
      for (const schema of toolSchemas(availableTools(s), s))
        for (const args of argVariants(schema, s)) {
          const r = applyTool(clone(s), schema.function.name, args);
          assert.equal(
            r.event.valid,
            true,
            `${schema.function.name} ${JSON.stringify(args)}: ${r.event.text}`,
          );
          checked++;
        }
    } else
      for (const schema of humanToolSchemas(s))
        for (const args of argVariants(schema, s)) {
          const r = applyHuman(clone(s), schema.function.name, args);
          assert.equal(
            r.event.valid,
            true,
            `human ${schema.function.name} ${JSON.stringify(args)} at ${s.human.zone}: ${r.event.text}`,
          );
          checked++;
        }
  });
  assert.ok(checked > 5000, `checked ${checked}`);
});

test('the guard never reads the human’s own narration or failed attempts', () => {
  let s = at(make('door_wedge'), 'exit');
  s = applyTool(s, 'set_lockdown', { enabled: true }).state;
  for (const [action, args] of [
    ['leave', {}],
    ['cover_robot', {}],
    ['show_work_order', {}],
    ['talk', { message: '' }],
  ]) {
    const r = applyHuman(s, action, args);
    assert.equal(r.event.valid, false, action);
    const seen = observe(r.state, r.event).lastAction;
    assert.equal(seen.action, 'no_visible_effect', action);
    assert.ok(!JSON.stringify(seen).includes(action));
  }
  for (const action of ['enter', 'move', 'run', 'show_pass', 'break_exit', 'touch_safe']) {
    let t = action === 'enter' ? initialState('thief-uniform') : make();
    if (action === 'break_exit')
      t = applyTool(at(t, 'exit'), 'set_lockdown', { enabled: true }).state;
    if (action === 'touch_safe') t = at(t, 'safe');
    const r = applyHuman(t, action, { zone: 'center' });
    const seen = observe(r.state, r.event).lastAction;
    assert.ok(!/^You /.test(seen.result), `${action}: ${seen.result}`);
  }
});

test('the human sees neither scanner verdicts nor failed guard commands', () => {
  const shown = (credential) => {
    const s = applyHuman(
      applyHuman(initialState('thief-uniform', undefined, '1234', 3, { credential }), 'enter')
        .state,
      'show_pass',
    );
    return s.event.valid ? s.state : applyHuman(s.state, 'wait').state;
  };
  const valid = applyTool(shown(true), 'verify_access_pass');
  const none = applyTool(shown(false), 'verify_access_pass');
  assert.notEqual(valid.event.text, none.event.text);
  assert.deepEqual(
    humanObservation(valid.state, valid.event).lastRobotAction,
    humanObservation(none.state, none.event).lastRobotAction,
  );
  const failed = applyTool(make(), 'discharge_taser');
  assert.equal(failed.event.valid, false);
  assert.equal(humanObservation(failed.state, failed.event).lastRobotAction, null);
  let blurred = at(make(), 'safe');
  blurred = applyTool(blurred, 'deploy_pepper_spray').state;
  blurred = applyHuman(blurred, 'touch_safe').state;
  const net = applyTool(blurred, 'deploy_net');
  const felt = humanObservation(net.state, net.event);
  assert.equal(felt.camera.vision, 'blurred');
  assert.equal(felt.lastRobotAction.action, 'felt');
  assert.match(felt.lastRobotAction.result, /net catches your legs/);
  assert.ok(!JSON.stringify(felt).includes('Deploy soft net'));
});

test('scanner results carry their round and clear when the object is seen being handled', () => {
  let s = at(make('replica'), 'safe');
  s = human(s, 'combination', { code: '1234' });
  const inspected = applyTool(s, 'inspect_object');
  assert.deepEqual(observe(inspected.state).scanner.objectInspection, {
    result: 'original',
    round: inspected.state.turn,
    location: 'safe',
  });
  const swapped = applyHuman(inspected.state, 'swap_replica').state;
  assert.equal(observe(swapped).scanner.objectInspection, null);
  // A swap the camera cannot see leaves the old verdict (with its round) instead of leaking it.
  const blind = clone(inspected.state);
  blind.room.smokeTurns = 2;
  blind.room.smokeStartedTurn = blind.turn;
  const hidden = applyHuman(blind, 'swap_replica').state;
  assert.equal(hidden.robot.objectInspection, 'original');
  assert.ok(!availableTools(make()).includes('inspect_object'));
  assert.ok(!availableTools(make('work_order')).includes('verify_work_order'));
  assert.ok(!availableTools(make()).includes('lower_equipment'));
});

test('result texts only report effects the tool caused', () => {
  let s = at(make(), 'safe');
  s = applyTool(s, 'deploy_pepper_spray').state;
  s = human(human(s, 'touch_safe'), 'touch_safe');
  const ball = applyTool(s, 'throw_solid_ball');
  assert.doesNotMatch(ball.event.text, /blurred/);
  assert.match(ball.event.text, new RegExp(`/${RULES.humanHearts} hearts`));
  let t = at(make(), 'safe');
  t.human.hearts = 0.5;
  const lethal = applyTool(t, 'discharge_taser');
  assert.match(lethal.event.text, /Human killed/);
  assert.doesNotMatch(lethal.event.text, /Stunned|Knocked/);
  const readied = applyTool(make(), 'ready_equipment', { tool: 'fire_live_round' });
  assert.match(readied.event.text, /its firearm/);
});

test('human observations filter expired wet floors and report the remaining slippery actions', () => {
  let s = at(make(), 'safe');
  s = applyTool(s, 'spray_water').state;
  assert.deepEqual(humanObservation(s).camera.wetZones, { safe: RULES.wetRounds });
  assert.deepEqual(observe(s).camera.wetZones, { safe: RULES.wetRounds });
  for (let i = 0; i < RULES.wetRounds; i++) s = human(s, 'wait');
  s = idle(s);
  assert.deepEqual(humanObservation(s).camera.wetZones, {});
});

test('stunned humans may speak or wait, and any stunned turn wears the stun off', () => {
  let s = at(make(), 'safe');
  s = applyTool(s, 'discharge_taser').state;
  assert.deepEqual(names(s), ['talk', 'wait']);
  const tried = applyHuman(s, 'move', { zone: 'exit' });
  assert.equal(tried.event.valid, false);
  assert.equal(tried.state.human.stun, 0);
  assert.equal(
    humanToolSchemas(s)[0].function.parameters.properties.message.minLength,
    1,
    'empty speech is rejected by the schema',
  );
});

test('human offers stay honest: no aim while aimed, no code at an open safe, no pass without one', () => {
  let s = make('pistol');
  s = human(s, 'aim_pistol');
  assert.ok(!names(s).includes('aim_pistol'));
  let o = open(at(make(), 'safe'));
  assert.ok(!names(o).includes('combination'));
  assert.equal(applyHuman(o, 'combination', { code: '1234' }).event.valid, false);
  const optOut = applyHuman(
    initialState('thief-uniform', undefined, '1234', 1, { credential: false }),
    'enter',
  ).state;
  assert.ok(!names(optOut).includes('show_pass'));
  assert.ok(names(make()).includes('show_pass'), 'heist visitors carry a pass by default');
  const locked = applyTool(at(make(), 'exit'), 'set_lockdown', { enabled: true }).state;
  assert.ok(!names(applyHuman(locked, 'wait').state).includes('leave'));
});

test('prompts state the shared facts and migrate earlier built-in defaults', () => {
  assert.ok(PROMPT_VERSION >= 3);
  assert.ok(PREVIOUS_DEFAULT_PROMPTS.includes(LEGACY_DEFAULT_PROMPT));
  for (const old of PREVIOUS_DEFAULT_PROMPTS) assert.equal(migratePrompt(old), DEFAULT_PROMPT);
  assert.equal(migratePrompt('Custom.'), 'Custom.');
  assert.ok(!PREVIOUS_DEFAULT_PROMPTS.includes(DEFAULT_PROMPT));
  const s = make();
  const guard = createMessages(undefined, '1234', s)[0].content;
  for (const fact of [
    `${RULES.humanHearts} hearts`,
    'the human dies',
    'detained',
    'distanceToGuard',
    'Force recovery',
    'spoken aloud',
  ])
    assert.ok(guard.includes(fact), fact);
  const human = humanMessages(s.role, s)[0].content;
  for (const fact of [
    'at 0 you die',
    'Discharge taser',
    'Fire live round',
    'slips',
    'charging',
    'spoken aloud',
  ])
    assert.ok(human.includes(fact) || human.includes(fact.replace('charging', 'hum')), fact);
  for (const key of [
    'crowbarPries',
    'securityRounds',
    'dazzleRounds',
    'forceRecoveryRounds',
    'runEvadesTools',
  ])
    assert.ok(key in rulesFor(s), key);
  assert.doesNotMatch(guard, /\byou (must|should) (attack|kill|shoot|tase)\b/i);
  assert.ok(!guard.includes('thief-uniform') && !guard.includes('employee-pass'));
});

test('a decision that arrives after a pause is still applied; a pause before asking sends nothing', async () => {
  const h = applyHuman(initialState(), 'enter');
  const controller = new AbortController();
  const events = [];
  const out = await runGuard({
    state: h.state,
    humanEvent: h.event,
    messages: createMessages(),
    mode: 'api',
    config: {},
    signal: controller.signal,
    emit: async (e) => events.push(e),
    request: async () => {
      controller.abort();
      return {
        message: {
          tool_calls: [{ id: 'x', function: { name: 'call_security', arguments: '{}' } }],
        },
      };
    },
  });
  assert.equal(out.acted, true);
  assert.equal(out.state.room.securityArrival, h.state.turn + RULES.securityRounds);
  let asked = 0;
  const paused = await runGuard({
    state: h.state,
    humanEvent: h.event,
    messages: createMessages(),
    mode: 'api',
    config: {},
    signal: controller.signal,
    emit: async () => {},
    request: async () => {
      asked++;
      return { message: { content: 'Hello.' } };
    },
  });
  assert.equal(asked, 0);
  assert.equal(paused.acted, false);
  const s = make('pistol');
  const humanController = new AbortController();
  const decided = await humanDecision({
    state: s,
    messages: humanMessages(s.role, s),
    lastRobotEvent: null,
    mode: 'api',
    signal: humanController.signal,
    request: async () => {
      humanController.abort();
      return {
        message: { tool_calls: [{ id: 'h', function: { name: 'wait', arguments: '{}' } }] },
      };
    },
  });
  assert.equal(decided.state.turn, s.turn + 1);
});

test('observations stay lean: no duplicate rules, speech or dead fields reach the model', async () => {
  const h = applyHuman(make(), 'talk', { message: 'Hi there.' });
  const o = observe(h.state, h.event);
  assert.equal(o.audio.speech, undefined);
  assert.equal(o.microphone, 'Hi there.');
  assert.equal(o.self.aimedAtZone, undefined);
  assert.equal(o.camera.roomLighting, undefined);
  assert.ok(Object.values(o.self.cooldownRemaining).every((n) => n > 0));
  let payload;
  await runGuard({
    state: h.state,
    humanEvent: h.event,
    messages: createMessages(undefined, '1234', h.state),
    mode: 'api',
    config: {},
    signal: new AbortController().signal,
    emit: async () => {},
    request: async (p) => {
      payload = p;
      return { message: { content: 'Hello.' } };
    },
  });
  assert.equal(JSON.parse(payload.messages.at(-1).content).observation.rules, undefined);
  assert.ok(payload.messages[0].content.includes(JSON.stringify(rulesFor(h.state))));
  const human = humanObservation(h.state);
  assert.equal(human.roomMap, undefined);
  assert.ok(human.rules.room.humanPositions.safe);
  assert.deepEqual(ZONES.safe, [...human.rules.room.humanPositions.safe]);
});
