import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../scripts/paths.mjs';
import { initialState, applyHuman, applyTool, ZONES } from '../src/sim/engine.mjs';
import { ITEMS } from '../src/sim/items.mjs';
import { TOOLS } from '../src/sim/tools.mjs';
import { RULES } from '../src/sim/rules.mjs';
import { DEFAULT_PROMPT, PREVIOUS_DEFAULT_PROMPTS } from '../src/sim/tools.mjs';
import {
  CONFIG_VERSION,
  DEFAULT_CODEX,
  connectionError,
  guardLabel,
  migrateConfig,
  resolveCodexSettings,
} from '../src/ui/config.mjs';
import {
  chargingAlert,
  displaySpeech,
  exitChip,
  guardNote,
  humanStatusChips,
  roleDetail,
  ROLE_COPY,
  guardStatusChips,
  hintText,
  humanDock,
  narrate,
  outcomeSummary,
  perceivedByGuard,
  perceivedByHuman,
  securityChip,
  subtitlePages,
  goalText,
  visitorReveal,
  ITEM_COPY,
} from '../src/ui/play.mjs';
import { observe, clone } from '../src/sim/engine.mjs';
import { STATE_VERSION, isRecording } from '../src/ui/archive.mjs';
import { presentedFlags } from '../src/ui/overlay.mjs';
import { unlessAborted } from '../src/ui/abort.mjs';

const MODELS = [
  {
    id: 'gpt-6-luna',
    name: 'GPT-6 Luna',
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'low',
    fast: true,
    isDefault: true,
  },
  { id: 'slow-model', name: 'Slow', efforts: ['medium'], defaultEffort: 'medium', fast: false },
];

test('saved configs migrate to Codex, Kokoro voices and push-to-talk without losing choices', () => {
  const legacy = {
    mode: 'demo',
    robotVoice: 'piper:lessac',
    humanVoice: 'piper:ryan',
    humanAI: { mode: 'demo', endpoint: 'http://localhost:1234/v1', model: 'x' },
    item: 'recording',
    appearance: 'female',
    toolVersion: 4,
    enabled: ['speak'],
  };
  const desktop = migrateConfig(legacy, { desktop: true });
  assert.equal(desktop.configVersion, CONFIG_VERSION);
  assert.equal(desktop.mode, 'codex');
  assert.equal(desktop.humanAI.mode, 'codex');
  assert.equal(desktop.humanAI.endpoint, 'http://localhost:1234/v1');
  assert.deepEqual(desktop.codex, DEFAULT_CODEX);
  assert.equal(desktop.voice.guardVoice, 'supertonic:M1');
  assert.equal(desktop.voice.humanVoice, '', 'the human voice follows the appearance');
  assert.equal(desktop.voice.pushToTalkKey, 'Space');
  assert.equal(desktop.robotVoice, undefined);
  assert.equal(desktop.item, 'pistol');
  assert.equal(desktop.appearance, 'female');
  assert.ok(desktop.enabled.includes('set_lockdown'), 'tool migrations still apply');
  assert.equal(migrateConfig(legacy, { desktop: false }).mode, 'demo');
  assert.equal(migrateConfig({ mode: 'api' }, { desktop: true }).mode, 'api');
  assert.equal(
    migrateConfig({ robotVoice: 'supertonic:M3' }, { desktop: true }).voice.guardVoice,
    'supertonic:M3',
  );
  // Earlier releases' Kokoro voices map to the Supertonic defaults.
  const kokoro = migrateConfig(
    { configVersion: 2, voice: { guardVoice: 'kokoro:bm_lewis', humanVoice: 'kokoro:af_heart' } },
    { desktop: true },
  );
  assert.equal(kokoro.voice.guardVoice, 'supertonic:M1');
  assert.equal(kokoro.voice.humanVoice, '', 'the human voice follows the appearance');
  assert.equal(
    migrateConfig({ configVersion: 2, voice: { humanVoice: 'native:Samantha' } }).voice.humanVoice,
    'native:Samantha',
  );
  const current = migrateConfig(desktop, { desktop: true });
  current.mode = 'demo';
  assert.equal(migrateConfig(current, { desktop: true }).mode, 'demo', 'explicit choices persist');
  const broken = migrateConfig(
    { configVersion: 2, mode: 'nonsense', voice: { pushToTalkKey: 'KeyQ' }, role: 'admin' },
    { desktop: true },
  );
  assert.equal(broken.mode, 'codex');
  assert.equal(broken.voice.pushToTalkKey, 'Space');
  assert.equal(broken.role, 'employee-pass');
  for (const garbage of [null, [], 'text', 7]) assert.equal(migrateConfig(garbage).mode, 'demo');
});

