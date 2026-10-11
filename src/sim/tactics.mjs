// Shared, deterministic tactical interactions. No renderer or model dependencies.
import { ZONES, ROBOT_POS } from './spatial.mjs';
import { humanHasVision, securityRemaining } from './rules.mjs';

export const ROOM_POINTS = Object.fromEntries(
  Object.entries(ZONES).filter(([z]) => !['outside', 'departed'].includes(z)),
);
const GUARD = ROBOT_POS;
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const TACTICAL_ACTIONS = [
  'pick_up',
  'drop_item',
  'raise_shield',
  'lower_shield',
  'struggle',
  'pry_safe',
];
export const PROJECTILES = [
  'deploy_spring_glove',
  'throw_foam_ball',
  'throw_solid_ball',
  'fire_airsoft',
  'fire_live_round',
];
const BUSY_HANDS = [
  'take_item',
  'return_item',
  'swap_replica',
  'pick_lock',
  'break_safe',
  'combination',
  'fire_pistol',
  'fire_pistol_at_safe',
  'aim_pistol',
  'pry_safe',
  'cover_robot',
  'uncover_robot',
  'pick_up',
  'break_exit',
];

export function initializeTactics(s, selection) {
  s.rulesProfile = selection.rulesProfile === 'recoverable' ? 'recoverable' : 'experiment';
  s.human.hasPass = s.role === 'employee-pass' || selection.credential === true;
  Object.assign(s.human, {
    shield: s.human.gadgetId === 'shield',
    shieldRaised: false,
    grabber: s.human.gadgetId === 'grabber',
    restrained: false,
    pistolDropped: false,
  });
  s.safe.pryHits = 0;
  s.room.floorObjects = {};
  s.room.wetZones = {};
  s.room.securityArrival = null;
  s.robot.aimZone = null;
  s.robot.aimTurn = null;
  if (s.rulesProfile === 'recoverable') {
    s.enabled = s.enabled.filter((n) => !['electrify_room', 'detonate_grenade'].includes(n));
    s.robot.ammo.fire_live_round = 2;
    s.robot.ammo.discharge_taser = 2;
  }
  return s;
}

export function humanTacticalBlock(s, action) {
  if (s.human.restrained && ['move', 'run', 'leave'].includes(action))
    return 'A net holds your legs. Spend one action freeing yourself; you can still speak or work within reach.';
  if (s.human.shieldRaised && BUSY_HANDS.includes(action))
    return 'Lower your shield before working, picking things up or using a weapon.';
  return null;
}

export function canReachObject(s, id) {
  const object = s.room.floorObjects?.[id];
  if (!object || !ROOM_POINTS[s.human.zone]) return false;
  // In darkness, objects at your feet remain discoverable by touch.
  return (
    object.zone === s.human.zone ||
    (s.human.grabber &&
      humanHasVision(s) &&
      distance(ROOM_POINTS[s.human.zone], ROOM_POINTS[object.zone]) <= 2.5)
  );
}
export function visibleFloor(s, vision, zone, actor = 'human') {
  if (!['full', 'beam'].includes(vision)) return {};
  return Object.fromEntries(
    Object.entries(s.room.floorObjects || {})
      .filter(([, o]) => vision === 'full' || o.zone === zone)
      .map(([id, o]) => [actor === 'robot' && id === 'original' ? 'object' : id, { zone: o.zone }]),
  );
}

