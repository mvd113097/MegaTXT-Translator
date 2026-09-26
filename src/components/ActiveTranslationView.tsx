import React, { useState } from "react";
import {
  BookOpen,
  CheckCircle2,
  Clock,
  Layers,
  Sparkles,
  Zap,
  Play,
  Pause,
  RotateCcw,
  RefreshCw,
  FastForward,
  Download,
  BookCheck,
  FileText,
  Trash2,
  ChevronDown,
  ChevronUp,
  Loader2,
  Activity,
  Search,
  ExternalLink,
  ListOrdered,
  Cloud,
  PlusCircle,
} from "lucide-react";
import {
  TranslationSession,
  TranslationMetrics,
  TranslationStyle,
  TranslationMode,
  TextChunk,
} from "../types";
import { checkTranslationQuality } from "../utils/qualityGuard";

interface ActiveTranslationViewProps {
  session: TranslationSession;
  metrics: TranslationMetrics;
  mode: TranslationMode;
  onChangeMode: (mode: TranslationMode) => void;
  style: TranslationStyle;
  onChangeStyle: (style: TranslationStyle) => void;
  customInstructions: string;
  onChangeCustomInstructions: (instructions: string) => void;
  concurrency: number;
  onChangeConcurrency: (concurrency: number) => void;
  isRunning: boolean;
  isPaused: boolean;
  isStarting?: boolean;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onTranslateNext: () => void;
  onRetryFailed: () => void;
  onOpenExport: () => void;
  onDownloadProgress: (format?: "epub" | "txt") => void;
  onTranslateChunk: (chunkId: string) => void;
  onReset: () => void;
  onTranslateNewNovel?: () => void;
  completedEnglishWords: number;
  lastDownloadedWords: number;
  onSyncProgress?: () => void;
  isSyncing?: boolean;
  onOpenReader?: () => void;
  firestoreStatus?: { isQuotaExhausted: boolean; isAvailable: boolean };
  aiCooldownSecondsRemaining?: number;
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

export const ActiveTranslationView: React.FC<ActiveTranslationViewProps> = ({
  session,
  metrics,
  mode,
  onChangeMode,
  style,
  onChangeStyle,
  customInstructions,
  onChangeCustomInstructions,
  concurrency,
  onChangeConcurrency,
  isRunning,
  isPaused,
  isStarting,
  onStart,
  onPause,
  onResume,
  onTranslateNext,
  onRetryFailed,
  onOpenExport,
  onDownloadProgress,
  onTranslateChunk,
  onReset,
  onTranslateNewNovel,
  completedEnglishWords,
  lastDownloadedWords,
  onSyncProgress,
  isSyncing = false,
  onOpenReader,
  firestoreStatus,
  aiCooldownSecondsRemaining = 0,
}) => {
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "completed" | "processing" | "pending">("all");
  const [showFormatDropdown, setShowFormatDropdown] = useState(false);

  const totalChunks = session.chunks.length;
  const completedChunks = session.chunks.filter((c) => c.status === "completed");
  const processingChunks = session.chunks.filter((c) => c.status === "processing");
  const pendingChunks = session.chunks.filter((c) => c.status === "pending");
  const errorChunks = session.chunks.filter((c) => c.status === "error");

  const isAllDone =
    session.status === "completed" ||
    (totalChunks > 0 && (metrics.completedChunks >= totalChunks || completedChunks.length >= totalChunks));
  const effectiveCompletedCount =
    isAllDone && totalChunks > 0
      ? totalChunks
      : Math.max(metrics.completedChunks, completedChunks.length);
  const percent = totalChunks > 0
    ? isAllDone
      ? 100
      : Math.min(99, Math.round((effectiveCompletedCount / totalChunks) * 100))
    : 0;
  const charPercent = metrics.totalChars > 0 ? Math.min(100, Math.round((metrics.completedChars / metrics.totalChars) * 100)) : 0;

  // Find active chunk
  const activeChunk =
    processingChunks[0] ||
    pendingChunks[0] ||
    session.chunks[Math.min(completedChunks.length, totalChunks - 1)];

  // Filtered chunks for the detailed inspector
  const filteredChunks = session.chunks.filter((chunk) => {
    if (statusFilter !== "all" && chunk.status !== statusFilter) return false;
    if (searchTerm) {
      const matchIndex = `chapter ${chunk.index + 1}`.includes(searchTerm.toLowerCase());
      const matchTitle = (chunk.chapterTitle || (chunk as any).title)?.toLowerCase().includes(searchTerm.toLowerCase());
      const matchChinese = chunk.chineseText.includes(searchTerm);
      const matchEnglish = chunk.englishText?.toLowerCase().includes(searchTerm.toLowerCase());
      return matchIndex || matchTitle || matchChinese || matchEnglish;
    }
    return true;
  });

  // Circular gauge calculations
  const radius = 46;
  const strokeWidth = 8.5;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (percent / 100) * circumference;

  const newWordsSinceLast = Math.max(0, completedEnglishWords - lastDownloadedWords);

  return (
    <div className="space-y-3.5 transition animate-in fade-in duration-200">
      {/* 1. Novel Header Card (Reference Screen 2) */}
      <div className="rounded-3xl border border-purple-100/80 dark:border-purple-900/40 bg-white/95 dark:bg-slate-900/95 p-4 sm:p-5 shadow-md shadow-purple-500/5 transition-colors">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-100 via-purple-100 to-pink-100 dark:from-indigo-950 dark:via-purple-900/60 dark:to-pink-950/60 text-purple-600 dark:text-purple-300 shadow-2xs">
              <BookOpen className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm sm:text-base font-extrabold text-slate-800 dark:text-slate-100 truncate" title={session.fileName}>
                {session.fileName}
              </h2>
              <p className="text-xs text-purple-600 dark:text-purple-300 font-medium truncate">
                Chapter {activeChunk ? activeChunk.index + 1 : 1} · {completedEnglishWords.toLocaleString()} words
                {metrics.estimatedRemainingSeconds > 0
                  ? ` · ~${formatDuration(metrics.estimatedRemainingSeconds)} remaining`
                  : ""}
              </p>
            </div>
          </div>

          <div className="shrink-0 flex items-center gap-2">
            {onOpenReader && (
              <button
                type="button"
                onClick={onOpenReader}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-purple-600 hover:bg-purple-700 text-white text-xs font-bold shadow-xs hover:shadow-purple-500/25 transition cursor-pointer"
                title="Open novel chapters in Reader Mode with QuickNovel TTS"
              >
                <BookOpen className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Read Novel (TTS)</span>
                <span className="sm:hidden">Read</span>
              </button>
            )}

            {isRunning ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-sky-50 dark:bg-sky-950/80 px-3 py-1 text-xs font-bold text-sky-700 dark:text-sky-300 border border-sky-200 dark:border-sky-800 shadow-2xs">
                <span className="h-2 w-2 rounded-full bg-sky-500 animate-pulse" />
                Translating...
              </span>
            ) : isPaused ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 dark:bg-amber-950/80 px-3 py-1 text-xs font-bold text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
                Paused
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-purple-50 dark:bg-purple-950/80 px-3 py-1 text-xs font-bold text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-800">
                Ready
              </span>
            )}
          </div>
        </div>
      </div>

