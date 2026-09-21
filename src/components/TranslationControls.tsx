import React, { useState } from "react";
import {
  Play,
  Pause,
  RotateCcw,
  FastForward,
  Download,
  Settings2,
  CheckCircle,
  AlertTriangle,
  BookCheck,
  BookOpen,
  ChevronDown,
  FileText,
  Cloud,
  Globe,
  WifiOff,
  ShieldCheck,
  RefreshCw,
  Loader2,
  Sparkles,
  Zap,
} from "lucide-react";
import { TranslationStyle, TranslationMode } from "../types";

interface TranslationControlsProps {
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
  hasErrors: boolean;
  completedChunks: number;
  totalChunks: number;
  completedEnglishWords: number;
  lastDownloadedWords: number;
  onReset?: () => void;
}

export const TranslationControls: React.FC<TranslationControlsProps> = ({
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
  hasErrors,
  completedChunks,
  totalChunks,
  completedEnglishWords,
  lastDownloadedWords,
  onReset,
}) => {
  const [showFormatDropdown, setShowFormatDropdown] = useState(false);
  const isFinished = totalChunks > 0 && completedChunks === totalChunks;
  const newWordsSinceLast = Math.max(0, completedEnglishWords - lastDownloadedWords);

  return (
    <div className="rounded-3xl border border-purple-100/80 dark:border-purple-900/40 bg-white/95 dark:bg-slate-900/95 p-4 sm:p-5 shadow-md shadow-purple-500/5 transition-colors space-y-4">
      {/* Metric Chips (Model & Streams) */}
      <div className="grid grid-cols-2 gap-2.5">
        <div className="flex items-center gap-2 rounded-2xl border border-purple-100 dark:border-purple-900/50 bg-[#FAF8FE]/80 dark:bg-slate-800/80 px-3.5 py-2.5">
          <Sparkles className="h-4 w-4 text-purple-500 shrink-0" />
          <div className="min-w-0">
            <div className="text-[10px] font-bold uppercase tracking-wider text-purple-600 dark:text-purple-300">Model</div>
            <div className="text-xs font-bold text-slate-800 dark:text-slate-100 truncate">Gemini 3.8 Flash</div>
          </div>
        </div>

        <div className="flex items-center gap-2 rounded-2xl border border-purple-100 dark:border-purple-900/50 bg-[#FAF8FE]/80 dark:bg-slate-800/80 px-3 py-1.5">
          <Zap className="h-4 w-4 text-amber-500 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-bold uppercase tracking-wider text-purple-600 dark:text-purple-300">Streams</div>
            <select
              value={concurrency}
              onChange={(e) => onChangeConcurrency(Number(e.target.value))}
              className="w-full bg-transparent text-xs font-bold text-slate-800 dark:text-slate-100 focus:outline-none cursor-pointer"
            >
              <option value={1}>1 stream (Ordered)</option>
              <option value={2}>2 streams (Fast)</option>
              <option value={3}>3 streams (Parallel)</option>
              <option value={4}>4 streams (High Speed)</option>
              <option value={5}>5 streams (Max Speed)</option>
            </select>
          </div>
        </div>
      </div>

      {/* Primary Action Button (Full Width on Mobile) */}
      <div>
        {isFinished ? (
          <div
            id="controls-completed-status-badge"
            className="flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-emerald-500 to-teal-600 py-3.5 px-4 text-sm font-bold text-white shadow-md shadow-emerald-500/20"
          >
            <CheckCircle className="h-5 w-5 text-emerald-100" />
            <span>Translation Finished (100%)</span>
          </div>
        ) : isStarting ? (
          <button
            id="starting-translation-btn"
            disabled
            className="flex w-full items-center justify-center gap-2 rounded-2xl bg-purple-400 py-3.5 px-4 text-sm font-bold text-white shadow-md opacity-90 cursor-wait"
          >
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Starting translation...</span>
          </button>
        ) : isRunning ? (
          <button
            id="pause-translation-btn"
            onClick={onPause}
            className="flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 py-3.5 px-4 text-sm font-bold text-white shadow-md shadow-amber-500/20 active:scale-98 transition cursor-pointer"
          >
            <Pause className="h-4 w-4" />
            <span>Pause Translation</span>
          </button>
        ) : isPaused || (completedChunks > 0 && completedChunks < totalChunks) ? (
          <button
            id="resume-translation-btn"
            onClick={isPaused ? onResume : onStart}
            className="flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500 hover:opacity-95 py-3.5 px-4 text-sm font-bold text-white shadow-md shadow-purple-500/20 active:scale-98 transition cursor-pointer"
          >
            <Play className="h-4 w-4 fill-white" />
            <span>{mode === "cloud" ? "Resume Cloud Translation ☁️" : "Resume Translation ⚡"}</span>
          </button>
        ) : (
          <button
            id="start-batch-btn"
            onClick={onStart}
            className="flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500 hover:opacity-95 py-3.5 px-4 text-sm font-bold text-white shadow-md shadow-purple-500/20 active:scale-98 transition cursor-pointer"
          >
            <Play className="h-4 w-4 fill-white" />
            <span>{mode === "cloud" ? "Start Cloud Translation ☁️" : "Start Translation ⚡"}</span>
          </button>
        )}
      </div>

      {/* Secondary Action Buttons (Download EPUB & Delete/Reset) */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Download EPUB Progress Button */}
        {completedChunks > 0 && (
          <div className="relative flex-1 inline-flex rounded-2xl shadow-xs">
            <button
              id="download-progress-btn"
              onClick={() => onDownloadProgress("epub")}
              className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-l-2xl border border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/60 hover:bg-emerald-100 dark:hover:bg-emerald-900/60 py-2.5 px-3 text-xs font-bold text-emerald-800 dark:text-emerald-200 transition active:scale-95 cursor-pointer"
              title="Download whatever is finished as an EPUB eBook"
            >
              <BookCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              <span>Download Current EPUB</span>
              {newWordsSinceLast > 0 && (
                <span className="rounded-full bg-emerald-600 px-1.5 py-0.2 text-[10px] font-bold text-white">
                  +{newWordsSinceLast > 1000 ? `${(newWordsSinceLast / 1000).toFixed(1)}k` : newWordsSinceLast}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => setShowFormatDropdown(!showFormatDropdown)}
              className="inline-flex items-center rounded-r-2xl border border-l-0 border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/60 hover:bg-emerald-100 dark:hover:bg-emerald-900/60 px-2 py-2.5 text-emerald-800 dark:text-emerald-200 transition"
              title="Select format (EPUB / TXT)"
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </button>

            {showFormatDropdown && (
              <div
                className="absolute left-0 top-full mt-1.5 z-30 w-52 rounded-2xl border border-purple-100 dark:border-slate-700 bg-white dark:bg-slate-800 p-2 shadow-xl"
                onClick={() => setShowFormatDropdown(false)}
              >
                <button
                  onClick={() => onDownloadProgress("epub")}
                  className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-xs font-medium text-slate-800 dark:text-slate-200 hover:bg-emerald-50 dark:hover:bg-slate-700"
                >
                  <BookCheck className="h-4 w-4 text-emerald-600" />
                  <div>
                    <div className="font-bold">EPUB eBook (.epub)</div>
                    <div className="text-[10px] text-slate-400">For Moon+ Reader, Kindle</div>
                  </div>
                </button>
                <button
                  onClick={() => onDownloadProgress("txt")}
                  className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-xs font-medium text-slate-800 dark:text-slate-200 hover:bg-purple-50 dark:hover:bg-slate-700"
                >
                  <FileText className="h-4 w-4 text-purple-600" />
                  <div>
                    <div className="font-bold">Plain TXT (.txt)</div>
                    <div className="text-[10px] text-slate-400">Standard text file</div>
                  </div>
                </button>
              </div>
            )}
          </div>
        )}

        {/* Export Book Options */}
        <button
          id="open-export-modal-btn"
          onClick={onOpenExport}
          className="inline-flex items-center justify-center gap-1.5 rounded-2xl border border-purple-200 dark:border-purple-800/80 bg-white dark:bg-slate-800 hover:bg-purple-50 dark:hover:bg-slate-700 px-3.5 py-2.5 text-xs font-bold text-purple-700 dark:text-purple-300 transition active:scale-95 cursor-pointer shadow-2xs"
          title="Open export modal (Bilingual, Markdown, TXT)"
        >
          <BookOpen className="h-4 w-4" />
          <span>Export Options</span>
        </button>

        {/* Retry errors button */}
        {hasErrors && !isRunning && (
          <button
            id="retry-failed-btn"
            onClick={onRetryFailed}
            className="inline-flex items-center justify-center gap-1 rounded-2xl border border-rose-200 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/60 px-3 py-2.5 text-xs font-bold text-rose-700 dark:text-rose-300 transition hover:bg-rose-100 active:scale-95 cursor-pointer"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span>Retry Failed</span>
          </button>
        )}

        {/* Step next chunk */}
        {!isRunning && !isFinished && (
          <button
            id="step-next-chunk-btn"
            onClick={onTranslateNext}
            className="inline-flex items-center justify-center gap-1 rounded-2xl border border-purple-100 dark:border-purple-900 bg-white dark:bg-slate-800 px-3 py-2.5 text-xs font-bold text-slate-700 dark:text-slate-200 transition hover:bg-purple-50 active:scale-95 cursor-pointer"
            title="Translate next chunk to preview quality"
          >
            <FastForward className="h-3.5 w-3.5 text-purple-500" />
            <span>Next Chunk</span>
          </button>
        )}

        {/* Translate Another Book / Delete */}
        {onReset && (
          <button
            id="controls-new-book-btn"
            onClick={onReset}
            className="inline-flex items-center justify-center gap-1 rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-rose-50 hover:text-rose-600 hover:border-rose-200 px-3 py-2.5 text-xs font-bold text-slate-600 dark:text-slate-300 transition active:scale-95 cursor-pointer"
            title="Delete translation / start another novel"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span>Reset Book</span>
          </button>
        )}
      </div>

      {/* Mode & Style Selection Accordion/Section */}
      <div className="rounded-2xl border border-purple-100/70 dark:border-purple-900/40 bg-[#FAF8FE]/50 dark:bg-slate-800/50 p-3 space-y-3">
        {/* Mode Switch Pills */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <span className="text-xs font-bold text-purple-700 dark:text-purple-300">
            Translation Mode:
          </span>
          <div className="flex rounded-xl border border-purple-100 dark:border-purple-900/60 bg-white dark:bg-slate-800 p-1 text-xs">
            <button
              type="button"
              onClick={() => onChangeMode("cloud")}
              className={`flex-1 flex items-center justify-center gap-1.5 rounded-lg px-2.5 py-1.5 font-bold transition ${
                mode === "cloud"
                  ? "bg-gradient-to-r from-indigo-500 to-purple-600 text-white shadow-2xs"
                  : "text-slate-600 dark:text-slate-300 hover:text-purple-600"
              }`}
            >
              <Cloud className="h-3.5 w-3.5" />
              <span>☁️ Cloud Mode (Background)</span>
            </button>
            <button
              type="button"
              onClick={() => onChangeMode("browser")}
              className={`flex-1 flex items-center justify-center gap-1.5 rounded-lg px-2.5 py-1.5 font-bold transition ${
                mode === "browser"
                  ? "bg-gradient-to-r from-indigo-500 to-purple-600 text-white shadow-2xs"
                  : "text-slate-600 dark:text-slate-300 hover:text-purple-600"
              }`}
            >
              <Globe className="h-3.5 w-3.5" />
              <span>⚡ Browser Tab</span>
            </button>
          </div>
        </div>

        {/* Style Selection Pills */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pt-1 border-t border-purple-100/60 dark:border-purple-900/40">
          <span className="text-xs font-bold text-purple-700 dark:text-purple-300">
            Tone / Style:
          </span>
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => onChangeStyle("xianxia")}
              className={`rounded-xl px-2.5 py-1 text-xs font-bold transition ${
                style === "xianxia"
                  ? "bg-purple-600 text-white shadow-2xs"
                  : "bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:text-purple-600 border border-purple-100 dark:border-purple-900/60"
              }`}
            >
              Webnovel / Xianxia
            </button>
            <button
              onClick={() => onChangeStyle("fluent")}
              className={`rounded-xl px-2.5 py-1 text-xs font-bold transition ${
                style === "fluent"
                  ? "bg-purple-600 text-white shadow-2xs"
                  : "bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:text-purple-600 border border-purple-100 dark:border-purple-900/60"
              }`}
            >
              Fluent Modern
            </button>
            <button
              onClick={() => onChangeStyle("literary")}
              className={`rounded-xl px-2.5 py-1 text-xs font-bold transition ${
                style === "literary"
                  ? "bg-purple-600 text-white shadow-2xs"
                  : "bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:text-purple-600 border border-purple-100 dark:border-purple-900/60"
              }`}
            >
              Literary
            </button>
          </div>
        </div>

        {/* Custom Instructions */}
        <div className="pt-1">
          <input
            type="text"
            placeholder="Custom instructions (e.g. 'Keep Pinyin for techniques and sect names')"
            value={customInstructions}
            onChange={(e) => onChangeCustomInstructions(e.target.value)}
            className="w-full rounded-xl border border-purple-100 dark:border-purple-900/60 bg-white dark:bg-slate-800 px-3 py-2 text-xs text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:border-purple-400 focus:outline-none"
          />
        </div>
      </div>
    </div>
  );
};
