import React from "react";
import { AlertTriangle, Trash2, X } from "lucide-react";

export interface ConfirmModalProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  isDestructive?: boolean;
  isLoading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export const ConfirmModal: React.FC<ConfirmModalProps> = ({
  isOpen,
  title,
  message,
  confirmText = "Delete",
  cancelText = "Cancel",
  isDestructive = true,
  isLoading = false,
  onConfirm,
  onCancel,
}) => {
  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs transition animate-in fade-in"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-md rounded-3xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 shadow-2xl transition animate-in zoom-in-95 space-y-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-4">
          <div
            className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl ${
              isDestructive
                ? "bg-rose-100 dark:bg-rose-950/80 text-rose-600 dark:text-rose-400 border border-rose-200 dark:border-rose-900/50"
                : "bg-purple-100 dark:bg-purple-950/80 text-purple-600 dark:text-purple-400 border border-purple-200 dark:border-purple-900/50"
            }`}
          >
            {isDestructive ? (
              <Trash2 className="h-6 w-6" />
            ) : (
              <AlertTriangle className="h-6 w-6" />
            )}
          </div>
          <div className="flex-1 min-w-0 pt-0.5 space-y-1.5">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-extrabold text-slate-900 dark:text-slate-100">
                {title}
              </h3>
              <button
                type="button"
                onClick={onCancel}
                disabled={isLoading}
                className="rounded-xl p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="text-xs text-slate-600 dark:text-slate-400 whitespace-pre-line leading-relaxed">
              {message}
            </p>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-slate-100 dark:border-slate-800/80">
          <button
            type="button"
            onClick={onCancel}
            disabled={isLoading}
            className="px-4 py-2.5 rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/80 text-xs font-bold text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition active:scale-95 cursor-pointer disabled:opacity-50"
          >
            {cancelText}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isLoading}
            className={`px-4 py-2.5 rounded-2xl text-xs font-bold text-white transition active:scale-95 cursor-pointer shadow-xs disabled:opacity-50 ${
              isDestructive
                ? "bg-rose-600 hover:bg-rose-700 dark:bg-rose-600 dark:hover:bg-rose-700"
                : "bg-purple-600 hover:bg-purple-700"
            }`}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
};
