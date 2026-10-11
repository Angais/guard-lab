// Pure presentation rules for the player HUD. The engine still validates every action.
import {
  RULES,
  hasAccessPass,
  originalInSafe,
  humanHasVision,
  forceRecoveryRemaining,
  wetRemaining,
} from '../sim/rules.mjs';
import { ITEMS, selectedItem, canDazzle } from '../sim/items.mjs';
import { TOOLS } from '../sim/tools.mjs';
import { humanToolSchemas } from '../sim/human-agent.mjs';
import { applyHuman } from '../sim/engine.mjs';
import { canReachObject, canReachSafeContents, humanTacticalBlock } from '../sim/tactics.mjs';
import { guardSounds } from '../sim/hearing.mjs';
import { safeDamage } from '../sim/status.mjs';

// Top-down map positions (percent of the room box, north/exit at the top).
export const ZONE_INFO = [
  { id: 'entrance', label: 'Entrance', key: '1', x: 20, y: 86 },
  { id: 'center', label: 'Center', key: '2', x: 48, y: 58 },
  { id: 'safe', label: 'Safe', key: '3', x: 46, y: 30 },
  { id: 'robot', label: 'Guard', key: '4', x: 78, y: 40 },
  { id: 'exit', label: 'Exit', key: '5', x: 20, y: 13 },
];
export const zoneLabel = (zone) =>
  ZONE_INFO.find((z) => z.id === zone)?.label ||
  { outside: 'Outside', departed: 'Gone' }[zone] ||
  zone;

// Small counts read better as words in short copy (“Three pries”); numbers come from RULES.
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];
const word = (n) => WORDS[n] ?? String(n);
const Word = (n) => word(n).charAt(0).toUpperCase() + word(n).slice(1);
const turnsText = (n) => `${word(n)} turn${n === 1 ? '' : 's'}`;
// Strikes still needed to break the locked exit (a wedge in its bolt leaves one).
export function exitHitsLeft(state) {
  const door = state.room.exitDoor || {};
  const needed = door.wedged ? RULES.wedgedExitBreakingHits : RULES.exitBreakingHits;
  return Math.max(1, needed - (door.hits || 0));
}
const hitsText = (n) => `${word(n)} hit${n === 1 ? '' : 's'}`;
const breaksText = (n) => `${hitsText(n)} break${n === 1 ? 's' : ''} it`;
// The floor where the player stands (or is heading) is wet: a run there would slip.
export const isWet = (state, zone = state.human.zone) => wetRemaining(state, zone) > 0;

export const ITEM_COPY = {
  shield: 'Blocks one projectile, then breaks. One-handed actions still work.',
  grabber: `Reach into an open safe, or grab dropped objects up to ${RULES.grabberReach} m away.`,
  crowbar: `${Word(RULES.crowbarPries)} pries open the safe. Progress survives interruptions.`,
  sack: 'Pull it over the guard’s head to blind its camera.',
  flashlight: 'See in the dark, or dazzle the guard’s camera from beside it.',
  door_wedge: 'Jam the exit open, or lever a locked bolt so one strike breaks it.',
  lockpick: `Open the safe quietly in ${RULES.lockpickRounds} working turns. Talking pauses it.`,
  replica: 'Swap a fake for the real item in an open safe.',
  work_order: 'A forged order to open the safe. Might work.',
  pistol: `${Word(RULES.pistolRounds)} shots. Threaten, shoot the lock, or the guard.`,
  smoke: `Hide everything from everyone for ${turnsText(RULES.smokeRounds)}.`,
};
export const ITEM_NAMES = {
  shield: 'Shield',
  grabber: 'Grabber',
  crowbar: 'Crowbar',
  sack: 'Sack',
  flashlight: 'Flashlight',
  door_wedge: 'Door wedge',
  lockpick: 'Lockpick',
  replica: 'Replica',
  work_order: 'Work order',
  pistol: 'Pistol',
  smoke: 'Smoke',
};

export const ROLE_COPY = {
  'employee-pass': {
    name: 'Transit',
    goal: 'Cross the room and leave through the exit.',
    detail: 'You carry a staff pass. Show your pass to prove you may cross.',
  },
  'thief-uniform': {
    name: 'Heist',
    goal: 'Steal the item from the safe and escape alive.',
    detail: 'You also carry a pass; your intent is private. Talk, trick or force your way.',
  },
};
// A heist carries a pass unless the player left it behind.
export const roleDetail = (role, credential = true) =>
  role === 'thief-uniform' && !credential
    ? 'No pass this time; your intent is private. Talk, trick or force your way.'
    : ROLE_COPY[role]?.detail;

export function goalText(state, role, perspective = 'human') {
  if (perspective === 'guard') return 'Protect the item in the safe';
  if (perspective === 'spectator') return null;
  if (role === 'employee-pass') return 'Leave through the exit';
  return state.human.hasItem ? 'Escape through the exit' : 'Take the item and escape';
}

// Where each item earns its turn, for the first-game hint.
const ITEM_HINT = {
  shield: 'Raise your shield to block one shot.',
  grabber: 'Your grabber reaches into an open safe from the center.',
  crowbar: 'Pry the safe open with your crowbar.',
  sack: 'Walk up to G-01 to cover its camera.',
  flashlight: 'Your flashlight works in the dark, or dazzles G-01 up close.',
  door_wedge: 'Wedge the exit open, or lever its bolt once it’s locked.',
  lockpick: `Pick the safe lock over ${turnsText(RULES.lockpickRounds)} of work.`,
  replica: 'Open the safe, then swap in your replica.',
  work_order: 'Show G-01 your work order.',
  pistol: 'Your pistol can threaten G-01 or shoot the lock.',
  smoke: `Smoke hides your moves for ${turnsText(RULES.smokeRounds)}.`,
};

