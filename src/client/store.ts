// Minimal IndexedDB wrapper. Everything a tutor enters is written here first,
// so nothing is lost if the phone has no signal or the app is closed.

type StoreName = 'kv' | 'sessions' | 'queue';

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('sts-portal', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('kv');
      db.createObjectStore('sessions', { keyPath: 'client_uuid' });
      db.createObjectStore('queue', { keyPath: 'seq', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run<T>(
  store: StoreName,
  mode: IDBTransactionMode,
  op: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    // Strict durability: resolve only once the write is on disk.
    const tx = db.transaction(store, mode, { durability: 'strict' });
    const req = op(tx.objectStore(store));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const kvGet = <T>(key: string) => run<T | undefined>('kv', 'readonly', (s) => s.get(key));
export const kvSet = (key: string, value: unknown) => run('kv', 'readwrite', (s) => s.put(value, key));
export const get = <T>(store: StoreName, key: IDBValidKey) =>
  run<T | undefined>(store, 'readonly', (s) => s.get(key));
export const getAll = <T>(store: StoreName) => run<T[]>(store, 'readonly', (s) => s.getAll());
export const put = (store: StoreName, value: unknown) => run(store, 'readwrite', (s) => s.put(value));
export const remove = (store: StoreName, key: IDBValidKey) =>
  run(store, 'readwrite', (s) => s.delete(key));
