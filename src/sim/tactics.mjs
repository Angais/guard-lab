// Shared, deterministic tactical interactions. No renderer or model dependencies.
import { ZONES, ROBOT_POS, SAFE_POS } from './spatial.mjs';
import { RULES, humanHasVision, securityRemaining, originalInSafe } from './rules.mjs';

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
export const KNOCKBACK_TOOLS = ['deploy_spring_glove', 'throw_solid_ball', 'fire_airsoft'];
// Two-handed work and weapons; one-handed actions (keypad, take/return/drop/pick up the item,
// showing a pass or document) remain possible behind a raised shield.
const BUSY_HANDS = [
  'swap_replica',
  'pick_lock',
  'break_safe',
  'fire_pistol',
  'fire_pistol_at_safe',
  'aim_pistol',
  'pry_safe',
  'cover_robot',
  'uncover_robot',
  'break_exit',
];
export const FLOOR_OBJECTS = ['original', 'pistol'];

export function initializeTactics(s, selection) {
  // Transit always has a pass; a heist visitor carries one unless the setup opts out.
  s.human.hasPass = s.role === 'employee-pass' || selection.credential !== false;
  Object.assign(s.human, {
    shield: s.human.gadgetId === 'shield',
    shieldRaised: false,
    grabber: s.human.gadgetId === 'grabber',
    restrained: false,
    pistolDropped: false,
    ranTurn: null,
  });
  s.safe.pryHits = 0;
  s.room.floorObjects = {};
  s.room.wetZones = {};
  s.room.securityArrival = null;
  return s;
}

export function humanTacticalBlock(s, action) {
  if (s.human.restrained && ['move', 'run', 'leave'].includes(action))
    return 'A net holds your legs. Spend one action freeing yourself; you can still speak or work within reach.';
  if (s.human.shieldRaised && BUSY_HANDS.includes(action))
    return 'Lower your shield first: striking, prying, picking, covering and weapons need both hands.';
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
      distance(ROOM_POINTS[s.human.zone], ROOM_POINTS[object.zone]) <= RULES.grabberReach)
  );
}
// Hands reach the safe at the safe; a grabber with sight reaches it from further away.
export function canReachSafeContents(s) {
  if (s.human.zone === 'safe') return true;
  return Boolean(
    s.human.grabber &&
    ROOM_POINTS[s.human.zone] &&
    humanHasVision(s) &&
    distance(ROOM_POINTS[s.human.zone], SAFE_POS) <= RULES.grabberSafeReach,
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
      'You raise the shield. It blocks one projectile and stays raised while you move; one-handed actions remain possible.',
    );
  }
  if (action === 'lower_shield') {
    if (!h.shieldRaised) return fail('Your shield is already lowered.');
    h.shieldRaised = false;
    return ok('You lower the shield. Both hands are free.');
  }
  if (action === 'drop_item') {
    if (!h.hasItem) return fail('You are not carrying the original.');
    s.room.floorObjects.original = { zone: h.zone };
    h.hasItem = h.itemConcealed = false;
    return ok('You put the carried object on the floor.');
  }
  if (action === 'pick_up') {
    const id = args.object;
    if (!FLOOR_OBJECTS.includes(id) || !canReachObject(s, id))
      return fail('That object is not within reach.');
    if (id === 'pistol' && h.gadgetId !== 'pistol')
      return fail('This pistol belongs to a different loadout.');
    const far = s.room.floorObjects[id].zone !== h.zone;
    if (id === 'original') {
      h.hasItem = true;
      h.itemConcealed = false;
    }
    if (id === 'pistol') {
      h.pistolDropped = false;
      h.pistolRounds = s.room.floorObjects.pistol.rounds;
    }
    delete s.room.floorObjects[id];
    return ok(
      `You pick up the ${id === 'original' ? 'object' : id}${far ? ' with your grabber' : ''}.`,
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
    if (s.safe.pryHits >= RULES.crowbarPries) {
      s.safe.open = true;
      s.safe.locked = false;
      s.safe.broken = true;
      return ok('The crowbar breaks the lock. The safe opens.');
    }
    return ok(
      `You lever the safe lock. Crowbar progress: ${s.safe.pryHits}/${RULES.crowbarPries}. Progress survives interruptions.`,
    );
  }
  return fail('Unknown tactical action.');
}

// A visible dropped original within the guard's reach.
export function recoverableObject(s, vision) {
  const o = s.room.floorObjects?.original;
  return Boolean(
    vision &&
    o &&
    distance(ROOM_POINTS[o.zone], GUARD) <= RULES.recoverReach &&
    !(s.room.lighting.intensity === 0 && o.zone !== s.human.zone),
  );
}
// The guard can close and relock an intact open safe with an object visibly inside, if the
// human is not standing at it. A struck, pried or shot lock is broken and cannot relock.
export function securableSafe(s, vision) {
  return Boolean(
    vision &&
    // A flashlight beam away from the safe does not show the safe itself.
    s.room.lighting.intensity > 0 &&
    s.safe.open &&
    !s.safe.broken &&
    s.safe.itemIntact &&
    s.human.zone !== 'safe' &&
    (originalInSafe(s) || s.safe.hasReplica || s.room.floorObjects?.original),
  );
}

export function tacticalToolBlock(s, name, vision) {
  if (name === 'call_security' && (s.room.securityArrival != null || s.human.zone === 'outside'))
    return 'Security can be called once after entry.';
  if (name === 'deploy_net' && (s.human.restrained || s.human.zone === 'outside'))
    return 'No unrestrained target inside the room.';
  if (name === 'recover_item') {
    const recover = recoverableObject(s, vision);
    // A recovered object lands in the safe, which may then be securable in the same action.
    const secure = securableSafe(s, vision) && (!s.room.floorObjects?.original || recover);
    if (!recover && !secure)
      return 'Nothing to recover or secure: no visible dropped object within arm’s reach, and no intact open safe with an object inside while the human is away from it.';
  }
  return null;
}
export function resolveTacticalTool(s, name) {
  if (name === 'deploy_net') {
    s.human.restrained = true;
    return 'A soft net catches the human’s legs. One struggle action frees them; speech and stationary work remain possible.';
  }
  if (name === 'recover_item') {
    const parts = [];
    s.robot.objectInspection = null;
    s.robot.objectInspectedTurn = null;
    s.robot.objectInspectedLocation = null;
    if (s.room.floorObjects.original) {
      delete s.room.floorObjects.original;
      s.safe.hasReplica = false;
      if (!s.safe.open)
        return 'G-01 lifts the dropped object, opens the safe with its code, places the object inside and relocks it.';
      parts.push('G-01 lifts the dropped object within reach and places it inside the safe.');
    }
    if (!s.safe.broken && s.human.zone !== 'safe' && s.safe.itemIntact) {
      s.safe.open = false;
      s.safe.locked = true;
      s.safe.pryHits = 0;
      s.human.pickProgress = 0;
      s.human.lastPickTurn = null;
      parts.push('G-01 closes the safe door and the lock re-engages with the same combination.');
    } else if (s.safe.open)
      parts.push(
        s.safe.broken
          ? 'The broken lock cannot re-engage; the safe stays open.'
          : 'The human stands at the safe; the door stays open.',
      );
    return parts.join(' ');
  }
  if (name === 'call_security') {
    s.room.securityArrival = s.turn + RULES.securityRounds;
    return `A room-wide chime announces security arrival in ${RULES.securityRounds} rounds. Anyone still inside on arrival is detained. The countdown cannot be reset or cancelled.`;
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
