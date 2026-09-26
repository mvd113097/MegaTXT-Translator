/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useMemo } from "react";
import { Navbar } from "./components/Navbar";
import { UploadSection } from "./components/UploadSection";
import { TranslationControls } from "./components/TranslationControls";
import { ProgressBar } from "./components/ProgressBar";
import { TranslationQueueHub } from "./components/TranslationQueueHub";
import { BottomNav } from "./components/BottomNav";
import { ActiveTranslationView } from "./components/ActiveTranslationView";
import { TranslationCompleteView } from "./components/TranslationCompleteView";

// Lazy-loaded components and modals to minimize initial bundle size and initial download
const GlossaryModal = React.lazy(() =>
  import("./components/GlossaryModal").then((m) => ({ default: m.GlossaryModal }))
);
const ExportModal = React.lazy(() =>
  import("./components/ExportModal").then((m) => ({ default: m.ExportModal }))
);
const TelegramSettingsModal = React.lazy(() =>
  import("./components/TelegramSettingsModal").then((m) => ({ default: m.TelegramSettingsModal }))
);
const HistoryModal = React.lazy(() =>
  import("./components/HistoryModal").then((m) => ({ default: m.HistoryModal }))
);
const StoreView = React.lazy(() =>
  import("./components/StoreView").then((m) => ({ default: m.StoreView }))
);
const ExploreView = React.lazy(() =>
  import("./components/ExploreView").then((m) => ({ default: m.ExploreView }))
);
const LibraryView = React.lazy(() =>
  import("./components/LibraryView").then((m) => ({ default: m.LibraryView }))
);
const NovelReaderModal = React.lazy(() =>
  import("./components/NovelReaderModal").then((m) => ({ default: m.NovelReaderModal }))
);
const PasswordGate = React.lazy(() =>
  import("./components/PasswordGate").then((m) => ({ default: m.PasswordGate }))
);
import {
  getSessionFromIdb,
  saveSessionToIdb,
  clearSessionFromIdb,
  getLocalLibraryBooks,
  removeBookFromLibrary,
  removeReadingHistoryItem,
  clearReadingHistory,
  addReadingHistory,
  addOrUpdateBookInLibrary,
} from "./utils/indexedDbStorage";
import { isSameNovel } from "./utils/chunkCleaner";
import {
  PagodaHeaderIllustration,
  SakuraFooterDecoration,
} from "./components/illustrations/StorybookArtwork";
import {
  TextChunk,
  TranslationStyle,
  TranslationMode,
  GlossaryTerm,
  TranslationMetrics,
  TranslationSession,
  AuthStatus,
} from "./types";
import {
  chunkChineseText,
  countChineseCharacters,
  countEnglishWords,
  getContiguousCompletedChunks,
  analyzeChunkContinuity,
} from "./utils/chunker";
import { SAMPLE_GLOSSARY } from "./data/sampleNovel";
import { downloadEpub } from "./utils/epubGenerator";
import { downloadFile } from "./utils/fileDownloader";
import {
  CheckCircle,
  CheckCircle2,
  ExternalLink,
  AlertTriangle,
  Download,
  Cloud,
  ShieldCheck,
  BookOpen,
  RefreshCw,
  BookCheck,
  Layers,
  FileText,
} from "lucide-react";

const STORAGE_KEY = "megatext_translator_session_v1";

