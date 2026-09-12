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
                className="inline-flex items-center gap-1.5 rounded-xl border border-amber-300 dark:border-amber-700 bg-white dark:bg-slate-800 px-3.5 py-2.5 text-xs font-semibold text-amber-900 dark:text-amber-200 hover:bg-amber-50 dark:hover:bg-slate-750 transition cursor-pointer"
                title="View all gap options"
              >
                <span>Options</span>
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Moon+ Reader Hero Download Card */}
      <div className="relative overflow-hidden rounded-2xl border border-indigo-200 dark:border-indigo-900/60 bg-gradient-to-br from-indigo-50/70 via-white to-sky-50/50 dark:from-slate-900 dark:via-slate-900 dark:to-indigo-950/40 p-5 sm:p-6 shadow-sm transition-colors duration-200">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-5">
          {/* Left info */}
          <div className="space-y-2">
            <div className="inline-flex items-center gap-2 rounded-full bg-indigo-100/80 dark:bg-indigo-950/80 px-3 py-1 text-xs font-semibold text-indigo-800 dark:text-indigo-300">
              <Smartphone className="h-3.5 w-3.5 text-indigo-600 dark:text-indigo-400" />
              <span>Moon+ Reader & Mobile eBook Ready</span>
            </div>

            <h2 className="text-lg sm:text-xl font-bold tracking-tight text-slate-900 dark:text-white">
              {completedEnglishWords > 0 ? (
                <span>
                  {continuity.hasGaps ? (
                    <>
                      <span>{continuity.continuousWordCount.toLocaleString()} words continuous</span>
                      <span className="text-sm font-normal text-slate-500 dark:text-slate-400 ml-2">
                        (Chapters 1–{continuity.continuousChunks.length} ready; Ch {continuity.missingChunks.map(c => `#${c.index+1}`).join(", ")} loading)
                      </span>
                    </>
                  ) : (
                    <>
                      <span>{completedEnglishWords.toLocaleString()} English words ready</span>
                      <span className="text-sm font-normal text-slate-500 dark:text-slate-400 ml-2">
                        ({completedChunks.length} of {totalChunks} chapters continuous)
                      </span>
                    </>
                  )}
                </span>
              ) : (
                <span>Translating novel chapters...</span>
              )}
            </h2>

            <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-300 max-w-xl leading-relaxed">
              {completedEnglishWords > 0 ? (
                <>
                  Download your completed chapters at any time to read in{" "}
                  <strong>Moon+ Reader</strong>. Translations continue running in the background while you read.
                  {newWordsSinceLast > 0 && lastDownloadedWords > 0 && (
                    <span className="ml-1.5 inline-flex items-center gap-1 font-semibold text-emerald-600 dark:text-emerald-400">
                      <Sparkles className="h-3.5 w-3.5" />
                      +{newWordsSinceLast.toLocaleString()} new words since last download!
                    </span>
                  )}
                </>
              ) : (
                <>
                  Start the translation to begin accumulating chapters. Once a few thousand words finish, you can grab the EPUB or TXT file immediately.
                </>
              )}
            </p>
          </div>

          {/* Right Download Buttons */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 shrink-0">
            {/* Download EPUB for Moon+ Reader */}
            <button
              id="moon-reader-download-epub-btn"
              onClick={() => onDownloadProgress("epub", "auto")}
              disabled={completedChunks.length === 0}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 px-5 py-3 text-xs sm:text-sm font-bold text-white shadow-md shadow-emerald-200/50 dark:shadow-none hover:bg-emerald-700 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed transition cursor-pointer"
              title="Download formatted EPUB eBook ready to open directly in Moon+ Reader"
            >
              <BookCheck className="h-4 w-4" />
              <span>
                {continuity.hasGaps
                  ? `Download EPUB (Ch 1–${continuity.continuousChunks.length})`
                  : "Download EPUB for Moon+ Reader"}
                {completedEnglishWords > 0 && (
                  <span className="ml-1 opacity-90 font-normal">
                    (
                    {(
                      (continuity.hasGaps
                        ? continuity.continuousWordCount
                        : completedEnglishWords) / 1000
                    ).toFixed(1)}
                    k words)
                  </span>
                )}
              </span>
              {isRunning && (
                <span className="relative flex h-2 w-2 ml-1">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-300 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-white"></span>
                </span>
              )}
            </button>

            {/* Quick TXT option */}
            <button
              id="moon-reader-download-txt-btn"
              onClick={() => onDownloadProgress("txt", "auto")}
              disabled={completedChunks.length === 0}
              className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-4 py-3 text-xs sm:text-sm font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-750 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed transition cursor-pointer shadow-2xs"
              title="Download completed text snapshot as a plain .txt file"
            >
              <FileText className="h-4 w-4 text-slate-500 dark:text-slate-400" />
              <span>Download TXT</span>
            </button>

            {/* All export options */}
            <button
              id="moon-reader-all-exports-btn"
              onClick={onOpenExport}
              className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3.5 py-3 text-xs sm:text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-750 active:scale-95 transition cursor-pointer"
              title="Open full export options (Bilingual EPUB, Markdown, Source TXT)"
            >
              <Layers className="h-4 w-4 text-indigo-500" />
              <span className="hidden lg:inline">More Formats</span>
            </button>
          </div>
        </div>
      </div>

      {/* Chapter Progress & Queue Monitor (Compact Table / List) */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs transition-colors duration-200 overflow-hidden">
        {/* Table Header / Toolbar */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 dark:border-slate-800 p-3 sm:px-4 bg-slate-50/60 dark:bg-slate-850/60">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200 uppercase tracking-wider">
              Translation Queue ({totalChunks} Chapters)
            </h3>

            {/* Filter pills */}
            <div className="flex items-center gap-1 text-[11px]">
              <button
                onClick={() => setStatusFilter("all")}
                className={`rounded-md px-2 py-0.5 font-medium transition cursor-pointer ${
                  statusFilter === "all"
                    ? "bg-slate-200 dark:bg-slate-700 text-slate-900 dark:text-white font-semibold"
                    : "text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
                }`}
              >
                All ({totalChunks})
              </button>
              <button
                onClick={() => setStatusFilter("completed")}
                className={`rounded-md px-2 py-0.5 font-medium transition cursor-pointer ${
                  statusFilter === "completed"
                    ? "bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-200 font-semibold"
                    : "text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
                }`}
              >
                Ready ({completedChunks.length})
              </button>
              {processingChunks.length > 0 && (
                <button
                  onClick={() => setStatusFilter("processing")}
                  className={`rounded-md px-2 py-0.5 font-medium transition cursor-pointer ${
                    statusFilter === "processing"
                      ? "bg-indigo-100 dark:bg-indigo-950 text-indigo-800 dark:text-indigo-200 font-semibold"
                      : "text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
                  }`}
                >
                  Translating ({processingChunks.length})
                </button>
              )}
              <button
                onClick={() => setStatusFilter("pending")}
                className={`rounded-md px-2 py-0.5 font-medium transition cursor-pointer ${
                  statusFilter === "pending"
                    ? "bg-slate-200 dark:bg-slate-700 text-slate-900 dark:text-white font-semibold"
                    : "text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
                }`}
              >
                Queued ({pendingChunks.length})
              </button>
            </div>
          </div>

          {/* Search bar */}
          <div className="relative w-full sm:w-56">
            <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400 dark:text-slate-500" />
            <input
              type="text"
              placeholder="Filter chapters..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 py-1.5 pl-8 pr-3 text-xs text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
            />
          </div>
        </div>

        {/* Chapters Queue Table */}
        <div className="max-h-[60vh] overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800/80">
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
                  className={`flex flex-wrap items-center justify-between gap-3 p-3 sm:px-4 text-xs transition ${
                    chunk.status === "processing"
                      ? "bg-indigo-50/50 dark:bg-indigo-950/30 font-medium"
                      : "hover:bg-slate-50/70 dark:hover:bg-slate-800/40"
                  }`}
                >
                  {/* Chapter Identifier & Title */}
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="flex h-6 w-12 shrink-0 items-center justify-center rounded-md bg-slate-100 dark:bg-slate-800 text-[11px] font-bold text-slate-600 dark:text-slate-300">
                      #{chunk.index + 1}
                    </span>
                    <div className="min-w-0">
                      <div className="font-semibold text-slate-900 dark:text-slate-100 truncate max-w-xs sm:max-w-md">
                        {chunk.chapterTitle || `Section ${chunk.index + 1}`}
                      </div>
                      <div className="text-[11px] text-slate-400 dark:text-slate-500">
                        {chunk.charCount.toLocaleString()} Chinese characters
                      </div>
                    </div>
                  </div>

                  {/* Status, Words Count, and Actions */}
                  <div className="flex items-center gap-3 shrink-0">
                    {/* English words count */}
                    {words > 0 && (
                      <span className="font-mono text-xs font-semibold text-slate-700 dark:text-slate-300">
                        {words.toLocaleString()} words
                      </span>
                    )}

                    {/* Status Badge */}
                    {chunk.status === "completed" && words > 0 && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 dark:bg-emerald-950/60 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
                        <CheckCircle2 className="h-3 w-3" />
                        <span>Ready</span>
                      </span>
                    )}

                    {chunk.status === "completed" && words === 0 && (
                      <span
                        className="inline-flex items-center gap-1 rounded-full bg-amber-50 dark:bg-amber-950/60 px-2.5 py-0.5 text-[11px] font-semibold text-amber-700 dark:text-amber-300"
                        title="Empty translation response detected. Click the reload icon to re-translate."
                      >
                        <AlertCircle className="h-3 w-3" />
                        <span>Empty (Needs Retry)</span>
                      </span>
                    )}

                    {chunk.status === "processing" && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 dark:bg-indigo-950/60 px-2.5 py-0.5 text-[11px] font-semibold text-indigo-700 dark:text-indigo-300 animate-pulse">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        <span>Translating...</span>
                      </span>
                    )}

                    {chunk.status === "pending" && (
                      <span className="rounded-full bg-slate-100 dark:bg-slate-800 px-2.5 py-0.5 text-[11px] font-medium text-slate-500 dark:text-slate-400">
                        In Queue
                      </span>
                    )}

                    {chunk.status === "error" && (
                      <span
                        className="inline-flex items-center gap-1 rounded-full bg-rose-50 dark:bg-rose-950/60 px-2.5 py-0.5 text-[11px] font-semibold text-rose-700 dark:text-rose-300"
                        title={chunk.errorMessage || "Error occurred during translation"}
                      >
                        <AlertCircle className="h-3 w-3" />
                        <span>Failed (Retrying)</span>
                      </span>
                    )}

                    {/* Retranslate button */}
                    <button
                      onClick={() => onTranslateChunk(chunk.id)}
                      disabled={chunk.status === "processing"}
                      className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-indigo-600 dark:hover:text-indigo-400 disabled:opacity-40 cursor-pointer transition"
                      title={chunk.status === "completed" ? "Re-translate this chapter" : "Translate this chapter now"}
                    >
                      <RotateCw className="h-3.5 w-3.5" />
                    </button>
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
