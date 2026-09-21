import React, { useState } from "react";
import {
  CheckCircle2,
  BookOpen,
  Download,
  FileText,
  Clock,
  Layers,
  Sparkles,
  Settings2,
  Trash2,
  BookCheck,
  RefreshCw,
  ExternalLink,
  Loader2,
} from "lucide-react";
import { TranslationSession, TranslationMetrics, TranslationStyle, TranslationMode } from "../types";
import { StoryVignetteIllustration } from "./illustrations/StorybookArtwork";

interface TranslationCompleteViewProps {
  session: TranslationSession;
  metrics: TranslationMetrics;
  mode: TranslationMode;
  style: TranslationStyle;
  concurrency: number;
  onDownloadProgress: (format?: "epub" | "txt") => void | Promise<void>;
  onOpenExport: () => void;
  onReset: () => void;
  onSyncProgress?: () => void;
  isSyncing?: boolean;
  onOpenReader?: () => void;
}

function formatDuration(seconds: number): string {
  if (seconds <= 0 || !isFinite(seconds)) return "Ready";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  if (mins >= 60) {
    const hours = Math.floor(mins / 60);
    const remainMins = mins % 60;
    return `${hours}h ${remainMins}m`;
  }
  return `${mins}m ${secs.toString().padStart(2, "0")}s`;
}