      {/* AI Free-Tier Rate Limit Cooldown Countdown Banner */}
      {aiCooldownSecondsRemaining > 0 && (
        <div className="rounded-2xl border border-amber-300 dark:border-amber-700/80 bg-gradient-to-r from-amber-50 to-orange-50 dark:from-amber-950/40 dark:to-orange-950/30 p-3.5 text-amber-900 dark:text-amber-200 flex items-center justify-between gap-3 shadow-sm shadow-amber-500/5">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-100 dark:bg-amber-900/60 text-amber-600 dark:text-amber-300">
              <Clock className="h-5 w-5 animate-pulse" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-amber-900 dark:text-amber-100">
                  AI Rate Limit Cooldown Active
                </span>
                <span className="rounded-md bg-amber-200/80 dark:bg-amber-900/80 px-1.5 py-0.5 font-mono text-[10px] font-extrabold text-amber-950 dark:text-amber-100">
                  Auto-resuming in {aiCooldownSecondsRemaining}s
                </span>
              </div>
              <p className="text-[11px] text-amber-700/90 dark:text-amber-300/90 truncate">
                Respecting Google Gemini free tier rate limit. Translation will automatically continue — no need to click pause or resume!
              </p>
            </div>
          </div>
          <div className="shrink-0 font-mono text-base font-extrabold px-3 py-1.5 rounded-xl bg-white/80 dark:bg-slate-900/80 border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-300">
            {aiCooldownSecondsRemaining}s
          </div>
        </div>
      )}

