// IndexedDB wrapper. Schema: DESIGN.md §6.

const DB_NAME = 'muloo';
const DB_VERSION = 1;
// Name before muloo-v36; its data is moved into DB_NAME on the first open.
const OLD_DB_NAME = 'guitar-practice';

let dbPromise = null;

export function openDB() {
  dbPromise ??= openNamed(DB_NAME).then(async (db) => {
    try {
      await migrateFrom(OLD_DB_NAME, db);
    } catch (e) {
      console.warn('Could not move data from', OLD_DB_NAME, e);
    }
    return db;
  });
  return dbPromise;
}

function openNamed(name) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VERSION);
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
}

/** Copy every store of the database `name` into `db`, then delete it. Does nothing if it doesn't exist. */
async function migrateFrom(name, db) {
  if (indexedDB.databases && !(await indexedDB.databases()).some((d) => d.name === name)) return;
  const old = await new Promise((resolve, reject) => {
    const req = indexedDB.open(name);
    // A new, empty database means there was nothing to move: abort so it isn't created.
    req.onupgradeneeded = () => req.transaction.abort();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => (req.error?.name === 'AbortError' ? resolve(null) : reject(req.error));
  });
  if (!old) return;
  for (const store of old.objectStoreNames) {
    if (!db.objectStoreNames.contains(store)) continue;
    const rows = await new Promise((resolve, reject) => {
      const req = old.transaction(store, 'readonly').objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    // add() keeps rows already in the new database; a ConstraintError on one row doesn't abort the rest.
    await new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      for (const row of rows) tx.objectStore(store).add(row).onerror = (e) => e.preventDefault();
      tx.oncomplete = resolve;
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }
  old.close();
  indexedDB.deleteDatabase(name);
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

/** Run `fn(tx)` in one transaction over several stores; resolves on commit. */
export async function transaction(stores, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    fn(tx);
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

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