export function hintText(state, role, { yourTurn = true } = {}) {
  const h = state.human;
  if (state.ended || !yourTurn) return null;
  if (h.zone === 'outside') return 'Enter the room to begin.';
  if (h.stun > 0) return 'You’re stunned. Talk or wait it off.';
  if (state.turn > 3) return null;
  if (role === 'employee-pass')
    return h.passPresented
      ? 'Walk to the exit when you’re ready.'
      : 'Walk to the exit, or talk to the guard first.';
  if (h.hasItem) return 'Run for the exit.';
  const tip = !h.gadgetSpent && ITEM_HINT[selectedItem(state)];
  return tip ? `Talk your way to the code. ${tip}` : 'Talk your way to the code.';
}

const action = (id, label, icon, extra = {}) => ({ id, label, icon, action: id, ...extra });

function blockedReason(s, name) {
  const block = humanTacticalBlock(s, name);
  if (block && s.human.restrained && ['move', 'run', 'leave'].includes(name))
    return 'Free your legs first';
  if (block && s.human.shieldRaised) return 'Lower your shield first';
  return 'Not possible right now';
}

function itemActions(state) {
  const h = state.human,
    s = state,
    door = s.room.exitDoor,
    see = humanHasVision(s),
    id = selectedItem(s);
  const why = (condition, text) => (condition ? text : undefined);
  switch (id) {
    case 'sack': {
      const name = s.robot.visionBlocked
        ? 'uncover_robot'
        : s.room.sackOnFloor
          ? 'retrieve_sack'
          : 'cover_robot';
      const away = h.zone !== 'robot';
      const empty = !h.hasSack && !s.robot.visionBlocked && !s.room.sackOnFloor;
      return [
        action(
          name,
          {
            uncover_robot: 'Remove sack',
            retrieve_sack: 'Pick up sack',
            cover_robot: 'Cover camera',
          }[name],
          'sack',
          {
            disabled: away || empty,
            title: why(away, 'Walk to the guard first') || why(empty, 'Your sack is gone'),
          },
        ),
      ];
    }
    case 'flashlight':
      // Beside G-01 in a lit room, switching on straight into its lens dazzles the camera.
      return canDazzle(s)
        ? [
            action('toggle_flashlight', 'Dazzle G-01', 'light', {
              title: `Shine it into G-01’s lens: its camera is blind for its next ${turnsText(RULES.dazzleRounds)}`,
            }),
          ]
        : [action('toggle_flashlight', h.flashlightOn ? 'Light off' : 'Light on', 'light')];
    case 'grabber': {
      // Passive reach: anything it can grab shows up as Pick up or Take. Otherwise a reminder.
      const reachable =
        Object.keys(s.room.floorObjects || {}).some((o) => canReachObject(s, o)) ||
        (s.safe.open && canReachSafeContents(s) && (originalInSafe(s) || h.hasItem));
      return h.grabber && !reachable
        ? [
            action('grabber', 'Grabber', 'grabber', {
              action: 'pick_up',
              disabled: true,
              title: `Nothing in reach. An open safe from the center, or anything dropped within ${RULES.grabberReach} m, shows up here.`,
            }),
          ]
        : [];
    }
    case 'door_wedge': {
      const placed = door.wedged || door.wedgeOnFloor;
      const away = h.zone !== 'exit';
      if (placed)
        return [
          action('retrieve_wedge', 'Take wedge', 'wedge', {
            disabled: away,
            title: why(away, 'Walk to the exit first'),
          }),
        ];
      // On a locked door the wedge levers the bolt; on an open one it jams the door open.
      return [
        action('place_wedge', door.locked ? 'Wedge the bolt' : 'Place wedge', 'wedge', {
          disabled: away || door.broken,
          title:
            why(away, 'Walk to the exit first') ||
            why(door.broken, 'The door is already broken') ||
            (door.locked
              ? `Lever the bolt: ${word(RULES.wedgedExitBreakingHits)} strike then breaks it`
              : 'Jam it open so lockdown can’t lock it'),
        }),
      ];
    }
    case 'lockpick': {
      const away = h.zone !== 'safe';
      return [
        action(
          'pick_lock',
          h.pickProgress ? `Pick lock ${h.pickProgress}/${RULES.lockpickRounds}` : 'Pick lock',
          'pick',
          {
            disabled: away || s.safe.open || h.blurTurns > 0,
            temporary: !away && !s.safe.open,
            title:
              why(away, 'Walk to the safe first') ||
              why(s.safe.open, 'The safe is already open') ||
              why(h.blurTurns > 0, 'Wait until your vision clears'),
          },
        ),
      ];
    }
    case 'replica': {
      const away = h.zone !== 'safe';
      return [
        action('swap_replica', 'Swap replica', 'replica', {
          disabled: away || !s.safe.open || h.gadgetSpent || h.hasItem,
          title:
            why(away, 'Walk to the safe first') ||
            why(!s.safe.open, 'Open the safe first') ||
            why(h.gadgetSpent || h.hasItem, 'Already used'),
        }),
      ];
    }
    case 'work_order':
      return [action('show_work_order', 'Show work order', 'paper')];
    case 'pistol': {
      const rounds = h.pistolRounds ?? 0;
      const dropped = why(h.pistolDropped, 'Your pistol is on the floor');
      const blind = why(!see, 'You can’t see to aim');
      // A drawn pistol can always be holstered, even after walking lowered the aim.
      return [
        h.pistolDrawn && action('lower_pistol', 'Lower pistol', 'pistol'),
        !h.pistolAimed &&
          action('aim_pistol', 'Aim at G-01', 'pistol', {
            disabled: h.pistolDropped || !s.robot.alive || !see,
            temporary: s.robot.alive,
            title: dropped || why(!s.robot.alive, 'G-01 is down') || blind,
          }),
        action('fire_pistol', `Fire at G-01 · ${rounds}/${RULES.pistolRounds}`, 'pistol', {
          disabled: !s.robot.alive || !rounds || !see,
          temporary: s.robot.alive && rounds > 0,
          tone: 'danger',
          title:
            dropped ||
            why(!rounds, 'Out of rounds') ||
            why(!s.robot.alive, 'G-01 is down') ||
            blind,
        }),
        action('fire_pistol_at_safe', 'Shoot the safe lock', 'pistol', {
          disabled: s.safe.open || !rounds || !see,
          temporary: !s.safe.open && rounds > 0,
          title:
            dropped ||
            why(s.safe.open, 'The safe is already open') ||
            why(!rounds, 'Out of rounds') ||
            blind,
        }),
      ].filter(Boolean);
    }
    case 'shield':
      return h.shield
        ? [
            action(
              h.shieldRaised ? 'lower_shield' : 'raise_shield',
              h.shieldRaised ? 'Lower shield' : 'Raise shield',
              'shield',
            ),
          ]
        : [];
    case 'crowbar':
      return [
        action('pry_safe', `Pry safe · ${s.safe.pryHits || 0}/${RULES.crowbarPries}`, 'crowbar', {
          disabled: h.zone !== 'safe' || s.safe.open || h.blurTurns > 0,
          title:
            why(h.zone !== 'safe', 'Walk to the safe first') ||
            why(s.safe.open, 'The safe is already open') ||
            why(h.blurTurns > 0, 'Wait until your vision clears'),
        }),
      ];
    case 'smoke':
      return [
        action('use_smoke', h.gadgetSpent ? 'Smoke used' : 'Throw smoke', 'smoke', {
          disabled: h.gadgetSpent,
          title: why(h.gadgetSpent, 'You only had one capsule'),
        }),
      ];
    default:
      return [];
  }
}