export default function App() {
  // Theme state
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    try {
      const saved = localStorage.getItem("megatext_theme");
      if (saved === "dark" || saved === "light") return saved;
      if (typeof window !== "undefined" && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
        return "dark";
      }
    } catch {
      // ignore
    }
    return "light";
  });

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "dark") {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
    try {
      localStorage.setItem("megatext_theme", theme);
    } catch {
      // ignore
    }
  }, [theme]);

  const toggleTheme = () => {
    setTheme((prev) => (prev === "dark" ? "light" : "dark"));
  };

  // Generate or retrieve persistent unique client/device session ID
  const getClientSessionId = () => {
    try {
      let sid = localStorage.getItem("megatext_client_session_id");
      if (!sid) {
        sid = "sess_" + Math.random().toString(36).substring(2, 12) + "_" + Date.now().toString(36);
        localStorage.setItem("megatext_client_session_id", sid);
      }
      return sid;
    } catch {
      return "sess_default";
    }
  };

  // Security & Auth Status
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);

  // Helper to attach session isolation headers
  const getAuthHeaders = () => {
    const token = typeof window !== "undefined" ? localStorage.getItem("megatext_auth_token") || "" : "";
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-session-id": getClientSessionId(),
      "x-auth-token": token,
      "Authorization": token ? `Bearer ${token}` : "",
    };
    if (session?.fileName) {
      headers["x-novel-filename"] = encodeURIComponent(session.fileName);
    }
    return headers;
  };

  // Check server auth status on initial load
  useEffect(() => {
    async function checkAuthStatus() {
      try {
        const res = await fetch("/api/auth/status", {
          headers: getAuthHeaders(),
        });
        const data = await res.json();
        setAuthStatus(data);
      } catch (err) {
        console.warn("Failed to check auth status:", err);
      } finally {
        setIsCheckingAuth(false);
      }
    }
    checkAuthStatus();
  }, []);

  // Translation Mode state: Option 1 (cloud) vs Option 2 (browser)
  const [mode, setMode] = useState<TranslationMode>(() => {
    try {
      const saved = localStorage.getItem("megatext_mode");
      if (saved === "cloud" || saved === "browser") return saved;
    } catch {
      // ignore
    }
    return "cloud"; // Default to Option 1: Cloud Mode for browser-closed translation
  });

  const handleModeChange = (newMode: TranslationMode) => {
    setMode(newMode);
    try {
      localStorage.setItem("megatext_mode", newMode);
    } catch {}
    setSession((prev) => (prev ? { ...prev, mode: newMode } : null));
  };

  // Main Session State
  const [session, setSession] = useState<TranslationSession | null>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        return JSON.parse(saved);
      }
    } catch (e) {
      console.error("Failed to read session from localStorage:", e);
    }
    return null;
  });

  // Track active or finished background cloud job discovered on server
  const [serverCloudJob, setServerCloudJob] = useState<any | null>(null);

  // Runner state
  const [isRunning, setIsRunning] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [concurrency, setConcurrency] = useState<number>(() => {
    try {
      const saved = localStorage.getItem("megatext_concurrency");
      if (saved) {
        const val = parseInt(saved, 10);
        if (val >= 1 && val <= 5) return val;
      }
    } catch {}
    return 2;
  });
  const [style, setStyle] = useState<TranslationStyle>(session?.style || "xianxia");
  const [customInstructions, setCustomInstructions] = useState(
    session?.customInstructions || ""
  );
  const [glossary, setGlossary] = useState<GlossaryTerm[]>(
    session?.glossary || SAMPLE_GLOSSARY
  );

  // Modals & Navigation
  const [activeNavTab, setActiveNavTab] = useState<"home" | "library" | "store" | "explore" | "history">(() => {
    try {
      if (typeof window !== "undefined") {
        const urlParams = new URLSearchParams(window.location.search);
        const tabParam = urlParams.get("tab");
        if (tabParam && ["home", "library", "store", "explore", "history"].includes(tabParam)) {
          return tabParam as any;
        }
      }
      const saved = localStorage.getItem("megatext_active_nav_tab");
      if (saved && ["home", "library", "store", "explore", "history"].includes(saved)) {
        return saved as any;
      }
    } catch {}
    return "home";
  });
  const [storeSearchTrigger, setStoreSearchTrigger] = useState<{ query: string; site?: string; timestamp: number } | null>(null);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [isGlossaryOpen, setIsGlossaryOpen] = useState(false);
  const [isExportOpen, setIsExportOpen] = useState(false);
  const [isTelegramSettingsOpen, setIsTelegramSettingsOpen] = useState(false);

  // Reader & TTS State with Persistent Session across page reload
  interface ActiveReaderNovel {
    novelTitle: string;
    author?: string;
    coverUrl?: string;
    novelUrl?: string;
    siteId?: string;
    chapterIndex?: number;
    totalChapters?: number;
    allChapters?: Array<{ title: string; url: string; index?: number }>;
    content?: string;
    englishContent?: string;
  }

  const READER_SESSION_KEY = "megatext_reader_session_v1";

  const [readerNovel, setReaderNovel] = useState<ActiveReaderNovel | null>(() => {
    try {
      const saved = localStorage.getItem(READER_SESSION_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && parsed.readerNovel && parsed.readerNovel.novelTitle) {
          return parsed.readerNovel;
        }
      }
      // Fallback: check personal library for the last-read novel
      const libraryBooks = getLocalLibraryBooks();
      if (libraryBooks && libraryBooks.length > 0) {
        const lastBook = libraryBooks[0];
        return {
          novelTitle: lastBook.title,
          author: lastBook.author,
          coverUrl: lastBook.coverUrl,
          novelUrl: lastBook.novelUrl,
          siteId: lastBook.siteId,
          chapterIndex: lastBook.currentChapterIndex || 1,
          totalChapters: lastBook.totalChapters || 1,
          allChapters: lastBook.allChapters,
        };
      }
    } catch (e) {
      console.warn("Could not restore reader novel from localStorage:", e);
    }
    return null;
  });

  const [isReaderOpen, setIsReaderOpen] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem(READER_SESSION_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (typeof parsed?.isReaderOpen === "boolean") {
          return parsed.isReaderOpen;
        }
      }
    } catch {}
    return false;
  });

  // Minimized reader is always visible when a novel has been loaded / read
  const [isReaderMinimized, setIsReaderMinimized] = useState<boolean>(true);

  // Sync reader state to localStorage
  useEffect(() => {
    try {
      if (readerNovel) {
        localStorage.setItem(
          READER_SESSION_KEY,
          JSON.stringify({
            readerNovel,
            isReaderOpen,
            isReaderMinimized: true,
            timestamp: Date.now(),
          })
        );
      }
    } catch (e) {
      console.warn("Could not save reader session to localStorage:", e);
    }
  }, [readerNovel, isReaderOpen]);

  const handleOpenReader = (novel: ActiveReaderNovel) => {
    setReaderNovel(novel);
    setIsReaderOpen(true);
    setIsReaderMinimized(false);
    try {
      addReadingHistory({
        title: novel.novelTitle,
        author: novel.author,
        coverUrl: novel.coverUrl,
        novelUrl: novel.novelUrl,
        siteId: novel.siteId,
        chapterIndex: novel.chapterIndex || 1,
        totalChapters: novel.totalChapters || novel.allChapters?.length || 1,
      });
    } catch {}
  };

  const handleCloseReader = () => {
    // When reader full-modal closes, keep the floating minimized bubble visible always
    setIsReaderOpen(false);
    setIsReaderMinimized(true);
  };

  // Memoized session chunks for active reader (includes both finished English translations and processing chunks)
  const currentSessionReaderChunks = useMemo(() => {
    if (!session || !session.chunks || session.chunks.length === 0) return undefined;
    return session.chunks;
  }, [session]);

  const handleOpenCurrentSessionReader = async () => {
    if (!session || !session.chunks || session.chunks.length === 0) return;
    const cleanTitle = session.fileName.replace(/\.txt$/i, "");

    // 1. Sync full translated chapter texts from server if needed (cloud mode or missing text)
    let currentChunks = chunksRef.current.length > 0 ? chunksRef.current : session.chunks;
    if (
      mode === "cloud" ||
      currentChunks.length === 0 ||
      currentChunks.some((c) => c.status === "completed" && (!c.englishText || !c.englishText.trim()))
    ) {
      const synced = await syncCompletedTexts(true);
      if (synced && synced.length > 0) {
        currentChunks = synced;
      }
    }

    // 2. All chunks sorted strictly by index 0, 1, 2, 3...
    const sortedChunks = [...currentChunks].sort((a, b) => a.index - b.index);

    // 3. Finished chapters translated by Gemini in order
    const finishedChunks = sortedChunks.filter(
      (c) => (c.status === "completed" || Boolean(c.englishText?.trim())) && Boolean(c.englishText?.trim())
    );

    // Map full novel chapter list
    const allChapters = sortedChunks.map((c) => ({
      title: c.chapterTitle || `Chapter ${c.index + 1}`,
      url: "",
      index: c.index + 1,
      originalIndex: c.index + 1,
    }));

    // Find starting chapter index: preserve existing progress if within valid range, else start at first translated chapter
    let targetIdx = 1;
    if (readerNovel && isSameNovel(readerNovel.novelTitle, cleanTitle)) {
      if (readerNovel.chapterIndex && readerNovel.chapterIndex >= 1 && readerNovel.chapterIndex <= sortedChunks.length) {
        targetIdx = readerNovel.chapterIndex;
      }
    } else if (finishedChunks.length > 0) {
      targetIdx = finishedChunks[0].index + 1;
    }

    const selectedChunk = sortedChunks.find((c) => c.index === targetIdx - 1) || finishedChunks[0] || sortedChunks[0];

    handleOpenReader({
      novelTitle: cleanTitle,
      totalChapters: sortedChunks.length,
      chapterIndex: targetIdx,
      allChapters,
      content: selectedChunk?.chineseText || "",
      englishContent: selectedChunk?.englishText || "",
    });
  };

  // Keep active reader novel chapters list synchronized in real time as background Gemini translation finishes more chapters
  useEffect(() => {
    if (!session || !session.chunks || !readerNovel) return;
    if (!isSameNovel(session.fileName, readerNovel.novelTitle)) return;

    const total = session.chunks.length;
    if (total === 0) return;

    if (readerNovel.totalChapters !== total || !readerNovel.allChapters || readerNovel.allChapters.length !== total) {
      setReaderNovel((prev) => {
        if (!prev) return null;
        return {
          ...prev,
          totalChapters: total,
          allChapters: session.chunks.map((c) => ({
            title: c.chapterTitle || `Chapter ${c.index + 1}`,
            url: "",
            index: c.index + 1,
            originalIndex: c.index + 1,
          })),
        };
      });
    }
  }, [session, readerNovel?.novelTitle]);

  const handleBottomNavChange = (tab: "home" | "library" | "store" | "explore" | "history") => {
    setActiveNavTab(tab);
    try {
      localStorage.setItem("megatext_active_nav_tab", tab);
      if (typeof window !== "undefined") {
        const url = new URL(window.location.href);
        url.searchParams.set("tab", tab);
        window.history.replaceState(null, "", url.toString());
      }
    } catch {}
    if (tab === "history") {
      setIsHistoryOpen(true);
    }
  };
  const [toastData, setToastData] = useState<{
    message: string;
    downloadUrl?: string;
    filename?: string;
    type?: "success" | "warning" | "error";
  } | null>(null);

  // Metrics
  const [startTime, setStartTime] = useState<number | null>(null);
  const [charsTranslatedInRun, setCharsTranslatedInRun] = useState(0);

  // Quota & Cooldown status tracking
  const [firestoreStatus, setFirestoreStatus] = useState<{
    isQuotaExhausted: boolean;
    isAvailable: boolean;
  }>({ isQuotaExhausted: false, isAvailable: true });
  const [aiCooldownSec, setAiCooldownSec] = useState<number>(0);

  // Automatic 1-second countdown for live rate-limit cooldown display
  useEffect(() => {
    if (aiCooldownSec <= 0) return;
    const timer = setInterval(() => {
      setAiCooldownSec((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [aiCooldownSec]);

  // Refs for queue management
  const userHasResetRef = useRef(false);
  const stopRequestedRef = useRef(false);
  const pauseRequestedRef = useRef(false);
  const activeRequestsRef = useRef(0);
  const chunksRef = useRef<TextChunk[]>(session?.chunks || []);

  // Synchronize chunksRef with state
  useEffect(() => {
    if (session?.chunks) {
      chunksRef.current = session.chunks;
    }
  }, [session?.chunks]);

  // Load session from IndexedDB on startup (handles novels of any size, bypassing 5MB localStorage cap)
  useEffect(() => {
    getSessionFromIdb()
      .then((saved) => {
        if (saved) {
          setSession((current) => {
            const savedTime = saved.lastUpdated || saved.createdAt || 0;
            const currentTime = current.lastUpdated || current.createdAt || 0;
            if (!current || savedTime > currentTime) {
              return saved;
            }
            return current;
          });
        }
      })
      .catch((err) => console.warn("IndexedDB session load skipped:", err));
  }, []);

  // Persist session changes to IndexedDB (unlimited quota) with localStorage backup
  useEffect(() => {
    if (session) {
      saveSessionToIdb(session).catch((err) =>
        console.warn("Failed to persist session to IndexedDB:", err)
      );
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
      } catch (err) {
        // Expected when novel exceeds 5MB localStorage limit, handled safely by IndexedDB
      }
    }
  }, [session]);

  const [isSyncingProgress, setIsSyncingProgress] = useState(false);

  // On-demand sync of full translated chapter texts for completed chunks
  const syncCompletedTexts = async (force: boolean = false): Promise<TextChunk[]> => {
    if (mode !== "cloud") return chunksRef.current;

    // Data-saving optimization: If not forced, check if all completed chunks already have English text in memory
    if (!force && chunksRef.current.length > 0) {
      const missingCompletedText = chunksRef.current.some(
        (c) => c.status === "completed" && (!c.englishText || !c.englishText.trim())
      );
      if (!missingCompletedText) {
        return chunksRef.current;
      }
    }

    try {
      const headers = getAuthHeaders();
      if (session?.fileName) {
        headers["x-novel-filename"] = encodeURIComponent(session.fileName);
      }

      const baseChunks = chunksRef.current.length > 0 ? chunksRef.current : (session?.chunks || []);
      const missingIndices = baseChunks
        .filter((c) => !c.englishText || !c.englishText.trim())
        .map((c) => c.index);

      // High-efficiency delta sync: sync all missing indices or all completed chunks
      let syncUrl = "/api/cloud-job/sync-texts?completedOnly=true";
      if (baseChunks.length > 0 && missingIndices.length > 0 && missingIndices.length <= 150) {
        syncUrl = `/api/cloud-job/sync-texts?indices=${missingIndices.join(",")}`;
      } else {
        syncUrl = "/api/cloud-job/sync-texts?completedOnly=true";
      }

      const res = await fetch(syncUrl, {
        headers,
      });
      const data = await res.json();
      if (data.success && Array.isArray(data.chunks) && data.chunks.length > 0) {
        const textMap = new Map<number, { chineseText: string; englishText: string; chapterTitle?: string; id?: string }>();
        data.chunks.forEach((c: any) => {
          textMap.set(c.index, {
            chineseText: c.chineseText || "",
            englishText: c.englishText || "",
            chapterTitle: c.chapterTitle,
            id: c.id,
          });
        });

        let updated: TextChunk[] = [];
        const baseChunks = chunksRef.current.length > 0 ? chunksRef.current : (session?.chunks || []);

        if (baseChunks.length === 0 || baseChunks.length < data.chunks.length) {
          // Reconstruct entire chunk list directly from server data
          updated = data.chunks.map((c: any) => ({
            id: c.id || `chunk-${c.index}`,
            index: c.index,
            chapterTitle: c.chapterTitle || `Section ${c.index + 1}`,
            chineseText: c.chineseText || "",
            englishText: c.englishText || "",
            charCount: countChineseCharacters(c.chineseText || "") || (c.chineseText || "").length,
            status: "completed" as const,
          }));
        } else {
          updated = baseChunks.map((c) => {
            const synced = textMap.get(c.index);
            if (synced && synced.englishText) {
              return {
                ...c,
                chapterTitle: synced.chapterTitle || c.chapterTitle,
                chineseText: synced.chineseText || c.chineseText,
                englishText: synced.englishText,
                status: "completed" as const,
              };
            }
            return c;
          });
        }

        chunksRef.current = updated;
        setSession((prev) => {
          if (!prev) {
            const now = Date.now();
            return {
              fileName: session?.fileName || "translated_novel.txt",
              fileSizeBytes: 0,
              totalChineseChars: updated.reduce((acc, c) => acc + c.charCount, 0),
              chunks: updated,
              style: style || "xianxia",
              customInstructions: "",
              glossary: [],
              status: "completed",
              createdAt: now,
              lastUpdated: now,
            };
          }
          return { ...prev, chunks: updated, lastUpdated: Date.now() };
        });

        return updated;
      }
    } catch (err) {
      console.warn("Error syncing completed chapter texts:", err);
    }
    return chunksRef.current;
  };

  // High-performance Cloud Progress Synchronization:
  // 1. Password Unlock: forceFullText=true instantly populates 50k+ translated words without page refresh
  // 2. Tab Visibility / Focus: ~2 KB lightweight sync when returning after Telegram notifications
  // 3. Manual Sync Button: pulls latest progress in milliseconds with live benchmark toast
  const syncCloudProgress = async (
    forceFullText: boolean = false,
    showFeedbackToast: boolean = false,
    explicitNovelFileName?: string
  ) => {
    const startTimeMs = performance.now();
    setIsSyncingProgress(true);
    try {
      const headers = getAuthHeaders();
      if (explicitNovelFileName) {
        userHasResetRef.current = false;
        headers["x-novel-filename"] = encodeURIComponent(explicitNovelFileName);
      }
      // Use summary mode by default for ultra-low data consumption (~350 bytes per sync)
      const url = forceFullText
        ? "/api/cloud-job/status?full=true&allowFallback=true"
        : (session?.chunks && session.chunks.length > 0)
        ? "/api/cloud-job/status?summary=true&allowFallback=true"
        : "/api/cloud-job/status?allowFallback=true";

      const res = await fetch(url, {
        headers,
      });
      const data = await res.json();
      const elapsedMs = Math.round(performance.now() - startTimeMs);

      if (data.firestoreStatus) {
        setFirestoreStatus(data.firestoreStatus);
      }
      if (data.projectsSummary && typeof data.projectsSummary.nextAvailableInSeconds === "number") {
        setAiCooldownSec(data.projectsSummary.nextAvailableInSeconds);
      }

      if (data.hasJob && data.job) {
        if (userHasResetRef.current && !explicitNovelFileName) {
          // User intentionally reset or deleted their translation; do not auto-resurrect unwanted novels
          return;
        }
        const sJob = data.job;

        // CRITICAL FIX: If the user currently has a newly imported or unstarted novel loaded in the workspace,
        // and its filename does NOT match the server job, DO NOT clobber the user's workspace
        // unless they explicitly asked to switch novels (explicitNovelFileName was provided).
        if (
          session &&
          session.fileName &&
          !isSameNovel(session.fileName, sJob.fileName) &&
          !explicitNovelFileName
        ) {
          // Keep serverCloudJob reference in state for history drawer, but do NOT replace the active session!
          setServerCloudJob(sJob);
          return;
        }

        setServerCloudJob(sJob);

        // If this is a lightweight summary update and we already have the novel session loaded
        if (sJob.isSummary && session && isSameNovel(session.fileName, sJob.fileName)) {
          const totalExpected = Math.max(session.chunks?.length || 0, sJob.totalChunks || 0);
          const isAllCompleted = (sJob.completedChunks === totalExpected && totalExpected > 0) || sJob.status === "completed";
          const finalJobStatus = isAllCompleted ? "completed" : sJob.status;

          setSession((prev) => {
            if (!prev) return prev;
            let updatedChunks = prev.chunks;
            if (isAllCompleted && updatedChunks && updatedChunks.length > 0) {
              const needsMarking = updatedChunks.some((c) => c.status !== "completed");
              if (needsMarking) {
                updatedChunks = updatedChunks.map((c) => ({
                  ...c,
                  status: "completed" as const,
                }));
                chunksRef.current = updatedChunks;
              }
            }
            return {
              ...prev,
              status: finalJobStatus,
              chunks: updatedChunks,
              completedEnglishWords: Math.max(prev.completedEnglishWords || 0, sJob.completedEnglishWords || 0),
              completedChars: Math.max(prev.completedChars || 0, sJob.completedChars || 0),
              lastUpdated: Math.max(prev.lastUpdated || 0, sJob.lastActiveAt || 0),
            };
          });

          // Check if local chunks are missing translated English texts or completed status
          const localDoneCount = (session.chunks || []).filter(c => c.status === "completed" && !!c.englishText?.trim()).length;
          if (sJob.completedChunks > localDoneCount || isAllCompleted || forceFullText) {
            syncCompletedTexts(true);
          }
        } else {
          // Full structure or novel change
          const sortedChunks = sJob.chunks ? [...sJob.chunks].sort((a: any, b: any) => a.index - b.index) : [];

          setSession((prev) => {
            if (!prev || !isSameNovel(prev.fileName, sJob.fileName)) {
              const totalExpected = Math.max(sortedChunks.length, sJob.totalChunks || 0);
              const isAllDone = (sJob.completedChunks === totalExpected && totalExpected > 0) || sJob.status === "completed";
              return {
                fileName: sJob.fileName,
                fileSizeBytes: sJob.fileSizeBytes || 0,
                totalChineseChars: sJob.totalChineseChars || 0,
                chunks: sortedChunks.map((c: any) => ({
                  id: c.id,
                  index: c.index,
                  chapterTitle: c.chapterTitle,
                  chineseText: c.chineseText || "",
                  englishText: c.englishText || "",
                  charCount: c.charCount || 0,
                  wordCount: c.wordCount || 0,
                  status: c.status,
                  hasEnglish: c.hasEnglish,
                  hasChinese: c.hasChinese,
                  attempts: c.attempts,
                  errorMessage: c.errorMessage,
                })),
                style: (sJob.style as TranslationStyle) || "xianxia",
                customInstructions: sJob.customInstructions || "",
                glossary: sJob.glossary || [],
                mode: "cloud",
                status: isAllDone ? "completed" : sJob.status,
                createdAt: sJob.startedAt,
                lastUpdated: sJob.lastActiveAt,
                completedEnglishWords: sJob.completedEnglishWords,
                completedChars: sJob.completedChars,
                lastDownloadedWordCount: prev?.lastDownloadedWordCount,
                lastDownloadedAt: prev?.lastDownloadedAt,
              };
            }

            // Monotonic chapter merge: NEVER downgrade completed local chunks
            const prevChunks = prev.chunks || [];
            // Union by chunk index to ensure that no chunks are ever dropped if server restarted with partial state
            const chunkMap = new Map<number, any>();
            for (const c of prevChunks) {
              chunkMap.set(c.index, { ...c });
            }
            for (const incChunk of sortedChunks) {
              const existing = chunkMap.get(incChunk.index);
              const hasEnglishLocally = existing && existing.status === "completed" && existing.englishText && existing.englishText.trim().length > 0;
              const hasEnglishServer = (incChunk.englishText && incChunk.englishText.trim().length > 0) || incChunk.hasEnglish || (incChunk.wordCount && incChunk.wordCount > 0);

              // Never downgrade completed local chapter text
              const mergedEnglish = (incChunk.englishText && incChunk.englishText.trim().length > 0)
                ? incChunk.englishText
                : (existing?.englishText || "");

              const mergedChinese = incChunk.chineseText !== undefined && incChunk.chineseText.length > 0
                ? incChunk.chineseText
                : (existing?.chineseText || "");

              const isDone = incChunk.status === "completed" || hasEnglishLocally || hasEnglishServer;
              const finalWordCount = incChunk.wordCount ?? existing?.wordCount ?? (mergedEnglish ? countEnglishWords(mergedEnglish) : 0);
              const finalCharCount = incChunk.charCount ?? existing?.charCount ?? 0;

              chunkMap.set(incChunk.index, {
                ...existing,
                ...incChunk,
                chineseText: mergedChinese,
                englishText: mergedEnglish,
                wordCount: finalWordCount,
                charCount: finalCharCount,
                status: isDone ? "completed" : incChunk.status,
              });
            }

            const merged = Array.from(chunkMap.values()).sort((a: any, b: any) => a.index - b.index);

            // Auto-heal only if server lost chunks completely (0 total chunks on server)
            if ((!sJob.totalChunks || sJob.totalChunks === 0) && prevChunks.length > 0) {
              console.log(`[Auto-Rehydrate] Server had 0 chunks vs local ${prevChunks.length}. Sending missing chunks to resume server translation.`);
              fetch("/api/cloud-job/rehydrate-chunks", {
                method: "POST",
                headers: { "Content-Type": "application/json", ...getAuthHeaders() },
                body: JSON.stringify({
                  fileName: prev.fileName,
                  chunks: merged,
                }),
              }).catch((e) => console.warn("Auto-rehydrate background error:", e));
            }

            const totalExpected = Math.max(prevChunks.length, sJob.totalChunks || 0, merged.length);
            const completedCount = merged.filter((c: any) => c.status === "completed").length;
            const isServerCompleted = sJob.status === "completed" || (totalExpected > 0 && sJob.completedChunks === totalExpected);
            const allDone = (totalExpected > 0 && merged.length >= totalExpected && completedCount === totalExpected) || isServerCompleted;
            const finalStatus = isServerCompleted ? "completed" : (allDone ? "completed" : sJob.status);

            chunksRef.current = merged;
            return {
              ...prev,
              status: finalStatus,
              chunks: merged,
              completedEnglishWords: sJob.completedEnglishWords,
              completedChars: sJob.completedChars,
              lastUpdated: Math.max(prev.lastUpdated || 0, sJob.lastActiveAt || 0),
            };
          });

          // If no chunks were returned or summary had missing text, automatically sync texts
          if (sortedChunks.length === 0 || forceFullText || sJob.status === "completed" || sJob.completedChunks === sJob.totalChunks) {
            syncCompletedTexts(true);
          }
        }

        if (typeof sJob.concurrency === "number" && sJob.concurrency >= 1 && sJob.concurrency <= 5) {
          setConcurrency(sJob.concurrency);
          try {
            localStorage.setItem("megatext_concurrency", String(sJob.concurrency));
          } catch {}
        }

        if (sJob.status === "running") {
          // If user just requested pause, do not allow an in-flight status poll to revert UI state
          if (!pauseRequestedRef.current) {
            setIsRunning(true);
            setIsPaused(false);
          }
        } else if (sJob.status === "paused") {
          setIsRunning(false);
          setIsPaused(true);
        } else if (sJob.status === "completed") {
          setIsRunning(false);
          setIsPaused(false);
        }

        if (forceFullText) {
          syncCompletedTexts(true);
        }

        if (showFeedbackToast) {
          const completedCount = sJob.completedChunks || 0;
          const totalCount = sJob.totalChunks || 0;
          const wordsReady = sJob.completedEnglishWords || 0;
          setToastData({
            message: `Synced in ${elapsedMs}ms (~350 B): ${completedCount}/${totalCount} chapters ready (${wordsReady.toLocaleString()} English words)`,
            type: "success",
          });
          setTimeout(() => {
            setToastData((t) => (t && t.message.includes("Synced in") ? null : t));
          }, 3500);
        }
      } else if (showFeedbackToast) {
        setToastData({
          message: `Synced in ${elapsedMs}ms: Workspace is up-to-date`,
          type: "success",
        });
        setTimeout(() => {
          setToastData((t) => (t && t.message.includes("Synced in") ? null : t));
        }, 3000);
      }
    } catch (err) {
      console.warn("Cloud progress sync error:", err);
      if (showFeedbackToast) {
        setToastData({
          message: "Unable to sync progress. Please check your network connection.",
          type: "warning",
        });
      }
    } finally {
      setIsSyncingProgress(false);
    }
  };

  // Auto-check and recover existing cloud job from server on initial load (Lightweight ~350 B mode)
  useEffect(() => {
    syncCloudProgress(false, false);
  }, []);

  // Load existing server job explicitly if requested
  const handleLoadServerJob = () => {
    if (!serverCloudJob) return;
    const sortedChunks = serverCloudJob.chunks ? [...serverCloudJob.chunks].sort((a: any, b: any) => a.index - b.index) : [];
    setSession({
      fileName: serverCloudJob.fileName,
      fileSizeBytes: serverCloudJob.fileSizeBytes || 0,
      totalChineseChars: serverCloudJob.totalChineseChars || 0,
      chunks: sortedChunks,
      style: (serverCloudJob.style as TranslationStyle) || "xianxia",
      customInstructions: serverCloudJob.customInstructions || "",
      glossary: serverCloudJob.glossary || [],
      mode: "cloud",
      status: serverCloudJob.status,
      createdAt: serverCloudJob.startedAt,
      lastUpdated: serverCloudJob.lastActiveAt,
    });
    chunksRef.current = sortedChunks;
    if (serverCloudJob.status === "running") {
      setIsRunning(true);
      setIsPaused(false);
    } else {
      setIsRunning(false);
      setIsPaused(false);
    }
    syncCompletedTexts(true);
  };

  // Tab Visibility & Focus Listener:
  // Saves 99%+ mobile data: Completely pauses polling when mobile screen is locked or tab is hidden.
  // Instantly refreshes with lightweight ~350 byte summary the exact second you open/unlock the tab.
  useEffect(() => {
    if (mode !== "cloud") return;

    let timer: any = null;

    const startPolling = () => {
      if (timer) clearInterval(timer);
      syncCloudProgress(false, false);
      // Poll every 10 seconds ONLY while translation is actively running to save mobile data
      if (isRunning && !isPaused) {
        timer = setInterval(() => {
          if (!document.hidden) {
            syncCloudProgress(false, false);
          }
        }, 10000);
      }
    };

    const stopPolling = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        // Stop polling completely when phone is locked or app is in background to save 100% of mobile background data
        stopPolling();
      } else {
        // Instantly sync all completed progress when phone unlocked or tab reopened
        syncCloudProgress(true, false);
        startPolling();
      }
    };

    const handleFocus = () => {
      syncCloudProgress(true, false);
      startPolling();
    };

    if (!document.hidden) {
      syncCloudProgress(true, false);
      startPolling();
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleFocus);

    return () => {
      stopPolling();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleFocus);
    };
  }, [mode, isRunning, isPaused]);

  // Dynamic Browser Wake-Lock & Keep-Alive (Method 3)
  // When a translation is actively running, sends a tiny keep-alive pulse every 90 seconds
  // Automatically stops immediately when translation completes or is paused so the server can sleep.
  useEffect(() => {
    if (!isRunning || isPaused) return;

    // Optional browser screen wake-lock (keeps phone screen / device active if supported)
    let wakeLockSentinel: any = null;
    if ("wakeLock" in navigator && (navigator as any).wakeLock?.request) {
      (navigator as any).wakeLock.request("screen").then((sentinel: any) => {
        wakeLockSentinel = sentinel;
      }).catch(() => {
        // Wake-lock denied or unsupported; HTTP heartbeat handles container keep-alive
      });
    }

    const keepAliveInterval = setInterval(() => {
      fetch("/api/heartbeat").catch(() => {
        // Silent catch for background heartbeat
      });
    }, 90000); // 90 seconds (well before Cloud Run's 10-15 minute idle timeout)

    return () => {
      clearInterval(keepAliveInterval);
      if (wakeLockSentinel && wakeLockSentinel.release) {
        wakeLockSentinel.release().catch(() => {});
      }
    };
  }, [isRunning, isPaused]);

  // Handle file or text load (with server-side prepare and instant Firestore check)
  const handleLoadText = (
    text: string,
    fileName: string,
    targetChunkChars: number,
    splitByChapters: boolean,
    autoStart: boolean = false
  ) => {
    // 1. Instant client-side preview using exact preserved chunker rules
    const rawChunks = chunkChineseText(text, {
      targetChunkChars,
      splitByChapters,
    });

    const totalChars = countChineseCharacters(text) || text.length;

    const newSession: TranslationSession = {
      fileName,
      fileSizeBytes: new Blob([text]).size,
      totalChineseChars: totalChars,
      chunks: rawChunks,
      style,
      customInstructions,
      glossary,
      mode,
      createdAt: Date.now(),
      lastUpdated: Date.now(),
    };

    userHasResetRef.current = false;
    setServerCloudJob(null);
    setSession(newSession);
    chunksRef.current = rawChunks;
    setIsRunning(false);
    setIsPaused(false);
    setStartTime(null);
    setCharsTranslatedInRun(0);
    saveSessionToIdb(newSession).catch(() => {});

    // 2. Server-side prepare: uploads text once, checks Firestore directly, gets authoritative jobId
    fetch("/api/cloud-job/prepare", {
      method: "POST",
      headers: {
        ...getAuthHeaders(),
        "Content-Type": "application/json",
        "x-novel-filename": encodeURIComponent(fileName),
      },
      body: JSON.stringify({
        rawText: text,
        fileName,
        fileSizeBytes: newSession.fileSizeBytes,
        style,
        customInstructions,
        glossary,
        concurrency,
        targetChunkChars,
        splitByChapters,
        autoStart,
      }),
    })
      .then((res) => res.json())
      .then((prepData) => {
        if (prepData && prepData.success && prepData.jobId) {
          setSession((prev) => {
            if (!prev) return null;
            const updated = { ...prev, jobId: prepData.jobId, id: prepData.jobId };
            saveSessionToIdb(updated).catch(() => {});
            return updated;
          });

          if (prepData.alreadyCompleted) {
            setToastData({
              message: `🎉 Novel "${fileName.replace(/\.txt$/i, "")}" is already 100% translated in Cloud! Restored all ${prepData.totalChunks} chapters.`,
              type: "success",
            });
            syncCloudProgress(true, true, fileName);
          }
        }
      })
      .catch((err) => {
        console.warn("Notice preparing novel job on server:", err);
      });

    if (autoStart) {
      setTimeout(() => {
        startCloudTranslation(newSession);
      }, 300);
    }
  };


  // Safely archive completed novel in history & library, then return to home upload screen to translate another novel
  const handleTranslateAnother = async () => {
    const novelName = session?.fileName || serverCloudJob?.fileName;
    if (session) {
      try {
        await saveSessionToIdb(session);
        addOrUpdateBookInLibrary({
          id: session.fileName,
          title: session.fileName.replace(/\.txt$/i, "").replace(/_/g, " "),
          totalChapters: session.chunks.length,
          completedChapters: session.chunks.filter((c) => c.status === "completed").length,
          coverUrl: (session as any).coverUrl,
          lastReadAt: Date.now(),
        });
      } catch (e) {
        console.warn("Error saving session to library before translating another:", e);
      }
    }

    try {
      await fetch("/api/cloud-job/archive", {
        method: "POST",
        headers: {
          ...getAuthHeaders(),
          "Content-Type": "application/json",
          ...(novelName ? { "x-novel-filename": encodeURIComponent(novelName) } : {}),
        },
        body: JSON.stringify({ fileName: novelName }),
      });
    } catch (e) {
      console.warn("Error archiving cloud job on server:", e);
    }

    userHasResetRef.current = true;
    stopRequestedRef.current = true;
    setIsRunning(false);
    setIsPaused(false);
    setSession(null);
    setServerCloudJob(null);
    chunksRef.current = [];
    localStorage.removeItem(STORAGE_KEY);
    setActiveNavTab("home");

    setToastData({
      message: novelName
        ? `"${novelName.replace(/\.txt$/i, "")}" is saved in History & Cloud Translations! Ready for your next novel.`
        : "Ready to translate another novel.",
      type: "success",
    });
  };

  // Reset workspace / permanently delete novel translation
  const handleReset = async (novelNameToDelete?: any, clearAll: boolean = false) => {
    if (
      isRunning &&
      !window.confirm("Translation is in progress. Are you sure you want to stop and delete?")
    ) {
      return;
    }

    const cleanNovelToDelete =
      typeof novelNameToDelete === "string" && novelNameToDelete.trim()
        ? novelNameToDelete.trim()
        : undefined;

    if (clearAll) {
      userHasResetRef.current = true;
      stopRequestedRef.current = true;
      setIsRunning(false);
      setIsPaused(false);
      setSession(null);
      setServerCloudJob(null);
      setReaderNovel(null);
      chunksRef.current = [];
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem("megatext_user_library_v1");
      clearReadingHistory();
      clearSessionFromIdb().catch(() => {});

      try {
        await fetch("/api/cloud-job/delete", {
          method: "POST",
          headers: {
            ...getAuthHeaders(),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ clearAll: true }),
        });
        setToastData({
          message: "All translations and records permanently cleared.",
          type: "success",
        });
      } catch {}
      return;
    }

    const targetNovel = cleanNovelToDelete || session?.fileName || serverCloudJob?.fileName;
    const targetJobId = serverCloudJob?.id;

    const isResettingCurrentSession =
      !cleanNovelToDelete ||
      (session && isSameNovel(session.fileName, cleanNovelToDelete));

    if (isResettingCurrentSession) {
      userHasResetRef.current = true;
      stopRequestedRef.current = true;
      setIsRunning(false);
      setIsPaused(false);
      setSession(null);
      chunksRef.current = [];
      localStorage.removeItem(STORAGE_KEY);
      clearSessionFromIdb().catch(() => {});
    }

    if (!cleanNovelToDelete || (serverCloudJob && isSameNovel(serverCloudJob.fileName, cleanNovelToDelete))) {
      setServerCloudJob(null);
    }

    if (targetNovel) {
      removeBookFromLibrary(targetNovel);
      removeReadingHistoryItem(targetNovel);
      if (readerNovel && isSameNovel(readerNovel.novelTitle, targetNovel)) {
        setReaderNovel(null);
      }
    }

    try {
      await fetch("/api/cloud-job/delete", {
        method: "POST",
        headers: {
          ...getAuthHeaders(),
          "Content-Type": "application/json",
          ...(targetNovel ? { "x-novel-filename": encodeURIComponent(targetNovel) } : {}),
        },
        body: JSON.stringify({
          fileName: targetNovel,
          jobId: targetJobId,
        }),
      });
      setToastData({
        message: targetNovel ? `Permanently removed "${targetNovel}".` : "Workspace cleared.",
        type: "success",
      });
    } catch {
      // ignore
    }
  };

  // Start cloud translation on server
  const startCloudTranslation = async (customSession?: TranslationSession) => {
    const targetSession = customSession || session;
    if (!targetSession) return;
    setIsStarting(true);

    try {
      // 1. Check if novel is already completed in cloud: restore instantly without retranslation
      if (
        serverCloudJob &&
        isSameNovel(serverCloudJob.fileName, targetSession.fileName) &&
        (serverCloudJob.status === "completed" || ((serverCloudJob as any).totalChunks > 0 && (serverCloudJob as any).completedChunks >= (serverCloudJob as any).totalChunks))
      ) {
        setToastData({
          message: "🎉 Novel Already 100% Translated! Restoring all completed chapters from cloud...",
          type: "success",
        });
        setTimeout(() => setToastData(null), 8000);
        await syncCloudProgress(true, true, targetSession.fileName);
        setIsStarting(false);
        return;
      }

      // 2. Try lightweight resume first ONLY if the server already has a job for this exact same novel
      if (
        serverCloudJob &&
        isSameNovel(serverCloudJob.fileName, targetSession.fileName) &&
        serverCloudJob.status !== "completed"
      ) {
        const resumeRes = await fetch("/api/cloud-job/resume", {
          method: "POST",
          headers: getAuthHeaders(),
        });

        if (resumeRes.ok) {
          const resumeData = await resumeRes.json();
          if (resumeData && resumeData.success) {
            setIsRunning(true);
            setIsPaused(false);
            setToastData({
              message: "☁️ Cloud Mode Resumed: The server is actively translating your novel in the background.",
              type: "success",
            });
            setTimeout(() => setToastData(null), 8000);
            return;
          }
        }
      }

      // 3. Start cloud job (Lightweight payload with instant live Firestore lookup)
      const startPayload: any = {
        jobId: targetSession.jobId || (targetSession as any).id,
        fileName: targetSession.fileName,
        fileSizeBytes: targetSession.fileSizeBytes,
        totalChineseChars: targetSession.totalChineseChars,
        style: targetSession.style || style,
        customInstructions: targetSession.customInstructions || customInstructions,
        glossary: targetSession.glossary || glossary,
        concurrency,
      };

      // If no server jobId was established yet, include chunks as fallback
      if (!targetSession.jobId && (!targetSession.id || !targetSession.id.startsWith("cloud_job_"))) {
        startPayload.chunks = targetSession.chunks;
      }

      const res = await fetch("/api/cloud-job/start", {
        method: "POST",
        headers: {
          ...getAuthHeaders(),
          "Content-Type": "application/json",
          "x-novel-filename": encodeURIComponent(targetSession.fileName),
        },
        body: JSON.stringify(startPayload),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to start cloud job on server");
      }

      if (data.alreadyCompleted) {
        setToastData({
          message: "🎉 Novel Already 100% Translated! Restoring all completed chapters from Cloud...",
          type: "success",
        });
        setTimeout(() => setToastData(null), 8000);
        await syncCloudProgress(true, true, targetSession.fileName);
        return;
      }

      setIsRunning(true);
      setIsPaused(false);

      setToastData({
        message: "☁️ Cloud Mode Activated: The server is translating your novel in the background. You can safely close your browser or turn off your screen anytime. Come back whenever you want to download your chapters!",
        type: "success",
      });
      setTimeout(() => setToastData(null), 10000);
    } catch (err: any) {
      setIsRunning(false);
      setToastData({
        message: "Could not start cloud job: " + (err.message || String(err)),
        type: "error",
      });
      setTimeout(() => setToastData(null), 7000);

    } finally {
      setIsStarting(false);
    }
  };

  // Single chunk translator helper (for Browser Mode or manual steps)
  const translateSingleChunk = async (
    chunk: TextChunk,
    currentGlossary: GlossaryTerm[],
    currentStyle: TranslationStyle,
    instructions: string,
    prevContext?: string
  ): Promise<{ success: boolean; englishText?: string; error?: string }> => {
    try {
      const res = await fetch("/api/translate-chunk", {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({
          text: chunk.chineseText,
          chunkIndex: chunk.index,
          totalChunks: session?.chunks.length || 1,
          previousContext: prevContext,
          glossary: currentGlossary,
          style: currentStyle,
          customInstructions: instructions,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        return {
          success: false,
          error: data.error || `HTTP ${res.status}: Failed to translate`,
        };
      }

      return {
        success: true,
        englishText: data.translatedText,
      };
    } catch (err: any) {
      return {
        success: false,
        error: err.message || "Network error while contacting server",
      };
    }
  };

  // Run in-browser batch translation queue (Option 2 - Strict Sequential "Never-Skip")
  const runBrowserBatch = async () => {
    if (!session) return;
    stopRequestedRef.current = false;
    pauseRequestedRef.current = false;
    setIsRunning(true);
    setIsPaused(false);

    if (!startTime) {
      setStartTime(Date.now());
    }

    const inFlightIds = new Set<string>();
    const numWorkers = 2; // Bounded concurrent browser tasks

    const runWorker = async () => {
      while (!stopRequestedRef.current && !pauseRequestedRef.current) {
        // Find next pending chunk not already being translated
        const chunkToProcess = chunksRef.current.find(
          (c) =>
            (c.status !== "completed" || !c.englishText || !c.englishText.trim()) &&
            !inFlightIds.has(c.id)
        );

        if (!chunkToProcess) {
          if (inFlightIds.size === 0) {
            break;
          }
          await new Promise((r) => setTimeout(r, 400));
          continue;
        }

        inFlightIds.add(chunkToProcess.id);
        updateChunkStatus(chunkToProcess.id, "processing");

        let prevContext = "";
        const prevChunk = chunksRef.current[chunkToProcess.index - 1];
        if (prevChunk && prevChunk.englishText) {
          prevContext = prevChunk.englishText.slice(-200);
        }

        const startChunkTime = Date.now();
        let success = false;
        let attempt = 0;

        while (!success && !stopRequestedRef.current && !pauseRequestedRef.current) {
          attempt++;
          const result = await translateSingleChunk(
            chunkToProcess,
            glossary,
            style,
            customInstructions,
            prevContext
          );

          const duration = Date.now() - startChunkTime;

          if (result.success && result.englishText) {
            updateChunkSuccess(chunkToProcess.id, result.englishText, duration);
            setCharsTranslatedInRun((prev) => prev + chunkToProcess.charCount);
            success = true;
          } else {
            updateChunkError(
              chunkToProcess.id,
              `Attempt ${attempt}: ${result.error || "Translation failed"}. Retrying...`,
              duration
            );
            if (stopRequestedRef.current || pauseRequestedRef.current) break;
            const cooldownMs = Math.min(attempt * 2500, 10000);
            await new Promise((r) => setTimeout(r, cooldownMs));
          }
        }

        inFlightIds.delete(chunkToProcess.id);
        await new Promise((r) => setTimeout(r, 1200));
      }
    };

    await Promise.all(Array.from({ length: numWorkers }, () => runWorker()));

    setIsRunning(false);
    if (pauseRequestedRef.current) {
      setIsPaused(true);
    }
  };

  // Main start handler dispatching based on mode
  const handleStart = () => {
    if (mode === "cloud") {
      startCloudTranslation();
    } else {
      runBrowserBatch();
    }
  };

  // Helpers to update session chunk states cleanly
  const updateChunkStatus = (chunkId: string, status: TextChunk["status"]) => {
    setSession((prev) => {
      if (!prev) return null;
      const nextChunks = prev.chunks.map((c) =>
        c.id === chunkId ? { ...c, status } : c
      );
      chunksRef.current = nextChunks;
      return { ...prev, chunks: nextChunks, lastUpdated: Date.now() };
    });
  };

  const updateChunkSuccess = (
    chunkId: string,
    englishText: string,
    durationMs: number
  ) => {
    setSession((prev) => {
      if (!prev) return null;
      const nextChunks = prev.chunks.map((c) =>
        c.id === chunkId
          ? {
              ...c,
              englishText,
              status: "completed" as const,
              durationMs,
              errorMessage: undefined,
            }
          : c
      );
      chunksRef.current = nextChunks;
      return { ...prev, chunks: nextChunks, lastUpdated: Date.now() };
    });
  };

  const updateChunkError = (
    chunkId: string,
    errorMessage: string,
    durationMs: number
  ) => {
    setSession((prev) => {
      if (!prev) return null;
      const nextChunks = prev.chunks.map((c) =>
        c.id === chunkId
          ? {
              ...c,
              status: "error" as const,
              errorMessage,
              durationMs,
            }
          : c
      );
      chunksRef.current = nextChunks;
      return { ...prev, chunks: nextChunks, lastUpdated: Date.now() };
    });
  };

  // Translate a specific chunk on demand
  const handleTranslateSpecificChunk = async (chunkId: string) => {
    const chunk = chunksRef.current.find((c) => c.id === chunkId);
    if (!chunk) return;

    updateChunkStatus(chunkId, "processing");

    let prevContext = "";
    const prevChunk = chunksRef.current[chunk.index - 1];
    if (prevChunk && prevChunk.englishText) {
      prevContext = prevChunk.englishText.slice(-200);
    }

    const startChunkTime = Date.now();
    try {
      const result = await translateSingleChunk(
        chunk,
        glossary,
        style,
        customInstructions,
        prevContext
      );
      const duration = Date.now() - startChunkTime;

      if (result.success && result.englishText && result.englishText.trim()) {
        updateChunkSuccess(chunkId, result.englishText, duration);
        // Sync immediately with the server's cloud job so polling doesn't overwrite it
        await fetch("/api/cloud-job/update-chunk", {
          method: "POST",
          headers: getAuthHeaders(),
          body: JSON.stringify({
            chunkId,
            englishText: result.englishText,
            status: "completed",
          }),
        }).catch(() => {});
        setToastData({
          message: `✨ Chapter #${chunk.index + 1} translated successfully! (${countEnglishWords(result.englishText)} words)`,
          type: "success",
        });
        setTimeout(() => setToastData(null), 4000);
      } else {
        updateChunkError(chunkId, result.error || "Translation returned empty text", duration);
        setToastData({
          message: `⚠️ Chapter #${chunk.index + 1} error: ${result.error || "Empty response from AI"}`,
          type: "error",
        });
        setTimeout(() => setToastData(null), 6000);
      }
    } catch (e: any) {
      updateChunkError(chunkId, e.message || "Failed to translate", Date.now() - startChunkTime);
    }
  };

  // Translate next single chunk for testing
  const handleTranslateNextSingle = () => {
    const nextChunk = chunksRef.current.find(
      (c) => c.status === "pending" || c.status === "error"
    );
    if (nextChunk) {
      handleTranslateSpecificChunk(nextChunk.id);
    }
  };

  // Pause translation
  const handlePause = async (novelFileName?: any) => {
    const cleanNovelName =
      typeof novelFileName === "string" && novelFileName.trim()
        ? novelFileName.trim()
        : session?.fileName;

    // Instantly transition UI to paused so button switches to Resume without lag
    pauseRequestedRef.current = true;
    setIsPaused(true);
    setIsRunning(false);
    setSession((prev) => (prev ? { ...prev, status: "paused", lastUpdated: Date.now() } : null));

    if (mode === "cloud" || cleanNovelName) {
      try {
        const headers: Record<string, string> = { ...getAuthHeaders() };
        if (cleanNovelName) {
          headers["x-novel-filename"] = encodeURIComponent(cleanNovelName);
        }
        await fetch("/api/cloud-job/pause", {
          method: "POST",
          headers,
          body: JSON.stringify({ fileName: cleanNovelName }),
        });
      } catch (err) {
        console.warn("Pause cloud job error:", err);
      }
    }
  };

  // Resume translation
  const handleResume = async (novelFileName?: any) => {
    const cleanNovelName =
      typeof novelFileName === "string" && novelFileName.trim()
        ? novelFileName.trim()
        : session?.fileName;

    pauseRequestedRef.current = false;
    setIsPaused(false);
    setIsRunning(true);
    setSession((prev) => (prev ? { ...prev, status: "running", lastUpdated: Date.now() } : null));

    if (mode === "cloud" || cleanNovelName) {
      try {
        const headers: Record<string, string> = { ...getAuthHeaders() };
        if (cleanNovelName) {
          headers["x-novel-filename"] = encodeURIComponent(cleanNovelName);
        }
        await fetch("/api/cloud-job/resume", {
          method: "POST",
          headers,
          body: JSON.stringify({ fileName: cleanNovelName }),
        });
      } catch (err) {
        console.warn("Resume cloud job error:", err);
      }
      setTimeout(() => {
        syncCloudProgress(true, false, cleanNovelName);
      }, 400);
    } else {
      runBrowserBatch();
    }
  };

  // Translate New Novel (Pause and preserve current novel progress in Cloud History, clear workspace for a new novel)
  const handleTranslateNewNovel = async () => {
    if (session) {
      const curFileName = session.fileName;
      // 1. Pause on server
      try {
        const headers: Record<string, string> = { ...getAuthHeaders() };
        if (curFileName) {
          headers["x-novel-filename"] = encodeURIComponent(curFileName);
        }
        await fetch("/api/cloud-job/pause", {
          method: "POST",
          headers,
          body: JSON.stringify({ fileName: curFileName }),
        });
      } catch (err) {
        console.warn("Pause cloud job error:", err);
      }

      // 2. Persist paused state into IndexedDB storage so no chapters are lost
      const pausedSession: TranslationSession = {
        ...session,
        status: session.status === "completed" ? "completed" : "paused",
        lastUpdated: Date.now(),
      };
      await saveSessionToIdb(pausedSession).catch(() => {});

      // 3. Clear workspace without deleting from history
      pauseRequestedRef.current = true;
      setIsRunning(false);
      setIsPaused(true);
      setSession(null);
      setServerCloudJob(null);
      chunksRef.current = [];
      userHasResetRef.current = true;

      // 4. Navigate to home / upload screen
      setActiveNavTab("home");

      // 5. Toast notification
      setToastData({
        message: `"${curFileName}" progress was saved to Cloud History. You can start translating a new novel or resume anytime!`,
        type: "success",
      });
    } else {
      setActiveNavTab("home");
    }
  };

  // Retry all failed chunks
  const handleRetryFailed = () => {
    setSession((prev) => {
      if (!prev) return null;
      const nextChunks = prev.chunks.map((c) =>
        c.status === "error" ? { ...c, status: "pending" as const } : c
      );
      chunksRef.current = nextChunks;
      return { ...prev, chunks: nextChunks };
    });
    setTimeout(() => {
      if (mode === "cloud") {
        startCloudTranslation();
      } else {
        runBrowserBatch();
      }
    }, 100);
  };

  // Update English text from manual inline edit
  const handleUpdateChunkText = (chunkId: string, newEnglishText: string) => {
    setSession((prev) => {
      if (!prev) return null;
      const nextChunks = prev.chunks.map((c) =>
        c.id === chunkId
          ? { ...c, englishText: newEnglishText, edited: true }
          : c
      );
      chunksRef.current = nextChunks;
      return { ...prev, chunks: nextChunks, lastUpdated: Date.now() };
    });

    if (mode === "cloud") {
      fetch("/api/cloud-job/update-chunk", {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({ chunkId, englishText: newEnglishText }),
      }).catch(() => {});
    }
  };

  // Open Export Modal with automated background text synchronization if in cloud mode
  const handleOpenExport = async () => {
    if (mode === "cloud" || chunksRef.current.length === 0 || chunksRef.current.some(c => c.status === "completed" && !c.englishText?.trim())) {
      await syncCompletedTexts(true);
    }
    setIsExportOpen(true);
  };

  // Dedicated progress downloader: downloads strictly the unbroken continuous chapters from Chapter 1 without stopping background translation
  const handleDownloadProgress = async (format: "epub" | "txt" = "epub") => {
    if (!session) return;
    let currentChunks = chunksRef.current;
    if (mode === "cloud" || currentChunks.length === 0 || currentChunks.some(c => c.status === "completed" && !c.englishText?.trim())) {
      const synced = await syncCompletedTexts(true);
      if (synced && synced.length > 0) {
        currentChunks = synced;
      }
    }
    if (currentChunks.length === 0) {
      currentChunks = session.chunks;
    }

    const continuity = analyzeChunkContinuity(currentChunks);
    let continuousList = continuity.continuousChunks;

    // If continuousList is empty (e.g. index 0 title issue) but we have completed chunks, use allCompletedChunks
    if (continuousList.length === 0 && continuity.allCompletedChunks.length > 0) {
      continuousList = continuity.allCompletedChunks;
    }

    if (continuousList.length === 0) {
      // Direct server-side download attempt
      if (mode === "cloud") {
        try {
          const downloadUrl = format === "epub" ? "/api/cloud-job/download-epub" : "/api/cloud-job/download-txt";
          window.location.href = downloadUrl;
          setToastData({
            message: `Starting direct server download for ${format.toUpperCase()}...`,
            type: "success",
          });
          setTimeout(() => setToastData(null), 5000);
          return;
        } catch {}
      }

      setToastData({
        message:
          "Chapter 1 has not completed translation yet. The Never-Skip Engine guarantees all downloaded books start from Chapter 1 with zero gaps. Please wait for Chapter 1 to finish!",
        type: "warning",
      });
      setTimeout(() => setToastData(null), 6000);
      return;
    }

    const wordsCount = continuousList.reduce(
      (acc, c) => acc + countEnglishWords(c.englishText),
      0
    );

    const baseName = session.fileName.replace(/\.[^/.]+$/, "") || "translated_novel";

    try {
      if (format === "epub") {
        const res = await downloadEpub(continuousList, session.fileName, {
          bookTitle: baseName.replace(/_/g, " "),
          allowGaps: true,
        });

        // Save that user downloaded up to this point so we can track incremental new words
        setSession((prev) =>
          prev
            ? {
                ...prev,
                lastDownloadedWordCount: wordsCount,
                lastDownloadedAt: Date.now(),
              }
            : null
        );

        const aheadNotice =
          continuity.aheadCompletedCount > 0
            ? ` (${continuity.aheadCompletedCount} upcoming chapter(s) ready ahead)`
            : "";

        setToastData({
          message: `EPUB eBook "${res.filename}" (Chapters 1–${continuousList.length}, ${wordsCount.toLocaleString()} words)${aheadNotice} prepared! Background translation continues uninterrupted.`,
          downloadUrl: res.downloadUrl,
          filename: res.filename,
          type: "success",
        });
        setTimeout(() => setToastData(null), 8000);
        return;
      }

      // Plain TXT export strictly contiguous
      const startCh = continuousList[0].chapterTitle || `Part 1`;
      const lastCh =
        continuousList[continuousList.length - 1].chapterTitle ||
        `Part ${continuousList.length}`;

      const header = `================================================================================
TRANSLATION PROGRESS SNAPSHOT: ${session.fileName}
Total English Words Translated (Continuous Sequence): ${wordsCount.toLocaleString()} words
Completed Frontier: Chapters 1 through ${continuousList.length} of ${session.chunks.length} total
Coverage: ${startCh} → ${lastCh}
Background Translation Status: ACTIVE & RUNNING UNINTERRUPTED
Export Timestamp: ${new Date().toLocaleString()}
================================================================================\n\n`;

      const body = continuousList
        .map((c) => {
          const title = c.chapterTitle
            ? `${c.chapterTitle}\n\n`
            : `Section ${c.index + 1}\n\n`;
          return `${title}${c.englishText.trim()}`;
        })
        .join("\n\n\n");

      const fullContent = header + body;
      const wordSuffix =
        wordsCount >= 1000
          ? `${(wordsCount / 1000).toFixed(1)}k_words`
          : `${wordsCount}_words`;
      const downloadName = `${baseName}_continuous_ch1_to_${continuousList.length}_${wordSuffix}.txt`;

      const res = await downloadFile(fullContent, downloadName, "text/plain;charset=utf-8");

      setSession((prev) =>
        prev
          ? {
              ...prev,
              lastDownloadedWordCount: wordsCount,
              lastDownloadedAt: Date.now(),
            }
          : null
      );

      const aheadNotice =
        continuity.aheadCompletedCount > 0
          ? ` (${continuity.aheadCompletedCount} upcoming chapter(s) ready ahead)`
          : "";

      setToastData({
        message: `TXT continuous snapshot "${downloadName}" (Chapters 1–${continuousList.length}, ${wordsCount.toLocaleString()} words)${aheadNotice} prepared! Background translation continues uninterrupted.`,
        downloadUrl: res.downloadUrl,
        filename: downloadName,
        type: "success",
      });
      setTimeout(() => setToastData(null), 8000);
    } catch (err: any) {
      console.warn("Client generation encountered error, trying direct server download:", err);
      if (mode === "cloud") {
        window.location.href = format === "epub" ? "/api/cloud-job/download-epub" : "/api/cloud-job/download-txt";
      } else {
        setToastData({
          message: "Download failed: " + (err.message || String(err)),
          type: "error",
        });
        setTimeout(() => setToastData(null), 6000);
      }
    }
  };

  // Calculate real-time metrics
  const hasMatchingServerJob = serverCloudJob && session && isSameNovel(serverCloudJob.fileName, session.fileName);
  const totalChunks = session?.chunks.length || (hasMatchingServerJob ? serverCloudJob.totalChunks : 0) || 0;
  const isJobFinished =
    session?.status === "completed" ||
    (hasMatchingServerJob && (serverCloudJob.status === "completed" || (serverCloudJob.completedChunks >= totalChunks && totalChunks > 0)));
  const completedChunks = isJobFinished && totalChunks > 0
    ? totalChunks
    : Math.max(
        (hasMatchingServerJob ? serverCloudJob.completedChunks : 0) || 0,
        session?.chunks.filter((c) => c.status === "completed").length || 0
      );
  const inProgressChunks =
    session?.chunks.filter((c) => c.status === "processing").length || 0;
  const errorChunks =
    session?.chunks.filter((c) => c.status === "error").length || 0;

  const totalChineseChars = session?.totalChineseChars || (hasMatchingServerJob ? serverCloudJob.totalChineseChars : 0) || 0;
  const completedChars = Math.max(
    (hasMatchingServerJob ? serverCloudJob.completedChars : 0) || 0,
    session?.completedChars || 0,
    session?.chunks
      .filter((c) => c.status === "completed")
      .reduce((acc, curr) => acc + (curr.charCount || 0), 0) || 0
  );

  // Calculate total English words produced so far:
  // Dynamically uses server calculation, session metric, or chunk wordCount/englishText
  const calculatedChunkWords = session?.chunks
    .filter((c) => c.status === "completed")
    .reduce(
      (acc, curr) =>
        acc + (curr.wordCount || (curr.englishText ? countEnglishWords(curr.englishText) : 0)),
      0
    ) || 0;

  const completedEnglishWords = Math.max(
    (hasMatchingServerJob ? serverCloudJob.completedEnglishWords : 0) || 0,
    session?.completedEnglishWords || 0,
    calculatedChunkWords
  );

  const lastDownloadedWordCount = session?.lastDownloadedWordCount || 0;
  const newWordsSinceLastDownload = Math.max(
    0,
    completedEnglishWords - lastDownloadedWordCount
  );

  const elapsedMs = startTime ? Date.now() - startTime : 0;
  const charsPerSec =
    elapsedMs > 1000 && charsTranslatedInRun > 0
      ? (charsTranslatedInRun / elapsedMs) * 1000
      : 0;

  const remainingChars = Math.max(0, totalChineseChars - completedChars);
  const estimatedRemainingSeconds =
    charsPerSec > 0 ? remainingChars / charsPerSec : 0;

  // Explicit completion flag: verified ONLY if all chunks are finished and totalChunks matches
  const isCompleted =
    totalChunks > 0 &&
    completedChunks >= totalChunks &&
    (session?.status === "completed" ||
      Boolean(hasMatchingServerJob && serverCloudJob.status === "completed") ||
      completedChunks === totalChunks);

  // Dynamic document title reflecting progress or 100% completion
  useEffect(() => {
    if (isCompleted && session) {
      document.title = `✅ [Completed] ${session.fileName} - MegaText Translator`;
    } else if (isRunning && session) {
      const pct = totalChunks > 0 ? Math.round((completedChunks / totalChunks) * 100) : 0;
      document.title = `⚡ [${pct}%] Translating ${session.fileName} - MegaText`;
    } else if (session) {
      document.title = `${session.fileName} - MegaText Translator`;
    } else {
      document.title = "MegaText Chinese to English Translator";
    }
  }, [isCompleted, isRunning, completedChunks, totalChunks, session?.fileName]);

  const metrics: TranslationMetrics = {
    totalChars: totalChineseChars,
    completedChars,
    totalChunks,
    completedChunks,
    inProgressChunks,
    errorChunks,
    completedEnglishWords,
    lastDownloadedWordCount,
    newWordsSinceLastDownload,
    startTime,
    elapsedMs,
    charsPerSecond: charsPerSec,
    estimatedRemainingSeconds,
  };

  if (isCheckingAuth) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center text-slate-300">
        <div className="flex items-center gap-3 bg-slate-900/90 px-6 py-4 rounded-2xl border border-slate-800 shadow-2xl">
          <RefreshCw className="w-5 h-5 animate-spin text-purple-400" />
          <span className="text-sm font-semibold text-slate-200">Checking security status...</span>
        </div>
      </div>
    );
  }

  if (authStatus?.requiresPasscode && !authStatus?.passcodeVerified) {
    return (
      <React.Suspense
        fallback={
          <div className="min-h-screen bg-slate-950 flex items-center justify-center text-slate-300">
            <div className="flex items-center gap-3 bg-slate-900/90 px-6 py-4 rounded-2xl border border-slate-800 shadow-2xl">
              <RefreshCw className="w-5 h-5 animate-spin text-purple-400" />
              <span className="text-sm font-semibold text-slate-200">Loading security gate...</span>
            </div>
          </div>
        }
      >
        <PasswordGate
          onUnlockSuccess={(token) => {
            if (token) {
              try {
                localStorage.setItem("megatext_auth_token", token);
              } catch {}
            }
            setAuthStatus({
              authenticated: true,
              requiresGoogle: false,
              requiresPasscode: true,
              googleVerified: true,
              passcodeVerified: true,
              hasPasscodeConfigured: true,
            });
            // Auto-fetch progress immediately on password unlock: loads the latest cloud job status and full texts
            syncCloudProgress(true, false);
          }}
        />
      </React.Suspense>
    );
  }

  return (
    <div className="min-h-screen w-full overflow-x-clip bg-[#FAF8FE] dark:bg-slate-950 text-slate-900 dark:text-slate-100 flex flex-col font-sans transition-colors duration-200 relative selection:bg-purple-200 selection:text-purple-900">
      {/* Pagoda Landscape Header Backdrop (Illustrated Storybook Spec) */}
      <PagodaHeaderIllustration />

      {/* Navigation header */}
      <Navbar
        hasFile={!!session}
        totalChars={totalChineseChars}
        completedChars={completedChars}
        isCompleted={isCompleted}
        isRunning={isRunning}
        completedChunks={completedChunks}
        totalChunks={totalChunks}
        onReset={handleReset}
        onOpenGlossary={() => setIsGlossaryOpen(true)}
        onOpenTelegramSettings={() => setIsTelegramSettingsOpen(true)}
        onOpenSettings={() => setIsTelegramSettingsOpen(true)}
        glossaryCount={glossary.length}
        theme={theme}
        onToggleTheme={toggleTheme}
      />

      {/* Main Screen Canvas */}
      <main className={`flex-1 w-full mx-auto px-3 sm:px-4 pt-3 pb-24 relative ${
        activeNavTab === "store" || activeNavTab === "explore" || activeNavTab === "library" ? "max-w-4xl" : "max-w-md"
      }`}>
        <React.Suspense
          fallback={
            <div className="flex flex-col items-center justify-center py-24 text-slate-400 dark:text-slate-500">
              <RefreshCw className="h-7 w-7 animate-spin text-purple-600 mb-3" />
              <span className="text-xs font-semibold tracking-wide uppercase">Loading View...</span>
            </div>
          }
        >
          {/* Library Tab View (Personal Bookshelf & Reading Progress) */}
          <div className={activeNavTab === "library" ? "block" : "hidden"}>
            <LibraryView
              onOpenReader={handleOpenReader}
              onSearchStore={(keyword, site = "aiqu226") => {
                setStoreSearchTrigger({ query: keyword, site, timestamp: Date.now() });
                setActiveNavTab("store");
              }}
              onTranslateWholeBook={(book) => {
                // Redirect to store to download full chapters or start translation
                setStoreSearchTrigger({ query: book.title, site: "all", timestamp: Date.now() });
                setActiveNavTab("store");
              }}
              onDeleteNovel={(novelTitle) => handleReset(novelTitle)}
              getAuthHeaders={getAuthHeaders}
            />
          </div>

          {/* Store Tab View */}
          <div className={activeNavTab === "store" ? "block" : "hidden"}>
            <StoreView
              onImportNovel={(title, rawText, autoStart) => {
                handleLoadText(rawText, title, 3000, true, autoStart);
                setActiveNavTab("home");
              }}
              getAuthHeaders={getAuthHeaders}
              externalSearchTrigger={storeSearchTrigger}
              onOpenReader={handleOpenReader}
            />
          </div>

          {/* Explore & Leaderboards Tab View */}
          <div className={activeNavTab === "explore" ? "block" : "hidden"}>
            <ExploreView
              onImportNovel={(title, rawText, autoStart) => {
                handleLoadText(rawText, title, 3000, true, autoStart);
                setActiveNavTab("home");
              }}
              getAuthHeaders={getAuthHeaders}
              onSearchStore={(keyword, site = "aiqu226") => {
                setStoreSearchTrigger({ query: keyword, site, timestamp: Date.now() });
                setActiveNavTab("store");
              }}
              onOpenReader={handleOpenReader}
            />
          </div>
        </React.Suspense>

        {/* Home Tab Views (Upload / Translating / Completed) */}
        <div className={activeNavTab === "home" ? "block" : "hidden"}>
          {!session ? (
            /* Screen 1: Upload / Setup Screen (Reference Screen 1) */
            <UploadSection
              onLoadText={handleLoadText}
              serverJob={serverCloudJob}
              onLoadServerJob={handleLoadServerJob}
              onDeleteServerJob={() => {
                if (serverCloudJob) {
                  handleReset(serverCloudJob.fileName);
                }
              }}
            />
          ) : isCompleted ? (
            /* Screen 3: Dedicated Translation Complete Screen (Reference Screen 3) */
            <TranslationCompleteView
              session={session}
              metrics={metrics}
              mode={mode}
              style={style}
              concurrency={concurrency}
              onDownloadProgress={handleDownloadProgress}
              onOpenExport={handleOpenExport}
              onReset={handleReset}
              onTranslateAnother={handleTranslateAnother}
              onSyncProgress={() => syncCloudProgress(false, true)}
              isSyncing={isSyncingProgress}
              onOpenReader={handleOpenCurrentSessionReader}
            />
          ) : (
            /* Screen 2: Active Translation Screen (Reference Screen 2) */
            <ActiveTranslationView
              session={session}
              metrics={metrics}
              mode={mode}
              onChangeMode={handleModeChange}
              style={style}
              onChangeStyle={(s) => {
                setStyle(s);
                setSession((prev) => (prev ? { ...prev, style: s } : null));
              }}
              customInstructions={customInstructions}
              onChangeCustomInstructions={(inst) => {
                setCustomInstructions(inst);
                setSession((prev) =>
                  prev ? { ...prev, customInstructions: inst } : null
                );
              }}
              concurrency={concurrency}
              onChangeConcurrency={(newConc) => {
                setConcurrency(newConc);
                try {
                  localStorage.setItem("megatext_concurrency", String(newConc));
                } catch {}
                if (mode === "cloud" && session) {
                  fetch("/api/cloud-job/update-settings", {
                    method: "POST",
                    headers: getAuthHeaders(),
                    body: JSON.stringify({ concurrency: newConc }),
                  }).catch(() => {});
                }
              }}
              isRunning={isRunning}
              isPaused={isPaused}
              isStarting={isStarting}
              onStart={handleStart}
              onPause={handlePause}
              onResume={handleResume}
              onTranslateNext={handleTranslateNextSingle}
              onRetryFailed={handleRetryFailed}
              onOpenExport={handleOpenExport}
              onDownloadProgress={handleDownloadProgress}
              onTranslateChunk={handleTranslateSpecificChunk}
              onReset={handleReset}
              onTranslateNewNovel={handleTranslateNewNovel}
              completedEnglishWords={completedEnglishWords}
              lastDownloadedWords={lastDownloadedWordCount}
              onSyncProgress={() => syncCloudProgress(false, true)}
              isSyncing={isSyncingProgress}
              onOpenReader={handleOpenCurrentSessionReader}
              firestoreStatus={firestoreStatus}
              aiCooldownSecondsRemaining={aiCooldownSec}
            />
          )}
        </div>
      </main>

      {/* Floating Sakura Petals Bottom Decoration */}
      <SakuraFooterDecoration />

      {/* Fixed Bottom Navigation (Reference Screen 1, 2, 3) */}
      <BottomNav
        activeTab={activeNavTab}
        onChangeTab={handleBottomNavChange}
      />

      {/* Lazy Modal Suspense Boundary */}
      <React.Suspense fallback={null}>
        {/* History Drawer Modal */}
        <HistoryModal
          isOpen={isHistoryOpen}
          onClose={() => {
            setIsHistoryOpen(false);
            setActiveNavTab("home");
          }}
          session={session}
          onDownloadProgress={handleDownloadProgress}
          onReset={handleReset}
          getAuthHeaders={getAuthHeaders}
          onSelectNovel={async (fileName, autoResume) => {
            userHasResetRef.current = false;
            await syncCloudProgress(true, true, fileName);
            setActiveNavTab("home");
            if (autoResume) {
              setTimeout(() => {
                handleResume(fileName);
                setToastData({
                  message: `Resumed translation of "${fileName}".`,
                  type: "success",
                });
              }, 400);
            }
          }}
          onOpenReader={handleOpenReader}
        />

        {/* Terminology & Glossary Modal */}
        <GlossaryModal
          isOpen={isGlossaryOpen}
          onClose={() => setIsGlossaryOpen(false)}
          glossary={glossary}
          onSaveGlossary={(newGlossary) => {
            setGlossary(newGlossary);
            setSession((prev) =>
              prev ? { ...prev, glossary: newGlossary } : null
            );
          }}
          sampleChineseText={session?.chunks[0]?.chineseText || ""}
        />

        {/* Export & Download Modal */}
        {session && (
          <ExportModal
            isOpen={isExportOpen}
            onClose={() => setIsExportOpen(false)}
            chunks={session.chunks}
            fileName={session.fileName}
          />
        )}

        {/* Telegram Notifications Settings Modal */}
        <TelegramSettingsModal
          isOpen={isTelegramSettingsOpen}
          onClose={() => {
            setIsTelegramSettingsOpen(false);
            setActiveNavTab("home");
          }}
        />

        {/* Novel Reader Modal & Minimized Background Player */}
        {readerNovel && (
          <NovelReaderModal
            key={`${readerNovel.novelTitle}__${readerNovel.novelUrl || readerNovel.siteId || ""}`}
            isOpen={isReaderOpen}
            isMinimized={isReaderMinimized}
            onClose={handleCloseReader}
            onToggleMinimize={() => setIsReaderMinimized((prev) => !prev)}
            onUpdateChapterIndex={(chapterIndex, chapterTitle, allChapters, content, englishContent) => {
              setReaderNovel((prev) => {
                if (!prev) return null;
                return {
                  ...prev,
                  chapterIndex,
                  ...(allChapters && allChapters.length > 0 ? { allChapters } : {}),
                  ...(content ? { content } : {}),
                  ...(englishContent !== undefined ? { englishContent } : {}),
                };
              });
            }}
            novelTitle={readerNovel.novelTitle}
            author={readerNovel.author}
            coverUrl={readerNovel.coverUrl}
            novelUrl={readerNovel.novelUrl}
            siteId={readerNovel.siteId}
            initialChapterIndex={readerNovel.chapterIndex || 1}
            totalChapters={readerNovel.totalChapters || 1}
            allChapters={readerNovel.allChapters}
            initialContent={readerNovel.content}
            initialEnglishContent={readerNovel.englishContent}
            getAuthHeaders={getAuthHeaders}
            sessionChunks={
              session &&
              isSameNovel(session.fileName, readerNovel.novelTitle)
                ? currentSessionReaderChunks
                : undefined
            }
            onImportNovel={() => {
              if (readerNovel.novelTitle) {
                setStoreSearchTrigger({ query: readerNovel.novelTitle, timestamp: Date.now() });
                setActiveNavTab("store");
                setIsReaderOpen(false);
              }
            }}
          />
        )}
      </React.Suspense>

      {/* Floating Toast notification when user downloads progress or gets a status alert */}
      {toastData && (
        <div className={`fixed bottom-5 left-4 right-4 sm:left-auto sm:right-6 z-50 flex max-w-md flex-col gap-2 rounded-2xl border p-4 text-xs shadow-2xl backdrop-blur-xs animate-in fade-in slide-in-from-bottom-4 ${
          toastData.type === "error"
            ? "border-rose-300 bg-rose-900/95 text-rose-100"
            : toastData.type === "warning"
            ? "border-amber-300 bg-amber-900/95 text-amber-100"
            : "border-emerald-300 bg-emerald-900/95 text-emerald-100"
        }`}>
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2">
              {toastData.type === "error" || toastData.type === "warning" ? (
                <AlertTriangle className="h-4 w-4 shrink-0 text-amber-300 mt-0.5" />
              ) : (
                <CheckCircle className="h-4 w-4 shrink-0 text-emerald-300 mt-0.5" />
              )}
              <span className="leading-relaxed font-medium">{toastData.message}</span>
            </div>
            <button
              onClick={() => setToastData(null)}
              className="rounded-lg p-1 text-slate-300 hover:bg-black/20 hover:text-white cursor-pointer"
            >
              ✕
            </button>
          </div>

          {toastData.downloadUrl && (
            <div className="mt-1 flex items-center gap-2 border-t border-white/15 pt-2">
              <a
                href={toastData.downloadUrl}
                target="_blank"
                rel="noopener noreferrer"
                download={toastData.filename}
                className="inline-flex items-center gap-1.5 rounded-xl bg-white/20 px-3 py-1.5 font-bold text-white hover:bg-white/30 transition"
              >
                <Download className="h-3.5 w-3.5" />
                <span>Direct Download Link (New Tab)</span>
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
