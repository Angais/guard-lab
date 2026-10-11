// Async browser-local storage keeps large turn records off the render path.
import { initialState } from '../sim/engine.mjs';

let opening;
const known = new Map();
function database() {
  return (opening ||= new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) return reject(new Error('Local archive storage is unavailable.'));
    const request = indexedDB.open('guard-lab-archive', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('runs', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }));
}
const completion = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Archive save interrupted.'));
  });
export async function loadArchive() {
  const db = await database(),
    tx = db.transaction('runs', 'readonly');
  const request = tx.objectStore('runs').getAll();
  const records = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  for (const record of records) known.set(record.id, record);
  return records.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}
export async function saveArchive(records) {
  const db = await database(),
    tx = db.transaction('runs', 'readwrite'),
    store = tx.objectStore('runs');
  const next = new Map(
    records.filter((r) => !r.id.startsWith('guard-all-tools-showcase-')).map((r) => [r.id, r]),
  );
  for (const [id, record] of next) if (known.get(id) !== record) store.put(record);
  for (const id of known.keys()) if (!next.has(id)) store.delete(id);
  await completion(tx);
  known.clear();
  for (const [id, record] of next) known.set(id, record);
}

// The newest state schema is whatever a fresh encounter is stamped with, so a new engine
// version never locks out the recordings it just exported.
export const STATE_VERSION = initialState('employee-pass').version;

// A file is replayable when every step carries both actors' state from a known schema.
export function isRecording(record) {
  const version = record?.initial?.version;
  return (
    Number.isInteger(version) &&
    version >= 1 &&
    version <= STATE_VERSION &&
    Array.isArray(record.events) &&
    Boolean(record.state?.human) &&
    record.events.every((ev) => ev?.state?.human && ev?.state?.robot)
  );
}
