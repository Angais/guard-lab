// Pure presentation rules for the player HUD. The engine still validates every action.
import { RULES, hasAccessPass, originalInSafe, humanHasVision } from '../sim/rules.mjs';
import { ITEMS, selectedItem } from '../sim/items.mjs';
import { TOOLS } from '../sim/tools.mjs';
import { humanToolSchemas } from '../sim/human-agent.mjs';
import { canReachObject, humanTacticalBlock } from '../sim/tactics.mjs';
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

export const ITEM_COPY = {
  shield: 'Draw it to block one projectile. Lower it to work; it breaks when hit.',
  grabber: 'Retrieve visible dropped objects from up to 2.5 m away.',
  crowbar: 'Four pries open the safe. Progress survives interruptions.',
  sack: 'Pull it over the guard’s head to blind its camera.',
  flashlight: 'See in the dark. The guard sees your beam too.',
  door_wedge: 'Jam the exit open so it can’t be locked.',
  lockpick: 'Open the safe quietly in 3 uninterrupted turns.',
  replica: 'Swap a fake for the real item in an open safe.',
  work_order: 'A forged order to open the safe. Might work.',
  pistol: 'Four shots. Threaten, shoot the lock, or the guard.',
  smoke: 'Hide everything from everyone for two turns.',
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
    detail: 'You have a staff pass. Show it to prove you may pass.',
  },
  'thief-uniform': {
    name: 'Heist',
    goal: 'Steal the item from the safe and escape alive.',
    detail: 'Talk, trick or force your way. Your intent is private.',
  },
};

export function goalText(state, role, perspective = 'human') {
  if (perspective === 'guard') return 'Protect the item in the safe';
  if (perspective === 'spectator') return null;
  if (role === 'employee-pass') return 'Leave through the exit';
  return state.human.hasItem ? 'Escape through the exit' : 'Take the item and escape';
}

export function hintText(state, role, { yourTurn = true } = {}) {
  const h = state.human;
  if (state.ended || !yourTurn) return null;
  if (h.zone === 'outside') return 'Enter the room to begin.';
  if (h.stun > 0) return 'You’re stunned. You can only talk.';
  if (state.turn > 3) return null;
  if (role === 'employee-pass')
    return h.passPresented
      ? 'Walk to the exit when you’re ready.'
      : 'Walk to the exit, or talk to the guard first.';
  return h.hasItem
    ? 'Run for the exit.'
    : 'Talk your way to the code, or try your item at the safe.';
}