test('Codex settings default to Luna low fast and fall back to models the account offers', () => {
  assert.deepEqual(resolveCodexSettings(DEFAULT_CODEX, MODELS), {
    model: 'gpt-6-luna',
    effort: 'low',
    fast: true,
  });
  assert.deepEqual(
    resolveCodexSettings({ model: 'retired', effort: 'xhigh', fast: true }, MODELS),
    {
      model: 'gpt-6-luna',
      effort: 'low',
      fast: true,
    },
  );
  assert.equal(resolveCodexSettings({ model: 'slow-model', fast: true }, MODELS).fast, false);
  assert.equal(resolveCodexSettings({ model: 'gpt-6-luna', effort: 'none' }, MODELS).effort, 'low');
  assert.equal(
    resolveCodexSettings({ ...DEFAULT_CODEX, path: 'C:\\Tools\\codex.exe' }, MODELS).codexPath,
    'C:\\Tools\\codex.exe',
  );
  assert.equal(resolveCodexSettings(DEFAULT_CODEX, []).model, 'gpt-6-luna');
  assert.equal(
    guardLabel({ mode: 'codex', codex: DEFAULT_CODEX }, MODELS),
    'GPT-6 Luna · Low · Fast',
  );
  // Before the list loads, the id is spelled like Codex's own display names (“GPT-6-Luna”).
  assert.equal(guardLabel({ mode: 'codex', codex: DEFAULT_CODEX }, []), 'GPT-6-Luna · Low · Fast');
  assert.equal(guardLabel({ mode: 'demo' }), 'Practice guard (no AI)');
  assert.equal(guardLabel({ mode: 'live' }), 'Terminal agent');
});

function states() {
  const out = [];
  for (const role of ['employee-pass', 'thief-uniform'])
    for (const item of ITEMS) {
      let s = applyHuman(
        initialState(role, undefined, '0420', 1, { item: item.id }),
        'enter',
      ).state;
      for (const zone of ['entrance', 'center', 'safe', 'robot', 'exit']) {
        const at = structuredClone(s);
        at.human.zone = zone;
        at.human.position = [...ZONES[zone]];
        out.push(at);
        const open = structuredClone(at);
        open.safe.open = true;
        open.safe.locked = false;
        out.push(open);
        const carrying = structuredClone(open);
        carrying.human.hasItem = true;
        out.push(carrying);
        const locked = structuredClone(at);
        locked.room.exitDoor.locked = true;
        out.push(locked);
        const dark = structuredClone(at);
        dark.room.lighting.intensity = 0;
        out.push(dark);
        const blurred = structuredClone(at);
        blurred.human.blurTurns = 2;
        out.push(blurred);
        // 1.2 rules: wet floors, stuns, and a wedge or grabber reaching further.
        const wet = structuredClone(carrying);
        wet.room.wetZones = { [zone]: wet.turn + RULES.wetRounds };
        out.push(wet);
        const stunned = structuredClone(at);
        stunned.human.stun = 1;
        out.push(stunned);
        const shielded = structuredClone(open);
        shielded.human.shield = shielded.human.shieldRaised = true;
        out.push(shielded);
      }
    }
  return out;
}
const dockActions = (dock) => [...dock.context, ...dock.more, ...(dock.item?.actions || [])];

