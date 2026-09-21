import React, { useState } from "react";
import { Lock, KeyRound, Eye, EyeOff, ShieldCheck, ArrowRight, Loader2, Sparkles } from "lucide-react";
import { PagodaHeaderIllustration } from "./illustrations/StorybookArtwork";

interface PasswordGateProps {
  onUnlockSuccess: (token: string) => void;
}

export const PasswordGate: React.FC<PasswordGateProps> = ({ onUnlockSuccess }) => {
  const [passcode, setPasscode] = useState("");
  const [showPasscode, setShowPasscode] = useState(false);
  const [error, setError] = useState("");
  const [isVerifying, setIsVerifying] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!passcode.trim()) {
      setError("Please enter your passcode.");
      return;
    }

    setIsVerifying(true);
    setError("");

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passcode: passcode.trim() }),
      });

      const data = await res.json();

      if (data.success && data.token) {
        localStorage.setItem("megatext_auth_token", data.token);
        onUnlockSuccess(data.token);
      } else {
        setError(data.error || "Incorrect passcode. Please try again.");
      }
    } catch (err) {
      console.error("Passcode verification error:", err);
      setError("Unable to verify passcode. Please check your network.");
    } finally {
      setIsVerifying(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 flex flex-col justify-center items-center p-4 relative overflow-hidden">
      {/* Background artwork and blur accents */}
      <div className="absolute inset-0 opacity-15 pointer-events-none">
        <PagodaHeaderIllustration className="w-full h-full object-cover scale-105 filter blur-xs" />
      </div>

      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 h-96 bg-purple-600/20 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-1/4 left-1/3 w-80 h-80 bg-amber-500/15 rounded-full blur-3xl pointer-events-none" />

      {/* Login Card */}
      <div className="relative z-10 w-full max-w-md bg-slate-900/90 dark:bg-slate-950/90 backdrop-blur-xl border border-slate-800 rounded-3xl p-8 shadow-2xl shadow-purple-950/50">
        <div className="flex flex-col items-center text-center mb-6">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-tr from-purple-600 to-amber-500 p-0.5 shadow-lg shadow-purple-500/30 mb-4 flex items-center justify-center">
            <div className="w-full h-full bg-slate-900 rounded-[14px] flex items-center justify-center">
              <Lock className="w-7 h-7 text-amber-400" />
            </div>
          </div>

          <h1 className="text-2xl font-black tracking-tight text-white flex items-center gap-2">
            <span>Workspace Protected</span>
          </h1>
          <p className="text-xs text-slate-400 mt-1.5 max-w-xs">
            Enter your master passcode to access the webnovel translation workbench.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1.5 flex items-center justify-between">
              <span className="flex items-center gap-1.5">
                <KeyRound className="w-3.5 h-3.5 text-purple-400" />
                <span>Master Passcode</span>
              </span>
            </label>

            <div className="relative">
              <input
                type={showPasscode ? "text" : "password"}
                value={passcode}
                onChange={(e) => {
                  setPasscode(e.target.value);
                  if (error) setError("");
                }}
                placeholder="Enter passcode..."
                autoFocus
                className="w-full px-4 py-3 bg-slate-800/80 border border-slate-700/80 rounded-xl text-white placeholder-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent transition"
              />
              <button
                type="button"
                onClick={() => setShowPasscode(!showPasscode)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white p-1 rounded-md transition cursor-pointer"
                title={showPasscode ? "Hide Passcode" : "Show Passcode"}
              >
                {showPasscode ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {error && (
            <div className="p-3 bg-rose-500/10 border border-rose-500/30 rounded-xl text-xs text-rose-300 font-medium animate-fadeIn flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-rose-400 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={isVerifying || !passcode.trim()}
            className="w-full py-3 px-4 bg-gradient-to-r from-purple-600 via-indigo-600 to-amber-500 hover:from-purple-500 hover:to-amber-400 text-white font-bold rounded-xl text-sm shadow-lg shadow-purple-900/40 transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          >
            {isVerifying ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin text-white" />
                <span>Verifying Passcode...</span>
              </>
            ) : (
              <>
                <span>Unlock Workspace</span>
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>
        </form>

        <div className="mt-6 pt-5 border-t border-slate-800 text-center">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-950/60 border border-emerald-800/40 text-[11px] text-emerald-300 font-medium">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
            <span>Translations execute without passcode constraints</span>
          </div>
        </div>
      </div>
    </div>
  );
};
