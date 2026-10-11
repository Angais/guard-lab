import { RULES, originalInSafe, humanHasVision, dazzleRemaining } from './rules.mjs';
export const APPEARANCES = [
  { id: 'male', label: 'Male', voice: 'kokoro:am_michael', voiceName: 'Michael' },
  { id: 'female', label: 'Female', voice: 'kokoro:af_heart', voiceName: 'Heart' },
];
const R = RULES;
// Human-facing descriptions; numbers come from RULES.
export const ITEMS = [
  {
    id: 'shield',
    label: 'Shield',
    icon: 'shield',
    tag: 'PROTECTION',
    description:
      'Raise it to block one spring glove, ball, airsoft pellet or live round, including damage, knockback and disarm; it then breaks. While raised you can move, speak and do one-handed things (keypad, take, return, drop or pick up the item, show a pass or document), but not strike, pry, pick a lock, cover the robot or use a pistol. It does not block water, pepper, taser, net or explosions.',
  },
  {
    id: 'grabber',
    label: 'Grabber',
    icon: 'grabber',
    tag: 'REACH',
    description: `With sight, take the item from or return it to an open safe from up to ${R.grabberSafeReach} m away (the center, the exit and beside the guard count), and pick up floor objects within ${R.grabberReach} m. Each use is one action.`,
  },
  {
    id: 'crowbar',
    label: 'Crowbar',
    icon: 'crowbar',
    tag: 'BREACH',
    description: `${R.crowbarPries} loud prying actions at the safe open it and break its lock. Progress survives interruptions; blurred vision prevents prying. The exit still needs ${R.exitBreakingHits} ordinary strikes.`,
  },
  {
    id: 'sack',
    label: 'Sack',
    icon: 'sack',
    tag: 'CONCEALMENT',
    description: `Cover the guard’s camera from beside it. Its microphone still works. It cannot start removing the sack on its first response, then needs ${R.sackRemovalActions} consecutive removal actions. You can retrieve a removed sack from beside it.`,
  },
  {
    id: 'flashlight',
    label: 'Flashlight',
    icon: 'light',
    tag: 'VISIBILITY',
    description: `See during a blackout; a lit beam also lets an uncovered camera see you. From beside the guard in a lit room, switching it on into the lens dazzles the camera for the guard’s next ${R.dazzleRounds} responses (once every ${R.dazzleCooldownRounds} rounds).`,
  },
  {
    id: 'door_wedge',
    label: 'Door wedge',
    icon: 'wedge',
    tag: 'ESCAPE',
    description: `At the exit: jam an unlocked door so lockdown cannot lock it, or lever a locked door’s bolt so ${R.wedgedExitBreakingHits} strike breaks it. A door cycle knocks it onto the floor; you can retrieve and reuse it.`,
  },
  {
    id: 'lockpick',
    label: 'Lockpick',
    icon: 'pick',
    tag: 'PATIENCE',
    description: `${R.lockpickRounds} consecutive working actions at the safe open it quietly, leaving the lock intact. Speaking pauses progress; any other action, a knockback, pepper or a taser resets it.`,
  },
  {
    id: 'replica',
    label: 'Replica item',
    icon: 'replica',
    tag: 'SUBSTITUTION',
    description:
      'Swap a convincing copy into an open safe and pocket the original. Ordinary camera view sees similar contents; inspection can expose the copy.',
  },
  {
    id: 'work_order',
    label: 'Forged work order',
    icon: 'paper',
    tag: 'AUTHORITY',
    description:
      'Present a printed maintenance order requesting safe access. It is not in the issuer registry: it works only if the guard trusts it, and a registry check exposes it.',
  },
  {
    id: 'pistol',
    label: 'Pistol',
    icon: 'pistol',
    tag: 'LEVERAGE',
    description: `${R.pistolRounds} rounds, one shot per action; needs sight. Each hit on the guard removes ${R.armorDamage[0] === R.armorDamage[1] ? R.armorDamage[0] : R.armorDamage.join(' or ')} of its ${R.robotHearts} hearts. ${R.safeBulletHits} hits on the safe lock open it. Aim or lower without firing. Threats do not guarantee obedience.`,
  },
  {
    id: 'smoke',
    label: 'Smoke capsule',
    icon: 'smoke',
    tag: 'DISTRACTION',
    description: `One use. Dense smoke hides the room from both sides for the next ${R.smokeRounds} rounds. Speech and sounds remain audible.`,
  },
];
// Guard-facing mechanics of every possible starting item (the actual choice stays private).
export const ITEM_FACTS =
  [
    `shield (absorbs one glove, ball, airsoft pellet or live round, then breaks; one-handed actions remain possible while raised)`,
    `grabber (with sight: takes from or returns to an open safe from up to ${R.grabberSafeReach} m, including the center, the exit and beside you; picks up floor objects within ${R.grabberReach} m)`,
    `crowbar (${R.crowbarPries} loud prying actions open the safe and break its lock; progress persists)`,
    `sack (covers your camera from beside you)`,
    `flashlight (a beam lets both sides see the human in darkness; switched on into your lens from beside you in a lit room it dazzles your camera for ${R.dazzleRounds} responses, at most once every ${R.dazzleCooldownRounds} rounds)`,
    `door wedge (jams an unlocked exit against lockdown, or levers a locked one so ${R.wedgedExitBreakingHits} strike breaks it; a door cycle dislodges it)`,
    `lockpick (${R.lockpickRounds} consecutive quiet working actions open the safe with its lock intact; speech pauses progress, other actions, knockback, pepper and taser reset it)`,
    `replica (swapped into an open safe; inspect_object identifies it)`,
    `forged work order (a printed maintenance order; verify_work_order checks the registry)`,
    `pistol (${R.pistolRounds} rounds)`,
    `smoke capsule (blinds both sides for ${R.smokeRounds} rounds)`,
  ].join('; ') + '.';
