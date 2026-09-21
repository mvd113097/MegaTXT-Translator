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
} from "lucide-react";
import { TranslationSession } from "../types";

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
  onReset: (novelName?: string) => void;
  getAuthHeaders?: () => Record<string, string>;
  onSelectNovel?: (fileName: string) => void;
}

export const HistoryModal: React.FC<HistoryModalProps> = ({
  isOpen,
  onClose,
  session,
  onDownloadProgress,
  onReset,
  getAuthHeaders,
  onSelectNovel,
}) => {
  const [novels, setNovels] = useState<StoredNovel[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [isClearingAll, setIsClearingAll] = useState(false);

  const fetchNovels = async () => {
    if (!isOpen) return;
    setIsLoading(true);
    try {
      const headers = getAuthHeaders ? getAuthHeaders() : {};
      const res = await fetch("/api/cloud-job/list", { headers });
      const data = await res.json();
      if (data.success && Array.isArray(data.novels)) {
        setNovels(data.novels);
      }
    } catch (err) {
      console.warn("Failed to fetch novels list:", err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchNovels();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleDeleteNovel = async (novel: StoredNovel) => {
    const confirmDelete = window.confirm(
      `Permanently delete "${novel.fileName}" from the server?\n\nThis will stop all background workers and completely remove all translated chunks and archives.`
    );
    if (!confirmDelete) return;

    setDeletingId(novel.id);
    try {
      const headers = getAuthHeaders ? getAuthHeaders() : {};
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
      });

      // Update local list
      setNovels((prev) => prev.filter((n) => n.fileName.toLowerCase() !== novel.fileName.toLowerCase() && n.id !== novel.id));

      // If this was the active session, clear it from view as well
      if (session && session.fileName.toLowerCase() === novel.fileName.toLowerCase()) {
        onReset(novel.fileName);
      }
    } catch (err) {
      console.error("Failed to delete novel:", err);
      alert("Failed to delete novel. Please check your connection.");
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
    try {
      const headers = getAuthHeaders ? getAuthHeaders() : {};
      await fetch("/api/cloud-job/delete", {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          clearAll: true,
        }),
      });
      setNovels([]);
      onReset();
      onClose();
    } catch (err) {
      console.error("Failed to clear all:", err);
      alert("Failed to clear all novels.");
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
                Translation History & Library
              </h3>
              <p className="text-[11px] text-slate-500">Manage all stored & active novel translations</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={fetchNovels}
              disabled={isLoading}
              title="Refresh novel list"
              className="flex h-8 w-8 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer disabled:opacity-50"
            >
              <RotateCw className={`h-3.5 w-3.5 ${isLoading ? "animate-spin text-purple-600" : ""}`} />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Scrollable Novel List */}
        <div className="flex-1 overflow-y-auto space-y-3 pr-0.5">
          {isLoading && novels.length === 0 ? (
            <div className="py-12 text-center space-y-2">
              <Loader2 className="h-6 w-6 animate-spin text-purple-600 mx-auto" />
              <p className="text-xs font-medium text-slate-500">Loading stored translations...</p>
            </div>
          ) : novels.length > 0 ? (
            novels.map((novel) => {
              const isCurrentSession = session && session.fileName.toLowerCase() === novel.fileName.toLowerCase();
              const percent = novel.totalChunks > 0 ? Math.round((novel.completedChunks / novel.totalChunks) * 100) : 0;
              const isDone = novel.status === "completed" || (novel.totalChunks > 0 && novel.completedChunks === novel.totalChunks);
              const isRunning = novel.status === "running";
              const isDeleting = deletingId === novel.id;

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
                      <button
                        type="button"
                        onClick={() => {
                          onSelectNovel(novel.fileName);
                          onClose();
                        }}
                        className="inline-flex items-center justify-center gap-1 rounded-xl bg-purple-600 px-2.5 py-1.5 text-xs font-bold text-white shadow-2xs hover:bg-purple-700 active:scale-95 transition cursor-pointer"
                      >
                        <Play className="h-3 w-3 fill-current" />
                        <span>Open Novel</span>
                      </button>
                    )}

                    {isCurrentSession && novel.completedChunks > 0 && (
                      <>
                        <button
                          type="button"
                          onClick={() => onDownloadProgress("epub")}
                          className="inline-flex items-center justify-center gap-1 rounded-xl border border-purple-200 dark:border-purple-800 bg-white dark:bg-slate-800 px-2.5 py-1.5 text-xs font-bold text-purple-700 dark:text-purple-300 hover:bg-purple-50 active:scale-95 transition cursor-pointer"
                        >
                          <Download className="h-3 w-3" />
                          <span>EPUB</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => onDownloadProgress("txt")}
                          className="inline-flex items-center justify-center gap-1 rounded-xl border border-purple-200 dark:border-purple-800 bg-white dark:bg-slate-800 px-2 py-1.5 text-xs font-bold text-purple-700 dark:text-purple-300 hover:bg-purple-50 active:scale-95 transition cursor-pointer"
                        >
                          <FileText className="h-3 w-3" />
                          <span>TXT</span>
                        </button>
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
