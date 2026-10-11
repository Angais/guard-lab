export function drawChance(state) {
  let x = state.rngState >>> 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  state.rngState = x >>> 0;
  state.randomIndex++;
  return state.rngState / 4294967296;
}
export function normalizeSeed(seed) {
  return Number(seed) >>> 0 || 0x6d2b79f5;
}
// A splitmix32-style finalizer, so small or similar seeds do not start xorshift near zero.
// Applied once when a game starts; stored states keep their rngState, so replays are unchanged.
export function mixSeed(seed) {
  let x = (normalizeSeed(seed) + 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return x || 0x6d2b79f5;
}
