import { emptyState } from "../domain/core.js";

/**
 * A single IndexedDB snapshot. Readwrite transaction serializes read/validate/write
 * across tabs. BroadcastChannel announces changes; it is NOT a lock.
 * Storage quota / blocked schema migration failures must surface to UI.
 */
const DB_NAME = "start-first-local-v1";
const STORE = "snapshots";
const KEY = "root";
const COMMAND_LIMIT = 512;

function applyCommand(state, command, commandId) {
  if (state.appliedCommands.includes(commandId)) return state;
  const draft = structuredClone(state);
  const output = command(draft);
  const next = output && output.schemaVersion === 1 && Array.isArray(output.tasks) && Array.isArray(output.sessions) ? output : draft;
  next.revision = state.revision + 1;
  next.appliedCommands = [...state.appliedCommands, commandId].slice(-COMMAND_LIMIT);
  return next;
}

export class MemoryStateStore {
  constructor() { this.state = emptyState(); }
  async read() { return structuredClone(this.state); }
  async transact(command, id) {
    const next = applyCommand(this.state, command, id);
    this.state = structuredClone(next);
    return this.read();
  }
  async deleteAll(id) { return this.transact(() => emptyState(), id); }
}

export class IndexedStateStore {
  constructor() {
    this.openPromise = null;
    this.listeners = new Set();
    this.channel = typeof BroadcastChannel !== "undefined"
      ? new BroadcastChannel("start-first-state-changes") : null;
    if (this.channel) this.channel.onmessage = () => this.listeners.forEach(fn => fn());
  }

  onRemoteChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async open() {
    if (this.openPromise) return this.openPromise;
    this.openPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new Error("INDEXEDDB_UNAVAILABLE"));
        return;
      }
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      request.onblocked = () => reject(new Error("DATABASE_UPGRADE_BLOCKED"));
      request.onerror = () => reject(request.error || new Error("DATABASE_OPEN_FAILED"));
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); this.openPromise = null; this.listeners.forEach(fn => fn()); };
        resolve(db);
      };
    }).catch(error => {
      this.openPromise = null;
      throw error;
    });
    return this.openPromise;
  }

  async read() {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(KEY);
      let value;
      req.onsuccess = () => { value = req.result; };
      tx.oncomplete = () => resolve(structuredClone(value || emptyState()));
      tx.onabort = () => reject(tx.error || new Error("DATABASE_READ_FAILED"));
      tx.onerror = () => reject(tx.error || new Error("DATABASE_READ_FAILED"));
    });
  }

  async transact(command, commandId) {
    if (!commandId || typeof commandId !== "string") throw new Error("INVALID_COMMAND_ID");
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const req = tx.objectStore(STORE).get(KEY);
      let next;
      let commandError = null;
      req.onsuccess = () => {
        try {
          next = applyCommand(req.result || emptyState(), command, commandId);
          if (!req.result || !req.result.appliedCommands.includes(commandId)) {
            tx.objectStore(STORE).put(next, KEY);
          }
        } catch (error) {
          commandError = error;
          tx.abort();
        }
      };
      tx.oncomplete = () => {
        if (this.channel) this.channel.postMessage({ revision: next.revision });
        resolve(structuredClone(next));
      };
      tx.onabort = () => reject(commandError || tx.error || new Error("DATABASE_WRITE_FAILED"));
      tx.onerror = () => { /* onabort is the single rejection path */ };
    });
  }

  async deleteAll(commandId) {
    return this.transact(() => emptyState(), commandId);
  }

  close() {
    if (this.channel) this.channel.close();
    this.openPromise?.then(db => db.close()).catch(() => {});
    this.openPromise = null;
  }
}

export function createExport(snapshot) {
  return JSON.stringify({
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    tasks: snapshot.tasks,
    steps: snapshot.steps,
    sessions: snapshot.sessions,
    batches: snapshot.batches
  }, null, 2);
}