      {/* Local Disk Storage Mode Badge (Firestore Free-Tier Quota Limit) */}
      {firestoreStatus?.isQuotaExhausted && (
        <div className="rounded-2xl border border-sky-200 dark:border-sky-800/70 bg-gradient-to-r from-sky-50 to-indigo-50 dark:from-sky-950/30 dark:to-indigo-950/20 p-3 text-sky-900 dark:text-sky-200 flex items-center justify-between gap-3 shadow-xs">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-sky-100 dark:bg-sky-900/60 text-sky-600 dark:text-sky-300">
              <Cloud className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-bold text-sky-900 dark:text-sky-100">
                Operating in Local Disk Mode
              </p>
              <p className="text-[11px] text-sky-700/90 dark:text-sky-300/80 truncate">
                Cloud sync daily free read limit reached. All translations & chapters are safely protected and stored directly on disk and in your browser.
              </p>
            </div>
          </div>
          <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-lg bg-sky-100 dark:bg-sky-900/80 text-sky-800 dark:text-sky-200 border border-sky-300/60 dark:border-sky-700/60">
            Protected
          </span>
        </div>
      )}

      {/* 2. Big Circular Progress Card (Reference Screen 2) */}
      <div className="relative rounded-3xl border border-purple-100/80 dark:border-purple-900/40 bg-white/95 dark:bg-slate-900/95 p-4 sm:p-5 shadow-md shadow-purple-500/5 transition-colors">
        {/* Top-Right Sync Progress Button (Encircled location) */}
        {onSyncProgress && (
          <button
            type="button"
            onClick={onSyncProgress}
            disabled={isSyncing}
            className="absolute top-3.5 right-3.5 sm:top-4 sm:right-4 z-10 flex h-8 w-8 items-center justify-center rounded-xl bg-purple-50/90 hover:bg-purple-100 dark:bg-purple-950/80 dark:hover:bg-purple-900/90 border border-purple-200/80 dark:border-purple-800/80 text-purple-600 dark:text-purple-300 shadow-2xs transition hover:scale-105 active:scale-95 disabled:opacity-60 cursor-pointer"
            title="Sync progress in milliseconds (~2 KB)"
            aria-label="Sync progress"
          >
            <RefreshCw className={`h-4 w-4 ${isSyncing ? "animate-spin text-purple-600 dark:text-purple-400" : ""}`} />
          </button>
        )}

        <div className="flex flex-row items-center gap-4 sm:gap-6">
          {/* Circular Donut Gauge on Left */}
          <div className="relative flex shrink-0 items-center justify-center">
            <svg className="h-28 w-28 sm:h-32 sm:w-32 -rotate-90 transform" viewBox="0 0 120 120">
              <circle
                cx="60"
                cy="60"
                r={radius}
                className="stroke-purple-100 dark:stroke-slate-800"
                strokeWidth={strokeWidth}
                fill="none"
              />
              <defs>
                <linearGradient id="activePastelGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#38bdf8" />
                  <stop offset="100%" stopColor="#818cf8" />
                </linearGradient>
              </defs>
              <circle
                cx="60"
                cy="60"
                r={radius}
                stroke="url(#activePastelGrad)"
                strokeWidth={strokeWidth}
                fill="none"
                strokeDasharray={circumference}
                strokeDashoffset={strokeDashoffset}
                strokeLinecap="round"
                className="transition-all duration-500 ease-out"
              />
            </svg>

            {/* Inner Percentage (Exact 68% format in reference) */}
            <div className="absolute inset-0 flex items-center justify-center text-center">
              <span className="text-2xl sm:text-3xl font-black tracking-tight text-slate-800 dark:text-white leading-none">
                {percent}%
              </span>
            </div>
          </div>