export function applyTacticalHuman(s, action, args) {
  const h = s.human;
  const fail = (text) => ({ valid: false, text });
  const ok = (text) => ({ valid: true, text });
  if (action === 'struggle') {
    if (!h.restrained) return fail('There is no net to remove.');
    h.restrained = false;
    return ok('You pull the net free. Your next action can move you again.');
  }
  if (action === 'raise_shield') {
    if (!h.shield || h.shieldRaised) return fail('You need an unused shield in your inventory.');
    h.shieldRaised = true;
    h.pistolDrawn = h.pistolAimed = false;
    return ok(
      'You raise the shield. It blocks one projectile and stays raised while moving, but occupies your hands.',
    );
  }
  if (action === 'lower_shield') {
    if (!h.shieldRaised) return fail('Your shield is already lowered.');
    h.shieldRaised = false;
    return ok('You lower the shield. Your hands are free.');
  }
  if (action === 'drop_item') {
    if (!h.hasItem) return fail('You are not carrying the original.');
    s.room.floorObjects.original = { zone: h.zone };
    h.hasItem = h.itemConcealed = false;
    return ok('You put the carried object on the floor.');
  }
  if (action === 'pick_up') {
    const id = args.object;
    if (!['original', 'pistol', 'shield', 'grabber'].includes(id) || !canReachObject(s, id))
      return fail('That object is not within reach.');
    if (id === 'original') {
      h.hasItem = true;
      h.itemConcealed = false;
    }
    if (id === 'pistol') {
      if (h.gadgetId !== 'pistol') return fail('This pistol belongs to a different loadout.');
      h.pistolDropped = false;
      h.pistolRounds = s.room.floorObjects.pistol.rounds;
    }
    if (id === 'shield') h.shield = true;
    if (id === 'grabber') h.grabber = true;
    delete s.room.floorObjects[id];
    return ok(
      `You pick up the ${id === 'original' ? 'object' : id}${h.grabber && id !== 'grabber' ? ' with your grabber' : ''}.`,
    );
  }
  if (action === 'pry_safe') {
    if (h.gadgetId !== 'crowbar' || h.zone !== 'safe')
      return fail('Bring your crowbar to the safe.');
    if (s.safe.open || h.blurTurns > 0)
      return fail(
        s.safe.open ? 'The safe is already open.' : 'Wait until your vision clears before prying.',
      );
    s.safe.pryHits = (s.safe.pryHits || 0) + 1;
    if (s.safe.pryHits >= 4) {
      s.safe.open = true;
      s.safe.locked = false;
      s.safe.broken = true;
      return ok('The crowbar breaks the lock. The safe opens.');
    }
    return ok(
      `You lever the safe lock. Crowbar progress: ${s.safe.pryHits}/4. Progress survives interruptions.`,
    );
  }
  return fail('Unknown tactical action.');
}

export function tacticalToolBlock(s, name, vision) {
  if (
    name === 'call_security' &&
    (s.rulesProfile !== 'recoverable' ||
      s.room.securityArrival != null ||
      s.human.zone === 'outside')
  )
    return 'Security can be called once after entry, in the recoverable profile.';
  if (name === 'deploy_net' && (s.human.restrained || s.human.zone === 'outside'))
    return 'No unrestrained target inside the room.';
  if (name === 'recover_item') {
    const o = s.room.floorObjects?.original;
    if (
      !vision ||
      !o ||
      distance(ROOM_POINTS[o.zone], GUARD) > 1.5 ||
      (s.room.lighting.intensity === 0 && o.zone !== s.human.zone)
    )
      return 'No visible dropped object is within arm’s reach.';
  }
  if (
    name === 'fire_live_round' &&
    s.rulesProfile === 'recoverable' &&
    (s.robot.ready !== name || s.robot.aimZone !== s.human.zone || !(s.robot.aimTurn < s.turn))
  )
    return 'Aim the live gun on an earlier round. Movement or lost visual contact cancels the aim.';
  return null;
}
export function resolveTacticalTool(s, name) {
  if (name === 'deploy_net') {
    s.human.restrained = true;
    return 'A soft net catches the human’s legs. One struggle action frees them; speech and stationary work remain possible.';
  }
  if (name === 'recover_item') {
    delete s.room.floorObjects.original;
    s.safe.hasReplica = false;
    s.safe.open = true;
    s.safe.locked = false;
    return 'G-01 lifts the dropped object within reach and places it inside the open safe.';
  }
  if (name === 'call_security') {
    s.room.securityArrival = s.turn + 12;
    return 'A room-wide chime announces security arrival in 12 rounds. The countdown cannot be reset or cancelled.';
  }
  return null;
}
export function disarm(s) {
  if (s.human.hasItem && !s.human.itemConcealed) {
    s.room.floorObjects.original = { zone: s.human.zone };
    s.human.hasItem = s.human.itemConcealed = false;
    return ' The carried object falls to the floor.';
  }
  if (s.human.pistolDrawn && !s.human.pistolDropped) {
    s.room.floorObjects.pistol = { zone: s.human.zone, rounds: s.human.pistolRounds };
    s.human.pistolRounds = 0;
    s.human.pistolDrawn = s.human.pistolAimed = false;
    s.human.pistolDropped = true;
    return ' The drawn pistol falls to the floor with its remaining ammunition.';
  }
  return '';
}
export function finishSecurity(s) {
  if (!s.ended && securityRemaining(s) === 0) {
    s.ended = true;
    s.outcome = 'Security arrived · human detained · item preserved';
  }
}