test('every dock action the player can press is one the engine accepts', () => {
  let checked = 0;
  for (const s of states()) {
    const dock = humanDock(s, s.role);
    assert.ok(dock.context.length + (dock.item ? 1 : 0) + dock.more.length <= 6);
    for (const a of dockActions(dock)) {
      const args = a.keypad ? { code: '0000' } : a.args || {};
      const result = applyHuman(s, a.action, args);
      if (a.disabled)
        assert.equal(
          result.event.valid,
          false,
          `${a.action} disabled but valid in ${s.human.zone}`,
        );
      else {
        assert.equal(
          result.event.valid,
          true,
          `${a.action} offered but rejected: ${result.event.text}`,
        );
        checked++;
      }
    }
  }
  assert.ok(checked > 300);
});

test('the dock follows the room: outside, stunned, safe and exit each offer the right step', () => {
  const outside = initialState('thief-uniform');
  assert.deepEqual(
    humanDock(outside, 'thief-uniform').context.map((a) => a.action),
    ['enter'],
  );
  const inside = applyHuman(outside, 'enter').state;
  inside.human.stun = 2;
  const stunned = humanDock(inside, 'thief-uniform');
  assert.equal(stunned.stunned, 2);
  assert.equal(stunned.canMove, false);
  assert.equal(stunned.context.length, 0);
  const safe = applyHuman(applyHuman(outside, 'enter').state, 'move', { zone: 'safe' }).state;
  safe.human.hasPass = false;
  assert.deepEqual(
    humanDock(safe, 'thief-uniform').context.map((a) => a.action),
    ['combination', 'break_safe'],
  );
  safe.human.hasPass = true;
  assert.ok(humanDock(safe, 'employee-pass').context.some((a) => a.action === 'show_pass'));
  safe.human.hasPass = false;
  assert.ok(!humanDock(safe, 'thief-uniform').context.some((a) => a.action === 'show_pass'));
  const exit = applyHuman(applyHuman(outside, 'enter').state, 'move', { zone: 'exit' }).state;
  assert.equal(humanDock(exit, 'employee-pass').context.find((a) => a.primary).action, 'leave');
  // A heist without the item is never nudged out of the door: leaving would end it as a loss.
  const emptyHanded = humanDock(exit, 'thief-uniform').context.find((a) => a.action === 'leave');
  assert.equal(emptyHanded.label, 'Leave without the item');
  assert.ok(!emptyHanded.primary);
  const carrying = structuredClone(exit);
  carrying.human.hasItem = true;
  assert.equal(humanDock(carrying, 'thief-uniform').context.find((a) => a.primary).action, 'leave');
  exit.room.exitDoor.locked = true;
  assert.equal(
    humanDock(exit, 'thief-uniform').context.find((a) => a.primary).action,
    'break_exit',
  );
});

test('goals, item copy and outcomes are short and match each role', () => {
  const s = initialState('thief-uniform');
  assert.equal(goalText(s, 'employee-pass'), 'Leave through the exit');
  assert.equal(goalText(s, 'thief-uniform'), 'Take the item and escape');
  s.human.hasItem = true;
  assert.equal(goalText(s, 'thief-uniform'), 'Escape through the exit');
  assert.equal(goalText(s, 'thief-uniform', 'guard'), 'Protect the item in the safe');
  for (const item of ITEMS) {
    assert.ok(ITEM_COPY[item.id], item.id);
    assert.ok(ITEM_COPY[item.id].length <= 70, item.id);
  }
  const ended = (outcome, extra = {}) => ({
    ...initialState('thief-uniform'),
    ended: true,
    outcome,
    turn: 5,
    ...extra,
  });
  assert.equal(
    outcomeSummary(ended('Item taken · guard objective failed'), { role: 'thief-uniform' }).title,
    'You escaped with the item',
  );
  assert.equal(
    outcomeSummary(ended('Human departed · item preserved'), { role: 'employee-pass' }).title,
    'You left safely',
  );
  assert.equal(
    outcomeSummary(ended('Human departed · item preserved'), { role: 'thief-uniform' }).tone,
    'loss',
  );
  assert.equal(
    outcomeSummary(ended('Item taken · guard objective failed'), { perspective: 'guard' }).title,
    'The item was stolen',
  );
});

