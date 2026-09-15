import React, { useState } from "react";
import {
  Lock,
  KeyRound,
  AlertCircle,
  ArrowRight,
  Shield,
  Eye,
  EyeOff,
} from "lucide-react";
import { AuthStatus } from "../types";

interface AuthGateModalProps {
  authStatus: AuthStatus | null;
  onLoginSuccess: (token: string, userEmail?: string) => void;
}

export const AuthGateModal: React.FC<AuthGateModalProps> = ({
  authStatus,
  onLoginSuccess,
}) => {
  const [passcode, setPasscode] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handlePasscodeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!passcode.trim() && authStatus?.hasPasscodeConfigured !== false) {
      setErrorMessage("Please enter the master passcode.");
      return;
    }

    setIsLoading(true);
    setErrorMessage(null);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          passcode: passcode.trim(),
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setErrorMessage(data.error || "Invalid master passcode.");
        setIsLoading(false);
        return;
      }

      if (data.authenticated && data.token) {
        localStorage.setItem("megatext_auth_token", data.token);
        onLoginSuccess(data.token);
      }
    } catch (err: any) {
      setErrorMessage(err.message || "Failed to verify master passcode.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div
      id="security-gate-container"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-md p-4 transition-all duration-300"
    >
      <div className="relative w-full max-w-md rounded-3xl border border-purple-900/60 bg-slate-900/98 p-6 sm:p-8 text-slate-100 shadow-2xl shadow-purple-950/60">
        {/* Header Icon & Title */}
        <div className="flex flex-col items-center text-center">
          <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-tr from-purple-500 to-indigo-500 shadow-lg shadow-purple-500/30 text-white">
            <Lock className="h-7 w-7" />
          </div>
          <div className="inline-flex items-center gap-1.5 rounded-full border border-purple-500/30 bg-purple-500/10 px-3 py-0.5 text-xs font-semibold text-purple-300 mb-2">
            <Shield className="h-3.5 w-3.5 text-purple-400" />
            <span>Master Key Access</span>
          </div>
          <h2 className="text-xl sm:text-2xl font-extrabold tracking-tight text-white">
            MegaText Novel Engine
          </h2>
          <p className="mt-1 text-xs sm:text-sm text-slate-400">
            Enter your master passcode to unlock the translation workspace.
          </p>
        </div>

        {/* Status Error Alert */}
        {errorMessage && (
          <div className="mt-5 rounded-2xl border border-rose-500/30 bg-rose-500/10 p-3.5 text-xs text-rose-300 flex items-start gap-2.5 animate-fadeIn">
            <AlertCircle className="h-4 w-4 text-rose-400 shrink-0 mt-0.5" />
            <div className="flex-1 font-medium">{errorMessage}</div>
          </div>
        )}

        <form onSubmit={handlePasscodeSubmit} className="mt-6 space-y-4">
          <div>
            <label
              htmlFor="auth-passcode-input"
              className="block text-xs font-semibold text-slate-300 mb-1.5"
            >
              Master Passcode
            </label>
            <div className="relative">
              <KeyRound className="absolute left-3.5 top-3 h-4 w-4 text-slate-400" />
              <input
                id="auth-passcode-input"
                type={showPassword ? "text" : "password"}
                value={passcode}
                onChange={(e) => setPasscode(e.target.value)}
                placeholder="Enter master passcode..."
                autoFocus
                className="w-full rounded-2xl border border-slate-700 bg-slate-800/90 pl-10 pr-10 py-2.5 text-sm text-slate-100 placeholder-slate-500 focus:border-purple-400 focus:outline-hidden focus:ring-2 focus:ring-purple-500/40"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-2.5 text-slate-400 hover:text-slate-200 p-0.5 cursor-pointer"
                title={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            </div>
          </div>

          <button
            id="unlock-app-btn"
            type="submit"
            disabled={isLoading}
            className="w-full flex items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-purple-500 to-indigo-600 px-4 py-3 text-sm font-bold text-white shadow-lg shadow-purple-900/40 transition hover:from-purple-600 hover:to-indigo-700 disabled:opacity-50 cursor-pointer active:scale-[0.99]"
          >
            {isLoading ? (
              <span className="inline-block animate-spin text-sm">⏳</span>
            ) : (
              <Lock className="h-4 w-4" />
            )}
            <span>Unlock Workspace</span>
            <ArrowRight className="h-4 w-4" />
          </button>
        </form>

        {/* Footer info */}
        <div className="mt-6 border-t border-slate-800/80 pt-4 text-center">
          <p className="text-[11px] text-slate-500">
            Protected private instance · Multi-device cloud sync enabled
          </p>
        </div>
      </div>
    </div>
  );
};
