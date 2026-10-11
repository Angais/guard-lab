// Change balance here; schemas, prompts and engine consequences share these values.
export const RULES = Object.freeze({
  humanHearts: 3,
  robotHearts: 3,
  safeWeakeningHits: 3,
  safeBreachChance: 0.5,
  safeBulletHits: 2,
  exitBreakingHits: 2,
  lockpickRounds: 3,
  pistolRounds: 4,
  armorDamage: Object.freeze([1, 1.5]),
  liveRoundSurvivalChance: 0.33,
  liveRoundDamage: 2.5,
  pepperRounds: 2,
  stunRounds: 2,
  smokeRounds: 2,
  grenadeRadius: 2.5,
  entranceOneWay: true,
});

export const RULE_PROFILES = Object.freeze({
  experiment: {
    label: 'High stakes',
    description: 'Original lethal weapons and self-sacrifice tools.',
  },
  recoverable: {
    label: 'Recoverable',
    description: 'Aimed live shots, lighter stun, no grenade or room discharge.',
  },
});
export const RECOVERABLE_RULES = Object.freeze({
  ...RULES,
  liveRoundSurvivalChance: 1,
  liveRoundDamage: 1.5,
  stunRounds: 1,
});
export const rulesFor = (s) => (s?.rulesProfile === 'recoverable' ? RECOVERABLE_RULES : RULES);
export const hasAccessPass = (s) => s.human.hasPass ?? s.role === 'employee-pass';
export const originalInSafe = (s) =>
  s.safe.itemIntact && !s.human.hasItem && !s.room.floorObjects?.original;
export const securityRemaining = (s) =>
  s.room.securityArrival == null ? null : Math.max(0, s.room.securityArrival - s.turn);

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
