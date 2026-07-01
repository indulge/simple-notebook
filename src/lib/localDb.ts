// IndexedDB persistence layer for the offline-first notebook.
//
// Database "snb" v1 — four object stores:
//   notebooks  keyPath "name"     { name }
//   notes      keyPath "path"     { path, notebook, name, content, updatedAt, driveId }
//   metadata   keyPath "notebook" { notebook, titles, order, updated, driveMetaId }
//   syncQueue  keyPath "id" (auto){ op, path, notebook, name, content?, driveId?, updatedAt }
//
// The module opens the connection lazily on first call and reuses it.

const DB_NAME = 'snb';
const DB_VERSION = 1;

export interface LocalNote {
  path: string;        // "docs/<notebook>/<file>.md" — primary key
  notebook: string;
  name: string;        // "<file>.md"
  content: string;
  updatedAt: number;
  driveId: string | null;  // Drive file ID; null until first successful Drive write
}

export interface LocalMeta {
  notebook: string;    // primary key
  titles: Record<string, string>;
  order: string[];
  updated: Record<string, number>;
  tags?: Record<string, string[]>; // optional: rows written before tags existed lack it
  driveMetaId: string | null; // Drive file ID of _metadata.json
}

export interface SyncQueueItem {
  id?: number;         // auto-increment
  op: 'upsert' | 'delete' | 'deleteNotebook';
  path: string;        // note path, or "notebook:<name>" for deleteNotebook
  notebook: string;
  name: string;
  content?: string;
  driveId?: string | null;
  updatedAt: number;
}

function idbOpen(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('notebooks')) {
        d.createObjectStore('notebooks', { keyPath: 'name' });
      }
      if (!d.objectStoreNames.contains('notes')) {
        const s = d.createObjectStore('notes', { keyPath: 'path' });
        s.createIndex('by_notebook', 'notebook');
      }
      if (!d.objectStoreNames.contains('metadata')) {
        d.createObjectStore('metadata', { keyPath: 'notebook' });
      }
      if (!d.objectStoreNames.contains('syncQueue')) {
        d.createObjectStore('syncQueue', { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let _dbPromise: Promise<IDBDatabase> | null = null;
const getDb = (): Promise<IDBDatabase> => (_dbPromise ??= idbOpen());

function rget<T>(store: string, key: IDBValidKey): Promise<T | null> {
  return getDb().then(db => new Promise((resolve, reject) => {
    const r = db.transaction(store).objectStore(store).get(key);
    r.onsuccess = () => resolve((r.result as T) ?? null);
    r.onerror = () => reject(r.error);
  }));
}

function rgetAll<T>(store: string): Promise<T[]> {
  return getDb().then(db => new Promise((resolve, reject) => {
    const r = db.transaction(store).objectStore(store).getAll();
    r.onsuccess = () => resolve(r.result as T[]);
    r.onerror = () => reject(r.error);
  }));
}

function rgetByIndex<T>(store: string, index: string, key: IDBValidKey): Promise<T[]> {
  return getDb().then(db => new Promise((resolve, reject) => {
    const r = db.transaction(store).objectStore(store).index(index).getAll(key);
    r.onsuccess = () => resolve(r.result as T[]);
    r.onerror = () => reject(r.error);
  }));
}

function rput(store: string, value: unknown): Promise<IDBValidKey> {
  return getDb().then(db => new Promise((resolve, reject) => {
    const r = db.transaction(store, 'readwrite').objectStore(store).put(value);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}

function rdel(store: string, key: IDBValidKey): Promise<void> {
  return getDb().then(db => new Promise((resolve, reject) => {
    const r = db.transaction(store, 'readwrite').objectStore(store).delete(key);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  }));
}

function rclear(store: string): Promise<void> {
  return getDb().then(db => new Promise((resolve, reject) => {
    const r = db.transaction(store, 'readwrite').objectStore(store).clear();
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  }));
}

export const localDb = {
  // ── Notebooks ──────────────────────────────────────────────────────────────

  async getNotebooks(): Promise<string[]> {
    const rows = await rgetAll<{ name: string }>('notebooks');
    return rows.map(r => r.name);
  },

  putNotebook: (name: string) => rput('notebooks', { name }),

  async deleteNotebook(name: string): Promise<void> {
    await rdel('notebooks', name);
    const notes = await localDb.getNotes(name);
    await Promise.all(notes.map(n => rdel('notes', n.path)));
    await rdel('metadata', name);
  },

  // ── Notes ──────────────────────────────────────────────────────────────────

  getNotes: (notebook: string) => rgetByIndex<LocalNote>('notes', 'by_notebook', notebook),

  getNote: (path: string) => rget<LocalNote>('notes', path),

  putNote: (note: LocalNote) => rput('notes', note).then(() => {}),

  deleteNote: (path: string) => rdel('notes', path),

  // ── Metadata ───────────────────────────────────────────────────────────────

  getMetadata: (notebook: string) => rget<LocalMeta>('metadata', notebook),

  getAllMetadata: () => rgetAll<LocalMeta>('metadata'),

  putMetadata: (meta: LocalMeta) => rput('metadata', meta).then(() => {}),

  deleteMetadata: (notebook: string) => rdel('metadata', notebook),

  // ── Sync queue ─────────────────────────────────────────────────────────────

  // A new item supersedes any queued item for the same path — the queue holds
  // at most one pending operation per path, always the latest.
  async enqueue(item: Omit<SyncQueueItem, 'id'>): Promise<void> {
    const all = await rgetAll<SyncQueueItem>('syncQueue');
    await Promise.all(
      all.filter(q => q.path === item.path && q.id != null).map(q => rdel('syncQueue', q.id!)),
    );
    await rput('syncQueue', item);
  },

  getQueue: () => rgetAll<SyncQueueItem>('syncQueue'),

  dequeue: (id: number) => rdel('syncQueue', id),

  // Drop queued work for a notebook (used before queueing its deletion).
  async removeQueuedForNotebook(notebook: string): Promise<void> {
    const all = await rgetAll<SyncQueueItem>('syncQueue');
    await Promise.all(
      all.filter(q => q.notebook === notebook && q.id != null).map(q => rdel('syncQueue', q.id!)),
    );
  },

  clearQueue: () => rclear('syncQueue'),
};
