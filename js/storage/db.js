// IndexedDB wrapper. Schema: DESIGN.md §6.

const DB_NAME = 'guitar-practice';
const DB_VERSION = 1;

let dbPromise = null;

export function openDB() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const ensure = (name, opts) => db.objectStoreNames.contains(name) || db.createObjectStore(name, opts);
      ensure('scores', { keyPath: 'id' });
      ensure('scoreMaps', { keyPath: 'pdfHash' });
      ensure('recordings', { keyPath: 'id' });
      ensure('pcmChunks', { keyPath: ['recordingId', 'index'] });
      ensure('settings', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => console.warn('IndexedDB upgrade blocked by another tab');
  });
  return dbPromise;
}

async function run(storeName, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const req = fn(tx.objectStore(storeName));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

export const get = (store, key) => run(store, 'readonly', (s) => s.get(key));
export const getAll = (store, query) => run(store, 'readonly', (s) => s.getAll(query));
export const put = (store, value) => run(store, 'readwrite', (s) => s.put(value));
export const del = (store, key) => run(store, 'readwrite', (s) => s.delete(key));

export const isQuotaError = (e) => e?.name === 'QuotaExceededError';

// Settings are loaded once at startup and then read synchronously.
const cache = new Map();

export const settings = {
  async load() {
    try {
      for (const row of await getAll('settings')) cache.set(row.key, row.value);
    } catch (e) {
      console.warn('Could not load settings', e);
    }
  },
  get(key, fallback) {
    return cache.has(key) ? cache.get(key) : fallback;
  },
  set(key, value) {
    cache.set(key, value);
    return put('settings', { key, value }).catch((e) => console.warn('Could not save setting', key, e));
  },
};

export async function requestPersistence() {
  if (!navigator.storage?.persist) return false;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}