          {/* 4 Rows on Right - Exact two-tier vertical hierarchy in reference */}
          <div className="flex-1 min-w-0 space-y-2 text-xs">
            <div className="flex items-start gap-2 min-w-0">
              <Layers className="h-3.5 w-3.5 text-indigo-500 mt-0.5 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="font-extrabold text-slate-800 dark:text-slate-100 truncate text-xs sm:text-sm leading-tight">
                  {effectiveCompletedCount.toLocaleString()} / {totalChunks.toLocaleString()}
                </div>
                <div className="text-[10px] text-slate-500 dark:text-slate-400 font-medium leading-tight">
                  chunks completed
                </div>
              </div>
            </div>

            <div className="flex items-start gap-2 min-w-0">
              <FileText className="h-3.5 w-3.5 text-indigo-500 mt-0.5 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="font-extrabold text-slate-800 dark:text-slate-100 truncate text-xs sm:text-sm leading-tight">
                  {metrics.completedChars.toLocaleString()} / {metrics.totalChars.toLocaleString()}
                </div>
                <div className="text-[10px] text-slate-500 dark:text-slate-400 font-medium leading-tight">
                  Chinese characters
                </div>
              </div>
            </div>

            <div className="flex items-start gap-2 min-w-0">
              <BookCheck className="h-3.5 w-3.5 text-indigo-500 mt-0.5 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="font-extrabold text-slate-800 dark:text-slate-100 truncate text-xs sm:text-sm leading-tight">
                  {completedEnglishWords.toLocaleString()}
                </div>
                <div className="text-[10px] text-slate-500 dark:text-slate-400 font-medium leading-tight">
                  English words ready
                </div>
              </div>
            </div>

