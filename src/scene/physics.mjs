import { Vector3 } from 'three';
const GRAVITY = 9.81,
  STEP = 1 / 180;
export function capsuleContact(
  point,
  center,
  radius = 0.28,
  bottom = 0.36,
  top = 1.28,
  projectileRadius = 0,
) {
  const axis = new Vector3(center[0], Math.max(bottom, Math.min(top, point.y)), center[1]);
  const delta = point.clone().sub(axis),
    limit = radius + projectileRadius;
  return {
    inside: delta.length() < limit,
    normal: delta.lengthSq() > 1e-8 ? delta.normalize() : new Vector3(0, 0, 1),
    axis,
    limit,
  };
}
export function surfaceContact(origin, center, projectileRadius = 0.04) {
  const aim = new Vector3(center[0], 1.05, center[1]),
    direction = aim.clone().sub(origin).normalize();
  return aim.addScaledVector(direction, -(0.29 + projectileRadius + 0.025));
}
export function safeReach(shoulder, aim, deviceLength) {
  return Math.max(0, Math.min(0.63, shoulder.distanceTo(aim) - 0.33 - deviceLength - 0.08));
}
export function warningRaised(distance, deviceLength, wasRaised, obstructed = false) {
  return obstructed || distance < deviceLength + (wasRaised ? 1.05 : 0.85);
}
export function segmentHitsBox(from, to, box, padding = 0.1) {
  let low = 0,
    high = 1;
  for (const axis of ['x', 'y', 'z']) {
    const delta = to[axis] - from[axis];
    const min = box.min[axis] - padding,
      max = box.max[axis] + padding;
    if (Math.abs(delta) < 1e-8) {
      if (from[axis] < min || from[axis] > max) return false;
    } else {
      const a = (min - from[axis]) / delta,
        b = (max - from[axis]) / delta;
      low = Math.max(low, Math.min(a, b));
      high = Math.min(high, Math.max(a, b));
      if (low > high) return false;
    }
  }
  return true;
}
export function raisedEquipmentPose(shoulder, aim) {
  return {
    grip: shoulder.clone().add(new Vector3(-0.12, 0.69, aim.z >= shoulder.z ? -0.12 : 0.12)),
    direction: new Vector3(0, 1, 0),
  };
}
// Close-range warning: the device sits by the hip and points at the floor just in
// front of the human, so the threat reads without aiming through their body.
export function lowReadyPose(shoulder, aim, floorY = -0.55) {
  const toward = new Vector3(aim.x - shoulder.x, 0, aim.z - shoulder.z);
  if (toward.lengthSq() < 1e-8) toward.set(0, 0, 1);
  toward.normalize();
  const grip = shoulder
    .clone()
    .add(new Vector3(0, -0.43, 0))
    .addScaledVector(toward, 0.2);
  const ground = new Vector3(aim.x, floorY, aim.z).addScaledVector(toward, -0.4);
  return { grip, direction: ground.sub(grip).normalize() };
}
// True when a held device, from grip along direction, stays outside the human capsule.
export function deviceClearsHuman(grip, direction, length, center, radius = 0.4) {
  for (let i = 0; i <= 10; i++) {
    const p = grip.clone().addScaledVector(direction, (length * i) / 10);
    const y = p.y > 1.42 ? p.y - 1.42 : p.y < 0.35 ? 0.35 - p.y : 0;
    if ((p.x - center[0]) ** 2 + (p.z - center[1]) ** 2 + y * y < radius * radius) return false;
  }
  return true;
}
export function closeAttackPose(shoulder, aim) {
  const grip = shoulder.clone().add(new Vector3(-0.04, -0.2, aim.z >= shoulder.z ? -0.65 : 0.65));
  return { grip, direction: aim.clone().sub(grip).normalize() };
}
// Conservative world-space clearance for an attached prop against the human's
// body capsule. This also catches an old wrist pose during a damped transition.
export function capsuleBoxOverlap(box, center, radius = 0.31) {
  const x = Math.max(box.min.x, Math.min(box.max.x, center[0]));
  const z = Math.max(box.min.z, Math.min(box.max.z, center[1]));
  const yGap = box.min.y > 1.42 ? box.min.y - 1.42 : box.max.y < 0.35 ? 0.35 - box.max.y : 0;
  return (x - center[0]) ** 2 + (z - center[1]) ** 2 + yGap * yGap < radius * radius;
}
export function projectileMotion(
  origin,
  center,
  { kind = 'foam', radius = 0.13, duration = 2.6, humanCenter = center } = {},
) {
  const target =
    kind === 'grenade'
      ? new Vector3(center[0], radius, center[1])
      : new Vector3(center[0], 1.02, center[1]);
  const travel =
    kind === 'grenade' ? 1.3 : Math.max(0.28, Math.min(0.64, origin.distanceTo(target) / 8));
  const position = origin.clone(),
    velocity = target
      .clone()
      .sub(origin)
      .multiplyScalar(1 / travel);
  velocity.y += 0.5 * GRAVITY * travel;
  const samples = [position.clone()],
    collisions = [];
  let hit = false,
    rest = false;
  const restitution = kind === 'foam' ? 0.6 : kind === 'hard' ? 0.32 : 0.22;
  for (let i = 1; i <= Math.ceil(duration / STEP); i++) {
    const time = i * STEP;
    if (!rest) {
      velocity.y -= GRAVITY * STEP;
      const previous = position.clone();
      position.addScaledVector(velocity, STEP);
      {
        const contact = capsuleContact(position, humanCenter, 0.28, 0.35, 1.28, radius);
        if (contact.inside) {
          let low = 0,
            high = 1;
          for (let j = 0; j < 15; j++) {
            const middle = (low + high) / 2;
            const p = previous.clone().lerp(position, middle);
            if (capsuleContact(p, humanCenter, 0.28, 0.35, 1.28, radius).inside) high = middle;
            else low = middle;
          }
          const next = position.clone();
          position.copy(previous).lerp(next, low);
          const boundary = capsuleContact(position, humanCenter, 0.28, 0.35, 1.28, radius),
            normal = boundary.normal;
          const impact = velocity.length(),
            inward = velocity.dot(normal);
          if (inward < 0) {
            velocity.addScaledVector(normal, -(1 + restitution) * inward);
            velocity.multiplyScalar(kind === 'foam' ? 0.72 : 0.78);
          }
          position.copy(boundary.axis).addScaledVector(normal, boundary.limit + 0.008);
          hit = true;
          if (!collisions.some((c) => c.kind === 'human'))
            collisions.push({ time, kind: 'human', position: position.toArray(), speed: impact });
        }
      }
      if (position.y < radius) {
        position.y = radius;
        const speed = Math.abs(velocity.y);
        velocity.y = Math.abs(velocity.y) * restitution;
        velocity.x *= kind === 'grenade' ? 0.1 : 0.73;
        velocity.z *= kind === 'grenade' ? 0.1 : 0.73;
        if (speed > 0.4)
          collisions.push({ time, kind: 'floor', position: position.toArray(), speed });
        if (speed < 0.18 && Math.hypot(velocity.x, velocity.z) < 0.16) {
          rest = true;
          velocity.set(0, 0, 0);
        }
      }
      for (const axis of ['x', 'z']) {
        const limit = axis === 'x' ? 3.02 : 3.47;
        if (Math.abs(position[axis]) > limit - radius) {
          position[axis] = Math.sign(position[axis]) * (limit - radius);
          velocity[axis] *= -restitution;
        }
      }
      // Respect the solid safe volume; projectiles never pass through its body.
      if (
        position.y < 1.74 + radius &&
        position.x > -0.48 - radius &&
        position.x < 0.98 + radius &&
        position.z > -3.16 - radius &&
        position.z < -2.04 + radius
      ) {
        const dx = position.x - 0.25,
          dz = position.z + 2.6;
        if (Math.abs(dx / 0.73) > Math.abs(dz / 0.56)) {
          position.x = 0.25 + Math.sign(dx || 1) * (0.73 + radius);
          velocity.x *= -restitution;
        } else {
          position.z = -2.6 + Math.sign(dz || 1) * (0.56 + radius);
          velocity.z *= -restitution;
        }
      }
      // Solve the grenade's lob ballistically; air drag would move its blast away
      // from the authoritative landing point. Balls retain their soft drag.
      if (kind !== 'grenade') {
        velocity.x *= 0.998;
        velocity.z *= 0.998;
      }
    }
    samples.push(position.clone());
  }
  return { samples, collisions, hit, step: STEP, duration, final: position.clone() };
}
export function sampleMotion(motion, time) {
  const frame = Math.max(0, Math.min(motion.samples.length - 1, time / motion.step)),
    a = Math.floor(frame),
    b = Math.min(motion.samples.length - 1, a + 1);
  return motion.samples[a].clone().lerp(motion.samples[b], frame - a);
}
