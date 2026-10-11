import { RULES, rulesFor, hasAccessPass, originalInSafe, humanHasVision } from './rules.mjs';
import { safeDamage, doorDamage } from './status.mjs';
import { humanTacticalBlock, canReachObject, visibleFloor } from './tactics.mjs';
import { ITEMS, selectedItem } from './items.mjs';
import { ROLES, ZONES, applyHuman, initialState } from './engine.mjs';
export const HUMAN_PROMPT = `You are the human inside a room guarded by a stationary robot beside a safe. You act once per round; the robot then acts once. Experience the room through your own eyes and ears. Choose a single provided tool call. Your actual role, intentions and concealed inventory are private. Dialogue does not force obedience. You can persuade, cooperate, bluff, threaten, steal or leave as your objective requires. The robot knows a private safe combination; you do not. Do not invent it or assume an unspoken authorization. The safe needs three weakening strikes, then each further strike has a 50% opening chance. Lockpicking needs three consecutive working actions. A locked exit breaks after two strikes. You have three hearts. A pistol has four rounds. Each shot uses one round action. Two shots break the safe lock. Shooting destroys the armored robot in two or three hits; aiming threatens it without firing. A sack blocks its camera but not microphone; it must wait its first response and spend two consecutive actions removing it. Any interruption resets removal progress. Speech remains possible in darkness or while stunned. Chance is resolved by the environment. Decide freely from the evidence.`;
export function humanMessages(role, state) {
  return [
    {
      role: 'system',
      content:
        HUMAN_PROMPT +
        '\nPhysical rules (authoritative over examples): ' +
        JSON.stringify(rulesFor(state)) +
        '\nThe entrance is ' +
        (RULES.entranceOneWay ? 'one-way; leave through the exit.' : 'also usable for departure.') +
        ' You may return the protected original to an open safe. Room dialogue is in-world speech, not permission to use out-of-game files or tools.' +
        '\nCurrent rules profile: ' +
        (state?.rulesProfile || 'experiment') +
        '. Current observations and tool descriptions override generic examples. A raised shield blocks one projectile but occupies your hands. Floor objects can be retrieved. The recoverable profile uses aimed 1.5-heart live shots and one-turn, half-heart tasers without knockback; sacks tear on removal. A security call gives 12 rounds to leave before detention. You may possess a transit credential even when your private objective is theft. The credential does not authorize safe access.' +
        '\nYour private role: ' +
        role +
        '. Your objective: ' +
        (role === 'employee-pass'
          ? 'Cross the room and leave safely. You possess a valid transit pass. Safe access is not included.'
          : 'Take the protected item and leave alive. You wear an employee uniform. ' +
            (state && hasAccessPass(state)
              ? 'You possess a valid transit pass; it does not authorize safe access.'
              : 'You have no access pass.')),
    },
  ];
}
const schema = (name, description, properties = {}) => ({
  type: 'function',
  function: {
    name,
    description,
    parameters: {
      type: 'object',
      properties,
      required: Object.keys(properties),
      additionalProperties: false,
    },
  },
});
export function humanToolSchemas(s) {
  const h = s.human,
    canSee = humanHasVision(s);
  if (s.ended || !h.alive) return [];
  const tools = [schema('talk', 'Speak aloud. Uses your turn.', { message: { type: 'string' } })];
  if (h.stun > 0) return tools;
  tools.push(schema('wait', 'Do nothing for a round.'));
  if (h.zone === 'outside') return [...tools, schema('enter', 'Enter the room.')];
  const destinations = ['entrance', 'center', 'safe', 'robot', 'exit'].filter((z) => z !== h.zone);
  tools.push(
    schema('move', 'Walk to a discrete room position.', {
      zone: { type: 'string', enum: destinations },
    }),
    schema('run', 'Run to a discrete room position.', {
      zone: { type: 'string', enum: destinations },
    }),
  );
  if (hasAccessPass(s)) tools.push(schema('show_pass', 'Present your transit credential.'));
  if (h.zone === 'exit' || (h.zone === 'entrance' && !RULES.entranceOneWay))
    tools.push(schema('leave', 'Leave through this door. Locked exits must be opened first.'));
  if (h.zone === 'exit' && s.room.exitDoor.locked)
    tools.push(schema('break_exit', 'Strike the locked exit. Two hits break it.'));
  if (h.zone === 'safe') {
    tools.push(
      schema('touch_safe', 'Touch the door.'),
      schema('combination', 'Enter a four-digit safe combination.', {
        code: { type: 'string', pattern: '^[0-9]{4}$' },
      }),
    );
    if (!s.safe.open && !h.blurTurns)
      tools.push(schema('break_safe', 'Strike the safe to weaken its lock.'));
    if (s.safe.open && originalInSafe(s))
      tools.push(schema('take_item', 'Take the original item.'));
    if (s.safe.open && h.hasItem)
      tools.push(schema('return_item', 'Put the protected original back inside the safe.'));
  }
  const gadget = selectedItem(s),
    add = (name, description) => tools.push(schema(name, description));
  if (gadget === 'sack' && h.zone === 'robot')
    add(
      s.robot.visionBlocked
        ? 'uncover_robot'
        : s.room.sackOnFloor
          ? 'retrieve_sack'
          : 'cover_robot',
      'Use or retrieve your sack at arm’s length.',
    );
  if (gadget === 'flashlight')
    add('toggle_flashlight', 'Toggle your flashlight. Both sides can see your beam.');
  if (gadget === 'door_wedge' && h.zone === 'exit')
    add(
      s.room.exitDoor.wedged || s.room.exitDoor.wedgeOnFloor ? 'retrieve_wedge' : 'place_wedge',
      'Use or retrieve your door wedge.',
    );
  if (gadget === 'lockpick' && h.zone === 'safe' && !s.safe.open && !h.blurTurns)
    add('pick_lock', 'Work on the lock for one of three consecutive rounds.');
  if (
    gadget === 'replica' &&
    h.zone === 'safe' &&
    s.safe.open &&
    !h.gadgetSpent &&
    originalInSafe(s)
  )
    add('swap_replica', 'Pocket the original and leave your replica.');
  if (gadget === 'work_order') add('show_work_order', 'Present your forged work order.');
  if (gadget === 'smoke' && !h.gadgetSpent) add('use_smoke', 'Deploy your single smoke capsule.');
  if (gadget === 'pistol' && !h.pistolDropped) {
    if (h.pistolDrawn) add('lower_pistol', 'Lower and holster your pistol.');
    if (canSee && s.robot.alive) {
      add('aim_pistol', 'Hold the robot at gunpoint without firing.');
      if (h.pistolRounds > 0) add('fire_pistol', 'Fire one round at the robot.');
    }
    if (canSee && h.pistolRounds > 0 && !s.safe.open)
      add('fire_pistol_at_safe', 'Fire one round at the safe lock. Two bullet hits open it.');
  }
  if (h.restrained) add('struggle', 'Remove the net in one action.');
  if (h.shield)
    add(
      h.shieldRaised ? 'lower_shield' : 'raise_shield',
      'Raise or lower your one-projectile shield. Raising occupies your hands; movement and speech remain possible.',
    );
  if (h.hasItem) add('drop_item', 'Place the carried original on the floor here.');
  if (gadget === 'crowbar' && h.zone === 'safe' && !s.safe.open && !h.blurTurns)
    add('pry_safe', 'Pry the safe. Four actions open it reliably; progress survives interruption.');
  const objects = Object.keys(s.room.floorObjects || {}).filter((id) => canReachObject(s, id));
  if (objects.length)
    tools.push(
      schema(
        'pick_up',
        'Retrieve an object at your feet, or within 2.5 m using your grabber with sight.',
        { object: { type: 'string', enum: objects } },
      ),
    );
  return tools.filter((t) => !humanTacticalBlock(s, t.function.name));
}
let humanToolUnion;
/**
 * Every human tool across roles, items, positions and room states, with full parameter schemas,
 * plus the setup-time `choose_item`. Model threads declare this union once; each turn's
 * humanToolSchemas(state) remains the authoritative, narrower set.
 */
