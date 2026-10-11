import fs from 'node:fs/promises';
import runtime from '../shared/runtime.cjs';
import { listenForTurn, sendDecision, waitForTurn } from './bridge.mjs';
import { createPacketFormatter } from './packet-format.mjs';
import { resolveTurnId } from './turn-id.mjs';

const args = process.argv.slice(2),
  command = args.shift() || 'help';
const flags = {},
  values = [];
for (const arg of args) {
  if (!arg.startsWith('--')) {
    values.push(arg);
    continue;
  }
  const split = arg.indexOf('=');
  flags[split === -1 ? arg.slice(2) : arg.slice(2, split)] =
    split === -1 ? true : arg.slice(split + 1);
}
const actor = flags.actor || 'robot',
  directory = runtime.bridgeDirectory(actor);
const options = { timeoutMs: Number(flags.wait ?? 25000), afterId: flags.after || null };
const formatPacket = createPacketFormatter({ compact: flags.compact === true });
const output = (packet) => {
  const value = formatPacket(packet);
  const active = ['waiting', 'awaiting_next_turn'].includes(value.status);
  console.log(
    JSON.stringify(
      active && command !== 'session'
        ? {
            ...value,
            agentControl: {
              ...(!(flags.compact && value.instructionsUnchanged)
                ? {
                    instruction:
                      'Keep this harness turn active. Submit exactly one decision per request ID, then listen again. Idle is not completion. Do not send a final answer until status is ended or the user explicitly stops play.',
                  }
                : { keepRunning: true }),
              nextCommand:
                value.status === 'waiting'
                  ? `node scripts/robot-link.mjs exchange ACTION --id=${value.replyId || value.id} --compact --actor=${actor}`
                  : `node scripts/robot-link.mjs listen --actor=${actor}`,
            },
          }
        : value,
    ),
  );
};
try {
  if (command === 'help')
    console.log(`Guard Lab live bridge (any terminal-capable AI)\n
  node scripts/robot-link.mjs listen [--actor=human] [--after=ID]
  node scripts/robot-link.mjs observe --wait=25000 [--actor=human] [--after=ID]
  node scripts/robot-link.mjs act hold_position --id=ID
  node scripts/robot-link.mjs act speak "Your words" --id=ID
  node scripts/robot-link.mjs act ready_equipment fire_airsoft --id=ID
  node scripts/robot-link.mjs act set_room_lighting '#ff3028' 1 --id=ID
  node scripts/robot-link.mjs act set_lockdown true --id=ID
  node scripts/robot-link.mjs respond --file=decision.json --id=ID
  node scripts/robot-link.mjs respond --stdin --id=ID
  node scripts/robot-link.mjs exchange hold_position --id=ID --wait=25000
  node scripts/robot-link.mjs status [--actor=human]
  node scripts/robot-link.mjs session --compact [--actor=human]

JSON decision: {"action":"speak","args":{"message":"Hello"}}
Observe returns instructions, sensors, recent history and exact available schemas.
One reply per ID. listen waits through idle periods until a turn or ending arrives.
For Codex terminals, use listen --compact then exchange ACTION --id=REPLY_ID --compact.
exchange exits as soon as the next packet is ready, avoiding persistent-terminal polling delays.
Persistent session --compact remains useful for harnesses that surface stdout immediately.
Compact packets include an eight-character replyId; full IDs also work.
First packet includes instructions/schemas; later packets list availableTools and toolUpdates.
Run it as a managed process; keep polling that process and keep your harness turn open.
Do not send a final answer between human moves. exchange sends and waits for a different ID.
A timeout is idle, not completion. --actor=human selects the independent human channel. Human shortcuts:
talk MESSAGE, move ZONE, run ZONE, combination CODE, choose_item ITEM, pick_up OBJECT;
others need no args.
Never read private app state while playing. See AGENTS.md and docs/BRIDGE.md.`);
  else if (command === 'session')
    await (await import('./agent-session.mjs')).agentSession(directory, output);
  else if (command === 'listen') output(await listenForTurn(directory, options));
  else if (command === 'observe') output(await waitForTurn(directory, options));
  else if (command === 'status') {
    try {
      const status = JSON.parse(await fs.readFile(directory + '/status.json', 'utf8'));
      const result = await fs
        .readFile(directory + '/result.json', 'utf8')
        .then(JSON.parse)
        .catch((e) => {
          if (e.code !== 'ENOENT') throw e;
          return null;
        });
      output({ ...status, ...(result ? { result } : {}) });
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      output({ state: 'not_started', actor });
    }
  } else if (['act', 'respond', 'exchange'].includes(command)) {
    let decision;
    if (command === 'respond') {
      if (flags.stdin) {
        let text = '';
        for await (const chunk of process.stdin) text += chunk;
        decision = JSON.parse(text);
      } else if (flags.file) decision = JSON.parse(await fs.readFile(flags.file, 'utf8'));
      else throw new Error('respond requires --stdin or --file=PATH.');
    } else {
      const action = values[0];
      let params = {};
      if (['speak', 'broadcast_warning', 'talk'].includes(action))
        params = { message: values.slice(1).join(' ') };
      else if (action === 'ready_equipment') params = { tool: values[1] };
      else if (action === 'set_room_lighting')
        params = { color: values[1], intensity: Number(values[2]) };
      else if (action === 'set_lockdown') {
        if (!['true', 'false'].includes(values[1])) throw new Error('Use true or false.');
        params = { enabled: values[1] === 'true' };
      } else if (['move', 'run'].includes(action)) params = { zone: values[1] };
      else if (action === 'combination') params = { code: values[1] };
      else if (action === 'choose_item') params = { item: values[1] };
      else if (action === 'pick_up') params = { object: values[1] };
      decision = { action, args: params };
    }
    const previous = await waitForTurn(directory, { timeoutMs: 0 });
    const fullId = resolveTurnId(previous, flags.id);
    if (command === 'exchange' && flags.compact) formatPacket(previous);
    const sent = await sendDecision(directory, decision, fullId);
    output(sent);
    if (command === 'exchange')
      output(await waitForTurn(directory, { ...options, afterId: sent.id }));
  } else throw new Error('Unknown command. Run node scripts/robot-link.mjs help.');
} catch (e) {
  console.error(JSON.stringify({ error: e.message }));
  process.exitCode = 1;
}
