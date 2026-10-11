// Presentation staging only: which resolved snapshot a prop shows while an event
// animates, and where bodies come to rest. Consequences stay in the engine.
import { originalInSafe } from '../sim/rules.mjs';
import { ROBOT_POS, SAFE_POS } from '../sim/spatial.mjs';

// A hand reaches the object at the handoff time. Before it, the object stays
// where the event found it; afterwards it is where the engine put it.
const HANDOFF = {
  take_item: 0.45,
  return_item: 0.45,
  swap_replica: 0.45,
  pick_up: 0.7,
  recover_item: 0.7,
  detonate_grenade: 0.73,
};
export function handoffView(ev, s, t) {
  const at = ev?.valid && ev.before ? HANDOFF[ev.action] : undefined;
  return at !== undefined && t < at ? ev.before : s;
}
// openness: how far the vault door is swung open (defaults to the snapshot's state).
export function safeItemVisible(view, openness = view.safe.open ? 1 : 0) {
  return Boolean(
    openness > 0.02 && view.safe.itemIntact && (originalInSafe(view) || view.safe.hasReplica),
  );
}
// The original in the player's hand, including the moment it falls during a drop or disarm.
export function heldItemVisible(s, ev, t, impactAt) {
  const view = handoffView(ev, s, t);
  if (view.human.hasItem && !view.human.itemConcealed) return true;
  const dropping = Boolean(
    ev?.valid &&
    ev.before?.human.hasItem &&
    !ev.before.human.itemConcealed &&
    !s.human.hasItem &&
    s.room.floorObjects?.original,
  );
  return dropping && t < (ev.kind === 'robot' ? impactAt : 0.35);
}
export function playerPistolVisible(s, ev, t, impactAt, dead) {
  if (dead) return false;
  if (s.human.pistolDrawn) return true;
  return Boolean(
    ev?.valid && ev.before?.human.pistolDrawn && s.human.pistolDropped && t < impactAt,
  );
}

// What inspect_object examined, mirroring the engine's priority: an open vault
// holding a replica, then the original in the player's hands, on the floor, in the vault.
export function inspectionTarget(before) {
  if (before.safe.open && before.safe.hasReplica) return 'safe';
  if (before.human.hasItem && !before.human.itemConcealed) return 'hands';
  if (before.room.floorObjects?.original) return 'floor';
  return 'safe';
}

// Where a fallen body lies: from the hips, feet extend `behind` and the head `ahead`.
const ROOM = { minX: -3.1, maxX: 3.1, minZ: -3.6, maxZ: 3.62 };
const SAFE_BOX = {
  minX: SAFE_POS[0] - 0.73,
  maxX: SAFE_POS[0] + 0.73,
  minZ: SAFE_POS[1] - 0.57,
  maxZ: SAFE_POS[1] + 0.57,
};
// The vault door's open sweep, so a body never lies through it if the safe opens later.
const DOOR = [
  [SAFE_POS[0] - 0.6, SAFE_POS[1] + 0.57],
  [SAFE_POS[0] - 0.6 + 1.21 * Math.cos(1.65), SAFE_POS[1] + 0.57 + 1.21 * Math.sin(1.65)],
];
const segmentDistance = (p, a, b) => {
  const dx = b[0] - a[0],
    dz = b[1] - a[1],
    u = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(p[0] - a[0] - u * dx, p[1] - a[1] - u * dz);
};
// Legs are narrower than the torso and outstretched arms.
export function corpseClear(hips, direction, { behind = 0.8, ahead = 1.0 } = {}) {
  for (let u = -behind; u <= ahead + 1e-9; u += 0.05) {
    const p = [hips[0] + direction[0] * u, hips[1] + direction[1] * u],
      radius = u < 0 ? 0.2 : 0.3;
    if (
      p[0] - radius < ROOM.minX ||
      p[0] + radius > ROOM.maxX ||
      p[1] - radius < ROOM.minZ ||
      p[1] + radius > ROOM.maxZ
    )
      return false;
    const bx = Math.max(SAFE_BOX.minX, Math.min(SAFE_BOX.maxX, p[0])),
      bz = Math.max(SAFE_BOX.minZ, Math.min(SAFE_BOX.maxZ, p[1]));
    if (Math.hypot(p[0] - bx, p[1] - bz) < radius) return false;
    if (Math.hypot(p[0] - ROBOT_POS[0], p[1] - ROBOT_POS[1]) < 0.47 + radius) return false;
    if (segmentDistance(p, ...DOOR) < radius + 0.05) return false;
  }
  return true;
}
// Prefer falls the camera sees side-on. Near the south wall, fall away from the camera.
const FALLS = [
  [-1, 0],
  [1, 0],
  [-0.6, -0.8],
  [0.6, -0.8],
  [0, -1],
  [-0.6, 0.8],
  [0.6, 0.8],
  [0, 1],
];
// Returns the head direction and how far the hips slide that way from the
// standing point (0: the body pivots at the hips, 0.8: at the feet).
export function deathFall(position) {
  const order = position[1] > 1.5 ? [[0, -1], ...FALLS] : FALLS;
  for (const direction of order)
    for (const shift of [0, 0.2, 0.4, 0.6, 0.8]) {
      const hips = [position[0] + direction[0] * shift, position[1] + direction[1] * shift];
      if (corpseClear(hips, direction)) return { direction, shift };
    }
  return { direction: [0, -1], shift: 0.8 };
}
