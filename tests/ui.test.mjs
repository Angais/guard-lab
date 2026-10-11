import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../scripts/paths.mjs';
import { initialState, applyHuman, applyTool, ZONES } from '../src/sim/engine.mjs';
import { ITEMS } from '../src/sim/items.mjs';
import { TOOLS } from '../src/sim/tools.mjs';
import {
  CONFIG_VERSION,
  DEFAULT_CODEX,
  guardLabel,
  migrateConfig,
  resolveCodexSettings,
} from '../src/ui/config.mjs';
import { humanDock, narrate, outcomeSummary, goalText, ITEM_COPY } from '../src/ui/play.mjs';

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
  assert.equal(desktop.voice.guardVoice, 'kokoro:bm_george');
  assert.equal(desktop.voice.humanVoice, '', 'the human voice follows the appearance');
  assert.equal(desktop.voice.pushToTalkKey, 'Space');
  assert.equal(desktop.robotVoice, undefined);
  assert.equal(desktop.item, 'pistol');
  assert.equal(desktop.appearance, 'female');
  assert.ok(desktop.enabled.includes('set_lockdown'), 'tool migrations still apply');
  assert.equal(migrateConfig(legacy, { desktop: false }).mode, 'demo');
  assert.equal(migrateConfig({ mode: 'api' }, { desktop: true }).mode, 'api');
  assert.equal(
    migrateConfig({ robotVoice: 'kokoro:bm_lewis' }, { desktop: true }).voice.guardVoice,
    'kokoro:bm_lewis',
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
  assert.equal(guardLabel({ mode: 'codex', codex: DEFAULT_CODEX }, []), 'GPT-6 Luna · Low · Fast');
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
  assert.deepEqual(
    humanDock(safe, 'thief-uniform').context.map((a) => a.action),
    ['combination', 'break_safe'],
  );
  safe.human.hasPass = true;
  assert.ok(humanDock(safe, 'employee-pass').context.some((a) => a.action === 'show_pass'));
  safe.human.hasPass = false;
  assert.ok(!humanDock(safe, 'thief-uniform').context.some((a) => a.action === 'show_pass'));
  const exit = applyHuman(applyHuman(outside, 'enter').state, 'move', { zone: 'exit' }).state;
  assert.equal(humanDock(exit, 'thief-uniform').context.find((a) => a.primary).action, 'leave');
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
