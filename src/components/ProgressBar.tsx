import React from "react";
import { Clock, Zap, FileText, BookOpen, CheckCircle2 } from "lucide-react";
import { TranslationMetrics } from "../types";

interface ProgressBarProps {
  metrics: TranslationMetrics;
  fileName: string;
  onQuickDownloadProgress?: (format?: "epub" | "txt") => void;
  isRunning: boolean;
  isCompleted?: boolean;
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
  isRunning,
  isCompleted: propIsCompleted,
}) => {
  const isFinished =
    propIsCompleted !== undefined
      ? propIsCompleted
      : metrics.totalChunks > 0 && metrics.completedChunks === metrics.totalChunks;

  const percent =
    metrics.totalChunks > 0
      ? Math.min(100, Math.round((metrics.completedChunks / metrics.totalChunks) * 100))
      : 0;

  const charPercent =
    metrics.totalChars > 0
      ? Math.min(100, Math.round((metrics.completedChars / metrics.totalChars) * 100))
      : 0;

  return (
    <div className={`rounded-xl border p-3.5 sm:p-4 shadow-xs transition-colors duration-200 overflow-hidden ${
      isFinished
        ? "border-emerald-300 dark:border-emerald-800 bg-white dark:bg-slate-900 shadow-emerald-500/5"
        : "border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900"
    }`}>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 min-w-0">
        <div className="flex flex-wrap items-center gap-1.5 sm:gap-2 min-w-0 flex-1">
          <FileText className="h-4 w-4 text-indigo-600 dark:text-indigo-400 shrink-0" />
          <span className="text-xs font-bold text-slate-800 dark:text-slate-200 truncate max-w-[170px] sm:max-w-md">
            {fileName}
          </span>
          
          {isFinished ? (
            <span
              id="progress-completed-badge"
              className="inline-flex items-center gap-1 rounded-full bg-emerald-100 dark:bg-emerald-950/80 px-2.5 py-0.5 text-[11px] font-bold text-emerald-800 dark:text-emerald-200 border border-emerald-300 dark:border-emerald-800 whitespace-nowrap"
            >
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
              <span>{metrics.completedChunks}/{metrics.totalChunks} Chunks (100%)</span>
            </span>
          ) : (
            <span className="rounded-full bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-[10px] font-semibold text-slate-600 dark:text-slate-300 whitespace-nowrap">
              {metrics.completedChunks} / {metrics.totalChunks} Chunks ({percent}%)
            </span>
          )}

          {/* Real-time English words translated indicator */}
          {metrics.completedEnglishWords > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 dark:bg-emerald-950/60 px-2 py-0.5 text-[10px] sm:text-[11px] font-bold text-emerald-700 dark:text-emerald-300 whitespace-nowrap">
              <BookOpen className="h-3 w-3 shrink-0" />
              <span>{metrics.completedEnglishWords.toLocaleString()} English words</span>
            </span>
          )}
        </div>

        <div className="flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400 shrink-0">
          {/* Speed */}
          {!isFinished && metrics.charsPerSecond > 0 && (
            <div className="flex items-center gap-1 whitespace-nowrap">
              <Zap className="h-3.5 w-3.5 text-amber-500 dark:text-amber-400 shrink-0" />
              <span>{Math.round(metrics.charsPerSecond)} chars/s</span>
            </div>
          )}

          {/* ETA */}
          {!isFinished && metrics.estimatedRemainingSeconds > 0 && (
            <div className="flex items-center gap-1 whitespace-nowrap">
              <Clock className="h-3.5 w-3.5 text-indigo-500 dark:text-indigo-400 shrink-0" />
              <span>ETA: {formatDuration(metrics.estimatedRemainingSeconds)}</span>
            </div>
          )}
        </div>
      </div>

      {/* Visual Bar */}
      <div className="mt-3 relative h-2.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
        <div
          className={`h-full rounded-full transition-all duration-300 ease-out ${
            isFinished
              ? "bg-gradient-to-r from-emerald-500 via-teal-500 to-emerald-600"
              : "bg-gradient-to-r from-indigo-500 to-indigo-600"
          }`}
          style={{ width: `${percent}%` }}
        />
      </div>

      {/* Sub metrics */}
      <div className="mt-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-1.5 text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 min-w-0">
          <span>
            Translated:{" "}
            <strong className="text-slate-800 dark:text-slate-200 font-semibold">
              {metrics.completedChars.toLocaleString()}
            </strong>{" "}
            / {metrics.totalChars.toLocaleString()} chars ({charPercent}%)
          </span>
          {metrics.completedEnglishWords > 0 && (
            <span className="text-indigo-600 dark:text-indigo-400 font-medium">
              (~{(metrics.completedEnglishWords / 1000).toFixed(1)}k English words)
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {isFinished && (
            <span
              id="progress-status-completed-text"
              className="text-emerald-700 dark:text-emerald-300 font-bold flex items-center gap-1 text-[11px] sm:text-xs whitespace-nowrap"
            >
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
              <span>Status: Completed (100%) — All Chapters Ready</span>
            </span>
          )}
          {!isFinished && isRunning && (
            <span className="text-indigo-600 dark:text-indigo-400 font-medium flex items-center gap-1">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-indigo-600 dark:bg-indigo-400 animate-pulse" />
              Translating continuous in background...
            </span>
          )}
          {metrics.errorChunks > 0 && (
            <span className="text-rose-600 dark:text-rose-400 font-medium">
              {metrics.errorChunks} chunk(s) error
            </span>
          )}
        </div>
      </div>
    </div>
  );
};