export const TranslationCompleteView: React.FC<TranslationCompleteViewProps> = ({
  session,
  metrics,
  mode,
  style,
  concurrency,
  onDownloadProgress,
  onOpenExport,
  onReset,
  onSyncProgress,
  isSyncing = false,
  onOpenReader,
}) => {
  const [downloadingFormat, setDownloadingFormat] = useState<"epub" | "txt" | null>(null);

  const handleDownload = async (format: "epub" | "txt") => {
    if (downloadingFormat) return;
    setDownloadingFormat(format);
    try {
      await onDownloadProgress(format);
    } finally {
      setDownloadingFormat(null);
    }
  };

  const totalChunks = session.chunks.length;
  const completedWords = metrics.completedEnglishWords;
  const totalChars = metrics.completedChars || session.totalChineseChars || 0;

  return (
    <div className="space-y-4 transition animate-in fade-in duration-300">
      {/* 1. Large Circular Green Checkmark Header (Reference Screen 3) */}
      <div className="text-center pt-2 pb-1 space-y-2">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500 text-white shadow-lg shadow-emerald-500/25">
          <CheckCircle2 className="h-9 w-9 stroke-[2.5]" />
        </div>
        <h2 className="text-xl sm:text-2xl font-black text-emerald-700 dark:text-emerald-400 tracking-tight">
          Translation Complete!
        </h2>
        <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-300 max-w-sm mx-auto">
          Your novel has been successfully translated to English.
        </p>
      </div>

      {/* 2. Novel Summary Card */}
      <div className="rounded-3xl border border-purple-100/80 dark:border-purple-900/40 bg-white/95 dark:bg-slate-900/95 p-4 sm:p-5 shadow-md shadow-purple-500/5 transition-colors space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-100 via-purple-100 to-pink-100 dark:from-indigo-950 dark:via-purple-900/60 dark:to-pink-950/60 text-purple-600 dark:text-purple-300">
              <BookOpen className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm sm:text-base font-extrabold text-slate-800 dark:text-slate-100 truncate" title={session.fileName}>
                {session.fileName}
              </h3>
              <p className="text-xs text-purple-600 dark:text-purple-300 font-medium">
                Chapter 1 — {totalChunks} · {completedWords.toLocaleString()} words
              </p>
            </div>
          </div>
        </div>

        {/* Metrics Rows */}
        <div className="border-t border-purple-50 dark:border-slate-800 pt-2.5 space-y-2 text-xs">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-slate-500 dark:text-slate-400">
              <Layers className="h-3.5 w-3.5 text-purple-500" />
              <span>Total Chunks</span>
            </div>
            <span className="font-extrabold text-slate-800 dark:text-slate-100">{totalChunks}</span>
          </div>

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-slate-500 dark:text-slate-400">
              <FileText className="h-3.5 w-3.5 text-purple-500" />
              <span>Chinese Characters</span>
            </div>
            <span className="font-extrabold text-slate-800 dark:text-slate-100">{totalChars.toLocaleString()}</span>
          </div>

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-slate-500 dark:text-slate-400">
              <BookCheck className="h-3.5 w-3.5 text-emerald-500" />
              <span>English Words</span>
            </div>
            <span className="font-extrabold text-emerald-600 dark:text-emerald-400">~{completedWords.toLocaleString()}</span>
          </div>

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-slate-500 dark:text-slate-400">
              <Clock className="h-3.5 w-3.5 text-purple-500" />
              <span>Total Time</span>
            </div>
            <span className="font-extrabold text-slate-800 dark:text-slate-100">
              {metrics.elapsedMs > 0 ? formatDuration(Math.floor(metrics.elapsedMs / 1000)) : "Complete"}
            </span>
          </div>
        </div>
      </div>

      {/* 3. Download Your Translation Card (Reference Screen 3) */}
      <div className="rounded-3xl border border-purple-100/80 dark:border-purple-900/40 bg-white/95 dark:bg-slate-900/95 p-4 sm:p-5 shadow-md shadow-purple-500/5 transition-colors space-y-3">
        <h4 className="text-xs font-extrabold uppercase tracking-wider text-slate-800 dark:text-slate-200">
          Read or Download Translation
        </h4>

        {onOpenReader && (
          <button
            type="button"
            onClick={onOpenReader}
            className="w-full flex items-center justify-center gap-2 rounded-2xl border border-purple-200 dark:border-purple-800 bg-purple-50 dark:bg-purple-950/60 hover:bg-purple-100 dark:hover:bg-purple-900/60 py-3 px-4 text-sm font-extrabold text-purple-700 dark:text-purple-300 shadow-2xs transition active:scale-98 cursor-pointer"
          >
            <BookOpen className="h-4.5 w-4.5 text-purple-600 dark:text-purple-400" />
            <span>Read in Reader Mode (QuickNovel TTS)</span>
          </button>
        )}

        {/* Primary Download EPUB Button */}
        <button
          id="complete-screen-download-epub-btn"
          type="button"
          disabled={downloadingFormat !== null}
          onClick={() => handleDownload("epub")}
          className="w-full flex items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500 hover:opacity-95 py-3.5 px-4 text-sm font-bold text-white shadow-md shadow-purple-500/20 active:scale-98 transition cursor-pointer disabled:opacity-75 disabled:cursor-wait"
        >
          {downloadingFormat === "epub" ? (
            <>
              <Loader2 className="h-4.5 w-4.5 animate-spin" />
              <span>Packaging EPUB eBook...</span>
            </>
          ) : (
            <>
              <Download className="h-4.5 w-4.5" />
              <span>Download EPUB</span>
            </>
          )}
        </button>
        <p className="text-center text-[11px] text-purple-600 dark:text-purple-300 font-medium">
          Your translated novel is ready!
        </p>

        {/* Secondary Download / Preview Action Buttons */}
        <div className="grid grid-cols-2 gap-2 pt-1">
          <button
            id="complete-screen-preview-btn"
            type="button"
            onClick={onOpenExport}
            className="flex items-center justify-center gap-1.5 rounded-2xl border border-purple-200 dark:border-purple-800 bg-white dark:bg-slate-800 hover:bg-purple-50 dark:hover:bg-slate-700 py-2.5 px-3 text-xs font-bold text-purple-700 dark:text-purple-300 transition active:scale-95 cursor-pointer"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            <span>Preview & Export</span>
          </button>

          <button
            id="complete-screen-download-txt-btn"
            type="button"
            disabled={downloadingFormat !== null}
            onClick={() => handleDownload("txt")}
            className="flex items-center justify-center gap-1.5 rounded-2xl border border-purple-200 dark:border-purple-800 bg-white dark:bg-slate-800 hover:bg-purple-50 dark:hover:bg-slate-700 py-2.5 px-3 text-xs font-bold text-purple-700 dark:text-purple-300 transition active:scale-95 cursor-pointer disabled:opacity-75 disabled:cursor-wait"
          >
            {downloadingFormat === "txt" ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>Exporting...</span>
              </>
            ) : (
              <>
                <FileText className="h-3.5 w-3.5" />
                <span>Plain TXT</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* 4. Translation Settings (Used) Card (Reference Screen 3) */}
      <div className="rounded-3xl border border-purple-100/80 dark:border-purple-900/40 bg-white/95 dark:bg-slate-900/95 p-4 sm:p-5 shadow-md shadow-purple-500/5 transition-colors space-y-2.5">
        <div className="flex items-center gap-2 text-xs font-extrabold text-slate-800 dark:text-slate-200 uppercase tracking-wider">
          <Settings2 className="h-4 w-4 text-purple-500" />
          <span>Translation Settings (Used)</span>
        </div>

        <div className="space-y-2 text-xs divide-y divide-purple-50 dark:divide-slate-800">
          <div className="flex items-center justify-between pt-1">
            <span className="text-slate-500 dark:text-slate-400">Chunk Size</span>
            <span className="font-bold text-slate-700 dark:text-slate-200">
              {Math.round(totalChars / (totalChunks || 1)).toLocaleString()} characters / chunk
            </span>
          </div>

          <div className="flex items-center justify-between pt-2">
            <span className="text-slate-500 dark:text-slate-400">Streams</span>
            <span className="font-bold text-slate-700 dark:text-slate-200">{concurrency} (Maximum Speed)</span>
          </div>

          <div className="flex items-center justify-between pt-2">
            <span className="text-slate-500 dark:text-slate-400">Model</span>
            <span className="font-bold text-slate-700 dark:text-slate-200">gemini-3.8-flash (Recommended)</span>
          </div>

          <div className="flex items-center justify-between pt-2">
            <span className="text-slate-500 dark:text-slate-400">Style</span>
            <span className="font-bold text-slate-700 dark:text-slate-200">
              {style === "xianxia" ? "Webnovel / Xianxia" : style === "fluent" ? "Fluent Modern" : "Literary"}
            </span>
          </div>

          <div className="flex items-center justify-between pt-2">
            <span className="text-slate-500 dark:text-slate-400">Mode</span>
            <span className="font-bold text-slate-700 dark:text-slate-200">
              {mode === "cloud" ? "☁️ Cloud Background" : "⚡ Browser Direct"}
            </span>
          </div>
        </div>
      </div>

      {/* 5. Translation Summary Card with Pagoda Sakura Vignette (Reference Screen 3) */}
      <div className="rounded-3xl border border-purple-100/80 dark:border-purple-900/40 bg-white/95 dark:bg-slate-900/95 p-4 sm:p-5 shadow-md shadow-purple-500/5 transition-colors space-y-3">
        <div className="flex items-center gap-2 text-xs font-extrabold text-slate-800 dark:text-slate-200 uppercase tracking-wider">
          <Sparkles className="h-4 w-4 text-pink-500" />
          <span>Translation Summary</span>
        </div>
        <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
          A total of {totalChunks} chapters were translated successfully. All original story content has been preserved, including names, dialogue, paragraphs, and chapter structure.
        </p>

        {/* Pagoda & Sakura Storybook Vignette with Quote: "Good stories travel far ♥" */}
        <StoryVignetteIllustration className="my-1" />
      </div>

      {/* 6. Bottom Action Button (Delete Translation / Start Another) */}
      <div className="pt-1">
        <button
          id="complete-screen-reset-btn"
          type="button"
          onClick={onReset}
          className="w-full flex items-center justify-center gap-2 rounded-2xl border border-rose-200 dark:border-rose-900/60 bg-rose-50/70 dark:bg-rose-950/30 hover:bg-rose-100 dark:hover:bg-rose-950/60 py-3 px-4 text-xs font-bold text-rose-700 dark:text-rose-300 active:scale-98 transition cursor-pointer"
        >
          <Trash2 className="h-4 w-4" />
          <span>Delete Translation / Translate Another Novel</span>
        </button>
      </div>
    </div>
  );
};
