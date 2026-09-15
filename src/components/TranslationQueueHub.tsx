import React, { useState } from "react";
import {
  BookCheck,
  Download,
  FileText,
  RotateCw,
  CheckCircle2,
  Loader2,
  AlertCircle,
  Search,
  BookOpen,
  Smartphone,
  Sparkles,
  ArrowDownToLine,
  Layers,
  AlertTriangle,
  ArrowRight,
} from "lucide-react";
import { TextChunk, TranslationMode } from "../types";
import { countEnglishWords, analyzeChunkContinuity } from "../utils/chunker";

interface TranslationQueueHubProps {
  chunks: TextChunk[];
  fileName: string;
  completedEnglishWords: number;
  lastDownloadedWords: number;
  onDownloadProgress: (
    format?: "epub" | "txt",
    mode?: "auto" | "continuous" | "with_placeholders" | "all_completed"
  ) => void;
  onOpenExport: () => void;
  onTranslateChunk: (chunkId: string) => void;
  isRunning: boolean;
  mode?: TranslationMode;
}

export const TranslationQueueHub: React.FC<TranslationQueueHubProps> = ({
  chunks,
  fileName,
  completedEnglishWords,
  lastDownloadedWords,
  onDownloadProgress,
  onOpenExport,
  onTranslateChunk,
  isRunning,
  mode = "cloud",
}) => {
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "completed" | "processing" | "pending">("all");

  const completedChunks = chunks.filter((c) => c.status === "completed");
  const pendingChunks = chunks.filter((c) => c.status === "pending");
  const processingChunks = chunks.filter((c) => c.status === "processing");
  const errorChunks = chunks.filter((c) => c.status === "error");

  const continuity = analyzeChunkContinuity(chunks);
  const newWordsSinceLast = Math.max(0, completedEnglishWords - lastDownloadedWords);
  const totalChunks = chunks.length;

  const filteredChunks = chunks.filter((chunk) => {
    if (statusFilter === "completed" && chunk.status !== "completed") return false;
    if (statusFilter === "processing" && chunk.status !== "processing") return false;
    if (statusFilter === "pending" && chunk.status !== "pending") return false;

    if (!searchTerm.trim()) return true;
    const q = searchTerm.toLowerCase();
    return (
      (chunk.chapterTitle && chunk.chapterTitle.toLowerCase().includes(q)) ||
      `chapter ${chunk.index + 1}`.includes(q) ||
      `section ${chunk.index + 1}`.includes(q)
    );
  });

  return (
    <div className="space-y-4">
      {/* Gap Warning Banner if parallel translation caused out-of-order completion */}
      {continuity.hasGaps && (
        <div
          id="chapter-gap-warning-banner"
          className="rounded-2xl border border-amber-300 dark:border-amber-800/80 bg-amber-50/90 dark:bg-amber-950/40 p-4 sm:p-5 shadow-xs transition"
        >
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-200/80 dark:bg-amber-900/80 text-amber-800 dark:text-amber-300">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <h3 className="text-xs sm:text-sm font-bold text-amber-950 dark:text-amber-200">
                    Chapter Continuity Notice: Chapter{" "}
                    {continuity.missingChunks.map((c) => `#${c.index + 1}`).join(", ")}{" "}
                    {continuity.missingChunks.length === 1 ? "is" : "are"} still translating
                  </h3>
                  {isRunning && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-amber-200/70 dark:bg-amber-900/60 px-2 py-0.5 text-[10px] font-semibold text-amber-800 dark:text-amber-300">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Loading...
                    </span>
                  )}
                </div>
                <p className="text-xs text-amber-900/80 dark:text-amber-300/80 max-w-xl leading-relaxed">
                  Chapter #{continuity.highestCompletedIndex + 1} finished early due to parallel streams.{" "}
                  <strong>Chapters 1 to {continuity.continuousChunks.length}</strong> are 100% continuous and ready for uninterrupted reading in Moon+ Reader right now.
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              {continuity.missingChunks.length > 0 && (
                <button
                  id="retry-missing-chapters-btn"
                  onClick={() => {
                    continuity.missingChunks.forEach((mc) => onTranslateChunk(mc.id));
                  }}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-amber-600 px-3.5 py-2.5 text-xs sm:text-sm font-bold text-white shadow-xs hover:bg-amber-700 active:scale-95 transition cursor-pointer"
                  title="Translate missing gap chapters now"
                >
                  <RotateCw className="h-3.5 w-3.5" />
                  <span>
                    Translate Chapter {continuity.missingChunks.map((c) => `#${c.index + 1}`).join(", ")} Now
                  </span>
                </button>
              )}

              <button
                id="gap-download-continuous-btn"
                onClick={() => onDownloadProgress("epub", "continuous")}
                disabled={continuity.continuousChunks.length === 0}
                className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-2.5 text-xs sm:text-sm font-bold text-white shadow-xs hover:bg-emerald-700 active:scale-95 transition cursor-pointer"
                title="Download 100% continuous chapters (no gaps)"
              >
                <BookCheck className="h-4 w-4" />
                <span>
                  Download Continuous EPUB (Ch 1–{continuity.continuousChunks.length})
                </span>
              </button>

              <button
                id="gap-resolve-options-btn"
                onClick={() => onDownloadProgress("epub", "auto")}
                className="inline-flex items-center gap-1.5 rounded-xl border border-amber-300 dark:border-amber-700 bg-white dark:bg-slate-800 px-3.5 py-2.5 text-xs font-semibold text-amber-900 dark:text-amber-200 hover:bg-amber-50 dark:hover:bg-slate-700 transition cursor-pointer"
                title="View all gap options"
              >
                <span>Options</span>
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Chapter Progress & Queue Monitor (Compact Table / List) */}
      <div className="rounded-3xl border border-purple-100/80 dark:border-purple-900/40 bg-white/95 dark:bg-slate-900/95 shadow-md shadow-purple-500/5 transition-colors overflow-hidden">
        {/* Table Header / Toolbar */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-purple-100/70 dark:border-purple-900/40 p-4 sm:px-5 bg-[#FAF8FE]/80 dark:bg-slate-900/90">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-xs font-extrabold text-slate-800 dark:text-slate-100 uppercase tracking-wider">
              Translation Queue ({totalChunks} Chapters{totalChunks > 0 && completedChunks.length === totalChunks ? " — 100% Completed" : ""})
            </h3>

            {/* Filter pills */}
            <div className="flex items-center gap-1 text-[11px]">
              <button
                onClick={() => setStatusFilter("all")}
                className={`rounded-full px-2.5 py-0.5 font-bold transition cursor-pointer ${
                  statusFilter === "all"
                    ? "bg-purple-600 text-white shadow-2xs"
                    : "text-slate-500 hover:text-purple-700 dark:hover:text-purple-300"
                }`}
              >
                All ({totalChunks})
              </button>
              <button
                onClick={() => setStatusFilter("completed")}
                className={`rounded-full px-2.5 py-0.5 font-bold transition cursor-pointer ${
                  statusFilter === "completed"
                    ? "bg-emerald-600 text-white shadow-2xs"
                    : "text-slate-500 hover:text-emerald-700 dark:hover:text-emerald-300"
                }`}
              >
                Done ({completedChunks.length})
              </button>
              {processingChunks.length > 0 && (
                <button
                  onClick={() => setStatusFilter("processing")}
                  className={`rounded-full px-2.5 py-0.5 font-bold transition cursor-pointer ${
                    statusFilter === "processing"
                      ? "bg-indigo-600 text-white shadow-2xs"
                      : "text-slate-500 hover:text-indigo-700 dark:hover:text-indigo-300"
                  }`}
                >
                  Active ({processingChunks.length})
                </button>
              )}
              <button
                onClick={() => setStatusFilter("pending")}
                className={`rounded-full px-2.5 py-0.5 font-bold transition cursor-pointer ${
                  statusFilter === "pending"
                    ? "bg-slate-300 dark:bg-slate-700 text-slate-900 dark:text-white"
                    : "text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
                }`}
              >
                Queued ({pendingChunks.length})
              </button>
            </div>
          </div>

          {/* Search bar */}
          <div className="relative w-full sm:w-56">
            <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-purple-400 dark:text-slate-500" />
            <input
              type="text"
              placeholder="Filter chapters..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full rounded-2xl border border-purple-100 dark:border-purple-900/60 bg-white dark:bg-slate-800 py-1.5 pl-9 pr-3 text-xs text-slate-800 dark:text-slate-200 placeholder-slate-400 focus:border-purple-400 focus:outline-none"
            />
          </div>
        </div>

        {/* Chapters Queue Table */}
        <div className="max-h-[60vh] overflow-y-auto divide-y divide-purple-50 dark:divide-slate-800/80">
          {filteredChunks.length === 0 ? (
            <div className="p-8 text-center text-xs text-slate-400 dark:text-slate-500">
              No chapters match the selected filter.
            </div>
          ) : (
            filteredChunks.map((chunk) => {
              const words = countEnglishWords(chunk.englishText);

              return (
                <div
                  key={chunk.id}
                  id={`queue-item-${chunk.index}`}
                  className={`flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 sm:gap-3 p-3.5 sm:px-5 text-xs transition ${
                    chunk.status === "processing"
                      ? "bg-purple-50/60 dark:bg-purple-950/30 font-medium"
                      : "hover:bg-purple-50/30 dark:hover:bg-slate-800/40"
                  }`}
                >
                  {/* Chapter Identifier & Title */}
                  <div className="flex items-center gap-2.5 sm:gap-3 min-w-0 flex-1">
                    <span className="flex h-7 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-50 to-purple-100 dark:from-indigo-950 dark:to-purple-900/60 text-[11px] font-extrabold text-purple-700 dark:text-purple-300">
                      #{chunk.index + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="font-bold text-slate-900 dark:text-slate-100 truncate max-w-[200px] sm:max-w-md" title={chunk.chapterTitle || `Section ${chunk.index + 1}`}>
                        {chunk.chapterTitle || `Section ${chunk.index + 1}`}
                      </div>
                      <div className="text-[11px] text-slate-400 dark:text-slate-500">
                        {chunk.charCount.toLocaleString()} Chinese characters
                      </div>
                    </div>
                  </div>

                  {/* Status, Words Count, and Actions */}
                  <div className="flex items-center justify-between sm:justify-end gap-2.5 sm:gap-3 shrink-0 pt-1 sm:pt-0 border-t border-purple-50/80 dark:border-slate-800/40 sm:border-t-0">
                    {/* English words count */}
                    {words > 0 ? (
                      <span className="font-mono text-[11px] sm:text-xs font-semibold text-purple-700 dark:text-purple-300 whitespace-nowrap">
                        {words.toLocaleString()} words
                      </span>
                    ) : (
                      <span className="text-[11px] text-slate-400 dark:text-slate-500 italic">
                        0 words
                      </span>
                    )}

                    <div className="flex items-center gap-2">
                      {/* Status Badge */}
                      {chunk.status === "completed" && words > 0 && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 dark:bg-emerald-950/80 px-2.5 py-0.5 text-[11px] font-bold text-emerald-800 dark:text-emerald-200 border border-emerald-200 dark:border-emerald-800 whitespace-nowrap">
                          <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-600" />
                          <span>Ready</span>
                        </span>
                      )}

                      {chunk.status === "completed" && words === 0 && (
                        <span
                          className="inline-flex items-center gap-1 rounded-full bg-amber-100 dark:bg-amber-950/80 px-2.5 py-0.5 text-[11px] font-bold text-amber-800 dark:text-amber-300 whitespace-nowrap"
                          title="Empty translation response detected. Click the reload icon to re-translate."
                        >
                          <AlertCircle className="h-3 w-3 shrink-0 text-amber-600" />
                          <span>Empty (Retry)</span>
                        </span>
                      )}

                      {chunk.status === "processing" && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-purple-100 dark:bg-purple-950/80 px-2.5 py-0.5 text-[11px] font-bold text-purple-700 dark:text-purple-300 animate-pulse whitespace-nowrap">
                          <Loader2 className="h-3 w-3 animate-spin shrink-0 text-purple-600" />
                          <span>Translating...</span>
                        </span>
                      )}

                      {chunk.status === "pending" && (
                        <span className="rounded-full bg-slate-100 dark:bg-slate-800 px-2.5 py-0.5 text-[11px] font-medium text-slate-500 dark:text-slate-400 whitespace-nowrap">
                          In Queue
                        </span>
                      )}

                      {chunk.status === "error" && (
                        <button
                          type="button"
                          onClick={() => {
                            const msg = chunk.errorMessage || "Temporary rate limit or empty response from model. Auto-retry is active.";
                            alert(`Chapter #${chunk.index + 1} Error Details:\n\n${msg}\n\nClick the circular reload button or the top Orange button to re-run immediately.`);
                          }}
                          className="inline-flex items-center gap-1 rounded-full bg-rose-100 dark:bg-rose-950/80 hover:bg-rose-200 dark:hover:bg-rose-900/80 px-2.5 py-0.5 text-[11px] font-bold text-rose-700 dark:text-rose-300 cursor-pointer transition whitespace-nowrap"
                          title="Click to view exact error details"
                        >
                          <AlertCircle className="h-3 w-3 shrink-0" />
                          <span>Failed (Retrying)</span>
                        </button>
                      )}

                      {/* Retranslate button */}
                      <button
                        onClick={() => onTranslateChunk(chunk.id)}
                        disabled={chunk.status === "processing"}
                        className="rounded-xl p-1.5 text-purple-400 hover:bg-purple-100/70 dark:hover:bg-slate-800 hover:text-purple-700 dark:hover:text-purple-300 disabled:opacity-40 cursor-pointer transition shrink-0"
                        title={chunk.status === "completed" ? "Re-translate this chapter" : "Translate this chapter now"}
                      >
                        <RotateCw className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
