// Presentation pacing only. Rendering stays close to 60 fps in step with the
// display refresh, and the drawing buffer shrinks when the GPU cannot keep up.
// Nothing here affects turn timing: animation progress is measured in real time.
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
};

// Render every Nth display refresh so frames stay evenly spaced: 144 Hz renders
// at 72 fps and 75 Hz at 75 fps, instead of alternating two and three refreshes.
export function createFrameGate({ target = 60, hiddenInterval = 125, history = 32 } = {}) {
  const deltas = [];
  let lastTick = 0,
    lastFrame = -Infinity,
    ticks = 0,
    refresh = 1000 / target;
  return {
    get refreshInterval() {
      return refresh;
    },
    get skip() {
      return Math.max(1, Math.floor((1000 / target + 1) / refresh));
    },
    tick(time, hidden = false) {
      const delta = time - lastTick;
      lastTick = time;
      // Pauses and background throttling are not display refreshes.
      if (delta > 0 && delta < 250) {
        deltas.push(delta);
        if (deltas.length > history) deltas.shift();
        if (deltas.length >= 6) refresh = median(deltas);
      }
      if (hidden) {
        if (time - lastFrame < hiddenInterval) return false;
      } else if (++ticks < this.skip && time - lastFrame < 250) return false;
      ticks = 0;
      lastFrame = time;
      return true;
    },
  };
}

// Device pixels per CSS pixel. Large windows on dense displays stay within a
// fixed pixel budget; the governor can lower the cap further on slow GPUs.
export function scenePixelRatio(
  devicePixelRatio,
  width,
  height,
  { cap = 1.7, budget = 2.6e6, limit = Infinity } = {},
) {
  const device = Math.max(0.5, devicePixelRatio || 1);
  const fit = Math.sqrt(budget / Math.max(1, width * height));
  const ratio = Math.max(Math.min(device, 1), Math.min(device, cap, fit));
  return Math.max(0.5, Math.min(ratio, limit));
}

// Steps the resolution limit down after sustained slow frames. Each step needs
// two consecutive slow seconds, so one shader compile or stall never triggers it.
export function createQualityGovernor({
  limits = [Infinity, 1.25, 1],
  windowMs = 1000,
  slowMs = 20,
  warmupMs = 3000,
} = {}) {
  let level = 0,
    started = null,
    windowStart = null,
    slowWindows = 0,
    samples = [];
  return {
    get limit() {
      return limits[level];
    },
    get level() {
      return level;
    },
    // interval: time since the previously rendered frame; expected: the paced interval.
    sample(time, interval, expected = 1000 / 60) {
      started ??= time;
      if (time - started < warmupMs || !(interval > 0) || interval > 250) {
        samples = [];
        windowStart = null;
        return false;
      }
      windowStart ??= time;
      samples.push(interval);
      if (time - windowStart < windowMs) return false;
      const slow = median(samples) > Math.max(slowMs, expected * 1.3);
      samples = [];
      windowStart = time;
      slowWindows = slow ? slowWindows + 1 : 0;
      if (slowWindows < 2 || level >= limits.length - 1) return false;
      level++;
      slowWindows = 0;
      return true;
    },
  };
}
