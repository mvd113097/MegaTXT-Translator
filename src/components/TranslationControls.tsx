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
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 shadow-xs transition-colors duration-200 space-y-4">
      {/* Mode Selection Banner (Option 1 vs Option 2) */}
      <div className="rounded-xl border border-indigo-100 dark:border-indigo-950/60 bg-gradient-to-r from-indigo-50/70 via-sky-50/50 to-slate-50 dark:from-indigo-950/30 dark:via-slate-900 dark:to-slate-900 p-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold uppercase tracking-wider text-indigo-900 dark:text-indigo-300">
                Translation Mode:
              </span>
              <span className="rounded-full bg-indigo-100 dark:bg-indigo-900/60 px-2 py-0.5 text-[10px] font-bold text-indigo-800 dark:text-indigo-200">
                {mode === "cloud" ? "Option 1 Selected" : "Option 2 Selected"}
              </span>
            </div>
            <p className="mt-0.5 text-[11px] text-slate-600 dark:text-slate-400">
              {mode === "cloud"
                ? "☁️ Translates on server in background. You can safely close the browser, turn off your screen, and uses 0 mobile data while translating."
                : "⚡ Translates in real-time in this open browser tab."}
            </p>
          </div>

          {/* Mode switch buttons */}
          <div className="flex w-full sm:inline-flex rounded-lg border border-slate-200 dark:border-slate-700 bg-white/80 dark:bg-slate-800/90 p-1 text-xs shadow-xs">
            <button
              type="button"
              onClick={() => onChangeMode("cloud")}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 sm:px-3 py-1.5 font-medium transition ${
                mode === "cloud"
                  ? "bg-indigo-600 text-white shadow-xs font-semibold"
                  : "text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white"
              }`}
              title="Translates continuously on server. Close browser anytime!"
            >
              <Cloud className="h-3.5 w-3.5" />
              <span className="truncate">
                <span className="hidden sm:inline">Option 1: ☁️ Cloud Mode (Browser Closed)</span>
                <span className="sm:hidden">☁️ Cloud Mode</span>
              </span>
            </button>
            <button
              type="button"
              onClick={() => onChangeMode("browser")}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 sm:px-3 py-1.5 font-medium transition ${
                mode === "browser"
                  ? "bg-indigo-600 text-white shadow-xs font-semibold"
                  : "text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white"
              }`}
              title="Translates in open browser tab"
            >
              <Globe className="h-3.5 w-3.5" />
              <span className="truncate">
                <span className="hidden sm:inline">Option 2: ⚡ Browser Mode (Tab Open)</span>
                <span className="sm:hidden">⚡ Browser Mode</span>
              </span>
            </button>
          </div>
        </div>

        {mode === "cloud" && (
          <div className="mt-2.5 flex flex-wrap items-center gap-3 border-t border-indigo-100/70 dark:border-indigo-900/40 pt-2 text-[11px] text-indigo-900 dark:text-indigo-200">
            <span className="inline-flex items-center gap-1 font-semibold text-emerald-700 dark:text-emerald-400">
              <ShieldCheck className="h-3.5 w-3.5" />
              100% Free Forever
            </span>
            <span className="inline-flex items-center gap-1 text-slate-600 dark:text-slate-300">
              <WifiOff className="h-3.5 w-3.5 text-indigo-500" />
              0 Mobile Data Usage during translation
            </span>
            <span className="inline-flex items-center gap-1 text-slate-600 dark:text-slate-300">
              <Cloud className="h-3.5 w-3.5 text-indigo-500" />
              Safe to close browser, lock phone, or sleep
            </span>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-4">
        {/* Style selection */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-bold text-slate-700 dark:text-slate-200">Style:</span>
          <div className="inline-flex rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 p-0.5 text-xs">
            <button
              onClick={() => onChangeStyle("xianxia")}
              className={`rounded-md px-2.5 py-1 font-medium transition ${
                style === "xianxia"
                  ? "bg-white dark:bg-slate-700 text-indigo-700 dark:text-indigo-300 shadow-xs font-semibold"
                  : "text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white"
              }`}
              title="Optimized for Chinese Webnovels, Cultivation, Xianxia, Wuxia fantasy tropes"
            >
              Webnovel / Xianxia
            </button>
            <button
              onClick={() => onChangeStyle("fluent")}
              className={`rounded-md px-2.5 py-1 font-medium transition ${
                style === "fluent"
                  ? "bg-white dark:bg-slate-700 text-indigo-700 dark:text-indigo-300 shadow-xs font-semibold"
                  : "text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white"
              }`}
              title="Natural, idiomatic, high-readability modern English"
            >
              Fluent Modern
            </button>
            <button
              onClick={() => onChangeStyle("literary")}
              className={`rounded-md px-2.5 py-1 font-medium transition ${
                style === "literary"
                  ? "bg-white dark:bg-slate-700 text-indigo-700 dark:text-indigo-300 shadow-xs font-semibold"
                  : "text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white"
              }`}
              title="Polished, rhythmic literary prose suitable for high-standard literature"
            >
              Literary Fiction
            </button>
            <button
              onClick={() => onChangeStyle("formal")}
              className={`rounded-md px-2.5 py-1 font-medium transition ${
                style === "formal"
                  ? "bg-white dark:bg-slate-700 text-indigo-700 dark:text-indigo-300 shadow-xs font-semibold"
                  : "text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white"
              }`}
              title="Objective, formal, for business, legal, or technical documentation"
            >
              Formal
            </button>
            <button
              onClick={() => onChangeStyle("literal")}
              className={`rounded-md px-2.5 py-1 font-medium transition ${
                style === "literal"
                  ? "bg-white dark:bg-slate-700 text-indigo-700 dark:text-indigo-300 shadow-xs font-semibold"
                  : "text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white"
              }`}
              title="Faithful and close to original sentence structure"
            >
              Literal
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-bold text-slate-700 dark:text-slate-200">Order & Concurrency:</span>
          <select
            value={concurrency}
            onChange={(e) => onChangeConcurrency(Number(e.target.value))}
            className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-2 py-1 text-xs font-medium text-slate-700 dark:text-slate-200 focus:border-indigo-500 focus:outline-none max-w-[160px] sm:max-w-none"
            title="Number of chapters translated in parallel"
          >
            <option value={1}>1 stream (Strict 1→2→3)</option>
            <option value={2}>2 streams (Fast Parallel)</option>
            <option value={3}>3 streams (Parallel)</option>
            <option value={4}>4 streams (High Speed)</option>
            <option value={5}>5 streams (Maximum Speed - 5 Projects)</option>
          </select>
        </div>

        {/* Action Buttons */}
        <div className="flex flex-wrap items-center gap-2">
          {isRunning ? (
            <button
              id="pause-translation-btn"
              onClick={onPause}
              className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-4 py-1.5 text-xs font-semibold text-white shadow-xs transition hover:bg-amber-600 active:scale-95"
            >
              <Pause className="h-3.5 w-3.5" />
              <span>Pause {mode === "cloud" ? "Cloud" : "Batch"}</span>
            </button>
          ) : isPaused ? (
            <button
              id="resume-translation-btn"
              onClick={onResume}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-1.5 text-xs font-semibold text-white shadow-xs transition hover:bg-emerald-700 active:scale-95"
            >
              <Play className="h-3.5 w-3.5" />
              <span>Resume {mode === "cloud" ? "Cloud" : "Batch"}</span>
            </button>
          ) : isFinished ? (
            <div className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-50 dark:bg-emerald-950/60 px-3 py-1.5 text-xs font-semibold text-emerald-700 dark:text-emerald-300">
              <CheckCircle className="h-3.5 w-3.5" />
              <span>All Chunks Translated</span>
            </div>
          ) : (
            <button
              id="start-batch-btn"
              onClick={onStart}
              className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-1.5 text-xs font-semibold text-white shadow-xs shadow-indigo-200 dark:shadow-none transition hover:bg-indigo-700 active:scale-95"
            >
              <Play className="h-3.5 w-3.5" />
              <span>{mode === "cloud" ? "Start Cloud Translation ☁️" : "Translate All Chunks ⚡"}</span>
            </button>
          )}

          {/* Translate Another Book button */}
          {onReset && (
            <button
              id="controls-new-book-btn"
              onClick={onReset}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 transition hover:bg-rose-50 dark:hover:bg-rose-950/40 hover:text-rose-600 dark:hover:text-rose-400 hover:border-rose-300 active:scale-95 cursor-pointer"
              title="Upload another book or clear current session"
            >
              <RefreshCw className="h-3.5 w-3.5 text-indigo-600 dark:text-indigo-400" />
              <span>Translate Another Book</span>
            </button>
          )}

          {/* Translate Next Single Chunk button */}
          {!isRunning && !isFinished && (
            <button
              id="step-next-chunk-btn"
              onClick={onTranslateNext}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 transition hover:bg-slate-50 dark:hover:bg-slate-700 active:scale-95"
              title="Translate just the next chunk to preview quality"
            >
              <FastForward className="h-3.5 w-3.5 text-indigo-600 dark:text-indigo-400" />
              <span>Translate Next Chunk</span>
            </button>
          )}

          {/* Retry errors button */}
          {hasErrors && !isRunning && (
            <button
              id="retry-failed-btn"
              onClick={onRetryFailed}
              className="inline-flex items-center gap-1.5 rounded-lg border border-rose-200 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/60 px-3 py-1.5 text-xs font-medium text-rose-700 dark:text-rose-300 transition hover:bg-rose-100 dark:hover:bg-rose-900 active:scale-95"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span>Retry Failed</span>
            </button>
          )}

          {/* Dedicated Download Progress Button as EPUB */}
          {completedChunks > 0 && (
            <div className="relative inline-flex rounded-lg shadow-xs shadow-emerald-200 dark:shadow-none">
              <button
                id="download-progress-btn"
                onClick={() => onDownloadProgress("epub")}
                className="inline-flex items-center gap-1.5 rounded-l-lg border border-emerald-500 bg-emerald-600 px-3.5 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-700 active:scale-95"
                title="Download whatever is finished so far as a full EPUB eBook without interrupting the translation"
              >
                <BookCheck className="h-3.5 w-3.5" />
                <span className="truncate">
                  <span className="hidden sm:inline">Download EPUB</span>
                  <span className="sm:hidden">EPUB</span>
                  <span className="ml-1 opacity-90">
                    (
                    {completedEnglishWords > 1000
                      ? `${(completedEnglishWords / 1000).toFixed(1)}k`
                      : `${completedEnglishWords}`}
                    )
                  </span>
                </span>
                {lastDownloadedWords > 0 && newWordsSinceLast > 0 && (
                  <span className="rounded-full bg-emerald-700 px-1.5 py-0.2 text-[10px] font-bold text-emerald-100">
                    +{newWordsSinceLast > 1000 ? `${(newWordsSinceLast / 1000).toFixed(1)}k` : newWordsSinceLast}
                  </span>
                )}
              </button>
              <button
                type="button"
                onClick={() => setShowFormatDropdown(!showFormatDropdown)}
                className="inline-flex items-center rounded-r-lg border border-l-0 border-emerald-500 bg-emerald-600 px-1.5 py-1.5 text-white transition hover:bg-emerald-700"
                title="Select format (EPUB / TXT)"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>

              {showFormatDropdown && (
                <div
                  className="absolute right-0 top-full mt-1 z-30 w-48 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-1.5 shadow-lg"
                  onClick={() => setShowFormatDropdown(false)}
                >
                  <button
                    onClick={() => onDownloadProgress("epub")}
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-medium text-slate-800 dark:text-slate-200 hover:bg-emerald-50 dark:hover:bg-emerald-950/50 hover:text-emerald-800 dark:hover:text-emerald-300"
                  >
                    <BookCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                    <div>
                      <div className="font-bold">EPUB eBook (.epub)</div>
                      <div className="text-[10px] text-slate-400 dark:text-slate-500">For Apple Books, Kindle, Moon+ Reader</div>
                    </div>
                  </button>
                  <button
                    onClick={() => onDownloadProgress("txt")}
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-medium text-slate-800 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700"
                  >
                    <FileText className="h-4 w-4 text-slate-500 dark:text-slate-400" />
                    <div>
                      <div className="font-bold">Plain TXT (.txt)</div>
                      <div className="text-[10px] text-slate-400 dark:text-slate-500">Standard text file</div>
                    </div>
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Export Book button - Always accessible */}
          <button
            id="open-export-modal-btn"
            onClick={onOpenExport}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-900 dark:bg-indigo-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-xs transition hover:bg-slate-800 dark:hover:bg-indigo-700 active:scale-95 cursor-pointer"
            title="Export novel in EPUB eBook, Bilingual EPUB, TXT, Markdown, or Original Chinese"
          >
            <BookOpen className="h-3.5 w-3.5" />
            <span>Export Book...</span>
          </button>
        </div>
      </div>

      {/* Optional custom instructions expander */}
      <div className="border-t border-slate-100 dark:border-slate-800 pt-2">
        <input
          type="text"
          placeholder="Custom Translation Prompt / Tone Rule (optional, e.g. 'Translate Shifu as Master, keep Pinyin for sword names')"
          value={customInstructions}
          onChange={(e) => onChangeCustomInstructions(e.target.value)}
          className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-800/60 px-3 py-1.5 text-xs text-slate-700 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-500 focus:border-indigo-500 focus:bg-white dark:focus:bg-slate-800 focus:outline-none"
        />
      </div>
    </div>
  );
};
