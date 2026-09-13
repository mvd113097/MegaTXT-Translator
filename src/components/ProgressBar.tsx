import React, { useState } from "react";
import { Clock, Zap, FileText, Download, BookOpen, BookCheck, ChevronDown, RefreshCw } from "lucide-react";
import { TranslationMetrics } from "../types";

interface ProgressBarProps {
  metrics: TranslationMetrics;
  fileName: string;
  onQuickDownloadProgress: (format?: "epub" | "txt") => void;
  isRunning: boolean;
  onReset?: () => void;
}

function formatDuration(seconds: number): string {
  if (seconds <= 0 || !isFinite(seconds)) return "--:--";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  if (mins >= 60) {
    const hours = Math.floor(mins / 60);
    const remainMins = mins % 60;
    return `${hours}h ${remainMins}m`;
  }
  return `${mins}m ${secs.toString().padStart(2, "0")}s`;
}

export const ProgressBar: React.FC<ProgressBarProps> = ({
  metrics,
  fileName,
  onQuickDownloadProgress,
  isRunning,
  onReset,
}) => {
  const [showFormatMenu, setShowFormatMenu] = useState(false);

  const percent =
    metrics.totalChunks > 0
      ? Math.min(100, Math.round((metrics.completedChunks / metrics.totalChunks) * 100))
      : 0;

  const charPercent =
    metrics.totalChars > 0
      ? Math.min(100, Math.round((metrics.completedChars / metrics.totalChars) * 100))
      : 0;

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 shadow-xs transition-colors duration-200">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <FileText className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
          <span className="text-xs font-bold text-slate-800 dark:text-slate-200 truncate max-w-xs sm:max-w-md">
            {fileName}
          </span>
          <span className="rounded-full bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-[10px] font-semibold text-slate-600 dark:text-slate-300">
            {metrics.completedChunks} / {metrics.totalChunks} Chunks ({percent}%)
          </span>

          {/* Real-time English words translated indicator */}
          {metrics.completedEnglishWords > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 dark:bg-emerald-950/60 px-2.5 py-0.5 text-[11px] font-bold text-emerald-700 dark:text-emerald-300">
              <BookOpen className="h-3 w-3" />
              <span>{metrics.completedEnglishWords.toLocaleString()} English words ready</span>
            </span>
          )}

          {/* Prominent Reset / Translate Another Book Button */}
          {onReset && (
            <button
              id="card-reset-book-btn"
              onClick={onReset}
              className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-200 dark:border-indigo-800 bg-indigo-50 dark:bg-indigo-950/60 px-2.5 py-1 text-xs font-bold text-indigo-700 dark:text-indigo-300 hover:bg-rose-50 dark:hover:bg-rose-950/50 hover:text-rose-600 dark:hover:text-rose-400 hover:border-rose-300 transition cursor-pointer active:scale-95 ml-auto sm:ml-2"
              title="Upload another book or clear current session"
            >
              <RefreshCw className="h-3.5 w-3.5 text-indigo-600 dark:text-indigo-400" />
              <span>Translate Another Book</span>
            </button>
          )}
        </div>

        <div className="flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
          {/* Speed */}
          {metrics.charsPerSecond > 0 && (
            <div className="flex items-center gap-1">
              <Zap className="h-3.5 w-3.5 text-amber-500 dark:text-amber-400" />
              <span>{Math.round(metrics.charsPerSecond)} chars/sec</span>
            </div>
          )}

          {/* ETA */}
          {metrics.estimatedRemainingSeconds > 0 && (
            <div className="flex items-center gap-1">
              <Clock className="h-3.5 w-3.5 text-indigo-500 dark:text-indigo-400" />
              <span>ETA: {formatDuration(metrics.estimatedRemainingSeconds)}</span>
            </div>
          )}

          {/* Quick Download Progress (EPUB default) */}
          {metrics.completedEnglishWords > 0 && (
            <div className="relative inline-flex rounded-lg shadow-xs">
              <button
                id="progress-quick-download-btn"
                onClick={() => onQuickDownloadProgress("epub")}
                className="inline-flex items-center gap-1.5 rounded-l-lg border border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/80 px-2.5 py-1 text-xs font-semibold text-emerald-800 dark:text-emerald-200 transition hover:bg-emerald-100 dark:hover:bg-emerald-900 active:scale-95"
                title="Download completed chapters right now as an EPUB eBook without stopping background translation"
              >
                <BookCheck className="h-3.5 w-3.5 text-emerald-700 dark:text-emerald-300" />
                <span>Download EPUB</span>
                {isRunning && (
                  <span className="relative flex h-2 w-2 ml-0.5">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                  </span>
                )}
              </button>
              <button
                type="button"
                onClick={() => setShowFormatMenu(!showFormatMenu)}
                className="inline-flex items-center rounded-r-lg border border-l-0 border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/80 px-1.5 py-1 text-emerald-800 dark:text-emerald-200 transition hover:bg-emerald-100 dark:hover:bg-emerald-900"
                title="Choose download format (EPUB / TXT)"
              >
                <ChevronDown className="h-3 w-3" />
              </button>

              {showFormatMenu && (
                <div
                  className="absolute right-0 top-full mt-1 z-20 w-44 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-1.5 shadow-lg"
                  onClick={() => setShowFormatMenu(false)}
                >
                  <button
                    onClick={() => onQuickDownloadProgress("epub")}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-emerald-50 dark:hover:bg-emerald-950/50 hover:text-emerald-800 dark:hover:text-emerald-300"
                  >
                    <BookCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                    <span>Download EPUB (.epub)</span>
                  </button>
                  <button
                    onClick={() => onQuickDownloadProgress("txt")}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700"
                  >
                    <FileText className="h-3.5 w-3.5 text-slate-500 dark:text-slate-400" />
                    <span>Download Plain TXT</span>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Visual Bar */}
      <div className="mt-3 relative h-2.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
        <div
          className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-indigo-600 transition-all duration-300 ease-out"
          style={{ width: `${percent}%` }}
        />
      </div>

      {/* Sub metrics */}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-1 text-[11px] text-slate-500 dark:text-slate-400">
        <span>
          Translated:{" "}
          <strong className="text-slate-800 dark:text-slate-200">
            {metrics.completedChars.toLocaleString()}
          </strong>{" "}
          / {metrics.totalChars.toLocaleString()} Chinese characters ({charPercent}%)
          {metrics.completedEnglishWords > 0 && (
            <span className="ml-2 text-indigo-600 dark:text-indigo-400 font-medium">
              (~{(metrics.completedEnglishWords / 1000).toFixed(1)}k English words)
            </span>
          )}
        </span>

        <div className="flex items-center gap-3">
          {isRunning && (
            <span className="text-indigo-600 dark:text-indigo-400 font-medium flex items-center gap-1">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-indigo-600 dark:bg-indigo-400 animate-pulse" />
              Translating book continuously in background...
            </span>
          )}
          {metrics.errorChunks > 0 && (
            <span className="text-rose-600 dark:text-rose-400 font-medium">
              {metrics.errorChunks} chunk(s) encountered error
            </span>
          )}
        </div>
      </div>
    </div>
  );
};

