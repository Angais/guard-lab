import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './paths.mjs';
import { initialState, applyHuman, applyTool, observe } from '../src/sim/engine.mjs';
import { humanObservation } from '../src/sim/human-agent.mjs';
const flag = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
if (process.argv.includes('--help')) {
  console.log(
    'node scripts/scenario.mjs [--file=actions.json] [--actor=human|robot] [--export=record.json]\nA deterministic developer scenario, without Electron or a model. Actions alternate human/robot. Export is an omniscient debug record: never read it during fair live play.',
  );
  process.exit(0);
}
const actor = flag('actor');
if (actor && !['human', 'robot'].includes(actor)) throw new Error('Actor must be human or robot.');
const input = JSON.parse(
  await fs.readFile(flag('file') || path.join(ROOT, 'docs/scenario.json'), 'utf8'),
);
let state = initialState(input.role, undefined, input.combination || '0420', input.seed ?? 1, {
    rulesProfile: input.rulesProfile,
    credential: input.credential,
    item: input.item || 'sack',
  }),
  phase = 'human';
const record = {
  format: 1,
  id: 'developer-scenario',
  createdAt: '2000-01-01T00:00:00.000Z',
  initial: state,
  events: [],
};
for (const [index, command] of input.actions.entries()) {
  if (state.ended) throw new Error(`Action ${index + 1} occurs after the encounter ended.`);
  if (command.actor !== phase) throw new Error(`Action ${index + 1}: expected ${phase}.`);
  const result =
    phase === 'human'
      ? applyHuman(state, command.action, command.args || {})
      : applyTool(state, command.action, command.args || {});
  if (!result.event?.valid)
    throw new Error(`Action ${index + 1}: ${result.event?.text || 'Unavailable turn'}`);
  state = result.state;
  record.events.push(result.event);
  if (actor)
    console.log(
      JSON.stringify({
        actor,
        observation:
          actor === 'robot'
            ? observe(state, result.event)
            : humanObservation(state, result.event.kind === 'robot' ? result.event : null),
      }),
    );
  phase = phase === 'human' && state.robot.alive ? 'robot' : 'human';
}
record.state = state;
if (flag('export'))
  await fs.writeFile(flag('export'), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
console.log(
  JSON.stringify({
    actions: record.events.length,
    rounds: state.turn,
    ended: state.ended,
    outcome: state.outcome,
  }),
);
