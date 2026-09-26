import React from "react";
import { Clock, Zap, FileText, BookOpen, CheckCircle2, RefreshCw } from "lucide-react";
import { TranslationMetrics } from "../types";

interface ProgressBarProps {
  metrics: TranslationMetrics;
  fileName: string;
  onQuickDownloadProgress?: (format?: "epub" | "txt") => void;
  isRunning: boolean;
  isCompleted?: boolean;
  onSyncProgress?: () => void;
  isSyncing?: boolean;
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
  onSyncProgress,
  isSyncing = false,
}) => {
  const isFinished =
    propIsCompleted !== undefined
      ? propIsCompleted
      : (metrics.totalChunks > 0 && metrics.completedChunks >= metrics.totalChunks);

  const percent = isFinished
    ? 100
    : (metrics.totalChunks > 0
        ? Math.min(99, Math.round((metrics.completedChunks / metrics.totalChunks) * 100))
        : 0);

  const charPercent =
    metrics.totalChars > 0
      ? Math.min(100, Math.round((metrics.completedChars / metrics.totalChars) * 100))
      : 0;

  // SVG circular gauge calculations (radius 48, circumference ~301.6)
  const radius = 48;
  const strokeWidth = 8.5;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (percent / 100) * circumference;

  return (
    <div className="space-y-3.5">
      {/* Novel Header Card */}
      <div className="rounded-3xl border border-purple-100/80 dark:border-purple-900/40 bg-white/95 dark:bg-slate-900/95 p-4 sm:p-5 shadow-md shadow-purple-500/5 transition-colors">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-100 via-purple-100 to-pink-100 dark:from-indigo-950 dark:via-purple-900/60 dark:to-pink-950/60 text-purple-600 dark:text-purple-300 shadow-2xs">
              <BookOpen className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm sm:text-base font-extrabold text-slate-800 dark:text-slate-100 truncate" title={fileName}>
                {fileName}
              </h2>
              <p className="text-xs text-purple-600 dark:text-purple-300 font-medium">
                {metrics.completedChunks} of {metrics.totalChunks} Chunks
                {metrics.estimatedRemainingSeconds > 0 && !isFinished
                  ? ` · ~${formatDuration(metrics.estimatedRemainingSeconds)} remaining`
                  : isFinished
                  ? " · 100% Finished"
                  : ""}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {isFinished ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 dark:bg-emerald-950/80 px-3 py-1 text-xs font-bold text-emerald-800 dark:text-emerald-200 border border-emerald-300 dark:border-emerald-700">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                Completed
              </span>
            ) : isRunning ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-purple-100 dark:bg-purple-950/80 px-3 py-1 text-xs font-bold text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-800">
                <span className="h-2 w-2 rounded-full bg-purple-600 animate-ping" />
                Translating...
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 dark:bg-slate-800 px-3 py-1 text-xs font-semibold text-slate-600 dark:text-slate-300">
                Idle / Paused
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Main Circular Progress Card */}
      <div className={`relative rounded-3xl border p-5 sm:p-6 shadow-md transition-colors ${
        isFinished
          ? "border-emerald-200/90 dark:border-emerald-800/60 bg-gradient-to-br from-emerald-50/40 via-white to-teal-50/30 dark:from-slate-900 dark:to-emerald-950/20 shadow-emerald-500/5"
          : "border-purple-100/80 dark:border-purple-900/40 bg-white/95 dark:bg-slate-900/95 shadow-purple-500/5"
      }`}>
        {/* Top-Right Sync / Reload Button */}
        {onSyncProgress && (
          <button
            type="button"
            onClick={onSyncProgress}
            disabled={isSyncing}
            className="absolute top-3.5 right-3.5 sm:top-4 sm:right-4 z-10 flex h-8 w-8 items-center justify-center rounded-xl bg-purple-50/90 hover:bg-purple-100 dark:bg-purple-950/80 dark:hover:bg-purple-900/90 border border-purple-200/80 dark:border-purple-800/80 text-purple-600 dark:text-purple-300 shadow-2xs transition hover:scale-105 active:scale-95 disabled:opacity-60 cursor-pointer"
            title="Reload progress (~2 KB)"
            aria-label="Reload progress"
          >
            <RefreshCw className={`h-4 w-4 ${isSyncing ? "animate-spin text-purple-600 dark:text-purple-400" : ""}`} />
          </button>
        )}

        <div className="flex flex-col sm:flex-row items-center sm:items-start gap-6 sm:gap-8">
          {/* Circular Donut Gauge */}
          <div className="relative flex shrink-0 items-center justify-center">
            <svg className="h-34 w-34 sm:h-38 sm:w-38 -rotate-90 transform" viewBox="0 0 120 120">
              {/* Background track */}
              <circle
                cx="60"
                cy="60"
                r={radius}
                className="stroke-purple-100 dark:stroke-slate-800"
                strokeWidth={strokeWidth}
                fill="none"
              />
              {/* Gradient definition */}
              <defs>
                <linearGradient id="pastelProgressGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#818cf8" />
                  <stop offset="50%" stopColor="#c084fc" />
                  <stop offset="100%" stopColor="#f472b6" />
                </linearGradient>
                <linearGradient id="emeraldProgressGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#34d399" />
                  <stop offset="100%" stopColor="#059669" />
                </linearGradient>
              </defs>
              {/* Animated Progress Ring */}
              <circle
                cx="60"
                cy="60"
                r={radius}
                stroke={isFinished ? "url(#emeraldProgressGrad)" : "url(#pastelProgressGrad)"}
                strokeWidth={strokeWidth}
                fill="none"
                strokeDasharray={circumference}
                strokeDashoffset={strokeDashoffset}
                strokeLinecap="round"
                className="transition-all duration-500 ease-out"
              />
            </svg>

            {/* Inner Percentage Display */}
            <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
              <span className="text-3xl sm:text-4xl font-black tracking-tight text-slate-800 dark:text-white">
                {percent}%
              </span>
              <span className="text-[11px] font-bold text-purple-600 dark:text-purple-300 uppercase tracking-wider mt-0.5">
                {isFinished ? "Completed" : "Progress"}
              </span>
            </div>
          </div>

          {/* Stats Stack */}
          <div className="flex-1 w-full space-y-3">
            <div className="flex items-center justify-between border-b border-purple-50 dark:border-slate-800 pb-2.5">
              <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                Chunks completed:
              </span>
              <span className="text-xs font-extrabold text-slate-800 dark:text-slate-100">
                <span className="text-purple-600 dark:text-purple-400">{metrics.completedChunks}</span> / {metrics.totalChunks}
              </span>
            </div>

            <div className="flex items-center justify-between border-b border-purple-50 dark:border-slate-800 pb-2.5">
              <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                Chinese characters:
              </span>
              <span className="text-xs font-bold text-slate-800 dark:text-slate-100">
                {metrics.completedChars.toLocaleString()} / {metrics.totalChars.toLocaleString()} ({charPercent}%)
              </span>
            </div>

            <div className="flex items-center justify-between border-b border-purple-50 dark:border-slate-800 pb-2.5">
              <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                English words ready:
              </span>
              <span className="text-xs font-bold text-emerald-600 dark:text-emerald-400">
                ~{metrics.completedEnglishWords.toLocaleString()} words
              </span>
            </div>

            <div className="flex items-center justify-between pt-0.5">
              <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                Estimated speed / ETA:
              </span>
              <div className="flex items-center gap-2 text-xs font-bold text-purple-700 dark:text-purple-300">
                {metrics.charsPerSecond > 0 && !isFinished && (
                  <span className="flex items-center gap-1">
                    <Zap className="h-3 w-3 text-amber-500" />
                    {Math.round(metrics.charsPerSecond)} chars/s
                  </span>
                )}
                <span>
                  {isFinished
                    ? "Complete!"
                    : metrics.estimatedRemainingSeconds > 0
                    ? `~${formatDuration(metrics.estimatedRemainingSeconds)}`
                    : "Calculating..."}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Linear fallback bar for quick scanning */}
        <div className="mt-4 relative h-2 w-full overflow-hidden rounded-full bg-purple-100/70 dark:bg-slate-800">
          <div
            className={`h-full rounded-full transition-all duration-300 ease-out ${
              isFinished
                ? "bg-gradient-to-r from-emerald-400 to-teal-500"
                : "bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500"
            }`}
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>
    </div>
  );
};

