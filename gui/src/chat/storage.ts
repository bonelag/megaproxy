/**
 * Chat history persistence.
 *
 * IndexedDB, not localStorage: an attached screenshot is a base64 data URL,
 * which routinely exceeds the ~5 MB localStorage budget for the whole origin —
 * and a quota failure there is a thrown exception mid-send, i.e. a lost turn.
 * IDB also lets the rail read a small summary list without deserializing every
 * message body.
 *
 * Two object stores:
 *  - `conversations` — the full record, keyed by id.
 *  - `summaries`     — the rail's row (title/model/updatedAt/count), keyed by id,
 *                      indexed by `updatedAt` so the rail is a cursor walk.
 *
 * Everything degrades to an in-memory map when IDB is missing (SSR, tests,
 * private-mode lockdowns). History is a convenience, never a correctness
 * requirement: chatting must work even when nothing can be stored.
 */
import type { ChatConversation, ChatConversationSummary } from "./types";
import { summarizeConversation } from "./types";

const DB_NAME = "opencodex-chat";
const DB_VERSION = 1;
const STORE_CONVERSATIONS = "conversations";
const STORE_SUMMARIES = "summaries";

export interface ChatStore {
  listSummaries(): Promise<ChatConversationSummary[]>;
  get(id: string): Promise<ChatConversation | null>;
  put(conversation: ChatConversation): Promise<void>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
  /** True when writes actually persist; false for the in-memory fallback. */
  readonly durable: boolean;
}

function memoryStore(): ChatStore {
  const map = new Map<string, ChatConversation>();
  return {
    durable: false,
    async listSummaries() {
      return [...map.values()]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(summarizeConversation);
    },
    async get(id) {
      const found = map.get(id);
      return found ? structuredCloneSafe(found) : null;
    },
    async put(conversation) {
      map.set(conversation.id, structuredCloneSafe(conversation));
    },
    async remove(id) {
      map.delete(id);
    },
    async clear() {
      map.clear();
    },
  };
}

function structuredCloneSafe<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_CONVERSATIONS)) {
        db.createObjectStore(STORE_CONVERSATIONS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_SUMMARIES)) {
        const summaries = db.createObjectStore(STORE_SUMMARIES, { keyPath: "id" });
        summaries.createIndex("updatedAt", "updatedAt");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    request.onblocked = () => reject(new Error("IndexedDB open blocked"));
  });
}

function indexedDbStore(dbPromise: Promise<IDBDatabase>): ChatStore {
  async function tx<T>(
    stores: string[],
    mode: IDBTransactionMode,
    work: (transaction: IDBTransaction) => Promise<T>,
  ): Promise<T> {
    const db = await dbPromise;
    const transaction = db.transaction(stores, mode);
    const done = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
      transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    });
    const result = await work(transaction);
    await done;
    return result;
  }

  return {
    durable: true,
    async listSummaries() {
      const rows = await tx([STORE_SUMMARIES], "readonly", transaction =>
        promisifyRequest(transaction.objectStore(STORE_SUMMARIES).getAll() as IDBRequest<ChatConversationSummary[]>));
      return rows.sort((a, b) => b.updatedAt - a.updatedAt);
    },
    async get(id) {
      const row = await tx([STORE_CONVERSATIONS], "readonly", transaction =>
        promisifyRequest(transaction.objectStore(STORE_CONVERSATIONS).get(id) as IDBRequest<ChatConversation | undefined>));
      return row ?? null;
    },
    async put(conversation) {
      await tx([STORE_CONVERSATIONS, STORE_SUMMARIES], "readwrite", async transaction => {
        transaction.objectStore(STORE_CONVERSATIONS).put(conversation);
        transaction.objectStore(STORE_SUMMARIES).put(summarizeConversation(conversation));
      });
    },
    async remove(id) {
      await tx([STORE_CONVERSATIONS, STORE_SUMMARIES], "readwrite", async transaction => {
        transaction.objectStore(STORE_CONVERSATIONS).delete(id);
        transaction.objectStore(STORE_SUMMARIES).delete(id);
      });
    },
    async clear() {
      await tx([STORE_CONVERSATIONS, STORE_SUMMARIES], "readwrite", async transaction => {
        transaction.objectStore(STORE_CONVERSATIONS).clear();
        transaction.objectStore(STORE_SUMMARIES).clear();
      });
    },
  };
}

let cached: ChatStore | null = null;

/**
 * The process-wide chat store. Resolved once: an IDB open failure must not make
 * every later call retry (and re-log) a store the browser has already refused.
 */
export function getChatStore(): ChatStore {
  if (cached) return cached;
  const idb = typeof globalThis !== "undefined"
    ? (globalThis as { indexedDB?: IDBFactory }).indexedDB
    : undefined;
  if (!idb) {
    cached = memoryStore();
    return cached;
  }
  const fallback = memoryStore();
  let store: ChatStore;
  try {
    store = indexedDbStore(openDatabase());
  } catch {
    cached = fallback;
    return cached;
  }
  // Wrap every method so a mid-session IDB failure (quota, corrupted DB, the tab
  // losing storage access) degrades to memory instead of surfacing as a broken UI.
  cached = {
    get durable() { return store.durable; },
    listSummaries: () => store.listSummaries().catch(() => fallback.listSummaries()),
    get: id => store.get(id).catch(() => fallback.get(id)),
    put: conversation => store.put(conversation).catch(() => fallback.put(conversation)),
    remove: id => store.remove(id).catch(() => fallback.remove(id)),
    clear: () => store.clear().catch(() => fallback.clear()),
  };
  return cached;
}

/** Test-only: drop the memoized store so a fresh environment can install its own. */
export function resetChatStoreForTests(): void {
  cached = null;
}