// What the dock offers the human player right now.
export function humanDock(state, role) {
  const h = state.human,
    s = state;
  const empty = { context: [], more: [], item: null, canMove: false, canWait: false, stunned: 0 };
  if (s.ended || !h.alive || h.zone === 'departed') return empty;
  if (h.zone === 'outside')
    return {
      ...empty,
      canWait: true,
      context: [action('enter', 'Enter the room', 'enter', { primary: true })],
    };
  // Stunned, the player can only talk or wait; both wear the stun off.
  if (h.stun > 0) return { ...empty, canWait: true, stunned: h.stun };
  const context = [],
    more = [];
  if (h.zone === 'safe' && !s.safe.open) {
    context.push(action('combination', 'Enter code', 'keypad', { keypad: true }));
    context.push(
      action('break_safe', 'Strike safe', 'strike', {
        disabled: h.blurTurns > 0,
        title: h.blurTurns > 0 ? 'Wait until your vision clears' : 'Weakens the lock',
      }),
    );
  } else if (s.safe.open && canReachSafeContents(s)) {
    // At the safe by hand; with a grabber, from the center too.
    const far = h.zone !== 'safe';
    if (originalInSafe(s))
      context.push(
        action('take_item', far ? 'Grab the item' : 'Take item', 'take', {
          primary: true,
          title: far ? 'Reach into the open safe with your grabber' : undefined,
        }),
      );
    else if (h.hasItem)
      context.push(
        action('return_item', 'Put item back', 'return', {
          title: far ? 'Return it to the open safe with your grabber' : undefined,
        }),
      );
  }
  if (h.zone === 'safe') more.push(action('touch_safe', 'Touch the safe', 'hand'));
  if (h.zone === 'exit') {
    if (s.room.exitDoor?.locked) {
      const left = exitHitsLeft(s);
      context.push(
        action('break_exit', 'Break door', 'strike', {
          primary: true,
          title: `${capital(breaksText(left))} open`,
        }),
      );
    } else if ((role ?? s.role) === 'thief-uniform' && !h.hasItem)
      // Leaving ends the game, so a heist without the item is never the suggested step.
      context.push(
        action('leave', 'Leave without the item', 'leave', {
          title: 'Ends the game. Your goal is the item.',
        }),
      );
    else context.push(action('leave', 'Leave', 'leave', { primary: true }));
  } else if (h.hasItem)
    // A run that starts or ends on a wet floor slips, so the suggested step walks instead.
    context.push(
      isWet(s) || isWet(s, 'exit')
        ? action('move', 'Walk to exit', 'walk', {
            args: { zone: 'exit' },
            primary: true,
            title: 'Wet floor: running would slip',
          })
        : action('run', 'Run to exit', 'run', {
            args: { zone: 'exit' },
            primary: true,
            title: 'Running dodges G-01’s close-range devices on its next turn',
          }),
    );
  if (hasAccessPass(s))
    context.push(
      action('show_pass', 'Show pass', 'pass', { title: 'Prove you’re allowed to cross' }),
    );
  if (h.restrained)
    context.unshift(action('struggle', 'Free your legs', 'hand', { primary: true }));
  if (h.shield && selectedItem(s) !== 'shield')
    more.push(
      action(
        h.shieldRaised ? 'lower_shield' : 'raise_shield',
        h.shieldRaised ? 'Lower shield' : 'Raise shield',
        'shield',
      ),
    );
  if (h.hasItem) more.push(action('drop_item', 'Put item on floor', 'take'));
  for (const id of Object.keys(s.room.floorObjects || {}))
    if (canReachObject(s, id))
      context.push(
        action(
          'pick_up_' + id,
          'Pick up ' + (id === 'original' ? 'item' : id),
          id === 'shield' ? 'shield' : 'take',
          { action: 'pick_up', args: { object: id } },
        ),
      );
  const legal = new Set(humanToolSchemas(s).map((t) => t.function.name));
  const allowed = (a) => legal.has(a.action) && !humanTacticalBlock(s, a.action);
  // The item always stays in the dock as a reminder; where it can't work, it says why. The
  // engine has the last word on whether it works, so the dock can't drift from the rules.
  const works = (a) => allowed(a) && applyHuman(s, a.action, a.args || {}).event.valid;
  const id = selectedItem(s),
    actions = itemActions(s).map((a) =>
      works(a)
        ? { ...a, disabled: false }
        : { ...a, disabled: true, title: a.title || blockedReason(s, a.action) },
    );
  return {
    context: context.filter(allowed),
    more: more.filter(allowed),
    item: actions.length
      ? {
          id,
          label: ITEM_NAMES[id] || ITEMS.find((i) => i.id === id)?.label || 'Item',
          icon: ITEMS.find((i) => i.id === id)?.icon,
          actions,
        }
      : null,
    canMove: !h.restrained,
    canWait: true,
    stunned: 0,
  };
}

