// Screen-wide overlays (smoke, blurred vision, blackout) follow the moment that causes them.
import { useEffect, useState } from 'react';
import { actionDuration } from '../scene/rig.mjs';

// How far into each event's animation its effect lands: the capsule bursts, the spray hits.
const IMPACT = { use_smoke: 0.5, deploy_pepper_spray: 0.45, set_room_lighting: 0.35 };

export const overlayFlags = (s) => ({
  blurred: (s?.human?.blurTurns || 0) > 0,
  dark: s?.room?.lighting?.intensity === 0 && !s?.human?.flashlightOn,
  smoke: (s?.room?.smokeTurns || 0) > 0,
});

// Flags an event newly turns on still read from the moment before it, until its impact.
export function presentedFlags(state, event, impacted) {
  const after = overlayFlags(state);
  if (!event?.before || impacted) return after;
  const before = overlayFlags(event.before);
  return Object.fromEntries(Object.entries(after).map(([k, on]) => [k, on && before[k]]));
}

export const impactDelay = (event, speed = 1) =>
  (actionDuration(event) * (IMPACT[event?.action] ?? 0.5)) / Math.max(0.1, speed);

// Overlays only ever start late, never early: an event that clears them applies at once.
export function useOverlayFlags(state, event, speed = 1) {
  const [impacted, setImpacted] = useState(null);
  const flags = presentedFlags(state, event, impacted === event?.id);
  const after = overlayFlags(state);
  const waiting = Object.keys(after).some((k) => after[k] !== flags[k]);
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => setImpacted(event.id), impactDelay(event, speed));
    return () => clearTimeout(timer);
  }, [event?.id, waiting]);
  return flags;
}
