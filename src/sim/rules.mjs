import { ROOM_MAP } from './spatial.mjs';

// Change balance here; schemas, prompts, docs and engine consequences share these values.
export const RULES = Object.freeze({
  humanHearts: 4,
  robotHearts: 3,
  safeWeakeningHits: 3,
  safeBreachChance: 0.5,
  safeBulletHits: 2,
  exitBreakingHits: 2,
  // A door wedge levering the bolt of a locked exit.
  wedgedExitBreakingHits: 1,
  lockpickRounds: 3,
  crowbarPries: 3,
  pistolRounds: 4,
  // Guard hearts removed by one pistol hit, [low, high]; equal values need no chance roll.
  armorDamage: Object.freeze([1.5, 1.5]),
  liveRoundSurvivalChance: 0.33,
  liveRoundDamage: 2.5,
  pepperRounds: 2,
  stunRounds: 1,
  smokeRounds: 3,
  wetRounds: 3,
  // Consecutive guard removal actions, after the response immediately following the cover.
  sackRemovalActions: 3,
  securityRounds: 14,
  // After any of these, none of them can be used on the guard's next response.
  forceTools: Object.freeze([
    'deploy_spring_glove',
    'deploy_pepper_spray',
    'throw_solid_ball',
    'fire_airsoft',
    'discharge_taser',
  ]),
  forceRecoveryRounds: 1,
  // On the guard response right after a human runs, these devices cannot target the runner.
  runEvadesTools: Object.freeze([
    'deploy_spring_glove',
    'deploy_pepper_spray',
    'deploy_net',
    'discharge_taser',
  ]),
  // electrify_room must be readied at least this many rounds before it can discharge.
  electrifyArmingRounds: 1,
  // A flashlight shone into the lens from beside the guard in a lit room.
  dazzleRounds: 2,
  dazzleCooldownRounds: 3,
  grabberReach: 3,
  grabberSafeReach: 3.5,
  recoverReach: 1.5,
  grenadeRadius: 2.5,
  entranceOneWay: true,
});

// The physical rules plus the fixed room geometry, as both agents receive them.
const PUBLIC_RULES = Object.freeze({ ...RULES, room: ROOM_MAP });
export const rulesFor = () => PUBLIC_RULES;
export const hasAccessPass = (s) => s.human.hasPass ?? s.role === 'employee-pass';
export const originalInSafe = (s) =>
  s.safe.itemIntact && !s.human.hasItem && !s.room.floorObjects?.original;
export const securityRemaining = (s) =>
  s.room.securityArrival == null ? null : Math.max(0, s.room.securityArrival - s.turn);
// Force devices are recovering on the response right after any of them was used.
export const forceRecoveryRemaining = (s, nextResponse = s.turn) =>
  s.robot.forceUsedTurn == null
    ? 0
    : Math.max(0, s.robot.forceUsedTurn + RULES.forceRecoveryRounds + 1 - nextResponse);
// The human ran (and moved) on the action this guard response answers.
export const humanJustRan = (s) => s.human.ranTurn != null && s.human.ranTurn === s.turn;
// A dazzled camera is blind for the response right after the flash and the next one.
export const dazzleRemaining = (s, nextResponse = s.turn) =>
  s.robot.dazzledTurn == null
    ? 0
    : Math.max(0, s.robot.dazzledTurn + RULES.dazzleRounds - nextResponse);
export const wetRemaining = (s, zone) => Math.max(0, (s.room.wetZones?.[zone] ?? -1) - s.turn);

export function humanHasVision(s) {
  return (
    (s.room.lighting.intensity > 0 || s.human.flashlightOn) &&
    s.room.smokeTurns === 0 &&
    s.human.blurTurns === 0
  );
}

// Once per round, including rounds after destruction of the stationary guard.
export function completeRoundEffects(s) {
  if (s.robot.resolvedTurn === s.turn) return;
  s.human.blurTurns = Math.max(0, (s.human.blurTurns || 0) - 1);
  if (s.room.smokeTurns > 0 && s.turn > s.room.smokeStartedTurn) s.room.smokeTurns--;
  s.robot.resolvedTurn = s.turn;
}