            <div className="flex items-start gap-2 min-w-0">
              <Clock className="h-3.5 w-3.5 text-indigo-500 mt-0.5 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="font-extrabold text-slate-800 dark:text-slate-100 truncate text-xs sm:text-sm leading-tight">
                  {metrics.estimatedRemainingSeconds > 0
                    ? `~${formatDuration(metrics.estimatedRemainingSeconds)}`
                    : "Calculating..."}
                </div>
                <div className="text-[10px] text-slate-500 dark:text-slate-400 font-medium leading-tight truncate">
                  {metrics.charsPerSecond > 0
                    ? `~${Math.round(metrics.charsPerSecond * 60).toLocaleString()} c/min · remaining`
                    : "remaining"}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 3. "Current Chapter" Card (Reference Screen 2) */}
      {activeChunk && (
        <div className="rounded-3xl border border-purple-100/80 dark:border-purple-900/40 bg-white/95 dark:bg-slate-900/95 p-4 sm:p-5 shadow-md shadow-purple-500/5 transition-colors space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-extrabold uppercase tracking-wider text-slate-800 dark:text-slate-200">
              <BookOpen className="h-4 w-4 text-purple-500" />
              <span>Current Chapter</span>
            </div>
            <span className="rounded-full bg-purple-100 dark:bg-purple-900/60 px-2.5 py-0.5 text-[10px] font-bold text-purple-700 dark:text-purple-300">
              Chunk {activeChunk.index + 1} / {totalChunks} · {activeChunk.charCount.toLocaleString()} chars
            </span>
          </div>

          <div>
            <h3 className="text-sm font-bold text-slate-900 dark:text-white truncate">
              {activeChunk.chapterTitle || (activeChunk as any).title || `Chapter ${activeChunk.index + 1}`}
            </h3>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 line-clamp-1 mt-0.5">
              {(activeChunk.chineseText || "").slice(0, 90)}...
            </p>
          </div>

          <div className="flex items-center gap-3 pt-1">
            <div className="flex-1 relative h-2 overflow-hidden rounded-full bg-purple-100/70 dark:bg-slate-800">
              <div
                className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-purple-600 transition-all duration-300"
                style={{ width: `${percent}%` }}
              />
            </div>
            <span className="text-xs font-bold text-purple-600 dark:text-purple-400">{percent}%</span>
          </div>
        </div>
      )}

      {/* 4. Active Model & Streams Cards Side-by-Side (Reference Screen 2) */}
      <div className="grid grid-cols-2 gap-2.5">
        <div className="flex items-center gap-2 rounded-2xl border border-purple-100 dark:border-purple-900/50 bg-white/95 dark:bg-slate-900/95 p-3 shadow-xs">
          <Sparkles className="h-4 w-4 text-sky-500 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Active Model</div>
            <div className="text-xs font-extrabold text-slate-800 dark:text-slate-100 truncate">
              gemini-3.8-flash
            </div>
            <div className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400">
              (Recommended)
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 rounded-2xl border border-purple-100 dark:border-purple-900/50 bg-white/95 dark:bg-slate-900/95 p-3 shadow-xs">
          <Zap className="h-4 w-4 text-indigo-500 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Streams</div>
            <div className="flex items-center gap-1">
              <select
                value={concurrency}
                onChange={(e) => onChangeConcurrency(Number(e.target.value))}
                className="bg-transparent text-xs font-extrabold text-slate-800 dark:text-slate-100 focus:outline-none cursor-pointer"
              >
                <option value={5}>5</option>
                <option value={4}>4</option>
                <option value={3}>3</option>
                <option value={2}>2</option>
                <option value={1}>1</option>
              </select>
            </div>
            <div className="text-[10px] font-bold text-slate-500 dark:text-slate-400">
              (Maximum Speed)
            </div>
          </div>
        </div>
      </div>

      {/* 5. Primary Action Button (Reference Screen 2) */}
      <div>
        {isStarting ? (
          <button
            id="starting-translation-btn"
            disabled
            className="flex w-full items-center justify-center gap-2 rounded-2xl bg-purple-400 py-3.5 px-4 text-sm font-bold text-white shadow-md opacity-90 cursor-wait"
          >
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Starting translation...</span>
          </button>
        ) : isRunning || session?.status === "running" ? (
          <button
            id="active-pause-btn"
            onClick={() => onPause()}
            className="flex w-full items-center justify-center gap-2.5 rounded-2xl bg-[#C084FC] hover:bg-[#A855F7] py-3.5 px-4 text-sm font-bold text-white shadow-md shadow-purple-500/15 active:scale-98 transition cursor-pointer"
          >
            <span className="font-mono text-base leading-none">❚❚</span>
            <span>Pause Translation</span>
          </button>
        ) : isPaused || (session?.status === "paused") || (metrics.completedChunks > 0 && metrics.completedChunks < metrics.totalChunks) ? (
          <button
            id="active-resume-btn"
            onClick={() => (isPaused || session?.status === "paused" ? onResume() : onStart())}
            className="flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500 hover:opacity-95 py-3.5 px-4 text-sm font-bold text-white shadow-md shadow-purple-500/20 active:scale-98 transition cursor-pointer"
          >
            <Play className="h-4 w-4 fill-white" />
            <span>{mode === "cloud" ? "Resume Cloud Translation ☁️" : "Resume Translation ⚡"}</span>
          </button>
        ) : (
          <button
            id="active-start-btn"
            onClick={() => onStart()}
            className="flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500 hover:opacity-95 py-3.5 px-4 text-sm font-bold text-white shadow-md shadow-purple-500/20 active:scale-98 transition cursor-pointer"
          >
            <Play className="h-4 w-4 fill-white" />
            <span>{mode === "cloud" ? "Start Cloud Translation ☁️" : "Start Translation ⚡"}</span>
          </button>
        )}
      </div>

      {/* 6. Two Secondary Action Buttons Side-by-Side (Reference Screen 2) */}
      <div className="grid grid-cols-2 gap-2.5">
        {/* Download EPUB Button */}
        <button
          id="active-download-epub-btn"
          onClick={() => onDownloadProgress("epub")}
          className="flex items-center justify-center gap-2 rounded-2xl border border-sky-300 dark:border-sky-800 bg-sky-50/80 dark:bg-sky-950/40 hover:bg-sky-100 dark:hover:bg-sky-900/50 py-3 px-3 text-xs font-extrabold text-sky-800 dark:text-sky-200 transition active:scale-98 cursor-pointer shadow-2xs"
        >
          <BookCheck className="h-4 w-4 text-sky-600 dark:text-sky-400" />
          <span className="truncate">Download Current EPUB</span>
        </button>

        {/* Translate New Novel Button */}
        <button
          id="active-translate-new-novel-btn"
          onClick={() => (onTranslateNewNovel ? onTranslateNewNovel() : onReset())}
          className="flex items-center justify-center gap-2 rounded-2xl border border-purple-200 dark:border-purple-800/80 bg-purple-50/80 dark:bg-purple-950/40 hover:bg-purple-100 dark:hover:bg-purple-900/60 py-3 px-3 text-xs font-extrabold text-purple-700 dark:text-purple-300 transition active:scale-98 cursor-pointer shadow-2xs"
          title="Pause current novel, save progress to Cloud History, and translate a new novel"
        >
          <PlusCircle className="h-4 w-4 text-purple-600 dark:text-purple-400" />
          <span className="truncate">Translate New Novel</span>
        </button>
      </div>

      {/* 7. Translation Queue (Always Visible - Never Hidden) */}
      <div className="rounded-3xl border border-purple-100/80 dark:border-purple-900/40 bg-white/95 dark:bg-slate-900/95 p-4 sm:p-5 shadow-md shadow-purple-500/5 transition-colors space-y-3">
        {/* Header & Status Summary */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-purple-50 dark:border-slate-800/80 pb-2.5">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-purple-600 dark:text-purple-400 shrink-0" />
            <span className="text-xs font-extrabold text-slate-800 dark:text-slate-200 uppercase tracking-wider">
              Translation Queue
            </span>
            <span className="rounded-full bg-purple-100 dark:bg-purple-900/50 px-2 py-0.5 text-[10px] font-bold text-purple-700 dark:text-purple-300">
              {completedChunks.length}/{totalChunks} done
            </span>
          </div>

          {/* Filter Badges */}
          <div className="flex items-center gap-1 text-[11px]">
            <button
              onClick={() => setStatusFilter("all")}
              className={`rounded-full px-2.5 py-0.5 font-bold transition cursor-pointer ${
                statusFilter === "all" ? "bg-purple-600 text-white" : "text-slate-500 hover:text-purple-600 dark:text-slate-400"
              }`}
            >
              All ({totalChunks})
            </button>
            <button
              onClick={() => setStatusFilter("completed")}
              className={`rounded-full px-2.5 py-0.5 font-bold transition cursor-pointer ${
                statusFilter === "completed" ? "bg-emerald-600 text-white" : "text-slate-500 hover:text-emerald-600 dark:text-slate-400"
              }`}
            >
              Done ({completedChunks.length})
            </button>
            {processingChunks.length > 0 && (
              <button
                onClick={() => setStatusFilter("processing")}
                className={`rounded-full px-2.5 py-0.5 font-bold transition cursor-pointer ${
                  statusFilter === "processing" ? "bg-sky-600 text-white" : "text-sky-600 dark:text-sky-400 hover:bg-sky-50"
                }`}
              >
                Active ({processingChunks.length})
              </button>
            )}
            <button
              onClick={() => setStatusFilter("pending")}
              className={`rounded-full px-2.5 py-0.5 font-bold transition cursor-pointer ${
                statusFilter === "pending" ? "bg-slate-300 dark:bg-slate-700 text-slate-900 dark:text-white" : "text-slate-500 dark:text-slate-400"
              }`}
            >
              Queued ({pendingChunks.length})
            </button>
          </div>
        </div>

        {/* Quick Search / Filter Input */}
        <div className="relative w-full">
          <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-slate-400" />
          <input
            type="text"
            placeholder="Search chapters or text..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full rounded-xl border border-purple-100 dark:border-purple-900/60 bg-purple-50/40 dark:bg-slate-800/80 py-1.5 pl-8 pr-3 text-xs text-slate-800 dark:text-slate-200 placeholder-slate-400 focus:outline-none focus:border-purple-400"
          />
        </div>

        {/* Always-Visible Complete Chapter List */}
        <div className="max-h-80 sm:max-h-96 overflow-y-auto divide-y divide-purple-50 dark:divide-slate-800/70 pr-1 space-y-0.5">
          {filteredChunks.map((chunk) => {
            const isDone = chunk.status === "completed";
            const isActive = chunk.status === "processing";
            const isError = chunk.status === "error";
            const quality = isDone ? checkTranslationQuality(chunk.chineseText, chunk.englishText) : null;

            return (
              <div
                key={chunk.id}
                className={`flex items-center justify-between py-2 px-2 rounded-xl transition ${
                  isActive
                    ? "bg-purple-50/90 dark:bg-purple-950/40 border border-purple-200/80 dark:border-purple-800/60 shadow-2xs"
                    : quality?.isFlagged
                    ? "bg-amber-50/70 dark:bg-amber-950/30 border border-amber-200/60 dark:border-amber-800/40"
                    : "hover:bg-purple-50/40 dark:hover:bg-slate-800/40"
                }`}
              >
                <div className="flex items-center gap-2.5 min-w-0 flex-1 pr-2">
                  {isDone ? (
                    <span
                      className={`flex h-4 w-4 items-center justify-center rounded-full text-white shrink-0 text-[10px] font-bold ${
                        quality?.isFlagged ? "bg-amber-500" : "bg-emerald-500"
                      }`}
                    >
                      {quality?.isFlagged ? "!" : "✓"}
                    </span>
                  ) : isActive ? (
                    <span className="flex h-4 w-4 items-center justify-center rounded-full bg-purple-600 text-white shrink-0 text-[10px] font-bold animate-pulse">
                      ⚡
                    </span>
                  ) : isError ? (
                    <span className="flex h-4 w-4 items-center justify-center rounded-full bg-rose-500 text-white shrink-0 text-[10px] font-bold">
                      !
                    </span>
                  ) : (
                    <span className="flex h-4 w-4 items-center justify-center rounded-full bg-purple-100 dark:bg-purple-900/60 text-purple-400 shrink-0 text-[10px] font-bold">
                      •
                    </span>
                  )}

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 truncate">
                      <span className="font-bold text-xs text-slate-800 dark:text-slate-100">
                        Chapter {chunk.index + 1}
                      </span>
                      {(chunk.chapterTitle || (chunk as any).title) && (
                        <span className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                          · {chunk.chapterTitle || (chunk as any).title}
                        </span>
                      )}
                      {isActive && (
                        <span className="rounded-md bg-purple-200/70 dark:bg-purple-900/80 px-1.5 py-0.2 text-[9px] font-bold text-purple-800 dark:text-purple-200 uppercase tracking-wider animate-pulse">
                          Translating
                        </span>
                      )}
                      {quality?.isFlagged && (
                        <span
                          className="rounded-md bg-amber-200/80 dark:bg-amber-900/80 px-1.5 py-0.2 text-[9px] font-bold text-amber-900 dark:text-amber-200 uppercase tracking-wider"
                          title={quality.reason}
                        >
                          Short / Summary
                        </span>
                      )}
                    </div>
                    <div className="text-[10px] text-slate-400 flex items-center gap-2">
                      <span>{chunk.charCount.toLocaleString()} chars</span>
                      {(chunk.wordCount || (chunk.englishText ? chunk.englishText.trim().split(/\s+/).filter(Boolean).length : 0)) > 0 ? (
                        <span>· {(chunk.wordCount || chunk.englishText!.trim().split(/\s+/).filter(Boolean).length).toLocaleString()} words</span>
                      ) : null}
                      {quality?.isFlagged && (
                        <span className="text-amber-600 dark:text-amber-400 font-semibold">
                          · Ratio {quality.ratio}x
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <span
                    className={`text-[11px] font-semibold ${
                      quality?.isFlagged
                        ? "text-amber-600 dark:text-amber-400 font-bold"
                        : isDone
                        ? "text-emerald-600 dark:text-emerald-400"
                        : isActive
                        ? "text-purple-600 dark:text-purple-400 font-bold"
                        : isError
                        ? "text-rose-500"
                        : "text-slate-400"
                    }`}
                  >
                    {quality?.isFlagged ? "flagged" : isDone ? "completed" : isActive ? "translating..." : isError ? "error" : "queued"}
                  </span>

                  {(!isDone || quality?.isFlagged) && !isRunning && (
                    <button
                      type="button"
                      onClick={() => onTranslateChunk(chunk.id)}
                      className={`rounded-lg border px-2 py-0.5 text-[10px] font-bold transition cursor-pointer ${
                        quality?.isFlagged
                          ? "border-amber-300 dark:border-amber-700 bg-amber-100/60 dark:bg-amber-900/50 text-amber-800 dark:text-amber-200 hover:bg-amber-200/80"
                          : "border-purple-200 dark:border-purple-800 text-purple-700 dark:text-purple-300 hover:bg-purple-100 dark:hover:bg-purple-900/50"
                      }`}
                      title={quality?.isFlagged ? "Re-translate to prevent summary" : "Translate chunk"}
                    >
                      {quality?.isFlagged ? "Re-do" : "Translate"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
