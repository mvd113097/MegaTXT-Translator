import React, { useEffect, useState } from "react";
import {
  Clock,
  X,
  BookOpen,
  CheckCircle2,
  Download,
  Trash2,
  Play,
  FileText,
  AlertTriangle,
  RotateCw,
  Loader2,
  Check,
  BookMarked,
  Sparkles,
} from "lucide-react";
import { TranslationSession } from "../types";
import {
  getReadingHistory,
  removeReadingHistoryItem,
  clearReadingHistory,
  removeBookFromLibrary,
  ReadingHistoryItem,
} from "../utils/indexedDbStorage";
import { isSameNovel } from "../utils/chunkCleaner";

interface StoredNovel {
  id: string;
  sessionId: string;
  fileName: string;
  status: "pending" | "running" | "paused" | "completed" | "error" | "stopped" | "idle";
  completedChunks: number;
  totalChunks: number;
  wordCount: number;
  lastActiveAt: number;
  startedAt: number;
}

interface HistoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  session: TranslationSession | null;
  onDownloadProgress: (format?: "epub" | "txt") => void;
  onReset: (novelName?: string, clearAll?: boolean) => void;
  getAuthHeaders?: () => Record<string, string>;
  onSelectNovel?: (fileName: string, autoResume?: boolean) => void;
  onOpenReader?: (novel: {
    novelTitle: string;
    author?: string;
    coverUrl?: string;
    novelUrl?: string;
    siteId?: string;
    chapterIndex?: number;
    totalChapters?: number;
  }) => void;
}

