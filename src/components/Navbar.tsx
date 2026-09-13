import React from "react";
import {
  BookOpen,
  Sparkles,
  RefreshCw,
  Layers,
  Sun,
  Moon,
  ExternalLink,
  ShieldCheck,
  LogOut,
} from "lucide-react";

interface NavbarProps {
  hasFile: boolean;
  totalChars: number;
  completedChars: number;
  onReset: () => void;
  onOpenGlossary: () => void;
  glossaryCount: number;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  userEmail?: string | null;
  onLogout?: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  hasFile,
  totalChars,
  completedChars,
  onReset,
  onOpenGlossary,
  glossaryCount,
  theme,
  onToggleTheme,
  userEmail,
  onLogout,
}) => {
  return (
    <header className="sticky top-0 z-30 border-b border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-slate-900/95 backdrop-blur-sm transition-colors duration-200">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-2.5 sm:px-6 lg:px-8 gap-1 sm:gap-4">
        {/* Brand */}
        <div className="flex items-center gap-2 shrink-0">
          <div className="flex h-9 w-9 sm:h-10 sm:w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-600 to-indigo-800 text-white shadow-sm shadow-indigo-200 dark:shadow-none">
            <BookOpen className="h-4 w-4 sm:h-5 sm:w-5" />
          </div>
          <div>
            <div className="flex items-center gap-1">
              <h1 className="text-xs font-bold text-slate-900 dark:text-slate-100 sm:text-lg">
                MegaText
              </h1>
              <span className="hidden sm:inline-flex rounded-full bg-indigo-50 dark:bg-indigo-950/80 px-2 py-0.5 text-[10px] sm:text-xs font-semibold text-indigo-700 dark:text-indigo-300">
                ZH → EN
              </span>
            </div>
            <p className="hidden text-[10px] text-slate-500 dark:text-slate-400 md:block">
              High-throughput 1,000,000+ Chinese character text engine
            </p>
          </div>
        </div>

        {/* Action badges & Controls */}
        <div className="flex items-center gap-1 sm:gap-2 overflow-x-auto no-scrollbar py-1">
          {/* Owner Account Badge & Logout */}
          {userEmail && (
            <div
              className="flex items-center gap-1 rounded-lg border border-emerald-200 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/40 px-1.5 sm:px-2.5 py-1 text-[11px] sm:text-xs text-emerald-800 dark:text-emerald-300 shrink-0"
              title={`Authorized owner session active for ${userEmail}`}
            >
              <ShieldCheck className="h-3 w-3 sm:h-3.5 sm:w-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
              <span className="font-semibold max-w-[50px] sm:max-w-[140px] truncate">{userEmail}</span>
            </div>
          )}

          {/* AI Model Badge */}
          <div className="hidden items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/80 px-2.5 py-1 text-xs text-slate-700 dark:text-slate-300 md:flex">
            <Sparkles className="h-3.5 w-3.5 text-indigo-600 dark:text-indigo-400" />
            <span className="font-medium">Gemini 3.8 Flash</span>
          </div>

          {/* Dark Mode Toggle Button */}
          <button
            id="toggle-theme-btn"
            onClick={onToggleTheme}
            className="flex h-8 w-8 sm:h-8.5 sm:w-8.5 items-center justify-center rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-amber-400 shadow-xs transition hover:bg-slate-50 dark:hover:bg-slate-700 active:scale-95 cursor-pointer shrink-0"
            title={theme === "dark" ? "Switch to Light Mode" : "Switch to Dark Mode (Night Reading)"}
            aria-label="Toggle dark mode"
          >
            {theme === "dark" ? (
              <Sun className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
            ) : (
              <Moon className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-slate-600" />
            )}
          </button>

          {/* Glossary button */}
          <button
            id="open-glossary-btn"
            onClick={onOpenGlossary}
            className="flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-2 sm:px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 shadow-xs transition hover:border-indigo-300 dark:hover:border-indigo-500 hover:bg-slate-50 dark:hover:bg-slate-700 active:scale-95 shrink-0"
            title="Manage character names, terms, and glossary"
          >
            <Layers className="h-3.5 w-3.5 text-indigo-600 dark:text-indigo-400" />
            <span className="hidden sm:inline">Glossary</span>
            {glossaryCount > 0 && (
              <span className="ml-0.5 rounded-full bg-indigo-100 dark:bg-indigo-900/60 px-1.5 py-0.2 text-[10px] font-bold text-indigo-700 dark:text-indigo-300">
                {glossaryCount}
              </span>
            )}
          </button>
        </div>
      </div>
    </header>
  );
};

