/**
 * High-performance, quota-free IndexedDB storage for MegaText translator.
 * Solves the ~5MB browser LocalStorage limit for massive 1,000,000+ character novels,
 * caches reader chapters offline for maximum data saving, and stores settings.
 */

const DB_NAME = "megatext_idb_v1";
const DB_VERSION = 1;

const STORES = {
  SESSIONS: "sessions",
  CACHED_CHAPTERS: "cached_chapters",
  READER_SETTINGS: "reader_settings",
  GLOSSARY: "glossary_cache",
};

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined" || !window.indexedDB) {
      reject(new Error("IndexedDB is not supported in this environment."));
      return;
    }

    const request = window.indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      if (!db.objectStoreNames.contains(STORES.SESSIONS)) {
        db.createObjectStore(STORES.SESSIONS);
      }
      if (!db.objectStoreNames.contains(STORES.CACHED_CHAPTERS)) {
        // key format: `${novelId}__ch_${chapterIndex}`
        db.createObjectStore(STORES.CACHED_CHAPTERS);
      }
      if (!db.objectStoreNames.contains(STORES.READER_SETTINGS)) {
        db.createObjectStore(STORES.READER_SETTINGS);
      }
      if (!db.objectStoreNames.contains(STORES.GLOSSARY)) {
        db.createObjectStore(STORES.GLOSSARY);
      }
    };

    request.onsuccess = (event) => {
      resolve((event.target as IDBOpenDBRequest).result);
    };

    request.onerror = (event) => {
      reject((event.target as IDBOpenDBRequest).error);
    };
  });
}

/**
 * Get an item from a specific IndexedDB store
 */
export async function idbGet<T>(storeName: string, key: string): Promise<T | null> {
  try {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const store = tx.objectStore(storeName);
      const req = store.get(key);

      req.onsuccess = () => {
        resolve((req.result as T) ?? null);
      };
      req.onerror = () => {
        reject(req.error);
      };
    });
  } catch (err) {
    console.warn(`[IndexedDB] Failed to get ${key} from ${storeName}:`, err);
    return null;
  }
}

/**
 * Save an item to a specific IndexedDB store
 */
export async function idbSet<T>(storeName: string, key: string, value: T): Promise<void> {
  try {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      const req = store.put(value, key);

      req.onsuccess = () => {
        resolve();
      };
      req.onerror = () => {
        reject(req.error);
      };
    });
  } catch (err) {
    console.warn(`[IndexedDB] Failed to set ${key} in ${storeName}:`, err);
  }
}

/**
 * Delete an item from a specific IndexedDB store
 */
export async function idbDelete(storeName: string, key: string): Promise<void> {
  try {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      const req = store.delete(key);

      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn(`[IndexedDB] Failed to delete ${key} from ${storeName}:`, err);
  }
}

// ----------------------------------------------------
// Specialized Session Storage Helpers
// ----------------------------------------------------

const ACTIVE_SESSION_KEY = "current_active_session";

export async function saveSessionToIdb(session: any): Promise<void> {
  await idbSet(STORES.SESSIONS, ACTIVE_SESSION_KEY, session);
}

export async function getSessionFromIdb(): Promise<any | null> {
  return await idbGet(STORES.SESSIONS, ACTIVE_SESSION_KEY);
}

export async function clearSessionFromIdb(): Promise<void> {
  await idbDelete(STORES.SESSIONS, ACTIVE_SESSION_KEY);
}

// ----------------------------------------------------
// Specialized Chapter Offline Cache (Data Saver)
// ----------------------------------------------------

export interface CachedChapterData {
  chapterIndex: number;
  chapterTitle: string;
  chineseContent: string;
  englishContent?: string;
  totalChapters?: number;
  timestamp: number;
}

export async function getCachedChapter(novelId: string, chapterIndex: number): Promise<CachedChapterData | null> {
  const key = `${novelId}__ch_${chapterIndex}`;
  return await idbGet<CachedChapterData>(STORES.CACHED_CHAPTERS, key);
}

export async function setCachedChapter(
  novelId: string,
  chapterIndex: number,
  data: Omit<CachedChapterData, "timestamp">
): Promise<void> {
  const key = `${novelId}__ch_${chapterIndex}`;
  await idbSet<CachedChapterData>(STORES.CACHED_CHAPTERS, key, {
    ...data,
    timestamp: Date.now(),
  });
}

// ----------------------------------------------------
// Reader Settings Persistence
// ----------------------------------------------------