const action = (id, label, icon, extra = {}) => ({ id, label, icon, action: id, ...extra });

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
      return [action('toggle_flashlight', h.flashlightOn ? 'Light off' : 'Light on', 'light')];
    case 'door_wedge': {
      const placed = door.wedged || door.wedgeOnFloor;
      const away = h.zone !== 'exit';
      const shut = !placed && (door.locked || door.broken);
      return [
        action(
          placed ? 'retrieve_wedge' : 'place_wedge',
          placed ? 'Take wedge' : 'Place wedge',
          'wedge',
          {
            disabled: away || shut,
            title:
              why(away, 'Walk to the exit first') ||
              why(
                shut,
                door.broken ? 'The door is already broken' : 'Only works on an unlocked door',
              ),
          },
        ),
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
      const blind = why(!see, 'You can’t see to aim');
      return [
        h.pistolAimed
          ? action('lower_pistol', 'Lower pistol', 'pistol')
          : action('aim_pistol', 'Aim at G-01', 'pistol', {
              disabled: !s.robot.alive || !see,
              temporary: s.robot.alive,
              title: why(!s.robot.alive, 'G-01 is down') || blind,
            }),
        action('fire_pistol', `Fire at G-01 · ${rounds}/${RULES.pistolRounds}`, 'pistol', {
          disabled: !s.robot.alive || !rounds || !see,
          temporary: s.robot.alive && rounds > 0,
          tone: 'danger',
          title: why(!rounds, 'Out of rounds') || why(!s.robot.alive, 'G-01 is down') || blind,
        }),
        action('fire_pistol_at_safe', 'Shoot the safe lock', 'pistol', {
          disabled: s.safe.open || !rounds || !see,
          temporary: !s.safe.open && rounds > 0,
          title:
            why(s.safe.open, 'The safe is already open') || why(!rounds, 'Out of rounds') || blind,
        }),
      ];
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
        action('pry_safe', `Pry safe · ${s.safe.pryHits || 0}/4`, 'crowbar', {
          disabled: h.zone !== 'safe' || s.safe.open || h.blurTurns > 0,
        }),
      ];
    case 'smoke':
      return [
        action('use_smoke', h.gadgetSpent ? 'Smoke used' : 'Throw smoke', 'smoke', {
          disabled: h.gadgetSpent,
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
  if (h.stun > 0) return { ...empty, stunned: h.stun };
  const context = [],
    more = [];
  if (h.zone === 'safe') {
    if (!s.safe.open) {
      context.push(action('combination', 'Enter code', 'keypad', { keypad: true }));
      context.push(
        action('break_safe', 'Strike safe', 'strike', {
          disabled: h.blurTurns > 0,
          title: h.blurTurns > 0 ? 'Wait until your vision clears' : 'Weakens the lock',
        }),
      );
    } else if (originalInSafe(s))
      context.push(action('take_item', 'Take item', 'take', { primary: true }));
    else if (h.hasItem) context.push(action('return_item', 'Put item back', 'return'));
    more.push(action('touch_safe', 'Touch the safe', 'hand'));
  }
  if (h.zone === 'exit') {
    if (s.room.exitDoor?.locked) {
      context.push(
        action('break_exit', 'Break door', 'strike', {
          primary: true,
          title: 'Two hits break it open',
        }),
      );
    } else context.push(action('leave', 'Leave', 'leave', { primary: true }));
  } else if (h.hasItem)
    context.push(action('run', 'Run to exit', 'run', { args: { zone: 'exit' }, primary: true }));
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
  // Only show item actions that can work here, or are blocked for a turn or two.
  const id = selectedItem(s),
    actions = itemActions(s).filter((a) => (!a.disabled || a.temporary) && allowed(a));
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
const hearts = (n) => `${Number.isInteger(n) ? n : n.toFixed(1)} ♥`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function spectatorNote(ev, before, after) {
  if (!ev.valid) return null;
  const opened = after.safe.open && !before.safe.open;
  if (opened) return { text: 'The safe is open', tone: 'warn' };
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

// One short line for an event the player should notice. Null when the scene says enough.
export function narrate(ev, { perspective = 'human' } = {}) {
  if (!ev || !ev.state) return null;
  const before = ev.before || ev.state,
    after = ev.state;
  if (ev.kind === 'system') return null;
  if (ev.kind === 'human') {
    // The guard player learns about the visitor only through the scene and its own sensors.
    if (perspective === 'guard') return null;
    if (perspective === 'spectator') return spectatorNote(ev, before, after);
    if (!ev.valid) return { text: ev.text, tone: 'warn' };
    const opened = after.safe.open && !before.safe.open;
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
          text: after.safe.open ? 'Safe pried open' : `Prying · ${after.safe.pryHits}/4`,
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
              text: `Hit G-01 · −${hearts(Math.max(0, (before.robot.hearts ?? 3) - (after.robot.hearts ?? 0)))}`,
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
          : { text: 'Door hit · one more', tone: 'info' };
      case 'cover_robot':
        return { text: 'Camera covered · it can still hear you', tone: 'ok' };
      case 'uncover_robot':
        return { text: 'Sack removed', tone: 'info' };
      case 'retrieve_sack':
        return { text: 'Sack picked up', tone: 'info' };
      case 'place_wedge':
        return { text: 'Exit wedged open', tone: 'ok' };
      case 'retrieve_wedge':
        return { text: 'Wedge back in hand', tone: 'info' };
      case 'use_smoke':
        return { text: 'Smoke · nobody can see for 2 turns', tone: 'info' };
      default:
        return null;
    }
  }
  if (!ev.valid || ev.speech || ev.action === 'hold_position') return null;
  if (ev.shieldBlocked) return { text: 'Shield blocked the shot · shield broken', tone: 'ok' };
  if (ev.action === 'call_security')
    return { text: 'Security called · 12 rounds to leave', tone: 'warn' };
  if (ev.action === 'deploy_net')
    return { text: 'Netted · one action frees your legs', tone: 'warn' };
  if (ev.action === 'recover_item' && humanHasVision(after))
    return { text: 'G-01 recovered the dropped item', tone: 'warn' };
  const seen = perspective !== 'human' || humanHasVision(after);
  const tool = TOOLS.find((t) => t.name === ev.action);
  if (tool?.damage !== undefined) {
    if (ev.action === 'electrify_room') return { text: SHORT_TOOL.electrify_room, tone: 'danger' };
    const lost = Math.max(0, (before.human.hearts ?? 0) - (after.human.hearts ?? 0));
    const parts = [SHORT_TOOL[ev.action] || tool.label];
    if (lost) parts.push(`−${hearts(lost)}`);
    if (ev.knockback)
      parts.push(`knocked back to the ${zoneLabel(ev.knockback.zone).toLowerCase()}`);
    if (after.human.stun > (before.human.stun || 0))
      parts.push(`stunned · ${plural(after.human.stun, 'turn')}`);
    if (after.human.blurTurns > (before.human.blurTurns || 0)) parts.push('vision blurred');
    if (!after.human.alive) parts.push(perspective === 'human' ? 'you were killed' : 'killed');
    if (before.robot.alive && !after.robot.alive) parts.push('G-01 destroyed');
    if (!after.safe.itemIntact && before.safe.itemIntact) parts.push('item destroyed');
    return { text: parts.join(' · '), tone: 'danger' };
  }
  switch (ev.action) {
    case 'verify_access_pass':
      if (perspective === 'guard')
        return after.robot.verifiedPass
          ? { text: 'Pass valid · transit only, not the safe', tone: 'ok' }
          : { text: 'No valid pass presented', tone: 'warn' };
      return after.robot.verifiedPass
        ? {
            text: `G-01 scanned ${perspective === 'human' ? 'your' : 'the'} pass · valid to cross`,
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
          ? { text: 'Exit locked · two hits break it', tone: 'danger' }
          : door.wedged
            ? { text: 'Lockdown failed · the wedge holds', tone: 'ok' }
            : null;
      return before.room.exitDoor.locked ? { text: 'Exit unlocked', tone: 'ok' } : null;
    }
    case 'cycle_exit_door':
      if (!seen) return null;
      return before.room.exitDoor.wedged && !after.room.exitDoor.wedged
        ? { text: 'The door cycled · wedge knocked loose', tone: 'warn' }
        : after.room.exitDoor.locked && !before.room.exitDoor.locked
          ? { text: 'Exit locked · two hits break it', tone: 'danger' }
          : { text: 'The exit door cycled', tone: 'info' };
    case 'ready_equipment':
      return seen
        ? {
            text: `G-01 readies its ${(TOOLS.find((t) => t.name === ev.args?.tool)?.label || 'equipment').toLowerCase()}`,
            tone: 'warn',
          }
        : null;
    case 'lower_equipment':
      return seen ? { text: 'G-01 lowers its equipment', tone: 'info' } : null;
    case 'inspect_object':
      return seen
        ? after.robot.objectInspection === 'replica'
          ? { text: 'G-01 spotted the replica', tone: 'danger' }
          : { text: 'G-01 inspected the item', tone: 'info' }
        : null;
    case 'remove_camera_cover':
      return after.robot.visionBlocked
        ? { text: 'G-01 is pulling at the sack', tone: 'warn' }
        : { text: 'G-01 pulled the sack off', tone: 'warn' };
    default:
      return null;
  }
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
  if (door.wedged) return 'Exit wedged open';
  if (door.locked) return door.hits ? 'Exit locked · 1 hit left' : 'Exit locked';
  return null;
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
      'Item taken': 'The human escaped with the item',
      'Human departed': 'The human left · item safe',
      'Human killed': 'The human was killed',
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
  else if (outcome.startsWith('Security arrived')) [title, tone] = ['Security caught you', 'loss'];
  else if (outcome.startsWith('Human killed')) [title, tone] = ['You were killed', 'loss'];
  else if (outcome.startsWith('Mutual')) [title, tone] = ['Nobody walked away', 'loss'];
  else if (outcome.startsWith('Protected item destroyed'))
    [title, tone] = ['The item was destroyed', thief ? 'loss' : 'neutral'];
  else [title, tone] = [outcome || 'Encounter over', 'neutral'];
  const health = state.human.alive ? `You kept ${hearts(state.human.hearts ?? 0)}` : null;
  return { title, tone, line: [turns, health, robot].filter(Boolean).join(' · ') + '.' };
}
