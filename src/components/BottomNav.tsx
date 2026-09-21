import React from "react";
import { Home, Library, Store, Compass, Clock } from "lucide-react";

interface BottomNavProps {
  activeTab: "home" | "library" | "store" | "explore" | "history";
  onChangeTab: (tab: "home" | "library" | "store" | "explore" | "history") => void;
}

export const BottomNav: React.FC<BottomNavProps> = ({
  activeTab,
  onChangeTab,
}) => {
  return (
    <nav
      id="mobile-bottom-navigation"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-purple-100/80 dark:border-purple-900/40 bg-white/95 dark:bg-slate-900/95 backdrop-blur-md pb-safe transition-colors"
      aria-label="Mobile Navigation"
    >
      <div className="mx-auto flex h-14 max-w-lg items-center justify-around px-1.5 sm:px-2">
        {/* Home Tab */}
        <button
          id="nav-tab-home"
          type="button"
          onClick={() => onChangeTab("home")}
          className={`flex flex-col items-center justify-center gap-1 py-1 px-2 rounded-xl transition cursor-pointer ${
            activeTab === "home"
              ? "text-purple-600 dark:text-purple-400 font-bold"
              : "text-slate-400 dark:text-slate-500 hover:text-purple-500"
          }`}
        >
          <Home className="h-5 w-5 stroke-[2.2]" />
          <span className="text-[10.5px] leading-none">Home</span>
        </button>

        {/* Store Tab */}
        <button
          id="nav-tab-store"
          type="button"
          onClick={() => onChangeTab("store")}
          className={`flex flex-col items-center justify-center gap-1 py-1 px-2 rounded-xl transition cursor-pointer ${
            activeTab === "store"
              ? "text-purple-600 dark:text-purple-400 font-bold"
              : "text-slate-400 dark:text-slate-500 hover:text-purple-500"
          }`}
        >
          <Store className="h-5 w-5 stroke-[2.2]" />
          <span className="text-[10.5px] leading-none">Store</span>
        </button>

        {/* Explore Tab */}
        <button
          id="nav-tab-explore"
          type="button"
          onClick={() => onChangeTab("explore")}
          className={`flex flex-col items-center justify-center gap-1 py-1 px-2 rounded-xl transition cursor-pointer ${
            activeTab === "explore"
              ? "text-purple-600 dark:text-purple-400 font-bold"
              : "text-slate-400 dark:text-slate-500 hover:text-purple-500"
          }`}
        >
          <Compass className="h-5 w-5 stroke-[2.2]" />
          <span className="text-[10.5px] leading-none">Explore</span>
        </button>

        {/* History Tab */}
        <button
          id="nav-tab-history"
          type="button"
          onClick={() => onChangeTab("history")}
          className={`flex flex-col items-center justify-center gap-1 py-1 px-2 rounded-xl transition cursor-pointer ${
            activeTab === "history"
              ? "text-purple-600 dark:text-purple-400 font-bold"
              : "text-slate-400 dark:text-slate-500 hover:text-purple-500"
          }`}
        >
          <Clock className="h-5 w-5 stroke-[2.2]" />
          <span className="text-[10.5px] leading-none">History</span>
        </button>

        {/* Library Tab */}
        <button
          id="nav-tab-library"
          type="button"
          onClick={() => onChangeTab("library")}
          className={`flex flex-col items-center justify-center gap-1 py-1 px-2 rounded-xl transition cursor-pointer ${
            activeTab === "library"
              ? "text-purple-600 dark:text-purple-400 font-bold"
              : "text-slate-400 dark:text-slate-500 hover:text-purple-500"
          }`}
        >
          <Library className="h-5 w-5 stroke-[2.2]" />
          <span className="text-[10.5px] leading-none">Library</span>
        </button>
      </div>

      {/* iOS / Android gesture home indicator line */}
      <div className="flex justify-center pb-1.5">
        <div className="h-1 w-28 rounded-full bg-slate-300/80 dark:bg-slate-700/80" />
      </div>
    </nav>
  );
};