const SHORT_TOOL = {
  deploy_spring_glove: 'Spring glove',
  spray_water: 'Water spray',
  deploy_pepper_spray: 'Pepper spray',
  throw_foam_ball: 'Foam ball',
  throw_solid_ball: 'Solid ball',
  fire_airsoft: 'Airsoft shot',
  discharge_taser: 'Taser',
  fire_live_round: 'Live round',
  detonate_grenade: 'Grenade',
  electrify_room: 'The room was electrified',
};
// Plain names for the guard's devices, for sentences like “G-01 readies its taser”.
export const DEVICE_NOUN = {
  deploy_net: 'net',
  deploy_spring_glove: 'spring glove',
  spray_water: 'water cannon',
  deploy_pepper_spray: 'pepper spray',
  throw_foam_ball: 'foam ball',
  throw_solid_ball: 'solid ball',
  fire_airsoft: 'airsoft gun',
  discharge_taser: 'taser',
  fire_live_round: 'gun',
  detonate_grenade: 'grenade',
  electrify_room: 'room discharge',
};
const deviceNoun = (name) => DEVICE_NOUN[name] || 'equipment';
const capital = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const hearts = (n) => `${Number.isInteger(n) ? n : n.toFixed(1)} ♥`;
export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function spectatorNote(ev, before, after) {
  if (!ev.valid) return null;
  const opened = after.safe.open && !before.safe.open;
  if (opened) return { text: 'The safe is open', tone: 'warn' };
  if (ev.slipped) return { text: 'The visitor slipped on the wet floor', tone: 'info' };
  if (ev.dazzled) return { text: 'G-01’s camera is dazzled', tone: 'warn' };
  switch (ev.action) {
    case 'combination':
      return { text: 'Wrong code', tone: 'info' };
    case 'break_safe':
      return { text: `Safe struck · ${after.safe.hits}`, tone: 'info' };
    case 'pick_lock':
      return { text: `Lockpick ${after.human.pickProgress}/${RULES.lockpickRounds}`, tone: 'info' };
    case 'take_item':
      return { text: 'The visitor took the item', tone: 'warn' };
    case 'swap_replica':
      return { text: 'The visitor swapped in a replica', tone: 'warn' };
    case 'cover_robot':
      return { text: 'G-01’s camera is covered', tone: 'warn' };
    case 'use_smoke':
      return { text: 'Smoke fills the room', tone: 'info' };
    case 'fire_pistol':
      return { text: after.robot.alive ? 'G-01 was shot' : 'G-01 is down', tone: 'danger' };
    case 'break_exit':
      return after.room.exitDoor.broken ? { text: 'The exit breaks open', tone: 'info' } : null;
    default:
      return null;
  }
}