export interface ReaderPreferences {
  theme: "sepia" | "oled" | "cream" | "slate" | "light";
  fontSize: number;
  lineHeight: "compact" | "normal" | "relaxed";
  fontFamily: "serif" | "sans" | "mono";
  bilingualMode: "english" | "dual" | "chinese";
  scrollMode?: "continuous" | "paged";
  ttsEngine?: "google-classic" | "browser-native";
  ttsVoiceName?: string;
  cloudVoiceLang?: string;
  ttsRate: number;
  ttsPitch: number;
  autoAdvanceTts: boolean;
}

const DEFAULT_READER_PREFERENCES: ReaderPreferences = {
  theme: "sepia",
  fontSize: 17,
  lineHeight: "normal",
  fontFamily: "serif",
  bilingualMode: "english",
  scrollMode: "continuous",
  ttsEngine: "browser-native",
  cloudVoiceLang: "en",
  ttsRate: 1.0,
  ttsPitch: 1.0,
  autoAdvanceTts: true,
};

export async function getReaderPreferences(): Promise<ReaderPreferences> {
  const prefs = await idbGet<ReaderPreferences>(STORES.READER_SETTINGS, "preferences");
  const hasSpeechSynthesis = typeof window !== "undefined" && "speechSynthesis" in window && !!window.speechSynthesis;
  const defaultEngine: "browser-native" | "google-classic" = hasSpeechSynthesis ? "browser-native" : "google-classic";
  
  const resolvedPrefs: ReaderPreferences = { ...DEFAULT_READER_PREFERENCES, ttsEngine: defaultEngine, ...(prefs || {}) };
  // If user previously had browser-native saved but is now in a browser without SpeechSynthesis (e.g. Soul Browser), auto fallback to google-classic
  if (!hasSpeechSynthesis && resolvedPrefs.ttsEngine === "browser-native") {
    resolvedPrefs.ttsEngine = "google-classic";
  }
  return resolvedPrefs;
}

export async function saveReaderPreferences(prefs: Partial<ReaderPreferences>): Promise<void> {
  const current = await getReaderPreferences();
  await idbSet(STORES.READER_SETTINGS, "preferences", { ...current, ...prefs });
}

// ----------------------------------------------------
// User Library Persistence (with instant localStorage sync)
// ----------------------------------------------------

const LIBRARY_STORAGE_KEY = "megatext_user_library_v1";

