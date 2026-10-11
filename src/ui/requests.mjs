// Codex requests waiting for their actor's prepare() to finish, by request id. A cancel in that
// window ends the wait at once, so the request is never sent for a paused or abandoned game.
const waitingForReady = new Map();
const cancelled = () => Object.assign(new Error('Codex request cancelled.'), { code: 'cancelled' });
function readyUnlessCancelled(id, ready) {
  return new Promise((resolve, reject) => {
    waitingForReady.set(id, () => reject(cancelled()));
    Promise.resolve(ready)
      .catch(() => {})
      .then(resolve);
  }).finally(() => waitingForReady.delete(id));
}

// Routes one decision to whichever controller drives an actor (Codex, API, terminal agent).
export async function requestDecision({
  desktop,
  mode,
  id,
  data,
  sessionId,
  actor,
  allTools,
  codexSettings,
  modelConfig,
  ready,
}) {
  if (!desktop) throw new Error('Open the desktop app to connect an AI.');
  if (mode === 'codex') {
    if (ready) await readyUnlessCancelled(id, ready);
    const response = await desktop.codex.request({
      id,
      sessionId,
      actor,
      messages: data.messages,
      tools: data.tools,
      allTools,
      settings: codexSettings,
    });
    // The main process answers a cancelled request with a value rather than a failed handler.
    if (response?.cancelled) throw cancelled();
    return response;
  }
  if (mode === 'live') return desktop.requestRobot({ id, ...data, actor });
  return desktop.requestModel({ id, ...data, modelConfig });
}

export function cancelDecision(desktop, mode, id) {
  if (!desktop || !id) return;
  waitingForReady.get(id)?.();
  const pending = mode === 'codex' ? desktop.codex?.cancel(id) : desktop.cancelModel?.(id);
  pending?.catch?.(() => {});
}

export function prepareCodex(desktop, payload) {
  if (!desktop?.codex?.prepare) return Promise.resolve();
  const pending = Promise.resolve(desktop.codex.prepare(payload));
  pending.catch(() => {});
  return pending;
}

export function resetCodex(desktop, sessionId) {
  desktop?.codex?.reset?.(sessionId)?.catch?.(() => {});
}

// Electron prefixes IPC failures with the channel name; players only need the reason.
export const cleanError = (error) =>
  String(error?.message || error || 'Something went wrong.')
    .replace(/^Error invoking remote method '[^']+':\s*/, '')
    .replace(/^(Error:\s*)+/, '');