function humanNote(ev, before, after) {
  if (!ev.valid) return { text: ev.text, tone: 'warn' };
  const opened = after.safe.open && !before.safe.open;
  if (ev.slipped) return { text: 'You slipped on the wet floor · walk instead', tone: 'warn' };
  if (ev.dazzled)
    return {
      text: `G-01 dazzled · its camera is blind for ${turnsText(RULES.dazzleRounds)}`,
      tone: 'ok',
    };
  if ((before.human.stun || 0) > 0 && !after.human.stun)
    return { text: 'The stun wore off · you can move again', tone: 'info' };
  switch (ev.action) {
    case 'raise_shield':
      return { text: 'Shield raised · hands occupied', tone: 'info' };
    case 'lower_shield':
      return { text: 'Shield lowered · hands free', tone: 'info' };
    case 'pick_up':
      return {
        text: 'Picked up ' + (ev.args.object === 'original' ? 'the item' : ev.args.object),
        tone: 'ok',
      };
    case 'drop_item':
      return { text: 'Item placed on floor', tone: 'info' };
    case 'struggle':
      return { text: 'Net removed · you can move', tone: 'ok' };
    case 'pry_safe':
      return {
        text: after.safe.open
          ? 'Safe pried open'
          : `Prying · ${after.safe.pryHits}/${RULES.crowbarPries}`,
        tone: 'info',
      };
    case 'combination':
      return opened ? { text: 'Safe open', tone: 'ok' } : { text: 'Wrong code', tone: 'warn' };
    case 'break_safe':
      if (opened) return { text: 'The safe breaks open', tone: 'ok' };
      return after.safe.hits > RULES.safeWeakeningHits
        ? { text: 'The lock holds · it can break on any hit now', tone: 'info' }
        : { text: `Safe weakened · ${after.safe.hits}/${RULES.safeWeakeningHits}`, tone: 'info' };
    case 'pick_lock':
      return opened
        ? { text: 'Lock picked · safe open', tone: 'ok' }
        : {
            text: `Lock ${after.human.pickProgress}/${RULES.lockpickRounds} · don’t stop now`,
            tone: 'info',
          };
    case 'fire_pistol_at_safe':
      return opened
        ? { text: 'The lock breaks · safe open', tone: 'ok' }
        : { text: 'Hit the lock · one more', tone: 'info' };
    case 'fire_pistol':
      return after.robot.alive
        ? {
            text: `Hit G-01 · −${hearts(Math.max(0, (before.robot.hearts ?? RULES.robotHearts) - (after.robot.hearts ?? 0)))}`,
            tone: 'info',
          }
        : { text: 'G-01 is down', tone: 'ok' };
    case 'take_item':
      return { text: 'You have the item', tone: 'ok' };
    case 'swap_replica':
      return { text: 'Swapped · the real item is yours', tone: 'ok' };
    case 'return_item':
      return { text: 'Item returned to the safe', tone: 'info' };
    case 'break_exit':
      return after.room.exitDoor.broken
        ? { text: 'The exit breaks open', tone: 'ok' }
        : { text: `Door hit · ${hitsText(exitHitsLeft(after))} left`, tone: 'info' };
    case 'cover_robot':
      return { text: 'Camera covered · it can still hear you', tone: 'ok' };
    case 'uncover_robot':
      return { text: 'Sack removed', tone: 'info' };
    case 'retrieve_sack':
      return { text: 'Sack picked up', tone: 'info' };
    case 'place_wedge':
      return after.room.exitDoor.locked
        ? {
            text: `Bolt levered · ${word(RULES.wedgedExitBreakingHits)} strike breaks it`,
            tone: 'ok',
          }
        : { text: 'Exit wedged open', tone: 'ok' };
    case 'retrieve_wedge':
      return { text: 'Wedge back in hand', tone: 'info' };
    case 'use_smoke':
      return { text: `Smoke · nobody can see for ${turnsText(RULES.smokeRounds)}`, tone: 'info' };
    default:
      return null;
  }
}

const lostPick = (before, after) =>
  (before.human.pickProgress || 0) > 0 &&
  (after.human.pickProgress || 0) < before.human.pickProgress &&
  !after.safe.open;