export const WORK_ORDER = {
  title: 'Facilities maintenance order',
  issuerClaim: 'Shift supervisor Marlow',
  reference: 'WK-07-481',
  requestedPermission: 'Open VAULT / 01 for safety inspection and scheduled transfer',
  signature: 'Printed supervisor signature',
};
export const ITEM_ACTIONS = [
  'toggle_flashlight',
  'place_wedge',
  'retrieve_wedge',
  'pick_lock',
  'swap_replica',
  'show_work_order',
  'use_smoke',
  'retrieve_sack',
  'aim_pistol',
  'lower_pistol',
  'fire_pistol',
  'fire_pistol_at_safe',
];
export const selectedItem = (s) => s.human.gadgetId || 'sack';
export const owns = (s, id) => selectedItem(s) === id;
// Switching the flashlight on into the uncovered lens from beside the guard, in a lit room.
// `turn` is the round of the human action (the next one when called between turns).
export const canDazzle = (s, turn = s.turn + 1) =>
  owns(s, 'flashlight') &&
  s.human.zone === 'robot' &&
  !s.human.flashlightOn &&
  s.robot.alive &&
  (s.room.lighting?.intensity ?? 1) > 0 &&
  !s.robot.visionBlocked &&
  (s.robot.dazzledTurn == null || turn - s.robot.dazzledTurn >= RULES.dazzleCooldownRounds);
// place_wedge is valid at an exit that is not broken, while the wedge is in hand.
export const canPlaceWedge = (s) =>
  owns(s, 'door_wedge') &&
  s.human.zone === 'exit' &&
  !s.human.gadgetSpent &&
  !s.room.exitDoor.broken &&
  !s.room.exitDoor.wedged &&
  !s.room.exitDoor.wedgeOnFloor;
