import React, { Component, ErrorInfo, ReactNode } from "react";
import { AlertTriangle, RefreshCw, Trash2 } from "lucide-react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
    };
  }

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Uncaught render error:", error, errorInfo);
  }

  public handleReset = () => {
    this.setState({ hasError: false, error: null });
    window.location.reload();
  };

  public handleClearStateAndReload = () => {
    try {
      localStorage.removeItem("megatext_reader_session_v1");
      localStorage.removeItem("megatext_translator_session_v1");
    } catch {}
    this.setState({ hasError: false, error: null });
    window.location.reload();
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center p-6 bg-[#FAF8FE] dark:bg-slate-950 text-slate-800 dark:text-slate-100">
          <div className="max-w-md w-full bg-white dark:bg-slate-900 rounded-3xl p-6 border border-purple-100 dark:border-purple-900 shadow-xl text-center space-y-4">
            <div className="h-12 w-12 rounded-2xl bg-amber-100 dark:bg-amber-950/80 text-amber-600 dark:text-amber-400 mx-auto flex items-center justify-center">
              <AlertTriangle className="h-6 w-6" />
            </div>
            <h2 className="text-base font-black">Something went wrong</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              An unexpected display issue occurred. You can return to your workspace without losing translation progress.
            </p>
            {this.state.error?.message && (
              <p className="text-[11px] font-mono bg-rose-50 dark:bg-rose-950/50 text-rose-600 dark:text-rose-400 p-2 rounded-xl text-left truncate">
                {this.state.error.message}
              </p>
            )}
            <div className="flex flex-col sm:flex-row items-center justify-center gap-2 pt-2">
              <button
                type="button"
                onClick={this.handleReset}
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-xl bg-purple-600 px-4 py-2.5 text-xs font-bold text-white hover:bg-purple-700 transition cursor-pointer"
              >
                <RefreshCw className="h-4 w-4" />
                <span>Reload Workspace</span>
              </button>
              <button
                type="button"
                onClick={this.handleClearStateAndReload}
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 dark:border-slate-700 px-4 py-2.5 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition cursor-pointer"
              >
                <Trash2 className="h-4 w-4" />
                <span>Reset Cache & Reload</span>
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
