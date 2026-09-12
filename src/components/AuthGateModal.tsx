import React, { useState, useEffect } from "react";
import {
  ShieldCheck,
  Lock,
  Mail,
  KeyRound,
  CheckCircle2,
  AlertCircle,
  Sparkles,
  ArrowRight,
  LogOut,
  Info,
  ExternalLink,
} from "lucide-react";
import { AuthStatus } from "../types";

interface AuthGateModalProps {
  authStatus: AuthStatus | null;
  onLoginSuccess: (token: string, userEmail: string) => void;
}

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: any) => void;
          renderButton: (parent: HTMLElement, options: any) => void;
          prompt: () => void;
        };
      };
    };
  }
}

export const AuthGateModal: React.FC<AuthGateModalProps> = ({
  authStatus,
  onLoginSuccess,
}) => {
  const [passcode, setPasscode] = useState("");
  const [emailInput, setEmailInput] = useState("");
  const [googleEmailVerified, setGoogleEmailVerified] = useState(
    authStatus?.googleVerified || false
  );
  const [verifiedEmail, setVerifiedEmail] = useState(
    authStatus?.userEmail || ""
  );
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showPasscodeOnly, setShowPasscodeOnly] = useState(false);

  const authorizedEmail = authStatus?.authorizedEmail || "cheesy3097@gmail.com";
  const requiresGoogle = authStatus?.requiresGoogle ?? true;
  const requiresPasscode = authStatus?.requiresPasscode ?? true;

  // Render Google Sign-in button if GSI SDK is ready
  useEffect(() => {
    const checkGsi = setInterval(() => {
      if (window.google?.accounts?.id) {
        clearInterval(checkGsi);
        try {
          // Initialize Google One-tap / Button
          window.google.accounts.id.initialize({
            client_id:
              "1096739983794-7qo45razs3xfja2h4gqnaw.apps.googleusercontent.com", // standard fallback client id
            callback: handleGoogleCredentialResponse,
            auto_select: false,
            cancel_on_tap_outside: true,
          });

          const btnContainer = document.getElementById("google-signin-btn-container");
          if (btnContainer) {
            btnContainer.innerHTML = "";
            window.google.accounts.id.renderButton(btnContainer, {
              theme: "filled_blue",
              size: "large",
              shape: "pill",
              text: "signin_with",
              width: 320,
            });
          }
        } catch (e) {
          console.warn("GSI init warning:", e);
        }
      }
    }, 400);

    return () => clearInterval(checkGsi);
  }, []);

  const handleGoogleCredentialResponse = async (response: any) => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          googleCredential: response.credential,
          passcode: passcode,
          token: localStorage.getItem("megatext_auth_token") || "",
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setErrorMessage(data.error || "Google authentication failed.");
        setIsLoading(false);
        return;
      }

      if (data.googleVerified) {
        setGoogleEmailVerified(true);
        setVerifiedEmail(data.userEmail || authorizedEmail);
      }

      if (data.authenticated && data.token) {
        localStorage.setItem("megatext_auth_token", data.token);
        onLoginSuccess(data.token, data.userEmail);
      } else {
        // Saved partial token for passcode step
        if (data.token) {
          localStorage.setItem("megatext_auth_token", data.token);
        }
      }
    } catch (err: any) {
      setErrorMessage(err.message || "Failed to contact auth service.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleDirectEmailVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!emailInput.trim()) return;

    setIsLoading(true);
    setErrorMessage(null);

    const inputEmail = emailInput.trim().toLowerCase();
    if (inputEmail !== authorizedEmail.toLowerCase()) {
      setErrorMessage(
        `Access Denied: "${inputEmail}" is not the authorized owner account. Only ${authorizedEmail} is permitted.`
      );
      setIsLoading(false);
      return;
    }

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: inputEmail,
          passcode: passcode,
          token: localStorage.getItem("megatext_auth_token") || "",
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setErrorMessage(data.error || "Email verification failed.");
        setIsLoading(false);
        return;
      }

      setGoogleEmailVerified(true);
      setVerifiedEmail(inputEmail);

      if (data.authenticated && data.token) {
        localStorage.setItem("megatext_auth_token", data.token);
        onLoginSuccess(data.token, inputEmail);
      } else if (data.token) {
        localStorage.setItem("megatext_auth_token", data.token);
      }
    } catch (err: any) {
      setErrorMessage(err.message || "Network error while verifying account.");
    } finally {
      setIsLoading(false);
    }
  };

  const handlePasscodeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!passcode.trim()) {
      setErrorMessage("Please enter the master passcode.");
      return;
    }

    setIsLoading(true);
    setErrorMessage(null);

    try {
      const existingToken = localStorage.getItem("megatext_auth_token") || "";
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: verifiedEmail || authorizedEmail,
          passcode: passcode.trim(),
          token: existingToken,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setErrorMessage(data.error || "Invalid passcode.");
        setIsLoading(false);
        return;
      }

      if (data.authenticated && data.token) {
        localStorage.setItem("megatext_auth_token", data.token);
        onLoginSuccess(data.token, data.userEmail || authorizedEmail);
      } else {
        if (!data.googleVerified && requiresGoogle) {
          setErrorMessage(
            `Passcode verified! Please complete Step 1 (Sign in with ${authorizedEmail}) to unlock the app.`
          );
        }
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
      <div className="relative w-full max-w-lg rounded-2xl border border-slate-700/80 bg-slate-900/95 p-6 sm:p-8 text-slate-100 shadow-2xl shadow-indigo-950/50">
        {/* Header Badge & Title */}
        <div className="flex flex-col items-center text-center">
          <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-tr from-indigo-600 to-sky-500 shadow-lg shadow-indigo-500/30 text-white">
            <Lock className="h-7 w-7" />
          </div>
          <div className="inline-flex items-center gap-1.5 rounded-full border border-indigo-500/30 bg-indigo-500/10 px-3 py-0.5 text-xs font-semibold text-indigo-300 mb-2">
            <ShieldCheck className="h-3.5 w-3.5 text-indigo-400" />
            <span>Dual-Factor Owner Security</span>
          </div>
          <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-white">
            Private Novel Translation Engine
          </h2>
          <p className="mt-1 text-xs sm:text-sm text-slate-400 max-w-sm">
            This deployment is private and strictly restricted to the authorized owner.
          </p>
        </div>

        {/* Status Error Alert */}
        {errorMessage && (
          <div className="mt-5 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3.5 text-xs text-rose-300 flex items-start gap-2.5 animate-fadeIn">
            <AlertCircle className="h-4 w-4 text-rose-400 shrink-0 mt-0.5" />
            <div className="flex-1 font-medium">{errorMessage}</div>
          </div>
        )}

        <div className="mt-6 space-y-5">
          {/* STEP 1: Google Identity Verification */}
          <div
            className={`rounded-xl border p-4 transition-all ${
              googleEmailVerified
                ? "border-emerald-500/40 bg-emerald-500/10"
                : "border-slate-700 bg-slate-800/60"
            }`}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div
                  className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${
                    googleEmailVerified
                      ? "bg-emerald-500 text-white"
                      : "bg-indigo-600 text-white"
                  }`}
                >
                  {googleEmailVerified ? <CheckCircle2 className="h-4 w-4" /> : "1"}
                </div>
                <span className="text-sm font-semibold text-slate-200">
                  Step 1: Authorized Google Account
                </span>
              </div>
              {googleEmailVerified && (
                <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[11px] font-bold text-emerald-300 flex items-center gap-1">
                  <CheckCircle2 className="h-3 w-3" />
                  Verified
                </span>
              )}
            </div>

            <div className="mt-2.5 text-xs text-slate-400">
              Only <span className="font-semibold text-sky-300 underline underline-offset-2">{authorizedEmail}</span> is granted access.
            </div>

            {googleEmailVerified ? (
              <div className="mt-3 flex items-center justify-between rounded-lg bg-emerald-950/40 border border-emerald-500/20 px-3 py-2 text-xs text-emerald-200">
                <span className="flex items-center gap-1.5 font-medium">
                  <Mail className="h-3.5 w-3.5 text-emerald-400" />
                  {verifiedEmail || authorizedEmail}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setGoogleEmailVerified(false);
                    setVerifiedEmail("");
                  }}
                  className="text-[11px] text-slate-400 hover:text-slate-200 underline cursor-pointer"
                >
                  Change
                </button>
              </div>
            ) : (
              <div className="mt-3.5 space-y-3">
                {/* Google Sign-in Button Container */}
                <div
                  id="google-signin-btn-container"
                  className="flex justify-center my-1"
                />

                {/* Email Confirmation Form */}
                <form onSubmit={handleDirectEmailVerify} className="space-y-2">
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <Mail className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                      <input
                        id="auth-email-input"
                        type="email"
                        value={emailInput}
                        onChange={(e) => setEmailInput(e.target.value)}
                        placeholder={`e.g. ${authorizedEmail}`}
                        className="w-full rounded-lg border border-slate-700 bg-slate-900/90 pl-9 pr-3 py-2 text-xs text-slate-100 placeholder-slate-500 focus:border-indigo-500 focus:outline-hidden focus:ring-1 focus:ring-indigo-500"
                        required
                      />
                    </div>
                    <button
                      id="verify-email-btn"
                      type="submit"
                      disabled={isLoading || !emailInput.trim()}
                      className="rounded-lg bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50 cursor-pointer shrink-0"
                    >
                      Verify Email
                    </button>
                  </div>
                </form>
              </div>
            )}
          </div>

          {/* STEP 2: Master Passcode */}
          <div
            className={`rounded-xl border p-4 transition-all ${
              authStatus?.passcodeVerified
                ? "border-emerald-500/40 bg-emerald-500/10"
                : "border-slate-700 bg-slate-800/60"
            }`}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div
                  className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${
                    authStatus?.passcodeVerified
                      ? "bg-emerald-500 text-white"
                      : "bg-indigo-600 text-white"
                  }`}
                >
                  {authStatus?.passcodeVerified ? (
                    <CheckCircle2 className="h-4 w-4" />
                  ) : (
                    "2"
                  )}
                </div>
                <span className="text-sm font-semibold text-slate-200">
                  Step 2: Master Passcode / Key
                </span>
              </div>
              {authStatus?.hasPasscodeConfigured === false && (
                <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-medium text-amber-300">
                  Optional (Not Set in .env)
                </span>
              )}
            </div>

            <form onSubmit={handlePasscodeSubmit} className="mt-3.5 space-y-3">
              <div className="relative">
                <KeyRound className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                <input
                  id="auth-passcode-input"
                  type="password"
                  value={passcode}
                  onChange={(e) => setPasscode(e.target.value)}
                  placeholder={
                    authStatus?.hasPasscodeConfigured === false
                      ? "Optional passcode (press Unlock)"
                      : "Enter master access passcode..."
                  }
                  className="w-full rounded-lg border border-slate-700 bg-slate-900/90 pl-9 pr-3 py-2 text-xs text-slate-100 placeholder-slate-500 focus:border-indigo-500 focus:outline-hidden focus:ring-1 focus:ring-indigo-500"
                />
              </div>

              <button
                id="unlock-app-btn"
                type="submit"
                disabled={isLoading}
                className="w-full flex items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-indigo-600 to-indigo-700 px-4 py-2.5 text-xs sm:text-sm font-bold text-white shadow-md shadow-indigo-900/40 transition hover:from-indigo-500 hover:to-indigo-600 disabled:opacity-50 cursor-pointer active:scale-[0.99]"
              >
                {isLoading ? (
                  <span className="inline-block animate-spin">⏳</span>
                ) : (
                  <Lock className="h-4 w-4" />
                )}
                <span>Unlock MegaText Translator</span>
                <ArrowRight className="h-4 w-4" />
              </button>
            </form>
          </div>
        </div>

        {/* Security Footer Notice */}
        <div className="mt-6 border-t border-slate-800 pt-4 text-center">
          <p className="text-[11px] text-slate-500 flex items-center justify-center gap-1.5">
            <Info className="h-3.5 w-3.5 text-slate-400" />
            Zero public access: translation engine and server jobs are shielded by backend token validation.
          </p>
        </div>
      </div>
    </div>
  );
};