export const HistoryModal: React.FC<HistoryModalProps> = ({
  isOpen,
  onClose,
  session,
  onDownloadProgress,
  onReset,
  getAuthHeaders,
  onSelectNovel,
  onOpenReader,
}) => {
  const [activeTab, setActiveTab] = useState<"reading" | "cloud">("reading");
  const [readingHistory, setReadingHistory] = useState<ReadingHistoryItem[]>([]);
  const [novels, setNovels] = useState<StoredNovel[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [isClearingAll, setIsClearingAll] = useState(false);

  const refreshReadingHistory = () => {
    const deletedSet = getLocalDeletedNovels();
    const raw = getReadingHistory();
    const filtered = raw.filter((item) => {
      const title = (item.title || "").trim().toLowerCase();
      const id = (item.id || "").trim().toLowerCase();
      if (deletedSet.has(title) || deletedSet.has(id)) return false;
      for (const del of deletedSet) {
        if (isSameNovel(del, title) || isSameNovel(del, id)) return false;
      }
      return true;
    });
    setReadingHistory(filtered);
  };

  const getLocalDeletedNovels = (): Set<string> => {
    const set = new Set<string>();
    try {
      const saved = localStorage.getItem("megatext_deleted_novels");
      if (saved) {
        const arr = JSON.parse(saved);
        if (Array.isArray(arr)) {
          for (const item of arr) if (item) set.add(String(item).trim().toLowerCase());
        }
      }
    } catch {}
    return set;
  };

  const addLocalDeletedNovel = (key: string) => {
    if (!key) return;
    try {
      const set = getLocalDeletedNovels();
      const cleanKey = key.trim().toLowerCase();
      set.add(cleanKey);
      set.add(cleanKey.replace(/\.(txt|epub|pdf|json)$/i, "").trim().toLowerCase());
      localStorage.setItem("megatext_deleted_novels", JSON.stringify(Array.from(set)));
    } catch {}
  };

  const fetchNovels = async () => {
    if (!isOpen) return;
    setIsLoading(true);
    try {
      const deletedSet = getLocalDeletedNovels();
      const headers = getAuthHeaders ? getAuthHeaders() : {};
      const res = await fetch("/api/cloud-job/list", { headers });
      const data = await res.json();
      if (data.success && Array.isArray(data.novels)) {
        const filtered = data.novels.filter((n: StoredNovel) => {
          const fn = (n.fileName || "").trim().toLowerCase();
          const id = (n.id || "").trim().toLowerCase();
          if (deletedSet.has(fn) || deletedSet.has(id)) return false;
          for (const del of deletedSet) {
            if (isSameNovel(del, fn)) return false;
          }
          return true;
        });
        setNovels(filtered);
      }
    } catch (err) {
      console.warn("Failed to fetch novels list:", err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      refreshReadingHistory();
      fetchNovels();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleDeleteHistoryItem = (item: ReadingHistoryItem, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const targetKey = item.id || item.title;
    addLocalDeletedNovel(targetKey);
    addLocalDeletedNovel(item.title);
    if (item.id) addLocalDeletedNovel(item.id);
    removeReadingHistoryItem(targetKey);
    removeReadingHistoryItem(item.title);
    removeBookFromLibrary(targetKey);
    removeBookFromLibrary(item.title);
    setReadingHistory((prev) => prev.filter((h) => h.id !== targetKey && h.title !== item.title));

    // Also inform server to remove any matching cloud jobs
    try {
      const headers = getAuthHeaders ? getAuthHeaders() : {};
      fetch("/api/cloud-job/delete", {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/json",
          "x-novel-filename": encodeURIComponent(item.title),
        },
        body: JSON.stringify({
          fileName: item.title,
          jobId: item.id,
        }),
      }).catch(() => {});
    } catch {}
  };

  const handleClearAllHistory = (e?: React.MouseEvent) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (readingHistory.length === 0) return;
    const confirmClear = window.confirm(
      "Are you sure you want to delete ALL novels from your reading history?"
    );
    if (!confirmClear) return;
    clearReadingHistory();
    setReadingHistory([]);
  };

  const handleReadHistoryNovel = (item: ReadingHistoryItem) => {
    if (onOpenReader) {
      onOpenReader({
        novelTitle: item.title,
        author: item.author,
        coverUrl: item.coverUrl,
        novelUrl: item.novelUrl,
        siteId: item.siteId,
        chapterIndex: item.lastReadChapterIndex || 1,
        totalChapters: item.totalChapters || 1,
      });
      onClose();
    }
  };

  const formatRelativeTime = (timestamp: number) => {
    const diffSec = Math.floor((Date.now() - timestamp) / 1000);
    if (diffSec < 60) return "Just now";
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHour = Math.floor(diffMin / 60);
    if (diffHour < 24) return `${diffHour}h ago`;
    const diffDays = Math.floor(diffHour / 24);
    if (diffDays < 7) return `${diffDays}d ago`;
    return new Date(timestamp).toLocaleDateString();
  };

  const handleDeleteNovel = async (novel: StoredNovel) => {
    const confirmDelete = window.confirm(
      `Permanently delete "${novel.fileName}" from the server?\n\nThis will stop all background workers and completely remove all translated chunks and archives.`
    );
    if (!confirmDelete) return;

    const deleteKey = novel.id || novel.fileName;
    setDeletingId(deleteKey);

    // Save tombstone in client localStorage immediately
    addLocalDeletedNovel(novel.fileName);
    if (novel.id) addLocalDeletedNovel(novel.id);

    // Optimistically remove from UI list immediately
    setNovels((prev) =>
      prev.filter(
        (n) =>
          !isSameNovel(n.fileName, novel.fileName) &&
          n.id !== novel.id
      )
    );

    // Clean up local library and reading history
    removeReadingHistoryItem(novel.id);
    removeReadingHistoryItem(novel.fileName);
    removeBookFromLibrary(novel.id);
    removeBookFromLibrary(novel.fileName);

    try {
      const headers = getAuthHeaders ? getAuthHeaders() : {};
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000);

      await fetch("/api/cloud-job/delete", {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/json",
          "x-novel-filename": encodeURIComponent(novel.fileName),
        },
        body: JSON.stringify({
          fileName: novel.fileName,
          jobId: novel.id,
        }),
        signal: controller.signal,
      }).catch((err) => {
        console.warn("Delete request warning:", err);
      });
      clearTimeout(timeoutId);

      // Tell parent to reset session if it matches this novel
      onReset(novel.fileName);
    } catch (err) {
      console.error("Failed to delete novel:", err);
    } finally {
      setDeletingId(null);
    }
  };

  const handleClearAll = async () => {
    const confirmClear = window.confirm(
      "Are you sure you want to permanently clear ALL saved novels and translation archives from the server?\n\nThis action cannot be undone."
    );
    if (!confirmClear) return;

    setIsClearingAll(true);
    setNovels([]);

    clearReadingHistory();
    try {
      localStorage.removeItem("megatext_user_library_v1");
    } catch {}

    try {
      const headers = getAuthHeaders ? getAuthHeaders() : {};
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000);

      await fetch("/api/cloud-job/delete", {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          clearAll: true,
        }),
        signal: controller.signal,
      }).catch((err) => {
        console.warn("Clear all request warning:", err);
      });
      clearTimeout(timeoutId);

      onReset(undefined, true);
      onClose();
    } catch (err) {
      console.error("Failed to clear all:", err);
    } finally {
      setIsClearingAll(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-slate-900/60 backdrop-blur-xs transition animate-in fade-in"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-t-3xl sm:rounded-3xl border border-purple-100 dark:border-purple-900/60 bg-white dark:bg-slate-900 p-5 shadow-2xl transition animate-in slide-in-from-bottom-4 space-y-4 max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-purple-100/70 dark:border-purple-900/40 pb-3 shrink-0">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-purple-100 dark:bg-purple-950/80 text-purple-600">
              <Clock className="h-4 w-4" />
            </div>
            <div>
              <h3 className="text-sm font-extrabold text-slate-800 dark:text-slate-100">
                History & Novel Library
              </h3>
              <p className="text-[11px] text-slate-500">Your read novels & background translations</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {activeTab === "cloud" && (
              <button
                type="button"
                onClick={fetchNovels}
                disabled={isLoading}
                title="Refresh novel list"
                className="flex h-8 w-8 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer disabled:opacity-50"
              >
                <RotateCw className={`h-3.5 w-3.5 ${isLoading ? "animate-spin text-purple-600" : ""}`} />
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Tab Switcher */}
        <div className="flex items-center gap-1 p-1 rounded-2xl bg-slate-100 dark:bg-slate-800/80 shrink-0">
          <button
            type="button"
            onClick={() => setActiveTab("reading")}
            className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-xl text-xs font-bold transition cursor-pointer ${
              activeTab === "reading"
                ? "bg-white dark:bg-slate-900 text-purple-700 dark:text-purple-300 shadow-xs"
                : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
            }`}
          >
            <BookMarked className="h-3.5 w-3.5" />
            <span>Reading History</span>
            <span className="ml-1 px-1.5 py-0.2 rounded-full bg-purple-100 dark:bg-purple-950 text-[10px] font-mono">
              {readingHistory.length}
            </span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("cloud")}
            className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-xl text-xs font-bold transition cursor-pointer ${
              activeTab === "cloud"
                ? "bg-white dark:bg-slate-900 text-purple-700 dark:text-purple-300 shadow-xs"
                : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
            }`}
          >
            <RotateCw className="h-3.5 w-3.5" />
            <span>Cloud Translations</span>
            <span className="ml-1 px-1.5 py-0.2 rounded-full bg-slate-200 dark:bg-slate-700 text-[10px] font-mono">
              {novels.length}
            </span>
          </button>
        </div>

        {/* TAB 1: READING HISTORY */}
        {activeTab === "reading" && (
          <div className="flex-1 flex flex-col min-h-0 space-y-3">
            {/* Reading History Top Bar with Clear-All Trash Icon */}
            <div className="flex items-center justify-between px-1 shrink-0">
              <span className="text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                Novels you opened in Reader mode
              </span>
              {readingHistory.length > 0 && (
                <button
                  type="button"
                  onClick={handleClearAllHistory}
                  title="Delete ALL novels from reading history"
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-xs font-bold text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 border border-rose-200/60 dark:border-rose-900/40 transition cursor-pointer active:scale-95"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span>Clear All</span>
                </button>
              )}
            </div>

            {/* Reading History List */}
            <div className="flex-1 overflow-y-auto space-y-2.5 pr-0.5">
              {readingHistory.length === 0 ? (
                <div className="py-12 text-center space-y-3">
                  <div className="w-12 h-12 rounded-2xl bg-purple-50 dark:bg-purple-950/50 text-purple-500 mx-auto flex items-center justify-center border border-purple-100 dark:border-purple-900/40">
                    <BookMarked className="h-6 w-6" />
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs font-bold text-slate-700 dark:text-slate-300">
                      No Reading History Yet
                    </p>
                    <p className="text-[11px] text-slate-400 max-w-xs mx-auto">
                      Whenever you tap <strong>Read</strong> on a novel card in Explore, Store, or Library, it will appear here for instant 1-tap resuming!
                    </p>
                  </div>
                </div>
              ) : (
                readingHistory.map((item) => (
                  <div
                    key={item.id}
                    onClick={() => handleReadHistoryNovel(item)}
                    className="group rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3.5 hover:border-purple-300 dark:hover:border-purple-700/60 shadow-xs hover:shadow-md transition-all cursor-pointer flex items-center justify-between gap-3"
                  >
                    {/* Cover Thumbnail / Book Icon */}
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      {item.coverUrl ? (
                        <img
                          src={item.coverUrl}
                          alt={item.title}
                          className="w-11 h-14 object-cover rounded-xl shrink-0 border border-black/10 shadow-2xs"
                        />
                      ) : (
                        <div className="w-11 h-14 rounded-xl bg-gradient-to-br from-purple-600 to-indigo-700 text-white flex items-center justify-center shrink-0 shadow-2xs font-black text-xs">
                          {item.title.slice(0, 1)}
                        </div>
                      )}

                      <div className="min-w-0 flex-1 space-y-1">
                        <h4 className="text-xs sm:text-sm font-bold text-slate-900 dark:text-slate-100 truncate group-hover:text-purple-600 dark:group-hover:text-purple-400 transition-colors">
                          {item.title}
                        </h4>
                        <div className="flex items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400 truncate">
                          {item.author && <span className="truncate">{item.author}</span>}
                          <span>•</span>
                          <span className="text-purple-600 dark:text-purple-400 font-semibold truncate">
                            {item.lastReadChapterTitle || `Chapter ${item.lastReadChapterIndex}`}
                          </span>
                        </div>
                        <span className="text-[10px] text-slate-400 block">
                          Read {formatRelativeTime(item.timestamp)}
                        </span>
                      </div>
                    </div>

                    {/* Action Buttons: Read + Single Trash */}
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleReadHistoryNovel(item);
                        }}
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl bg-purple-600 hover:bg-purple-700 text-white font-bold text-xs shadow-xs active:scale-95 transition cursor-pointer"
                        title="Resume reading this novel"
                      >
                        <BookOpen className="h-3.5 w-3.5" />
                        <span>Read</span>
                      </button>

                      <button
                        type="button"
                        onClick={(e) => handleDeleteHistoryItem(item, e)}
                        title="Remove novel from reading history"
                        className="p-1.5 rounded-xl text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition cursor-pointer"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* TAB 2: CLOUD TRANSLATIONS */}
        {activeTab === "cloud" && (
          <div className="flex-1 overflow-y-auto space-y-3 pr-0.5">
            {isLoading && novels.length === 0 ? (
              <div className="py-12 text-center space-y-2">
                <Loader2 className="h-6 w-6 animate-spin text-purple-600 mx-auto" />
                <p className="text-xs font-medium text-slate-500">Loading stored translations...</p>
              </div>
            ) : novels.length > 0 ? (
              novels.map((novel) => {
                const isCurrentSession = session && session.fileName.toLowerCase() === novel.fileName.toLowerCase();
                const isDone = novel.status === "completed" || (novel.totalChunks > 0 && novel.completedChunks >= novel.totalChunks);
                const percent = novel.totalChunks > 0 ? (isDone ? 100 : Math.round((novel.completedChunks / novel.totalChunks) * 100)) : 0;
                const isRunning = !isDone && novel.status === "running" && novel.totalChunks > 0 && novel.completedChunks < novel.totalChunks;
                const isDeleting = deletingId === novel.id || deletingId === novel.fileName;

                return (
                  <div
                    key={novel.id || novel.fileName}
                    className={`rounded-2xl border p-4 space-y-3 transition ${
                      isCurrentSession
                        ? "border-purple-300 dark:border-purple-600 bg-purple-50/40 dark:bg-purple-950/20 shadow-xs"
                        : "border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/50 hover:bg-white dark:hover:bg-slate-800"
                    }`}
                  >
                    {/* Title and badges */}
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <BookOpen className={`h-4 w-4 shrink-0 ${isCurrentSession ? "text-purple-600" : "text-slate-500"}`} />
                        <div className="min-w-0">
                          <h4 className="text-xs font-bold text-slate-800 dark:text-slate-100 truncate" title={novel.fileName}>
                            {novel.fileName}
                          </h4>
                          {isCurrentSession && (
                            <span className="text-[10px] font-semibold text-purple-600 dark:text-purple-400">
                              Currently Active View
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        {isDone ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 dark:bg-emerald-950/80 px-2 py-0.5 text-[10px] font-bold text-emerald-800 dark:text-emerald-200">
                            <CheckCircle2 className="h-3 w-3" />
                            Completed
                          </span>
                        ) : isRunning ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-sky-100 dark:bg-sky-950/80 px-2 py-0.5 text-[10px] font-bold text-sky-700 dark:text-sky-300 animate-pulse">
                            <RotateCw className="h-3 w-3 animate-spin" />
                            Translating
                          </span>
                        ) : (
                          <span className="rounded-full bg-slate-200 dark:bg-slate-700 px-2 py-0.5 text-[10px] font-bold text-slate-700 dark:text-slate-300">
                            Paused / Idle
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Progress bar */}
                    <div className="space-y-1">
                      <div className="flex justify-between text-[11px] text-slate-500 dark:text-slate-400">
                        <span>{novel.completedChunks} / {novel.totalChunks} Chunks ({percent}%)</span>
                        {novel.wordCount > 0 && <span>~{novel.wordCount.toLocaleString()} words</span>}
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
                        <div
                          className={`h-full rounded-full transition-all duration-300 ${
                            isDone
                              ? "bg-emerald-500"
                              : "bg-gradient-to-r from-sky-400 to-purple-600"
                          }`}
                          style={{ width: `${percent}%` }}
                        />
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      {!isCurrentSession && onSelectNovel && (
                        novel.completedChunks < novel.totalChunks && novel.totalChunks > 0 ? (
                          <button
                            type="button"
                            onClick={() => {
                              onSelectNovel(novel.fileName, true);
                              onClose();
                            }}
                            className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-purple-600 px-3 py-1.5 text-xs font-bold text-white shadow-2xs hover:bg-purple-700 active:scale-95 transition cursor-pointer"
                            title="Resume translation on server and continue progress"
                          >
                            <Play className="h-3 w-3 fill-current text-white" />
                            <span>Resume Translation</span>
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              onSelectNovel(novel.fileName, false);
                              onClose();
                            }}
                            className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-purple-600 px-3 py-1.5 text-xs font-bold text-white shadow-2xs hover:bg-purple-700 active:scale-95 transition cursor-pointer"
                          >
                            <BookOpen className="h-3 w-3 text-white" />
                            <span>Open Novel</span>
                          </button>
                        )
                      )}

                      {isCurrentSession && (
                        <span className="inline-flex items-center gap-1 rounded-xl bg-purple-50 dark:bg-purple-950/60 border border-purple-200 dark:border-purple-800/80 px-2.5 py-1 text-xs font-bold text-purple-700 dark:text-purple-300">
                          Active in Workspace
                        </span>
                      )}

                      {novel.completedChunks > 0 && (
                        <>
                          <a
                            href={`/api/cloud-job/download-epub?novelName=${encodeURIComponent(novel.fileName)}`}
                            download
                            className="inline-flex items-center justify-center gap-1 rounded-xl border border-purple-200 dark:border-purple-800 bg-white dark:bg-slate-800 px-2.5 py-1.5 text-xs font-bold text-purple-700 dark:text-purple-300 hover:bg-purple-50 active:scale-95 transition cursor-pointer"
                            title="Download complete novel as EPUB"
                          >
                            <Download className="h-3 w-3" />
                            <span>EPUB</span>
                          </a>
                          <a
                            href={`/api/cloud-job/download-txt?novelName=${encodeURIComponent(novel.fileName)}`}
                            download
                            className="inline-flex items-center justify-center gap-1 rounded-xl border border-purple-200 dark:border-purple-800 bg-white dark:bg-slate-800 px-2 py-1.5 text-xs font-bold text-purple-700 dark:text-purple-300 hover:bg-purple-50 active:scale-95 transition cursor-pointer"
                            title="Download complete novel as TXT"
                          >
                            <FileText className="h-3 w-3" />
                            <span>TXT</span>
                          </a>
                        </>
                      )}

                      <button
                        type="button"
                        disabled={isDeleting}
                        onClick={() => handleDeleteNovel(novel)}
                        className="ml-auto inline-flex items-center justify-center gap-1 rounded-xl border border-rose-200 dark:border-rose-900/60 bg-white dark:bg-slate-800 px-2.5 py-1.5 text-xs font-bold text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 active:scale-95 transition cursor-pointer disabled:opacity-50"
                      >
                        {isDeleting ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Trash2 className="h-3 w-3" />
                        )}
                        <span>Delete</span>
                      </button>
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="py-8 text-center space-y-2">
                <p className="text-xs font-medium text-slate-400 dark:text-slate-500">
                  No saved translation records found.
                </p>
                <p className="text-[11px] text-slate-400">
                  Upload a Chinese novel or select one from Explore to start translating!
                </p>
              </div>
            )}
          </div>
        )}

        {/* Footer actions */}
        <div className="border-t border-purple-100/70 dark:border-purple-900/40 pt-3 space-y-2 shrink-0">
          {novels.length > 1 && (
            <button
              type="button"
              disabled={isClearingAll}
              onClick={handleClearAll}
              className="w-full flex items-center justify-center gap-1.5 rounded-xl border border-rose-200 dark:border-rose-900/60 bg-rose-50/50 dark:bg-rose-950/20 py-2 text-xs font-bold text-rose-600 dark:text-rose-400 hover:bg-rose-100/60 transition cursor-pointer disabled:opacity-50"
            >
              {isClearingAll ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              <span>Clear All Old Translations from Server</span>
            </button>
          )}

          <button
            type="button"
            onClick={onClose}
            className="w-full rounded-2xl border border-purple-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-800 py-2.5 text-xs font-bold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
