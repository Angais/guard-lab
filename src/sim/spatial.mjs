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