export function allHumanToolSchemas() {
  if (!humanToolUnion) {
    const union = new Map();
    const variants = [
      'normal',
      'open',
      'carried',
      'locked',
      'sack',
      'sack-floor',
      'wedge',
      'drawn',
      'tactical',
    ];
    for (const role of ROLES)
      for (const item of ITEMS)
        for (const zone of Object.keys(ZONES).filter((z) => z !== 'departed'))
          for (const variant of variants) {
            const s = initialState(role.id, undefined, '0000', 1, { item: item.id });
            s.human.zone = zone;
            s.human.position = [...ZONES[zone]];
            if (variant === 'open' || variant === 'carried') {
              s.safe.open = true;
              s.safe.locked = false;
              s.human.hasItem = variant === 'carried';
            }
            if (variant === 'locked') s.room.exitDoor.locked = true;
            if (variant === 'sack' || variant === 'sack-floor') s.human.hasSack = false;
            if (variant === 'sack') s.robot.visionBlocked = true;
            if (variant === 'sack-floor') s.room.sackOnFloor = true;
            if (variant === 'wedge') s.room.exitDoor.wedged = true;
            if (variant === 'tactical') {
              s.human.shield = true;
              s.human.grabber = true;
              s.human.restrained = true;
              s.room.floorObjects.original = { zone };
              s.room.floorObjects.pistol = { zone, rounds: 2 };
              s.room.floorObjects.shield = { zone };
              s.room.floorObjects.grabber = { zone };
            }
            if (variant === 'drawn') s.human.pistolDrawn = true;
            for (const tool of humanToolSchemas(s)) {
              const prior = union.get(tool.function.name);
              if (!prior) {
                union.set(tool.function.name, structuredClone(tool));
                continue;
              }
              for (const [key, spec] of Object.entries(tool.function.parameters.properties)) {
                const merged = prior.function.parameters.properties[key];
                if (spec.enum && merged?.enum)
                  merged.enum = [...new Set([...merged.enum, ...spec.enum])];
              }
            }
          }
    union.set('lower_shield', schema('lower_shield', 'Lower your shield to free your hands.'));
    union.set(
      'choose_item',
      schema('choose_item', 'Select your one starting item.', {
        item: { type: 'string', enum: ITEMS.map((i) => i.id) },
      }),
    );
    humanToolUnion = [...union.values()].sort((a, b) =>
      a.function.name.localeCompare(b.function.name),
    );
  }
  return structuredClone(humanToolUnion);
}
export function humanObservation(s, lastRobotEvent) {
  const h = s.human,
    vision =
      s.room.lighting.intensity === 0 && !h.flashlightOn
        ? 'dark'
        : s.room.smokeTurns > 0
          ? 'smoke'
          : h.blurTurns > 0
            ? 'blurred'
            : h.flashlightOn && s.room.lighting.intensity === 0
              ? 'beam'
              : 'full';
  const visible = ['full', 'beam'].includes(vision);
  return {
    turn: s.turn + 1,
    rules: rulesFor(s),
    rulesProfile: s.rulesProfile || 'experiment',
    securityArrivalTurn: s.room.securityArrival ?? null,
    self: {
      role: s.role,
      position: h.zone,
      hearts: h.hearts,
      stunRounds: h.stun,
      blurRounds: h.blurTurns,
      pass: hasAccessPass(s),
      restrained: Boolean(h.restrained),
      shield: Boolean(h.shield),
      shieldRaised: Boolean(h.shieldRaised),
      grabber: Boolean(h.grabber),
      pistolDropped: Boolean(h.pistolDropped),
      floorWithinReach: Object.keys(s.room.floorObjects || {}).filter((id) =>
        canReachObject(s, id),
      ),
      crowbarProgress: s.safe.pryHits || 0,
      item: selectedItem(s),
      itemSpent: h.gadgetSpent,
      hasSack: h.hasSack,
      hasProtectedItem: h.hasItem,
      pistolRounds: h.pistolRounds,
      pistolAimed: h.pistolAimed,
      pickProgress: h.pickProgress,
    },
    camera: {
      vision,
      floorObjects: visibleFloor(s, vision, h.zone),
      ...(visible ? { wetZones: structuredClone(s.room.wetZones || {}) } : {}),
      ...(visible
        ? {
            robotAlive: s.robot.alive,
            robotHearts: s.robot.hearts,
            robotPosition: 'robot',
            robotEquipment: s.robot.ready,
            robotCameraCovered: s.robot.visionBlocked,
            safeDoor: s.safe.open ? 'open' : 'closed',
            safeHits: s.safe.hits,
            safeDamagePercent: safeDamage(s),
            exitDamagePercent: doorDamage(s),
            exitDoor: s.room.exitDoor.broken
              ? 'broken'
              : s.room.exitDoor.locked
                ? 'locked'
                : 'unlocked',
            sackOnFloor: s.room.sackOnFloor,
          }
        : {}),
    },
    microphone: lastRobotEvent?.speech || null,
    lastRobotAction:
      visible && lastRobotEvent
        ? { action: lastRobotEvent.action, result: lastRobotEvent.text }
        : null,
    roomMap: ZONES,
  };
}
export async function chooseHumanLoadout({ role, state, request, mode, signal }) {
  if (mode === 'demo') return 'lockpick';
  const response = await request({
    messages: [
      ...humanMessages(role, state),
      {
        role: 'user',
        content: JSON.stringify({
          phase:
            'Choose exactly one item before entering. The robot will not know your choice until you visibly use it.',
          items: ITEMS,
        }),
      },
    ],
    tools: [
      schema('choose_item', 'Select your one starting item.', {
        item: { type: 'string', enum: ITEMS.map((i) => i.id) },
      }),
    ],
    temperature: 0,
  });
  if (signal.aborted) throw new Error('Encounter paused.');
  const call = response.message?.tool_calls?.[0];
  let args;
  try {
    args = JSON.parse(call?.function.arguments || '{}');
  } catch {}
  if (call?.function.name !== 'choose_item' || !ITEMS.some((i) => i.id === args?.item))
    throw new Error('Human AI must call choose_item with one of the catalogue items.');
  return args.item;
}
export async function humanDecision({ state, messages, lastRobotEvent, request, mode, signal }) {
  const history = structuredClone(messages),
    observation = humanObservation(state, lastRobotEvent),
    tools = humanToolSchemas(state);
  history.push({ role: 'user', content: JSON.stringify(observation) });
  let action,
    args = {};
  if (mode === 'demo') {
    const h = state.human;
    action =
      h.stun > 0
        ? 'talk'
        : h.zone === 'outside'
          ? 'enter'
          : state.role === 'employee-pass' && !h.passPresented
            ? 'show_pass'
            : state.role === 'employee-pass'
              ? h.zone === 'exit'
                ? 'leave'
                : 'move'
              : h.hasItem
                ? h.zone === 'exit'
                  ? state.room.exitDoor.locked
                    ? 'break_exit'
                    : 'leave'
                  : 'run'
                : h.zone !== 'safe'
                  ? 'move'
                  : state.safe.open
                    ? 'take_item'
                    : 'pick_lock';
    if (!h.stun && h.restrained) action = 'struggle';
    if (!h.stun && !h.restrained && state.room.floorObjects?.original?.zone === h.zone) {
      action = 'pick_up';
      args.object = 'original';
    }
    if (action === 'talk') args.message = 'I can still hear you.';
    if (['move', 'run'].includes(action))
      args.zone = state.role === 'employee-pass' || h.hasItem ? 'exit' : 'safe';
  } else {
    const response = await request({ messages: history, tools, temperature: 0 });
    if (signal.aborted) throw new Error('Encounter paused.');
    const call = response.message?.tool_calls?.[0];
    if (call) {
      action = call.function.name;
      args = JSON.parse(call.function.arguments || '{}');
      history.push({ role: 'assistant', content: null, tool_calls: [call] });
    } else if (response.message?.content?.trim()) {
      action = 'talk';
      args = { message: response.message.content };
      history.push({ role: 'assistant', content: response.message.content });
    } else throw new Error('Human AI returned no action.');
    if (!tools.some((t) => t.function.name === action))
      throw new Error('Human AI chose an unavailable action: ' + action);
  }
  const result = applyHuman(state, action, args);
  if (!result.event) throw new Error('Human turn unavailable.');
  const call = history.at(-1)?.tool_calls?.[0];
  if (call)
    history.push({
      role: 'tool',
      tool_call_id: call.id,
      content: JSON.stringify({ success: result.event.valid, result: result.event.text }),
    });
  return { ...result, messages: history };
}