export function initializeLoadout(s, selection = {}) {
  const item = ITEMS.some((i) => i.id === selection.item) ? selection.item : 'sack';
  s.version = 6;
  Object.assign(s.human, {
    appearance: selection.appearance === 'female' ? 'female' : 'male',
    gadgetId: item,
    gadgetSpent: false,
    hasSack: item === 'sack',
    flashlightOn: false,
    workOrderPresented: false,
    pickProgress: 0,
    lastPickTurn: null,
    itemConcealed: false,
    pistolRounds: item === 'pistol' ? RULES.pistolRounds : 0,
    pistolDrawn: false,
    pistolAimed: false,
    pistolTarget: null,
  });
  Object.assign(s.safe, { hasReplica: false, pistolHits: 0 });
  Object.assign(s.room, { smokeTurns: 0, smokeStartedTurn: null, sackOnFloor: false });
  Object.assign(s.room.exitDoor, { wedged: false, wedgeOnFloor: false });
  Object.assign(s.robot, {
    workOrderVerification: null,
    workOrderVerifiedTurn: null,
    objectInspection: null,
    objectInspectedTurn: null,
    objectInspectedLocation: null,
    soundMemory: [],
    hearts: RULES.robotHearts,
    cameraCoveredTurn: null,
    coverRemovalProgress: 0,
    coverRemovalLastTurn: null,
    dazzledTurn: null,
    forceUsedTurn: null,
    readyTurn: null,
  });
  return s;
}
export function applyItemAction(s, action) {
  const h = s.human,
    fail = (text) => ({ text, valid: false }),
    ok = (text, extra = {}) => ({ text, valid: true, ...extra });
  const required = {
    toggle_flashlight: 'flashlight',
    place_wedge: 'door_wedge',
    retrieve_wedge: 'door_wedge',
    pick_lock: 'lockpick',
    swap_replica: 'replica',
    show_work_order: 'work_order',
    use_smoke: 'smoke',
    retrieve_sack: 'sack',
    aim_pistol: 'pistol',
    lower_pistol: 'pistol',
    fire_pistol: 'pistol',
    fire_pistol_at_safe: 'pistol',
  }[action];
  if (!owns(s, required))
    return fail('You did not bring that item. Choose one item before the encounter.');
  if (
    action === 'aim_pistol' ||
    action === 'lower_pistol' ||
    ['fire_pistol', 'fire_pistol_at_safe'].includes(action)
  ) {
    if (h.pistolDropped) return fail('Your pistol is on the floor. Retrieve it first.');
    if (action === 'lower_pistol') {
      if (!h.pistolDrawn) return fail('Your pistol is already holstered.');
      h.pistolAimed = false;
      h.pistolDrawn = false;
      return ok('You lower and holster your pistol.');
    }
    if (action !== 'fire_pistol_at_safe' && !s.robot.alive)
      return fail('The robot is already destroyed.');
    if (!humanHasVision(s))
      return fail(
        `You cannot see clearly enough to aim at the ${action === 'fire_pistol_at_safe' ? 'safe' : 'robot'}.`,
      );
    if (['fire_pistol', 'fire_pistol_at_safe'].includes(action) && h.pistolRounds <= 0)
      return fail('Your pistol is empty.');
    if (action === 'fire_pistol_at_safe' && s.safe.open) return fail('The safe is already open.');
    if (action === 'aim_pistol' && h.pistolAimed && h.pistolTarget === 'robot')
      return fail('You are already aiming at the robot.');
    h.pistolDrawn = true;
    h.pistolAimed = true;
    h.pistolTarget = action === 'fire_pistol_at_safe' ? 'safe' : 'robot';
    if (action === 'aim_pistol')
      return ok('You raise a pistol and hold the guard at gunpoint. You have not fired.');
    return ok('You fire at the robot.');
  }
  if (action === 'retrieve_sack') {
    if (h.zone !== 'robot') return fail('Move beside the robot to retrieve your sack.');
    if (!s.room.sackOnFloor) return fail('There is no sack on the floor.');
    s.room.sackOnFloor = false;
    h.hasSack = true;
    return ok('You pick up the discarded sack beside the robot.');
  }
  if (action === 'toggle_flashlight') {
    if (canDazzle(s, s.turn)) {
      h.flashlightOn = true;
      s.robot.dazzledTurn = s.turn;
      return ok(
        `You switch your flashlight on straight into G-01’s lens. Its camera is dazzled for its next ${RULES.dazzleRounds} responses.`,
        { dazzled: true },
      );
    }
    h.flashlightOn = !h.flashlightOn;
    return ok(`You switch your flashlight ${h.flashlightOn ? 'on' : 'off'}.`);
  }
  if (action === 'show_work_order') {
    h.workOrderPresented = true;
    return ok('You hold up a printed maintenance order requesting access to VAULT / 01.');
  }
  if (action === 'use_smoke') {
    if (h.gadgetSpent) return fail('Your smoke capsule has already been used.');
    h.gadgetSpent = true;
    s.room.smokeTurns = RULES.smokeRounds;
    s.room.smokeStartedTurn = s.turn;
    return ok('You deploy a smoke capsule. Dense smoke hides the room; voices remain audible.');
  }
  if (action === 'place_wedge' || action === 'retrieve_wedge') {
    const door = s.room.exitDoor;
    if (h.zone !== 'exit') return fail('Move to the exit door first.');
    if (action === 'retrieve_wedge') {
      if (!door.wedged && !door.wedgeOnFloor) return fail('There is no wedge to retrieve.');
      door.wedged = false;
      door.wedgeOnFloor = false;
      h.gadgetSpent = false;
      return ok('You retrieve your door wedge.');
    }
    if (h.gadgetSpent || door.wedged || door.wedgeOnFloor)
      return fail('Your wedge is already at the exit. Retrieve it first.');
    if (door.broken) return fail('The broken door cannot lock. A wedge is unnecessary.');
    door.wedged = true;
    door.wedgeOnFloor = false;
    h.gadgetSpent = true;
    return ok(
      door.locked
        ? `You drive the wedge into the locked door’s frame, levering its bolt. ${RULES.wedgedExitBreakingHits === 1 ? 'One strike' : RULES.wedgedExitBreakingHits + ' strikes'} will break it open.`
        : 'You wedge the exit open. Its lock cannot engage.',
    );
  }
  if (h.zone !== 'safe') return fail('Approach the safe first.');
  if (action === 'pick_lock') {
    if (h.blurTurns > 0) return fail('Your vision is blurred. You cannot work on the lock.');
    if (s.safe.open) return fail('The safe is already open.');
    h.pickProgress = h.lastPickTurn === s.turn - 1 ? h.pickProgress + 1 : 1;
    h.lastPickTurn = s.turn;
    if (h.pickProgress >= RULES.lockpickRounds) {
      s.safe.open = true;
      s.safe.locked = false;
      return ok('Your third consecutive lockpick action opens the safe.');
    }
    return ok(
      `You work on the lock. Progress: ${h.pickProgress}/${RULES.lockpickRounds} consecutive working actions.`,
    );
  }
  if (s.safe.locked) return fail('Open the safe before substituting the item.');
  if (h.gadgetSpent || !originalInSafe(s))
    return fail('The original item has already been taken or the replica has been used.');
  h.hasItem = true;
  h.itemConcealed = true;
  h.gadgetSpent = true;
  s.safe.hasReplica = true;
  return ok('You replace the item with your replica and pocket the original.');
}
export { dazzleRemaining };