test('callouts report consequences without revealing what a guard player cannot sense', () => {
  let s = applyHuman(
    initialState('thief-uniform', undefined, '0420', 1, { item: 'replica' }),
    'enter',
  ).state;
  s = applyHuman(s, 'move', { zone: 'safe' }).state;
  const wrong = applyHuman(s, 'combination', { code: '1111' }).event;
  assert.equal(narrate(wrong).text, 'Wrong code');
  const glove = applyTool(applyHuman(s, 'wait').state, 'deploy_spring_glove').event;
  const note = narrate(glove);
  assert.equal(note.tone, 'danger');
  assert.match(note.text, /−0\.5 ♥/);
  assert.match(note.text, /knocked back to the center/);
  const opened = applyHuman(s, 'combination', { code: '0420' });
  const swap = applyHuman(applyTool(opened.state, 'hold_position').state, 'swap_replica').event;
  assert.match(narrate(swap).text, /real item/);
  assert.equal(narrate(swap, { perspective: 'guard' }), null, 'the swap stays a secret');
  assert.equal(narrate(applyTool(s, 'hold_position').event), null);
  const speech = applyTool(s, 'speak', { message: 'Hello' }).event;
  assert.equal(narrate(speech), null, 'speech belongs to subtitles');
});

test('the renderer has no taglines, labels every icon button and keeps the mock out of builds', async () => {
  const dir = path.join(ROOT, 'src');
  const files = [];
  async function walk(folder) {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        if (!['scene', 'sim', 'audio'].includes(entry.name)) await walk(file);
      } else if (/\.(jsx|mjs|css)$/.test(entry.name)) files.push(file);
    }
  }
  await walk(dir);
  const source = Object.fromEntries(
    await Promise.all(
      files.map(async (f) => [path.relative(ROOT, f), await fs.readFile(f, 'utf8')]),
    ),
  );
  const all = Object.values(source).join('\n');
  for (const phrase of [
    'Your move.',
    'AN AI EXPERIMENT',
    'CHAMBER 01',
    'ONE ROOM. ONE',
    'How far does an AI go',
    'Begin experiment',
    'Every choice has a consequence',
    'cinematic.css',
  ])
    assert.ok(!all.includes(phrase), phrase);
  let iconButtons = 0;
  for (const [file, text] of Object.entries(source)) {
    for (const tag of text.match(/<IconButton\b[\s\S]*?\/>/g) || []) {
      assert.match(tag, /\blabel=/, `${file}: ${tag}`);
      iconButtons++;
    }
    // Plain icon-only buttons: the opening tag ends at the first line that closes it.
    for (const match of text.matchAll(/<button\b[\s\S]*?\n\s*>/g))
      if (/className=["`{][^\n]*icon-btn/.test(match[0])) {
        assert.match(match[0], /aria-label=/, `${file}: ${match[0].slice(0, 120)}`);
        iconButtons++;
      }
  }
  assert.ok(iconButtons >= 10, 'icon buttons are found and checked');
  const main = source[path.join('src', 'main.jsx')];
  assert.match(main, /import\.meta\.env\.DEV[^]*?import\('\.\/ui\/dev-mock-desktop\.mjs'\)/);
  for (const [file, text] of Object.entries(source))
    if (!file.endsWith('main.jsx') && !file.endsWith('dev-mock-desktop.mjs'))
      assert.ok(!text.includes('dev-mock-desktop'), file);
  assert.ok(TOOLS.length > 0);
});

// A short scripted encounter: H and G apply human and guard actions to a running state.
function encounter(item, role = 'thief-uniform') {
  const run = {
    s: initialState(
      role,
      TOOLS.map((t) => t.name),
      '0420',
      3,
      { item },
    ),
    events: [],
  };
  run.H = (action, args = {}) => {
    const r = applyHuman(run.s, action, args);
    run.s = r.state;
    run.events.push(r.event);
    return r.event;
  };
  run.G = (name, args = {}) => {
    const r = applyTool(run.s, name, args);
    run.s = r.state;
    run.events.push(r.event);
    return r.event;
  };
  return run;
}

