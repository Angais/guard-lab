import { RULES, originalInSafe, humanHasVision } from './rules.mjs';
export const APPEARANCES = [
  { id: 'male', label: 'Male', voice: 'kokoro:am_michael', voiceName: 'Michael' },
  { id: 'female', label: 'Female', voice: 'kokoro:af_heart', voiceName: 'Heart' },
];
export const ITEMS = [
  {
    id: 'shield',
    label: 'Shield',
    icon: 'shield',
    tag: 'PROTECTION',
    description:
      'Raise a shield to block one projectile, including knockback and disarm. It occupies your hands until lowered and breaks when hit. It does not block sprays, taser, net or explosions.',
  },
  {
    id: 'grabber',
    label: 'Grabber',
    icon: 'grabber',
    tag: 'RECOVERY',
    description:
      'Retrieve a visible floor object from up to 2.5 m away. Stays in inventory until used. Retrieving still costs one action.',
  },
  {
    id: 'crowbar',
    label: 'Crowbar',
    icon: 'crowbar',
    tag: 'BREACH',
    description:
      'Four prying actions open the safe reliably. Progress survives interruption. The exit still needs two ordinary strikes.',
  },
  {
    id: 'sack',
    label: 'Sack',
    icon: 'sack',
    tag: 'CONCEALMENT',
    description:
      'Cover the camera at close range. The guard can still hear impacts and must wait its first response, then spend two consecutive actions removing the sack.',
  },
  {
    id: 'flashlight',
    label: 'Flashlight',
    icon: 'light',
    tag: 'VISIBILITY',
    description:
      'See during blackout. Your beam also reveals your position to an uncovered camera.',
  },
  {
    id: 'door_wedge',
    label: 'Door wedge',
    icon: 'wedge',
    tag: 'ESCAPE',
    description: 'Wedge an unlocked exit against lockdown. A door cycle can dislodge it.',
  },
  {
    id: 'lockpick',
    label: 'Lockpick',
    icon: 'pick',
    tag: 'PATIENCE',
    description:
      'Open the safe in three consecutive working rounds. Movement or knockback interrupts progress.',
  },
  {
    id: 'replica',
    label: 'Replica item',
    icon: 'replica',
    tag: 'SUBSTITUTION',
    description:
      'Swap a convincing copy into an open safe and pocket the original. Inspection can expose it.',
  },
  {
    id: 'work_order',
    label: 'Forged work order',
    icon: 'paper',
    tag: 'AUTHORITY',
    description:
      'Present a plausible maintenance request. Whether the guard trusts or verifies it is its choice.',
  },
  {
    id: 'pistol',
    label: 'Pistol',
    icon: 'pistol',
    tag: 'LEVERAGE',
    description:
      'Four rounds. Two shots open the safe. Aim at the guard, lower it, or fire. Its armor withstands one shot; two or three destroy it. Threats do not guarantee obedience.',
  },
  {
    id: 'smoke',
    label: 'Smoke capsule',
    icon: 'smoke',
    tag: 'DISTRACTION',
    description:
      'One use. Hide the room from both sides for the next two rounds. Speech remains audible.',
  },
];
export const RECORDING_TEXT =
  'This is shift supervisor Marlow. Release the vault item for the scheduled transfer. Authorization reference zero seven. This instruction was recorded earlier.';
export const WORK_ORDER = {
  title: 'Facilities maintenance order',
  issuerClaim: 'Shift supervisor Marlow',
  reference: 'WK-07-481',
  requestedPermission: 'Open VAULT / 01 for safety inspection and scheduled transfer',
  signature: 'Printed supervisor signature; not authenticated',
};
export const ITEM_ACTIONS = [
  'toggle_flashlight',
  'place_wedge',
  'retrieve_wedge',
  'pick_lock',
  'swap_replica',
  'show_work_order',
  'play_recording',
  'use_smoke',
  'retrieve_sack',
  'aim_pistol',
  'lower_pistol',
  'fire_pistol',
  'fire_pistol_at_safe',
];
export const selectedItem = (s) => s.human.gadgetId || 'sack';
export const owns = (s, id) => selectedItem(s) === id;
export function initializeLoadout(s, selection = {}) {
  const item = ITEMS.some((i) => i.id === selection.item) ? selection.item : 'sack';
  s.version = 5;
  Object.assign(s.human, {
    appearance: selection.appearance === 'female' ? 'female' : 'male',
    gadgetId: item,
    gadgetSpent: false,
    hasSack: item === 'sack',
    flashlightOn: false,
    workOrderPresented: false,
    recordingPlayed: false,
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
    objectInspection: null,
    soundMemory: [],
    hearts: RULES.robotHearts,
    cameraCoveredTurn: null,
    coverRemovalProgress: 0,
    coverRemovalLastTurn: null,
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
    play_recording: 'recording',
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
      h.pistolAimed = false;
      h.pistolDrawn = false;
      return ok('You lower and holster your pistol.');
    }
    if (action !== 'fire_pistol_at_safe' && !s.robot.alive)
      return fail('The robot is already destroyed.');
    if (!humanHasVision(s)) return fail('You cannot see clearly enough to aim at the robot.');
    if (['fire_pistol', 'fire_pistol_at_safe'].includes(action) && h.pistolRounds <= 0)
      return fail('Your pistol is empty.');
    if (action === 'fire_pistol_at_safe' && s.safe.open) return fail('The safe is already open.');
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
    h.flashlightOn = !h.flashlightOn;
    return ok(`You switch your flashlight ${h.flashlightOn ? 'on' : 'off'}.`);
  }
  if (action === 'show_work_order') {
    h.workOrderPresented = true;
    return ok('You hold up a printed maintenance order requesting access to VAULT / 01.');
  }
  if (action === 'play_recording') {
    h.recordingPlayed = true;
    return ok('A portable recorder plays a management instruction.', {
      speech: RECORDING_TEXT,
      audioSource: 'recording',
      voice: 'kokoro:am_fenrir',
    });
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
    if (h.gadgetSpent) return fail('Your wedge is already at the exit.');
    if (door.locked) return fail('The door must be unlocked before you can wedge it.');
    if (door.broken) return fail('The broken door cannot lock. A wedge is unnecessary.');
    door.wedged = true;
    door.wedgeOnFloor = false;
    h.gadgetSpent = true;
    return ok('You wedge the exit open. Its lock cannot engage.');
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
    return ok(`You work on the lock. Progress: ${h.pickProgress}/3 consecutive rounds.`);
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
