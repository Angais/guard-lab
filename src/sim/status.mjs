import { RULES } from './rules.mjs';
export const safeDamage = (s) =>
  s.safe.broken === true ||
  s.safe.pistolHits >= RULES.safeBulletHits ||
  (s.safe.broken === undefined && s.safe.open && s.safe.hits > RULES.safeWeakeningHits)
    ? 100
    : Math.min(
        95,
        Math.max(
          ((s.safe.hits || 0) / (RULES.safeWeakeningHits + 1)) * 100,
          ((s.safe.pryHits || 0) / RULES.crowbarPries) * 100,
          ((s.safe.pistolHits || 0) / RULES.safeBulletHits) * 100,
        ),
      );
export const doorDamage = (s) =>
  s.room.exitDoor.broken
    ? 100
    : Math.min(100, ((s.room.exitDoor.hits || 0) / RULES.exitBreakingHits) * 100);