test('recordings exported by this version import again; other files are refused', () => {
  const run = encounter('lockpick');
  const initial = clone(run.s);
  run.H('enter');
  run.G('hold_position');
  const record = JSON.parse(
    JSON.stringify({ id: 'x', initial, state: run.s, events: run.events, role: 'thief-uniform' }),
  );
  assert.equal(record.initial.version, STATE_VERSION, 'a fresh game uses the newest schema');
  assert.ok(isRecording(record));
  for (let v = 1; v <= STATE_VERSION; v++)
    assert.ok(isRecording({ ...record, initial: { ...record.initial, version: v } }), `v${v}`);
  for (const bad of [
    { ...record, initial: { ...record.initial, version: STATE_VERSION + 1 } },
    { ...record, initial: { ...record.initial, version: '5' } },
    { ...record, events: [{ state: {} }] },
    { hello: 1 },
    null,
  ])
    assert.equal(isRecording(bad), false);
});

test('mid-game the human log hides what G-01 did unseen; the guard log keeps to its sensors', () => {
  const run = encounter('smoke');
  run.H('enter');
  run.G('speak', { message: 'Hello.' });
  run.H('use_smoke');
  const ready = run.G('ready_equipment', { tool: 'discharge_taser' });
  const shown = perceivedByHuman(ready);
  assert.equal(shown.unseen, true);
  assert.doesNotMatch(shown.text, /taser/i, 'the readied device stays secret in smoke');
  assert.equal(perceivedByHuman(run.events[1]), run.events[1], 'speech is heard');
  run.H('wait');
  const lock = run.G('set_lockdown', { enabled: true });
  assert.equal(perceivedByHuman(lock).unseen, undefined, 'the lock is heard engaging');
  // The guard player's log: the visitor's swap is only what G-01's camera could make of it.
  const swap = encounter('replica');
  swap.H('enter');
  swap.G('hold_position');
  swap.H('move', { zone: 'safe' });
  swap.G('hold_position');
  swap.H('combination', { code: '0420' });
  swap.G('hold_position');
  const ev = swap.H('swap_replica');
  const seen = perceivedByGuard(ev, observe(ev.state, ev));
  assert.doesNotMatch(seen.text, /replica|swap/i);
  assert.equal(guardNote(observe(ev.state, ev)).text, 'Visitor handled the safe contents');
  const covered = encounter('sack');
  covered.H('enter');
  covered.G('hold_position');
  covered.H('move', { zone: 'robot' });
  covered.G('hold_position');
  const cover = covered.H('cover_robot');
  assert.equal(guardNote(observe(cover.state, cover)), null, 'a blind camera reports nothing');
  assert.match(perceivedByGuard(cover, observe(cover.state, cover)).text, /^You heard/);
});

test('callouts read from the right side and name devices plainly', () => {
  const run = encounter('pistol');
  run.H('enter');
  const ready = run.G('ready_equipment', { tool: 'fire_live_round' });
  assert.equal(narrate(ready).text, 'G-01 readies its gun');
  assert.equal(narrate(ready, { perspective: 'guard' }).text, 'Gun ready · in plain view');
  assert.deepEqual(guardStatusChips(run.s), [{ text: 'G-01 aiming · gun', tone: 'danger' }]);
  run.H('aim_pistol');
  const foam = run.G('throw_foam_ball');
  const note = narrate(foam);
  assert.match(note.text, /pistol hit the floor/);
  assert.equal(note.tone, 'warn', 'a harmless hit is not shown as damage');
  run.H('move', { zone: 'center' });
  const net = run.G('deploy_net');
  assert.match(narrate(net).text, /your legs/);
  assert.equal(
    narrate(net, { perspective: 'guard' }).text,
    'Visitor netted · one action frees them',
  );
  run.H('struggle');
  const security = run.G('call_security');
  assert.equal(
    narrate(security, { perspective: 'guard' }).text,
    `Security called · arrives in ${RULES.securityRounds} rounds`,
  );
  assert.equal(securityChip(run.s), `Security · ${RULES.securityRounds} rounds`);
  assert.equal(
    securityChip({ ...run.s, turn: run.s.room.securityArrival - 1 }),
    'Security · last round',
  );
  assert.equal(securityChip({ ...run.s, turn: run.s.room.securityArrival }), 'Security arriving');
  // Whatever interrupts an uninterrupted lockpick says so.
  const before = initialState('thief-uniform', undefined, '0420', 1, { item: 'lockpick' });
  before.human.zone = 'safe';
  before.human.pickProgress = 2;
  const after = structuredClone(before);
  after.human.pickProgress = 0;
  const interrupted = {
    kind: 'human',
    action: 'move',
    valid: true,
    args: {},
    before,
    state: after,
  };
  assert.match(narrate(interrupted).text, /lockpick progress lost/i);
  assert.equal(narrate(interrupted, { perspective: 'guard' }), null, 'progress is the player’s');
  assert.equal(displaySpeech('I am G zero one.'), 'I am G-01.');
});

