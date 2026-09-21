import React, { useState } from "react";
import {
  BookOpen,
  Sun,
  Moon,
  Menu,
  X,
  Layers,
  Settings,
  RefreshCw,
} from "lucide-react";

interface NavbarProps {
  hasFile: boolean;
  totalChars: number;
  completedChars: number;
  isCompleted?: boolean;
  isRunning?: boolean;
  completedChunks?: number;
  totalChunks?: number;
  onReset: () => void;
  onOpenGlossary: () => void;
  onOpenTelegramSettings: () => void;
  onOpenSettings?: () => void;
  glossaryCount: number;
  theme: "light" | "dark";
  onToggleTheme: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  hasFile,
  totalChars,
  completedChars,
  isCompleted = false,
  isRunning = false,
  completedChunks = 0,
  totalChunks = 0,
  onReset,
  onOpenGlossary,
  onOpenTelegramSettings,
  onOpenSettings,
  glossaryCount,
  theme,
  onToggleTheme,
}) => {
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  return (
    <header className="sticky top-0 z-40 border-b border-purple-100/40 dark:border-purple-900/30 bg-white/20 dark:bg-slate-900/30 backdrop-blur-xs transition-colors duration-200">
      <div className="mx-auto flex h-14 max-w-md items-center justify-between px-4 sm:px-6">
        {/* Brand */}
        <div className="flex items-center gap-2.5 shrink-0">
          <div className="flex h-9 w-9 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-400 text-white shadow-xs shadow-purple-500/25">
            <BookOpen className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-base font-extrabold text-slate-800 dark:text-slate-100 tracking-tight leading-tight">
              MegaText
            </h1>
            <p className="text-[11px] font-medium text-purple-600 dark:text-purple-300 leading-none">
              Chinese → English
            </p>
          </div>
        </div>

        {/* Right Action Icons (Sun/Moon + Menu hamburger) */}
        <div className="flex items-center gap-2 shrink-0">
          {/* Theme Toggle */}
          <button
            id="toggle-theme-btn"
            type="button"
            onClick={onToggleTheme}
            className="flex h-9 w-9 items-center justify-center rounded-2xl border border-purple-100/80 dark:border-purple-800/60 bg-white/90 dark:bg-slate-800 text-slate-700 dark:text-amber-400 shadow-2xs transition hover:bg-purple-50 dark:hover:bg-slate-700 active:scale-95 cursor-pointer"
            title={theme === "dark" ? "Switch to Light Mode" : "Switch to Dark Mode"}
            aria-label="Toggle theme"
          >
            {theme === "dark" ? (
              <Sun className="h-4.5 w-4.5" />
            ) : (
              <Sun className="h-4.5 w-4.5 text-purple-600" />
            )}
          </button>

          {/* Menu Drawer Button */}
          <button
            id="nav-menu-btn"
            type="button"
            onClick={() => setIsMenuOpen(!isMenuOpen)}
            className="flex h-9 w-9 items-center justify-center rounded-2xl border border-purple-100/80 dark:border-purple-800/60 bg-white/90 dark:bg-slate-800 text-slate-700 dark:text-slate-200 shadow-2xs transition hover:bg-purple-50 dark:hover:bg-slate-700 active:scale-95 cursor-pointer"
            title="Menu & Settings"
            aria-label="Open menu"
          >
            {isMenuOpen ? <X className="h-4.5 w-4.5" /> : <Menu className="h-4.5 w-4.5 text-purple-700 dark:text-purple-300" />}
          </button>
        </div>
      </div>

      {/* Slide-out Menu Popover for Extra Settings */}
      {isMenuOpen && (
        <div className="absolute top-full left-0 right-0 z-50 border-b border-purple-100 dark:border-purple-900/60 bg-white/98 dark:bg-slate-900/98 backdrop-blur-md p-3 shadow-xl transition animate-in fade-in slide-in-from-top-2">
          <div className="mx-auto max-w-md space-y-1.5">
            {/* Application & Translation Settings (Moved from bottom bar as requested) */}
            <button
              id="menu-settings-btn"
              type="button"
              onClick={() => {
                setIsMenuOpen(false);
                if (onOpenSettings) onOpenSettings();
                else onOpenTelegramSettings();
              }}
              className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-xs font-bold text-slate-700 dark:text-slate-200 hover:bg-purple-50 dark:hover:bg-purple-950/40 transition cursor-pointer"
            >
              <Settings className="h-4 w-4 text-purple-600" />
              <span>Settings & Configuration</span>
            </button>

            {/* Glossary */}
            <button
              id="menu-glossary-btn"
              type="button"
              onClick={() => {
                setIsMenuOpen(false);
                onOpenGlossary();
              }}
              className="flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-purple-50 dark:hover:bg-purple-950/40 transition cursor-pointer"
            >
              <div className="flex items-center gap-2.5">
                <Layers className="h-4 w-4 text-purple-600" />
                <span>Glossary & Terminology</span>
              </div>
              {glossaryCount > 0 && (
                <span className="rounded-full bg-purple-100 dark:bg-purple-900/60 px-2 py-0.5 text-[10px] font-bold text-purple-700 dark:text-purple-300">
                  {glossaryCount} terms
                </span>
              )}
            </button>

            {/* Telegram Settings */}
            <button
              id="menu-telegram-btn"
              type="button"
              onClick={() => {
                setIsMenuOpen(false);
                onOpenTelegramSettings();
              }}
              className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-purple-50 dark:hover:bg-purple-950/40 transition cursor-pointer"
            >
              <Settings className="h-4 w-4 text-indigo-500" />
              <span>Telegram Progress Alerts</span>
            </button>

            {/* Reset / New Novel */}
            {hasFile && (
              <button
                id="menu-reset-btn"
                type="button"
                onClick={() => {
                  setIsMenuOpen(false);
                  onReset();
                }}
                className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-xs font-semibold text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition cursor-pointer"
              >
                <RefreshCw className="h-4 w-4" />
                <span>Start New Novel</span>
              </button>
            )}
          </div>
        </div>
      )}
    </header>
  );
};