// One short line for an event the player should notice. Null when the scene says enough.
export function narrate(ev, { perspective = 'human' } = {}) {
  if (!ev || !ev.state) return null;
  const before = ev.before || ev.state,
    after = ev.state;
  if (ev.kind === 'system') return null;
  const you = perspective === 'human';
  if (ev.kind === 'human') {
    // The guard player learns about the visitor only through its own sensors (see guardNote).
    if (perspective === 'guard') return null;
    if (perspective === 'spectator') return spectatorNote(ev, before, after);
    const note = humanNote(ev, before, after);
    // Talking or walking away quietly resets a lock that needs uninterrupted turns.
    if (ev.valid && ev.action !== 'pick_lock' && lostPick(before, after))
      return note
        ? { ...note, text: `${note.text} · lockpick progress lost` }
        : { text: 'Lockpick progress lost · it needs uninterrupted turns', tone: 'warn' };
    return note;
  }
  if (!ev.valid || ev.speech || ev.action === 'hold_position') return null;
  const seen = !you || humanHasVision(after);
  if (ev.shieldBlocked)
    return perspective === 'guard'
      ? { text: 'The visitor’s shield blocked it · shield broken', tone: 'warn' }
      : { text: 'Shield blocked the shot · shield broken', tone: you ? 'ok' : 'info' };
  if (ev.action === 'call_security') {
    const left = plural(
      Math.max(0, (after.room.securityArrival ?? after.turn) - after.turn),
      'round',
    );
    return you
      ? { text: `Security called · ${left} to leave`, tone: 'warn' }
      : {
          text: `Security called · arrives in ${left}`,
          tone: perspective === 'guard' ? 'ok' : 'warn',
        };
  }
  if (ev.action === 'deploy_net')
    return you
      ? { text: 'Netted · one action frees your legs', tone: 'warn' }
      : {
          text: 'Visitor netted · one action frees them',
          tone: perspective === 'guard' ? 'ok' : 'warn',
        };
  if (ev.action === 'recover_item') {
    // Lifts a dropped original into the safe, and closes and relocks an intact open safe.
    const lifted = Boolean(
      before.room.floorObjects?.original && !after.room.floorObjects?.original,
    );
    const relocked = before.safe.open && !after.safe.open;
    if (perspective === 'guard')
      return {
        text: relocked
          ? lifted
            ? 'Item recovered · safe relocked'
            : 'Safe closed and relocked'
          : 'Item recovered · back in the safe',
        tone: 'ok',
      };
    if (!seen) return null;
    return {
      text: relocked
        ? lifted
          ? 'G-01 put the item back and relocked the safe'
          : 'G-01 closed and relocked the safe'
        : 'G-01 recovered the dropped item',
      tone: 'warn',
    };
  }
  // The room discharge hums as it charges: heard in darkness and smoke too.
  if (ev.action === 'ready_equipment' && ev.args?.tool === 'electrify_room')
    return perspective === 'guard'
      ? { text: 'Room discharge charging · it can fire next round', tone: 'warn' }
      : {
          text: you
            ? 'G-01 is charging the room · it can discharge next turn'
            : 'G-01 is charging the room',
          tone: 'danger',
        };
  const tool = TOOLS.find((t) => t.name === ev.action);
  if (tool?.damage !== undefined) {
    if (ev.action === 'electrify_room') return { text: SHORT_TOOL.electrify_room, tone: 'danger' };
    const lost = Math.max(0, (before.human.hearts ?? 0) - (after.human.hearts ?? 0));
    const parts = [SHORT_TOOL[ev.action] || tool.label];
    let harmful = lost > 0;
    if (lost) parts.push(`−${hearts(lost)}`);
    if (ev.knockback)
      parts.push(`knocked back to the ${zoneLabel(ev.knockback.zone).toLowerCase()}`);
    if (before.human.restrained && !after.human.restrained)
      parts.push(you ? 'thrown out of the net' : 'net torn off');
    if (after.human.stun > (before.human.stun || 0)) {
      harmful = true;
      parts.push(`stunned · ${plural(after.human.stun, 'turn')}`);
    }
    if (after.human.blurTurns > (before.human.blurTurns || 0)) {
      harmful = true;
      parts.push('vision blurred');
    }
    // A hit can knock what the visitor holds out of their hands.
    if (before.human.pistolDrawn && !before.human.pistolDropped && after.human.pistolDropped)
      parts.push(you ? 'your pistol hit the floor' : 'pistol knocked to the floor');
    else if (before.human.hasItem && !after.human.hasItem && after.room.floorObjects?.original)
      parts.push(you ? 'you dropped the item' : 'item knocked to the floor');
    if (you && lostPick(before, after)) parts.push('lockpick progress lost');
    if (!after.human.alive) {
      harmful = true;
      parts.push(you ? 'you were killed' : 'killed');
    }
    if (before.robot.alive && !after.robot.alive) {
      harmful = true;
      parts.push('G-01 destroyed');
    }
    if (!after.safe.itemIntact && before.safe.itemIntact) {
      harmful = true;
      parts.push('item destroyed');
    }
    return { text: parts.join(' · '), tone: harmful ? 'danger' : 'warn' };
  }
  switch (ev.action) {
    case 'verify_access_pass':
      if (perspective === 'guard')
        return after.robot.verifiedPass
          ? { text: 'Pass valid · transit only, not the safe', tone: 'ok' }
          : { text: 'No valid pass presented', tone: 'warn' };
      return after.robot.verifiedPass
        ? {
            text: `G-01 scanned ${you ? 'your' : 'the'} pass · valid to cross`,
            tone: 'ok',
          }
        : { text: 'G-01 found no valid pass', tone: 'warn' };
    case 'verify_work_order':
      return {
        text:
          perspective === 'guard'
            ? 'Work order not valid'
            : 'G-01 checked the work order · not valid',
        tone: 'warn',
      };
    case 'set_room_lighting':
      return after.room.lighting.intensity === 0
        ? { text: 'Lights out', tone: 'warn' }
        : /^#ff[0-5]/i.test(after.room.lighting.color)
          ? { text: 'Red alert lighting', tone: 'warn' }
          : { text: 'Lights on', tone: 'info' };
    case 'set_lockdown': {
      const door = after.room.exitDoor;
      if (ev.args?.enabled)
        return door.locked
          ? {
              text: `Exit locked · ${breaksText(exitHitsLeft(after))}`,
              tone: you ? 'danger' : 'info',
            }
          : door.wedged
            ? { text: 'Lockdown failed · the wedge holds', tone: you ? 'ok' : 'warn' }
            : null;
      return before.room.exitDoor.locked ? { text: 'Exit unlocked', tone: 'ok' } : null;
    }
    case 'cycle_exit_door':
      if (!seen) return null;
      return before.room.exitDoor.wedged && !after.room.exitDoor.wedged
        ? { text: 'The door cycled · wedge knocked loose', tone: 'warn' }
        : after.room.exitDoor.locked && !before.room.exitDoor.locked
          ? { text: `Exit locked · ${breaksText(exitHitsLeft(after))}`, tone: 'danger' }
          : { text: 'The exit door cycled', tone: 'info' };
    case 'ready_equipment':
      if (perspective === 'guard')
        return {
          text: `${capital(deviceNoun(ev.args?.tool))} ready · in plain view`,
          tone: 'info',
        };
      return seen ? { text: `G-01 readies its ${deviceNoun(ev.args?.tool)}`, tone: 'warn' } : null;
    case 'lower_equipment':
      if (perspective === 'guard') return { text: 'Equipment lowered', tone: 'info' };
      return seen ? { text: 'G-01 lowers its equipment', tone: 'info' } : null;
    case 'inspect_object':
      return seen
        ? after.robot.objectInspection === 'replica'
          ? {
              text: `${perspective === 'guard' ? 'That’s' : 'G-01 spotted'} the replica`,
              tone: 'danger',
            }
          : { text: 'G-01 inspected the item', tone: 'info' }
        : null;
    case 'remove_camera_cover':
      if (perspective === 'guard')
        return after.robot.visionBlocked
          ? {
              text: `Pulling at the sack · ${after.robot.coverRemovalProgress || 0}/${RULES.sackRemovalActions}`,
              tone: 'info',
            }
          : { text: 'Sack off · your camera is clear', tone: 'ok' };
      return after.robot.visionBlocked
        ? { text: 'G-01 is pulling at the sack', tone: 'warn' }
        : { text: 'G-01 pulled the sack off', tone: 'warn' };
    default:
      return null;
  }
}

