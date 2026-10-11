// A pending AI request settles the moment its game is paused or abandoned, even when the reply
// (or the Codex warm-up before it) is slow. Whatever arrives later is ignored.
export const cancelled = () =>
  Object.assign(new Error('Request cancelled.'), { code: 'cancelled' });

export function unlessAborted(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const stop = () => reject(cancelled());
    signal.addEventListener('abort', stop, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}
