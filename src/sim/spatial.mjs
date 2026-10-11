export const ZONES = {
  outside: [-1.8, 4.4],
  entrance: [-1.8, 2.6],
  center: [0, 0.8],
  safe: [0.5, -1.4],
  robot: [1.15, -1.65],
  exit: [-1.8, -2.5],
  departed: [-1.8, -4.2],
};
export const ROBOT_POS = [1.8, -2.0];
export const SAFE_POS = [0.25, -2.6];
export const ROOM_ZONES = ['entrance', 'center', 'safe', 'robot', 'exit'];
const meters = (a, b) => Number(Math.hypot(a[0] - b[0], a[1] - b[1]).toFixed(2));

// Grenades land beside the human, clear of their capsule and the guard base.
// The engine and presentation share this point; collateral uses the same origin.
export function grenadeLanding(human, robot) {
  const dx = robot[0] - human[0],
    dz = robot[1] - human[1],
    length = Math.hypot(dx, dz) || 1;
  return length > 1.2
    ? [human[0] + (dx / length) * 0.6, human[1] + (dz / length) * 0.6]
    : [human[0] - (dz / length) * 0.85, human[1] + (dx / length) * 0.85];
}

// Fixed, public room geometry. Positions are where the human stands; `robot` is beside the guard.
export const ROOM_MAP = Object.freeze({
  units: 'meters as [x, z]',
  humanPositions: Object.freeze(
    Object.fromEntries(ROOM_ZONES.map((z) => [z, Object.freeze([...ZONES[z]])])),
  ),
  safeBox: Object.freeze([...SAFE_POS]),
  guardBase: Object.freeze([...ROBOT_POS]),
  distanceToGuard: Object.freeze(
    Object.fromEntries(ROOM_ZONES.map((z) => [z, meters(ZONES[z], ROBOT_POS)])),
  ),
  distanceToSafeBox: Object.freeze(
    Object.fromEntries(ROOM_ZONES.map((z) => [z, meters(ZONES[z], SAFE_POS)])),
  ),
});
