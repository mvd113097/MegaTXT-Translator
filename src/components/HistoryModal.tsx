import React from "react";
import { Clock, X, BookOpen, CheckCircle2, Download, Trash2, ArrowRight, FileText } from "lucide-react";
import { TranslationSession } from "../types";

interface HistoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  session: TranslationSession | null;
  onDownloadProgress: (format?: "epub" | "txt") => void;
  onReset: () => void;
}

export const HistoryModal: React.FC<HistoryModalProps> = ({
  isOpen,
  onClose,
  session,
  onDownloadProgress,
  onReset,
}) => {
  if (!isOpen) return null;

  const chunks = session?.chunks || [];
  const completedChunks = chunks.filter((c) => c.status === "completed").length;
  const totalChunks = chunks.length;
  const isFinished = totalChunks > 0 && completedChunks === totalChunks;
  const totalChars = session?.totalChineseChars ?? (session as any)?.totalCharacters ?? 0;
  const percent = totalChunks > 0 ? Math.round((completedChunks / totalChunks) * 100) : 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-slate-900/60 backdrop-blur-xs transition animate-in fade-in"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-t-3xl sm:rounded-3xl border border-purple-100 dark:border-purple-900/60 bg-white dark:bg-slate-900 p-5 shadow-2xl transition animate-in slide-in-from-bottom-4 space-y-4 max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-purple-100/70 dark:border-purple-900/40 pb-3">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-purple-100 dark:bg-purple-950/80 text-purple-600">
              <Clock className="h-4 w-4" />
            </div>
            <div>
              <h3 className="text-sm font-extrabold text-slate-800 dark:text-slate-100">
                Translation History
              </h3>
              <p className="text-[11px] text-slate-500">Current & past translation sessions</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Content */}
        {session ? (
          <div className="space-y-3">
            <div className="rounded-2xl border border-purple-100 dark:border-purple-900/50 bg-purple-50/30 dark:bg-slate-800/80 p-4 space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <BookOpen className="h-4 w-4 text-purple-600 shrink-0" />
                  <h4 className="text-xs font-bold text-slate-800 dark:text-slate-100 truncate">
                    {session.fileName || "Untitled Manuscript"}
                  </h4>
                </div>
                {isFinished ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 dark:bg-emerald-950/80 px-2 py-0.5 text-[10px] font-bold text-emerald-800 dark:text-emerald-200 shrink-0">
                    <CheckCircle2 className="h-3 w-3" />
                    Completed
                  </span>
                ) : (
                  <span className="rounded-full bg-purple-100 dark:bg-purple-950/80 px-2 py-0.5 text-[10px] font-bold text-purple-700 dark:text-purple-300 shrink-0">
                    {completedChunks} / {totalChunks} Chunks ({percent}%)
                  </span>
                )}
              </div>

              {/* Progress Bar */}
              <div className="h-2 w-full overflow-hidden rounded-full bg-purple-100 dark:bg-slate-800">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-sky-400 to-purple-600 transition-all duration-300"
                  style={{ width: `${percent}%` }}
                />
              </div>

              <div className="text-[11px] text-slate-500 dark:text-slate-400 space-y-0.5">
                <p>Total Characters: {totalChars.toLocaleString()} Chinese characters</p>
                {session.createdAt && (
                  <p>Started: {new Date(session.createdAt).toLocaleDateString()} {new Date(session.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
                )}
              </div>

              {/* Actions */}
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {completedChunks > 0 && (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        onDownloadProgress("epub");
                      }}
                      className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-xl bg-purple-600 px-3 py-2 text-xs font-bold text-white shadow-2xs hover:bg-purple-700 active:scale-95 transition cursor-pointer"
                    >
                      <Download className="h-3.5 w-3.5" />
                      <span>Download EPUB</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        onDownloadProgress("txt");
                      }}
                      className="inline-flex items-center justify-center gap-1 rounded-xl border border-purple-200 dark:border-purple-800 bg-white dark:bg-slate-800 px-3 py-2 text-xs font-bold text-purple-700 dark:text-purple-300 hover:bg-purple-50 active:scale-95 transition cursor-pointer"
                    >
                      <FileText className="h-3.5 w-3.5" />
                      <span>TXT</span>
                    </button>
                  </>
                )}
                <button
                  type="button"
                  onClick={() => {
                    onReset();
                    onClose();
                  }}
                  className="inline-flex items-center justify-center gap-1 rounded-xl border border-rose-200 dark:border-rose-900 bg-white dark:bg-slate-800 px-3 py-2 text-xs font-bold text-rose-600 dark:text-rose-400 hover:bg-rose-50 active:scale-95 transition cursor-pointer"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span>Delete</span>
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="py-8 text-center space-y-2">
            <p className="text-xs font-medium text-slate-400 dark:text-slate-500">
              No active translation in progress.
            </p>
            <p className="text-[11px] text-slate-400">
              Upload a Chinese text file to start translating!
            </p>
          </div>
        )}

        <button
          type="button"
          onClick={onClose}
          className="w-full rounded-2xl border border-purple-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-800 py-2.5 text-xs font-bold text-slate-700 dark:text-slate-200 hover:bg-slate-100 transition cursor-pointer"
        >
          Close
        </button>
      </div>
    </div>
  );
};
