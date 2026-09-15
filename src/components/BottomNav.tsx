import React from "react";
import { Home, Clock, Settings } from "lucide-react";

interface BottomNavProps {
  activeTab: "home" | "history" | "settings";
  onChangeTab: (tab: "home" | "history" | "settings") => void;
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
      <div className="mx-auto flex h-14 max-w-md items-center justify-around px-4">
        {/* Home Tab */}
        <button
          id="nav-tab-home"
          type="button"
          onClick={() => onChangeTab("home")}
          className={`flex flex-col items-center justify-center gap-1 py-1 px-4 rounded-xl transition cursor-pointer ${
            activeTab === "home"
              ? "text-purple-600 dark:text-purple-400 font-bold"
              : "text-slate-400 dark:text-slate-500 hover:text-purple-500"
          }`}
        >
          <Home className="h-5 w-5 stroke-[2.2]" />
          <span className="text-[11px] leading-none">Home</span>
        </button>

        {/* History Tab */}
        <button
          id="nav-tab-history"
          type="button"
          onClick={() => onChangeTab("history")}
          className={`flex flex-col items-center justify-center gap-1 py-1 px-4 rounded-xl transition cursor-pointer ${
            activeTab === "history"
              ? "text-purple-600 dark:text-purple-400 font-bold"
              : "text-slate-400 dark:text-slate-500 hover:text-purple-500"
          }`}
        >
          <Clock className="h-5 w-5 stroke-[2.2]" />
          <span className="text-[11px] leading-none">History</span>
        </button>

        {/* Settings Tab */}
        <button
          id="nav-tab-settings"
          type="button"
          onClick={() => onChangeTab("settings")}
          className={`flex flex-col items-center justify-center gap-1 py-1 px-4 rounded-xl transition cursor-pointer ${
            activeTab === "settings"
              ? "text-purple-600 dark:text-purple-400 font-bold"
              : "text-slate-400 dark:text-slate-500 hover:text-purple-500"
          }`}
        >
          <Settings className="h-5 w-5 stroke-[2.2]" />
          <span className="text-[11px] leading-none">Settings</span>
        </button>
      </div>

      {/* iOS / Android gesture home indicator line */}
      <div className="flex justify-center pb-1.5">
        <div className="h-1 w-28 rounded-full bg-slate-300/80 dark:bg-slate-700/80" />
      </div>
    </nav>
  );
};
