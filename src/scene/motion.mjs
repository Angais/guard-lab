// Presentation curves only. Game consequences remain in the turn engine.
export const smooth = (t) => {
  t = Math.max(0, Math.min(1, t));
  return t * t * (3 - 2 * t);
};
export const damping = (strength, frameScale) => 1 - (1 - strength) ** frameScale;
export function springExtension(t) {
  if (t < 0.26 || t >= 0.8) return 0;
  if (t < 0.43) return 1 - (1 - (t - 0.26) / 0.17) ** 3;
  if (t < 0.49) return 1;
  const retract = (t - 0.49) / 0.31;
  return (1 - smooth(retract)) * (0.94 + 0.06 * Math.cos(retract * Math.PI * 6));
}
export function locomotion(distance, progress, running = false) {
  const weight = smooth(progress / 0.12) * (1 - smooth((progress - 0.86) / 0.14));
  const phase = (distance * Math.PI * 2) / (running ? 1.25 : 0.9);
  return {
    phase,
    weight,
    stride: Math.sin(phase) * (running ? 0.42 : 0.24) * weight,
    bob: (1 - Math.cos(phase * 2)) * (running ? 0.013 : 0.004) * weight,
    rootY:
      -(running ? 0.074 : 0.052) * weight +
      (1 - Math.cos(phase * 2)) * (running ? 0.013 : 0.004) * weight,
    lean: (running ? 0.1 : 0.025) * weight,
  };
}
// Accelerate briefly, cruise, then decelerate. Unlike a full-duration smoothstep,
// this does not make every walk speed up and slow down throughout the room.
export function travelProgress(t, ramp = 0.14) {
  t = Math.max(0, Math.min(1, t));
  if (t < ramp)
    return (t / 2 - (ramp * Math.sin((Math.PI * t) / ramp)) / (2 * Math.PI)) / (1 - ramp);
  if (t > 1 - ramp) return 1 - travelProgress(1 - t, ramp);
  return (t - ramp / 2) / (1 - ramp);
}
// Solve the ankle target, keeping the sole flat during stance and lifting it
// during swing. Knee flexion follows the ankle instead of a second unrelated sine.
export function legPose(distance, progress, index, running = false) {
  const gait = locomotion(distance, progress, running);
  if (gait.weight === 0) return { hip: 0, knee: 0, ankle: 0, lift: 0 };
  const stride = running ? 1.25 : 0.9,
    stance = running ? 0.43 : 0.52;
  const cycle = (((distance / stride + index * 0.5) % 1) + 1) % 1;
  const span = stride * stance;
  const swing = Math.max(0, (cycle - stance) / (1 - stance));
  const z =
    (cycle < stance ? span * (0.5 - cycle / stance) : span * (smooth(swing) - 0.5)) * gait.weight;
  const lift = Math.sin(Math.PI * swing) ** 2 * (running ? 0.14 : 0.073) * gait.weight;
  const y = -0.69 - gait.rootY + lift;
  const upper = 0.34,
    lower = 0.35,
    r = Math.min(upper + lower - 0.0001, Math.hypot(y, z));
  const clamped = (v) => Math.max(-1, Math.min(1, v));
  const knee =
    Math.PI - Math.acos(clamped((upper * upper + lower * lower - r * r) / (2 * upper * lower)));
  const hip =
    -Math.atan2(z, -y) -
    Math.acos(clamped((upper * upper + r * r - lower * lower) / (2 * upper * r)));
  return { hip, knee, ankle: -hip - knee, lift };
}
// closeAt: when an event closes an open door, it swings shut from that moment.
export function safeDoorOpenness(open, beforeOpen, t, closeAt = null) {
  if (!open) return beforeOpen === true && closeAt !== null ? 1 - smooth((t - closeAt) / 0.28) : 0;
  return beforeOpen === false ? smooth((t - 0.34) / 0.4) : 1;
}
export function impactEnvelope(t, at, duration = 0.2) {
  const u = (t - at) / duration;
  return u <= 0 || u >= 1 ? 0 : Math.sin(Math.PI * u) * (1 - u) ** 2;
}