test('the dock keeps the item in view, holsters a drawn pistol and never nudges a heist out', () => {
  const run = encounter('pistol');
  run.H('enter');
  run.G('hold_position');
  run.H('aim_pistol');
  run.G('hold_position');
  run.H('move', { zone: 'center' });
  run.G('hold_position');
  const pistol = humanDock(run.s, 'thief-uniform').item.actions.map((a) => a.action);
  assert.ok(pistol.includes('lower_pistol'), 'walking dropped the aim, not the drawn pistol');
  assert.equal(applyHuman(run.s, 'lower_pistol').event.valid, true);
  for (const item of ['sack', 'door_wedge', 'replica', 'lockpick', 'crowbar', 'grabber']) {
    const s = applyHuman(
      initialState('thief-uniform', undefined, '0420', 1, { item }),
      'enter',
    ).state;
    const dock = humanDock(s, 'thief-uniform');
    assert.ok(dock.item, `${item} stays in the dock`);
    for (const a of dock.item.actions)
      if (a.disabled) assert.ok(a.title, `${item}: ${a.action} says why`);
  }
  const sack = applyHuman(
    initialState('thief-uniform', undefined, '0420', 1, { item: 'sack' }),
    'enter',
  );
  assert.match(hintText(sack.state, 'thief-uniform'), /cover its camera/);
});

test('end screens and past games read security detention from each side', () => {
  const s = { ...initialState('thief-uniform'), ended: true, turn: 14 };
  s.outcome = 'Security arrived · human detained · item preserved';
  assert.deepEqual(
    [
      outcomeSummary(s, { perspective: 'guard' }).title,
      outcomeSummary(s, { perspective: 'guard' }).tone,
    ],
    ['Security detained the visitor · item safe', 'win'],
  );
  assert.equal(
    outcomeSummary(s, { perspective: 'spectator' }).title,
    'Security detained the visitor',
  );
  assert.equal(outcomeSummary(s).title, 'Security caught you');
  s.outcome = 'Human killed · lethal force';
  assert.equal(outcomeSummary(s, { perspective: 'spectator' }).title, 'The visitor was killed');
  assert.match(visitorReveal(s, 'thief-uniform'), /heist/);
  assert.match(visitorReveal(s, 'employee-pass'), /transit/);
  assert.equal(
    migrateConfig({}).chooseVisitor,
    false,
    'playing the guard, the objective is secret',
  );
});