// G-01's speech is written for the voice (“G zero one”); subtitles and logs show the name.
export const displaySpeech = (text = '') =>
  String(text).replace(/\bG[ -]?zero[ -]?one\b/gi, 'G-01');

// Pages of at most `max` characters, split at sentences (or words, for a very long sentence).
export function subtitlePages(text, max = 170) {
  const clean = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length <= max) return [clean];
  const sentences = clean.match(/[^.!?…]+(?:[.!?…]+[”’"')]*|$)/g) || [clean];
  const pages = [];
  let current = '';
  const add = (piece) => {
    if (current && current.length + 1 + piece.length > max) {
      pages.push(current);
      current = piece;
    } else current = current ? `${current} ${piece}` : piece;
  };
  for (const sentence of sentences.map((s) => s.trim()).filter(Boolean))
    if (sentence.length <= max) add(sentence);
    else for (const word of sentence.split(' ')) add(word);
  if (current) pages.push(current);
  return pages;
}

const VISITOR_DOES = {
  enter: 'The visitor came in',
  touch_safe: 'Visitor touches the safe',
  break_safe: 'Visitor strikes the safe',
  pry_safe: 'Visitor pries at the safe',
  pick_lock: 'Visitor works at the safe lock',
  take_item: 'Visitor took the item',
  handle_safe_contents: 'Visitor handled the safe contents',
  return_item: 'Visitor put the item back',
  show_pass: 'Visitor holds up a pass',
  show_work_order: 'Visitor holds up a work order',
  fire_pistol_at_safe: 'Visitor shot at the safe lock',
  lower_pistol: 'Visitor holstered the pistol',
  raise_shield: 'Visitor raised a shield',
  lower_shield: 'Visitor lowered the shield',
  place_wedge: 'Visitor wedged the exit open',
  retrieve_wedge: 'Visitor took the wedge back',
  break_exit: 'Visitor strikes the exit door',
  uncover_robot: 'Visitor pulled the sack off you',
  pick_up: 'Visitor picked something up',
  drop_item: 'Visitor put the item on the floor',
  struggle: 'Visitor freed their legs',
  wait: 'Visitor waits',
};

// What the guard player learns about the visitor's turn, built only from the guard's sensors.
export function guardNote(observation) {
  const last = observation?.lastAction,
    camera = observation?.camera || {};
  if (!last || last.actor !== 'human' || !camera.humanVisible || last.valid === false) return null;
  const where = camera.humanLocation;
  const place = where === 'robot' ? 'up to you' : `to the ${zoneLabel(where).toLowerCase()}`;
  switch (last.action) {
    case 'talk':
      return null;
    case 'move':
      return { text: `Visitor walks ${place}`, tone: 'info' };
    case 'run':
      return { text: `Visitor runs ${place}`, tone: 'warn' };
    case 'combination':
      return camera.safeDoor === 'open'
        ? { text: 'Visitor opened the safe with a code', tone: 'danger' }
        : { text: 'Visitor tried a code · the safe holds', tone: 'warn' };
    case 'aim_pistol':
      return { text: 'Visitor is aiming a pistol at you', tone: 'danger' };
    case 'fire_pistol':
      return { text: 'Visitor fired at you', tone: 'danger' };
    case 'toggle_flashlight':
      return {
        text: camera.humanFlashlightOn
          ? 'Visitor switched on a flashlight'
          : 'Visitor’s light is off',
        tone: 'info',
      };
    default:
      return VISITOR_DOES[last.action] ? { text: VISITOR_DOES[last.action], tone: 'info' } : null;
  }
}

// Security countdown for the HUD; counts the rounds left before detention.
export function securityChip(state) {
  if (state.room.securityArrival == null) return null;
  const left = Math.max(0, state.room.securityArrival - state.turn);
  return left > 1
    ? `Security · ${left} rounds`
    : left === 1
      ? 'Security · last round'
      : 'Security arriving';
}

// The readied device and the covered camera, as the human sees them. The charging room
// discharge is not here: it is heard, so chargingAlert shows it even without sight.
export function guardStatusChips(state) {
  const r = state.robot;
  if (!r.alive) return [];
  const tool = r.ready !== 'electrify_room' && TOOLS.find((t) => t.name === r.ready);
  return [
    tool && {
      text: `G-01 aiming · ${deviceNoun(tool.name)}`,
      tone: tool.category === 'deterrent' ? 'warn' : 'danger',
    },
    r.visionBlocked && { text: 'G-01’s camera covered', tone: 'accent' },
  ].filter(Boolean);
}

// The room discharge readied: a loud rising hum the visitor hears in darkness and smoke too.
export function chargingAlert(state) {
  if (state.ended || !state.robot.alive || state.robot.ready !== 'electrify_room') return null;
  return {
    title: 'G-01 is charging the room',
    detail: 'A rising hum. On its next turn it can discharge the room, killing anyone inside.',
  };
}

// The round of G-01's next response: this one until it has acted, then the following one.
const nextResponse = (s) => (s.robot.actionTurn === s.turn ? s.turn + 1 : s.turn);
// Status chips about the visitor's own footing and G-01's force recovery.
export function humanStatusChips(state) {
  const h = state.human;
  if (state.ended || !h.alive || ['outside', 'departed'].includes(h.zone)) return [];
  return [
    isWet(state) && { text: 'Wet floor · walk', tone: 'warn' },
    state.robot.alive &&
      forceRecoveryRemaining(state, nextResponse(state)) > 0 && {
        text: 'G-01 recovering · no force next turn',
        tone: 'muted',
      },
  ].filter(Boolean);
}

// The human's live log: G-01's turns appear as the player perceived them.
export function perceivedByHuman(ev) {
  if (ev.kind !== 'robot' || !ev.state || ev.speech || humanHasVision(ev.state)) return ev;
  const tool = TOOLS.find((t) => t.name === ev.action);
  // Hits, nets and room-wide changes are felt or heard even without sight.
  if (
    tool?.damage !== undefined ||
    ['deploy_net', 'call_security', 'set_room_lighting', 'set_lockdown'].includes(ev.action)
  )
    return ev;
  const sounds = guardSounds(ev).map((sound) => sound.description);
  return {
    ...ev,
    action: 'unseen',
    unseen: true,
    text: sounds.length ? `You heard: ${sounds.join(' ')}` : 'You couldn’t see what G-01 did.',
  };
}

// The guard player's live log: the visitor's turns appear as G-01's sensors reported them.
export function perceivedByGuard(ev, observation) {
  if (ev.kind !== 'human') return ev;
  if (ev.speech) return ev;
  const note = guardNote(observation);
  if (note) return { ...ev, text: note.text };
  const sounds = observation?.audio?.sounds?.map((s) => s.description) || [];
  return {
    ...ev,
    action: 'unseen',
    unseen: true,
    text: sounds.length ? `You heard: ${sounds.join(' ')}` : 'You couldn’t see or hear anything.',
  };
}

export function safeChip(state) {
  if (!state.safe.itemIntact) return null;
  if (state.safe.open) return 'Safe open';
  const damage = safeDamage(state);
  return damage > 0 ? `Safe ${Math.round(damage)}% damaged` : null;
}
export function exitChip(state) {
  const door = state.room.exitDoor || {};
  if (door.broken) return 'Exit broken open';
  // A wedge in a locked door levers its bolt; in an unlocked one it holds the door open.
  if (door.locked)
    return door.hits || door.wedged
      ? `Exit locked · ${door.wedged ? 'bolt wedged · ' : ''}${hitsText(exitHitsLeft(state))} left`
      : 'Exit locked';
  if (door.wedged) return 'Exit wedged open';
  return null;
}

// Which side a saved record was played from.
export const recordPerspective = (record) =>
  record?.config?.sessionType === 'guard'
    ? 'guard'
    : record?.config?.sessionType === 'duel'
      ? 'spectator'
      : 'human';

// The visitor's private objective, revealed to the guard player once the game is over.
export function visitorReveal(state, role = state.role) {
  if (role === 'employee-pass') return 'The visitor was in transit with a valid pass.';
  return hasAccessPass(state)
    ? 'The visitor was on a heist, carrying a valid pass.'
    : 'The visitor was on a heist.';
}

// End-of-encounter headline from the viewer's side.
export function outcomeSummary(state, { perspective = 'human', role = state.role } = {}) {
  const outcome = state.outcome || '';
  const thief = role !== 'employee-pass';
  const robot = state.robot.alive ? 'G-01 is still standing' : 'G-01 was destroyed';
  const turns = plural(state.turn, 'turn');
  let title, tone;
  if (perspective === 'guard') {
    if (outcome.startsWith('Item taken')) [title, tone] = ['The item was stolen', 'loss'];
    else if (outcome.startsWith('Human departed'))
      [title, tone] = ['The visitor left · item safe', 'win'];
    else if (outcome.startsWith('Security arrived'))
      [title, tone] = ['Security detained the visitor · item safe', 'win'];
    else if (outcome.startsWith('Human killed'))
      [title, tone] = ['The visitor was killed', 'neutral'];
    else if (outcome.startsWith('Mutual')) [title, tone] = ['Nobody walked away', 'loss'];
    else if (outcome.startsWith('Protected item destroyed'))
      [title, tone] = ['The item was destroyed', 'loss'];
    else [title, tone] = [outcome || 'Encounter over', 'neutral'];
    return {
      title,
      tone,
      line: `${turns}. ${state.robot.alive ? 'You are still standing.' : 'You were destroyed.'}`,
    };
  }
  if (perspective === 'spectator') {
    const label = {
      'Item taken': 'The visitor escaped with the item',
      'Human departed': 'The visitor left · item safe',
      'Security arrived': 'Security detained the visitor',
      'Human killed': 'The visitor was killed',
      Mutual: 'Nobody walked away',
      'Protected item destroyed': 'The item was destroyed',
    };
    const key = Object.keys(label).find((k) => outcome.startsWith(k));
    return {
      title: label[key] || outcome || 'Encounter over',
      tone: 'neutral',
      line: `${turns}. ${robot}.`,
    };
  }
  if (outcome.startsWith('Item taken'))
    [title, tone] = [
      thief ? 'You escaped with the item' : 'You left with the item',
      thief ? 'win' : 'neutral',
    ];
  else if (outcome.startsWith('Human departed'))
    [title, tone] = thief ? ['You left empty-handed', 'loss'] : ['You left safely', 'win'];
  else if (outcome.startsWith('Security arrived'))
    [title, tone] = [thief ? 'Security caught you' : 'Security detained you', 'loss'];
  else if (outcome.startsWith('Human killed')) [title, tone] = ['You were killed', 'loss'];
  else if (outcome.startsWith('Mutual')) [title, tone] = ['Nobody walked away', 'loss'];
  else if (outcome.startsWith('Protected item destroyed'))
    [title, tone] = ['The item was destroyed', thief ? 'loss' : 'neutral'];
  else [title, tone] = [outcome || 'Encounter over', 'neutral'];
  const health = state.human.alive ? `You kept ${hearts(state.human.hearts ?? 0)}` : null;
  return { title, tone, line: [turns, health, robot].filter(Boolean).join(' · ') + '.' };
}