export function getLocalLibraryBooks(): any[] {
  try {
    const raw = localStorage.getItem(LIBRARY_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveLocalLibraryBooks(books: any[]): void {
  try {
    localStorage.setItem(LIBRARY_STORAGE_KEY, JSON.stringify(books));
  } catch (err) {
    console.warn("Failed to persist library books to localStorage:", err);
  }
}

export function addOrUpdateBookInLibrary(book: any): any[] {
  const list = getLocalLibraryBooks();
  const novelId = book.id || `${book.siteId || "src"}_${book.title}`;
  const existingIdx = list.findIndex((b) => b.id === novelId || (b.title === book.title && b.author === book.author));
  
  const updatedBook = {
    ...book,
    id: novelId,
    lastReadAt: Date.now(),
    addedAt: existingIdx >= 0 ? list[existingIdx].addedAt : Date.now(),
    currentChapterIndex: book.currentChapterIndex || (existingIdx >= 0 ? list[existingIdx].currentChapterIndex : 1),
    totalChapters: book.totalChapters || (existingIdx >= 0 ? list[existingIdx].totalChapters : 1),
  };

  let nextList: any[];
  if (existingIdx >= 0) {
    nextList = [...list];
    nextList[existingIdx] = { ...list[existingIdx], ...updatedBook };
  } else {
    nextList = [updatedBook, ...list];
  }

  saveLocalLibraryBooks(nextList);
  return nextList;
}

export function removeBookFromLibrary(bookId: string): any[] {
  const list = getLocalLibraryBooks();
  const nextList = list.filter((b) => b.id !== bookId);
  saveLocalLibraryBooks(nextList);
  return nextList;
}

// ----------------------------------------------------
// Novel-Specific Auto-Generated Glossary Cache
// ----------------------------------------------------

export interface NovelGlossaryTerm {
  id: string;
  original: string;
  translation: string;
  category: "Character" | "Faction" | "Realm/Skill" | "Location" | "Item" | "General";
  notes?: string;
  confidence?: number;
}

export async function getNovelGlossary(novelId: string): Promise<NovelGlossaryTerm[]> {
  const terms = await idbGet<NovelGlossaryTerm[]>(STORES.GLOSSARY, `glossary_${novelId}`);
  return terms || [];
}

export async function saveNovelGlossary(novelId: string, terms: NovelGlossaryTerm[]): Promise<void> {
  await idbSet<NovelGlossaryTerm[]>(STORES.GLOSSARY, `glossary_${novelId}`, terms);
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function applyGlossaryToText(
  text: string,
  glossary: Array<{ original: string; translation: string }>
): string {
  if (!text || !glossary || glossary.length === 0) return text;

  const valid = glossary.filter(
    (g) => g.original && g.translation && g.original.trim() !== g.translation.trim()
  );
  if (valid.length === 0) return text;

  // Sort by original length descending so longer phrases match before shorter substrings
  const sorted = [...valid].sort((a, b) => b.original.length - a.original.length);

  let result = text;
  for (const item of sorted) {
    const from = item.original.trim();
    const to = item.translation.trim();

    const isLatin = /^[A-Za-z0-9_ -]+$/.test(from);
    if (isLatin) {
      const pattern = new RegExp(`\\b${escapeRegExp(from)}\\b`, "gi");
      result = result.replace(pattern, (match) => {
        if (match === match.toUpperCase() && match.length > 1) return to.toUpperCase();
        if (match[0] === match[0].toUpperCase()) return to.charAt(0).toUpperCase() + to.slice(1);
        return to.charAt(0).toUpperCase() + to.slice(1);
      });
    } else {
      const pattern = new RegExp(escapeRegExp(from), "g");
      result = result.replace(pattern, to);
    }
  }

  return result;
}

/**
 * Permanently replaces matched English names/terms in all offline cached chapters of a novel.
 * Consumes 0 KB network data and updates local IndexedDB storage.
 */
export async function replaceTermsInNovelCache(
  novelId: string,
  replacements: Array<{ from: string; to: string }>
): Promise<{ chaptersUpdated: number; totalReplacements: number }> {
  const validReplacements = replacements.filter(
    (r) => r.from && r.to && r.from.trim() !== r.to.trim()
  );
  if (validReplacements.length === 0) {
    return { chaptersUpdated: 0, totalReplacements: 0 };
  }

  const glossaryItems = validReplacements.map((r) => ({
    original: r.from,
    translation: r.to,
  }));

  try {
    const db = await openDatabase();
    return new Promise((resolve) => {
      const tx = db.transaction(STORES.CACHED_CHAPTERS, "readwrite");
      const store = tx.objectStore(STORES.CACHED_CHAPTERS);
      const req = store.openCursor();
      let chaptersUpdated = 0;
      let totalReplacements = 0;

      req.onsuccess = (e) => {
        const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          const key = String(cursor.key);
          if (key.startsWith(`${novelId}__ch_`)) {
            const data = cursor.value as CachedChapterData;
            const origEnglish = data.englishContent || "";
            const origTitle = data.chapterTitle || "";

            const newEnglish = applyGlossaryToText(origEnglish, glossaryItems);
            const newTitle = applyGlossaryToText(origTitle, glossaryItems);

            if (newEnglish !== origEnglish || newTitle !== origTitle) {
              cursor.update({
                ...data,
                englishContent: newEnglish,
                chapterTitle: newTitle,
              });
              chaptersUpdated++;
              totalReplacements++;
            }
          }
          cursor.continue();
        } else {
          resolve({ chaptersUpdated, totalReplacements });
        }
      };

      req.onerror = () => {
        resolve({ chaptersUpdated: 0, totalReplacements: 0 });
      };
    });
  } catch (err) {
    console.warn("[IndexedDB] replaceTermsInNovelCache error:", err);
    return { chaptersUpdated: 0, totalReplacements: 0 };
  }
}

// ----------------------------------------------------
// Offline Cached Chapters Statistics Helper
// ----------------------------------------------------

/**
 * Counts how many chapters are saved offline in IndexedDB for a given novelId
 */
export async function getNovelCachedChaptersCount(novelId: string): Promise<number> {
  if (!novelId) return 0;
  try {
    const db = await openDatabase();
    return new Promise((resolve) => {
      const tx = db.transaction(STORES.CACHED_CHAPTERS, "readonly");
      const store = tx.objectStore(STORES.CACHED_CHAPTERS);
      const req = store.openCursor();
      let count = 0;

      req.onsuccess = (e) => {
        const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          const key = String(cursor.key);
          if (key.startsWith(`${novelId}__ch_`)) {
            count++;
          }
          cursor.continue();
        } else {
          resolve(count);
        }
      };

      req.onerror = () => resolve(0);
    });
  } catch {
    return 0;
  }
}

/**
 * Gets offline cached chapter counts for all novels in IndexedDB
 */
export async function getAllNovelCachedChapterCounts(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  try {
    const db = await openDatabase();
    return new Promise((resolve) => {
      const tx = db.transaction(STORES.CACHED_CHAPTERS, "readonly");
      const store = tx.objectStore(STORES.CACHED_CHAPTERS);
      const req = store.openCursor();

      req.onsuccess = (e) => {
        const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          const key = String(cursor.key);
          const parts = key.split("__ch_");
          if (parts.length === 2 && parts[0]) {
            const novelId = parts[0];
            counts[novelId] = (counts[novelId] || 0) + 1;
          }
          cursor.continue();
        } else {
          resolve(counts);
        }
      };

      req.onerror = () => resolve(counts);
    });
  } catch {
    return counts;
  }
}

// ----------------------------------------------------
// Reading History Persistence
// ----------------------------------------------------

export interface ReadingHistoryItem {
  id: string;
  title: string;
  author?: string;
  coverUrl?: string;
  novelUrl?: string;
  siteId?: string;
  lastReadChapterIndex: number;
  lastReadChapterTitle: string;
  totalChapters?: number;
  timestamp: number;
}

const READING_HISTORY_KEY = "megatext_reading_history_v1";

export function getReadingHistory(): ReadingHistoryItem[] {
  try {
    const raw = localStorage.getItem(READING_HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveReadingHistory(history: ReadingHistoryItem[]): void {
  try {
    localStorage.setItem(READING_HISTORY_KEY, JSON.stringify(history));
  } catch (err) {
    console.warn("Failed to persist reading history:", err);
  }
}

export function addReadingHistory(
  item: {
    id?: string;
    title: string;
    author?: string;
    coverUrl?: string;
    novelUrl?: string;
    siteId?: string;
    chapterIndex?: number;
    chapterTitle?: string;
    totalChapters?: number;
  }
): ReadingHistoryItem[] {
  if (!item || !item.title) return getReadingHistory();

  const novelId = item.id || `${item.siteId || "src"}_${item.title}`.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5]/g, "_");
  const list = getReadingHistory();
  const existingIdx = list.findIndex(
    (h) => h.id === novelId || (h.title.trim().toLowerCase() === item.title.trim().toLowerCase() && (h.author === item.author || !item.author))
  );

  const prev = existingIdx >= 0 ? list[existingIdx] : null;
  const chapterIdx = item.chapterIndex || prev?.lastReadChapterIndex || 1;
  const chapterTitle = item.chapterTitle || prev?.lastReadChapterTitle || `Chapter ${chapterIdx}`;
  const totalCh = item.totalChapters || prev?.totalChapters || 1;

  const newEntry: ReadingHistoryItem = {
    id: novelId,
    title: item.title,
    author: item.author || prev?.author,
    coverUrl: item.coverUrl || prev?.coverUrl,
    novelUrl: item.novelUrl || prev?.novelUrl,
    siteId: item.siteId || prev?.siteId || "default",
    lastReadChapterIndex: chapterIdx,
    lastReadChapterTitle: chapterTitle,
    totalChapters: totalCh,
    timestamp: Date.now(),
  };

  // Prepend to top of list so most recently read is first
  let nextList = list.filter(
    (h) => h.id !== novelId && !(h.title.trim().toLowerCase() === item.title.trim().toLowerCase() && (h.author === item.author || !item.author))
  );
  nextList.unshift(newEntry);

  // Cap at 100 recent entries to keep storage compact
  if (nextList.length > 100) {
    nextList = nextList.slice(0, 100);
  }

  saveReadingHistory(nextList);
  return nextList;
}

export function removeReadingHistoryItem(idOrTitle: string): ReadingHistoryItem[] {
  if (!idOrTitle) return getReadingHistory();
  const list = getReadingHistory();
  const target = idOrTitle.trim().toLowerCase();
  const nextList = list.filter(
    (h) => h.id !== idOrTitle && h.title !== idOrTitle && h.title.trim().toLowerCase() !== target
  );
  saveReadingHistory(nextList);
  return nextList;
}

export function clearReadingHistory(): void {
  try {
    localStorage.removeItem(READING_HISTORY_KEY);
  } catch (err) {
    console.warn("Failed to clear reading history:", err);
  }
}