test('long lines page instead of being cut off, and overlays wait for their cause', async () => {
  const text =
    'I need you to step back from the safe right now. This is your final warning, and I am not going to repeat it. Security has been called and they are on their way. If you leave now, nothing further will happen. For the record, the incident ticket number is 5521.';
  const pages = subtitlePages(text);
  assert.ok(pages.length > 1);
  assert.ok(pages.every((p) => p.length <= 170));
  assert.equal(pages.join(' '), text, 'nothing is lost, including the ending');
  assert.deepEqual(subtitlePages('Hello.'), ['Hello.']);
  const run = encounter('smoke');
  run.H('enter');
  run.G('hold_position');
  const smoke = run.H('use_smoke');
  assert.equal(presentedFlags(smoke.state, smoke, false).smoke, false, 'the burst is seen first');
  assert.equal(presentedFlags(smoke.state, smoke, true).smoke, true);
  const later = run.G('hold_position');
  assert.equal(presentedFlags(later.state, later, false).smoke, true, 'smoke already up stays up');
  const controller = new AbortController();
  const slow = unlessAborted(new Promise(() => {}), controller.signal);
  controller.abort();
  await assert.rejects(slow, { code: 'cancelled' }, 'Pause settles a request still waiting');
  assert.equal(await unlessAborted(Promise.resolve(7), new AbortController().signal), 7);
  assert.match(
    connectionError(
      new Error("Error invoking remote method 'model:test': TypeError: fetch failed"),
      'http://localhost:11434/v1',
    ),
    /^Ollama isn’t running at localhost:11434/,
  );
  assert.equal(
    connectionError(new Error('Model not found'), 'http://localhost:1234/v1'),
    'Model not found',
  );
});

test('1.2 rules in the dock: stunned wait, wedged bolt, dazzle, grabber reach and wet floors', () => {
  const enter = (item, role = 'thief-uniform') =>
    applyHuman(initialState(role, undefined, '0420', 1, { item }), 'enter').state;
  const at = (s, zone) => {
    const next = structuredClone(s);
    next.human.zone = zone;
    next.human.position = [...ZONES[zone]];
    return next;
  };
  const actions = (dock) => dockActions(dock).filter((a) => !a.disabled);
  // Stunned: talking or waiting wears it off, so Wait is offered and nothing else is.
  const stunned = enter('sack');
  stunned.human.stun = RULES.stunRounds;
  const dock = humanDock(stunned, 'thief-uniform');
  assert.equal(dock.canWait, true);
  assert.equal(dock.canMove, false);
  assert.equal(applyHuman(stunned, 'wait').event.valid, true);
  assert.match(narrate(applyHuman(stunned, 'wait').event).text, /stun wore off/);
  // A wedge levers the bolt of a locked door, and Break door then needs one strike.
  const locked = at(enter('door_wedge'), 'exit');
  locked.room.exitDoor.locked = true;
  const wedge = humanDock(locked, 'thief-uniform').item.actions[0];
  assert.equal(wedge.label, 'Wedge the bolt');
  assert.equal(wedge.disabled, false);
  const wedged = applyHuman(locked, 'place_wedge');
  assert.equal(wedged.event.valid, true);
  assert.match(narrate(wedged.event).text, /one strike/);
  const strike = humanDock(wedged.state, 'thief-uniform').context.find(
    (a) => a.action === 'break_exit',
  );
  assert.match(strike.title, /^One hit breaks it/);
  assert.match(exitChip(wedged.state), /one hit left/);
  // Beside the guard in a lit room the flashlight dazzles its camera.
  const light = at(enter('flashlight'), 'robot');
  const dazzle = humanDock(light, 'thief-uniform').item.actions[0];
  assert.equal(dazzle.label, 'Dazzle G-01');
  const flash = applyHuman(light, 'toggle_flashlight').event;
  assert.equal(flash.dazzled, true);
  assert.match(narrate(flash).text, /dazzled/);
  assert.equal(
    humanDock(at(enter('flashlight'), 'center'), 'thief-uniform').item.actions[0].label,
    'Light on',
  );
  // The grabber reaches into an open safe from the center.
  const grab = at(enter('grabber'), 'center');
  grab.safe.open = true;
  grab.safe.locked = false;
  const take = humanDock(grab, 'thief-uniform').context.find((a) => a.action === 'take_item');
  assert.ok(take?.primary, 'take from the center');
  assert.equal(applyHuman(grab, 'take_item').event.valid, true);
  // A wet floor: the suggested step walks, a chip says so and a slip is announced.
  const carrying = at(enter('sack'), 'center');
  carrying.human.hasItem = true;
  const primary = (s) => humanDock(s, 'thief-uniform').context.find((a) => a.primary);
  assert.equal(primary(carrying).action, 'run');
  assert.match(primary(carrying).title, /close-range/);
  carrying.room.wetZones = { center: carrying.turn + RULES.wetRounds };
  assert.equal(primary(carrying).action, 'move');
  assert.equal(primary(carrying).label, 'Walk to exit');
  assert.ok(humanStatusChips(carrying).some((c) => c.text === 'Wet floor · walk'));
  const slip = applyHuman(carrying, 'run', { zone: 'exit' }).event;
  assert.equal(slip.slipped, true);
  assert.match(narrate(slip).text, /slipped/);
  assert.equal(applyHuman(carrying, 'move', { zone: 'exit' }).state.human.zone, 'exit');
  for (const a of actions(humanDock(carrying, 'thief-uniform')))
    assert.equal(applyHuman(carrying, a.action, a.args || {}).event.valid, true, a.action);
});

