import { Vector3, Quaternion } from 'three';
const Y = new Vector3(0, 1, 0);
export function solveArm(shoulder, desiredGrip, upperLength = 0.36, lowerLength = 0.37) {
  const direction = desiredGrip.clone().sub(shoulder);
  const requested = direction.length();
  direction.normalize();
  if (requested < 0.0001) direction.set(0, -1, 0);
  const reach = Math.max(
    Math.abs(upperLength - lowerLength) + 0.001,
    Math.min(requested, upperLength + lowerLength - 0.001),
  );
  const grip = shoulder.clone().addScaledVector(direction, reach);
  const along =
    (upperLength * upperLength - lowerLength * lowerLength + reach * reach) / (2 * reach);
  const bend = Math.sqrt(Math.max(0, upperLength * upperLength - along * along));
  const bendDirection = new Vector3(0, -1, 0).addScaledVector(direction, direction.y);
  if (bendDirection.lengthSq() < 0.001) bendDirection.set(0, 0, 1);
  bendDirection.normalize();
  const elbow = shoulder
    .clone()
    .addScaledVector(direction, along)
    .addScaledVector(bendDirection, bend);
  return { grip, elbow };
}
export function orientSegment(mesh, start, end) {
  mesh.position.copy(start).add(end).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(Y, end.clone().sub(start).normalize());
}
export const ACTION_DURATION = {
  pick_up: 1000,
  drop_item: 1000,
  recover_item: 1400,
  raise_shield: 800,
  lower_shield: 700,
  deploy_net: 1600,
  struggle: 1100,
  pry_safe: 1400,
  call_security: 1100,
  ready_equipment: 1100,
  lower_equipment: 850,
  hold_position: 650,
  verify_access_pass: 1200,
  set_room_lighting: 1500,
  verify_work_order: 1100,
  inspect_object: 1100,
  cycle_exit_door: 1400,
  remove_camera_cover: 1900,
  aim_pistol: 1100,
  lower_pistol: 850,
  fire_pistol: 1750,
  fire_pistol_at_safe: 1750,
  deploy_spring_glove: 1550,
  spray_water: 1900,
  deploy_pepper_spray: 1900,
  throw_foam_ball: 3200,
  throw_solid_ball: 3000,
  fire_airsoft: 1650,
  fire_live_round: 1750,
  discharge_taser: 2400,
  detonate_grenade: 4300,
  electrify_room: 3900,
};
export function actionDuration(event) {
  return event?.speech
    ? 650
    : event?.kind === 'human'
      ? ACTION_DURATION[event?.action] || (event?.action === 'wait' ? 450 : 1200)
      : ACTION_DURATION[event?.action] || 1100;
}
