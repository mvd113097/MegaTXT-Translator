import React from "react";
import {
  X,
  AlertTriangle,
  BookCheck,
  Loader2,
  CheckCircle2,
  ArrowRight,
  Clock,
  Layers,
  Sparkles,
} from "lucide-react";
import { ContinuityReport, countEnglishWords } from "../utils/chunker";

interface ContinuityModalProps {
  isOpen: boolean;
  onClose: () => void;
  continuity: ContinuityReport;
  fileName: string;
  format: "epub" | "txt";
  isRunning: boolean;
  onConfirmDownload: (mode: "continuous" | "with_placeholders" | "all_completed") => void;
}

export const ContinuityModal: React.FC<ContinuityModalProps> = ({
  isOpen,
  onClose,
  continuity,
  fileName,
  format,
  isRunning,
  onConfirmDownload,
}) => {
  if (!isOpen) return null;

  const {
    continuousChunks,
    missingChunks,
    highestCompletedIndex,
    continuousWordCount,
    totalCompletedWordCount,
    allCompletedChunks,
  } = continuity;

  const continuousCount = continuousChunks.length;
  const highestChapterNum = highestCompletedIndex + 1;
  const missingChapterLabels = missingChunks
    .map((c) => `#${c.index + 1}`)
    .join(", ");

  return (
    <div
      id="continuity-modal-backdrop"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs"
      onClick={onClose}
    >
      <div
        id="continuity-modal-card"
        className="relative w-full max-w-xl rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-2xl p-6 transition-all animate-in fade-in zoom-in-95 duration-150"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute right-4 top-4 rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-600 dark:hover:text-slate-200 transition cursor-pointer"
          title="Close dialog"
        >
          <X className="h-5 w-5" />
        </button>

        {/* Header with warning icon */}
        <div className="flex items-start gap-3.5 mb-5">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-amber-100 dark:bg-amber-950/70 text-amber-600 dark:text-amber-400">
            <AlertTriangle className="h-6 w-6" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-slate-900 dark:text-white">
              Chapter Gap Detected
            </h2>
            <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-400 mt-0.5">
              Chapter {missingChapterLabels} {missingChunks.length === 1 ? "is" : "are"} still translating, but Chapter #{highestChapterNum} finished ahead of {missingChunks.length === 1 ? "it" : "them"}.
            </p>
          </div>
        </div>

        {/* Status card */}
        <div className="rounded-xl border border-amber-200/80 dark:border-amber-900/50 bg-amber-50/60 dark:bg-amber-950/20 p-3.5 mb-5 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-slate-700 dark:text-slate-300">
              Continuous Unbroken Read:
            </span>
            <span className="font-bold text-emerald-600 dark:text-emerald-400">
              Chapters 1 to {continuousCount} ({continuousWordCount.toLocaleString()} words)
            </span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-slate-700 dark:text-slate-300">
              Chapters Still Loading/Incomplete:
            </span>
            <span className="font-bold text-amber-600 dark:text-amber-400 flex items-center gap-1">
              {isRunning && <Loader2 className="h-3 w-3 animate-spin inline" />}
              Chapter {missingChapterLabels}
            </span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-slate-700 dark:text-slate-300">
              Finished Ahead:
            </span>
            <span className="text-slate-600 dark:text-slate-400">
              Chapter #{highestChapterNum}
            </span>
          </div>
        </div>

        <p className="text-xs text-slate-600 dark:text-slate-400 mb-4">
          To make sure you get continuous reading (<strong>1, 2, 3, 4, 5</strong> instead of skipped chapters), choose how you want to export your {format.toUpperCase()}:
        </p>

        {/* Options Stack */}
        <div className="space-y-2.5">
          {/* Option 1: Continuous sequence (Recommended) */}
          <button
            id="download-continuous-opt"
            onClick={() => onConfirmDownload("continuous")}
            disabled={continuousCount === 0}
            className="w-full text-left rounded-xl border-2 border-emerald-500/80 dark:border-emerald-500/60 bg-emerald-50/50 dark:bg-emerald-950/30 p-3.5 hover:bg-emerald-100/60 dark:hover:bg-emerald-950/50 transition cursor-pointer group"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 font-bold text-xs sm:text-sm text-emerald-900 dark:text-emerald-200">
                <BookCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                <span>Download Continuous: Chapters 1 to {continuousCount}</span>
                <span className="rounded-full bg-emerald-600 text-white text-[10px] px-2 py-0.5 font-bold uppercase tracking-wider">
                  Recommended
                </span>
              </div>
              <ArrowRight className="h-4 w-4 text-emerald-600 group-hover:translate-x-0.5 transition-transform" />
            </div>
            <p className="text-[11px] sm:text-xs text-emerald-800/80 dark:text-emerald-300/80 mt-1 pl-6">
              Guarantees 100% unbroken story flow for Moon+ Reader. Zero skipped chapters. Contains {continuousWordCount.toLocaleString()} words.
            </p>
          </button>

          {/* Option 2: Placeholders to keep numbering */}
          <button
            id="download-placeholders-opt"
            onClick={() => onConfirmDownload("with_placeholders")}
            className="w-full text-left rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-800/60 p-3.5 hover:bg-slate-50 dark:hover:bg-slate-800 transition cursor-pointer group"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 font-bold text-xs sm:text-sm text-slate-900 dark:text-white">
                <Layers className="h-4 w-4 text-indigo-500 shrink-0" />
                <span>Download Chapters 1 to {highestChapterNum} with Placeholders</span>
              </div>
              <ArrowRight className="h-4 w-4 text-slate-400 group-hover:translate-x-0.5 transition-transform" />
            </div>
            <p className="text-[11px] sm:text-xs text-slate-500 dark:text-slate-400 mt-1 pl-6">
              Includes Chapters 1–{highestChapterNum}. The missing chapters ({missingChapterLabels}) will have placeholder notes indicating they are still translating.
            </p>
          </button>

          {/* Option 3: Wait / Cancel */}
          <button
            id="wait-for-chapters-btn"
            onClick={onClose}
            className="w-full text-left rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-800/40 p-3.5 hover:bg-slate-50 dark:hover:bg-slate-800 transition cursor-pointer group"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 font-semibold text-xs sm:text-sm text-slate-700 dark:text-slate-300">
                <Clock className="h-4 w-4 text-amber-500 shrink-0" />
                <span>Wait for Chapter {missingChapterLabels} to finish</span>
              </div>
              <span className="text-xs text-slate-400 font-medium">Keep translating</span>
            </div>
            <p className="text-[11px] sm:text-xs text-slate-500 dark:text-slate-400 mt-1 pl-6">
              Close this dialog and let the translator finish loading. Once they show Ready, you can download all chapters in order.
            </p>
          </button>

          {/* Option 4: Download Ready Only (skip missing) */}
          <div className="pt-1 text-right">
            <button
              id="download-ready-only-btn"
              onClick={() => onConfirmDownload("all_completed")}
              className="text-[11px] text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 underline cursor-pointer"
            >
              Or download ready chapters anyway (skip missing {missingChapterLabels})
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