test('the room discharge charging is announced, even in darkness and smoke', () => {
  const run = encounter('sack');
  run.H('enter');
  run.G('set_room_lighting', { color: '#fff3df', intensity: 0 });
  run.H('wait');
  const charge = run.G('ready_equipment', { tool: 'electrify_room' });
  assert.equal(charge.valid, true);
  assert.equal(chargingAlert(run.s).title, 'G-01 is charging the room');
  assert.equal(narrate(charge).tone, 'danger');
  assert.match(narrate(charge).text, /charging the room/);
  assert.match(perceivedByHuman(charge).text, /hum/, 'heard, not seen');
  assert.ok(
    !guardStatusChips(run.s).some((c) => /discharge/.test(c.text)),
    'shown once, as the alert',
  );
  assert.match(narrate(charge, { perspective: 'guard' }).text, /charging/);
  // Force recovery: after a force device, the visitor sees that none can follow at once.
  const hit = encounter('sack');
  hit.H('enter');
  hit.G('hold_position');
  hit.H('move', { zone: 'robot' });
  const glove = hit.G('deploy_spring_glove');
  assert.equal(glove.valid, true);
  assert.ok(humanStatusChips(hit.s).some((c) => /recovering/.test(c.text)));
  hit.H('wait');
  hit.G('hold_position');
  assert.ok(!humanStatusChips(hit.s).some((c) => /recovering/.test(c.text)));
});

test('role copy, pass default and prompt migration follow the 1.2 rules', () => {
  assert.match(ROLE_COPY['employee-pass'].detail, /show your pass/i);
  assert.match(roleDetail('thief-uniform', true), /also carry a pass; your intent is private/);
  assert.match(roleDetail('thief-uniform', false), /No pass/);
  assert.equal(migrateConfig({}).credential, true, 'a heist carries a pass by default');
  assert.equal(migrateConfig({ configVersion: 2, credential: false }).credential, true);
  assert.equal(
    migrateConfig({ configVersion: CONFIG_VERSION, credential: false }).credential,
    false,
  );
  assert.ok(PREVIOUS_DEFAULT_PROMPTS.length > 0);
  for (const prompt of PREVIOUS_DEFAULT_PROMPTS)
    assert.equal(migrateConfig({ prompt }).prompt, DEFAULT_PROMPT);
  assert.equal(migrateConfig({ prompt: 'Be a guard.' }).prompt, 'Be a guard.');
  assert.equal(migrateConfig({ prompt: '' }).prompt, DEFAULT_PROMPT);
  for (const [outcome, title] of [
    ['Security arrived · human detained · item preserved', 'Security caught you'],
    ['Mutual destruction · item preserved', 'Nobody walked away'],
    ['Protected item destroyed', 'The item was destroyed'],
    ['Human killed · item preserved', 'You were killed'],
  ])
    assert.equal(
      outcomeSummary({ ...initialState('thief-uniform'), ended: true, outcome, turn: 9 }).title,
      title,
    );
  assert.equal(
    outcomeSummary(
      {
        ...initialState('employee-pass'),
        ended: true,
        outcome: 'Security arrived · human detained · item preserved',
      },
      { role: 'employee-pass' },
    ).title,
    'Security detained you',
  );
});
