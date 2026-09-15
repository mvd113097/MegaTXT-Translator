import React, { useState, useEffect } from "react";
import {
  X,
  Send,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Bell,
  Eye,
  EyeOff,
  Clock,
  Settings2
} from "lucide-react";

interface TelegramSettings {
  botToken: string;
  chatIds: string;
  enabled: boolean;
  statusIntervalMin: number;
  statusEnabled: boolean;
}

interface TelegramSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const TelegramSettingsModal: React.FC<TelegramSettingsModalProps> = ({
  isOpen,
  onClose,
}) => {
  const [settings, setSettings] = useState<TelegramSettings>({
    botToken: "",
    chatIds: "",
    enabled: false,
    statusIntervalMin: 5,
    statusEnabled: true,
  });

  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [testStatus, setTestStatus] = useState<"idle" | "sending" | "success" | "error">("idle");
  const [testError, setTestError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<"idle" | "success" | "error">("idle");

  // Fetch current settings on open
  useEffect(() => {
    if (isOpen) {
      setIsLoading(true);
      fetch("/api/telegram-settings")
        .then((res) => res.json())
        .then((data) => {
          setSettings(data);
          setIsLoading(false);
        })
        .catch((err) => {
          console.error("Failed to load Telegram settings:", err);
          setIsLoading(false);
        });
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSave = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setIsSaving(true);
    setSaveStatus("idle");

    try {
      const res = await fetch("/api/telegram-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      const data = await res.json();
      if (data.success) {
        setSaveStatus("success");
        setSettings(data.settings);
        setTimeout(() => setSaveStatus("idle"), 3000);
      } else {
        setSaveStatus("error");
      }
    } catch (err) {
      console.error("Failed to save Telegram settings:", err);
      setSaveStatus("error");
    } finally {
      setIsSaving(false);
    }
  };

  const handleTestConnection = async () => {
    setTestStatus("sending");
    setTestError(null);

    // Build the request URL directly to Telegram APIs to test right away
    const token = settings.botToken.trim();
    const chatIdsStr = settings.chatIds.trim();

    if (!token || !chatIdsStr) {
      setTestStatus("error");
      setTestError("Please enter both Bot Token and Chat ID(s) before testing.");
      return;
    }

    const chatIds = chatIdsStr
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0);

    if (chatIds.length === 0) {
      setTestStatus("error");
      setTestError("Please enter at least one valid numeric Chat ID.");
      return;
    }

    try {
      // Send a test message
      const testMsg = encodeURIComponent(
        `🔔 <b>[MegaText Telegram Connection Test]</b>\n\n` +
        `Your bot is correctly connected to MegaText! 🎉\n` +
        `Periodic updates are currently configured for: <b>every ${settings.statusIntervalMin} minutes</b>.`
      );

      const promises = chatIds.map(async (chatId) => {
        const url = `https://api.telegram.org/bot${token}/sendMessage?chat_id=${chatId}&text=${testMsg}&parse_mode=HTML`;
        const res = await fetch(url);
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.description || `HTTP Error ${res.status}`);
        }
      });

      await Promise.all(promises);
      setTestStatus("success");
      setTimeout(() => setTestStatus("idle"), 5000);
    } catch (err: any) {
      console.error("Telegram test failed:", err);
      setTestStatus("error");
      setTestError(err.message || String(err));
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-purple-950/30 dark:bg-black/70 p-4 backdrop-blur-xs">
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-3xl border border-purple-100 dark:border-purple-900/60 bg-white/98 dark:bg-slate-900/98 shadow-2xl shadow-purple-500/10 transition-colors duration-200 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-purple-100/70 dark:border-purple-900/40 px-6 py-4 bg-[#FAF8FE]/80 dark:bg-slate-900">
          <div className="flex items-center gap-2.5">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-purple-100 dark:bg-purple-950 text-purple-600 dark:text-purple-300">
              <Bell className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm sm:text-base font-extrabold text-slate-900 dark:text-slate-100">
                Telegram Notifications Settings
              </h3>
              <p className="text-[10px] sm:text-xs text-purple-600 dark:text-purple-300 font-medium">
                Get progress reports and completion alerts sent to your phone
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-xl p-1.5 text-slate-400 hover:bg-purple-50 dark:hover:bg-slate-800 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Form Body */}
        {isLoading ? (
          <div className="flex flex-col items-center justify-center py-16 gap-3">
            <Loader2 className="h-8 w-8 text-indigo-600 animate-spin" />
            <span className="text-xs text-slate-500 dark:text-slate-400 font-medium">Loading settings...</span>
          </div>
        ) : (
          <form onSubmit={handleSave} className="flex-1 overflow-y-auto p-6 space-y-5">
            {/* Global toggle */}
            <div className="flex items-center justify-between rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/60 p-4 transition">
              <div className="space-y-0.5">
                <label className="text-xs sm:text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Enable Telegram Notifications
                </label>
                <p className="text-[10px] sm:text-xs text-slate-500 dark:text-slate-400">
                  Send translation completion, failures, and status updates
                </p>
              </div>
              <button
                type="button"
                id="toggle-telegram-btn"
                onClick={() => setSettings({ ...settings, enabled: !settings.enabled })}
                className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                  settings.enabled ? "bg-indigo-600" : "bg-slate-200 dark:bg-slate-700"
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out ${
                    settings.enabled ? "translate-x-5" : "translate-x-0"
                  }`}
                />
              </button>
            </div>

            {settings.enabled && (
              <div className="space-y-4 animate-in fade-in duration-200">
                {/* Bot Token */}
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                    Bot Token (from @BotFather)
                  </label>
                  <div className="relative">
                    <input
                      type={showToken ? "text" : "password"}
                      value={settings.botToken}
                      onChange={(e) => setSettings({ ...settings, botToken: e.target.value })}
                      placeholder="e.g. 123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ"
                      className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 py-2 pl-3 pr-10 text-xs text-slate-900 dark:text-slate-100 focus:border-indigo-500 focus:outline-none transition"
                      required={settings.enabled}
                    />
                    <button
                      type="button"
                      onClick={() => setShowToken(!showToken)}
                      className="absolute right-2 top-2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer"
                    >
                      {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>

                {/* Chat IDs */}
                <div className="space-y-1.5">
                  <div className="flex justify-between items-center">
                    <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                      Telegram Chat ID(s)
                    </label>
                    <span className="text-[10px] text-slate-400">Comma-separated for multiple</span>
                  </div>
                  <input
                    type="text"
                    value={settings.chatIds}
                    onChange={(e) => setSettings({ ...settings, chatIds: e.target.value })}
                    placeholder="e.g. 987654321, -10012345678"
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-xs text-slate-900 dark:text-slate-100 focus:border-indigo-500 focus:outline-none transition"
                    required={settings.enabled}
                  />
                </div>

                {/* Periodic Progress Updates Toggle */}
                <div className="rounded-xl border border-slate-100 dark:border-slate-800 bg-slate-50/20 dark:bg-slate-800/30 p-4 space-y-3.5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Clock className="h-4 w-4 text-indigo-500" />
                      <div>
                        <span className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                          Periodic Progress Reports
                        </span>
                        <p className="text-[10px] text-slate-400">
                          Get updates while translations are actively running
                        </p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setSettings({ ...settings, statusEnabled: !settings.statusEnabled })}
                      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                        settings.statusEnabled ? "bg-indigo-600" : "bg-slate-200 dark:bg-slate-700"
                      }`}
                    >
                      <span
                        className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out ${
                          settings.statusEnabled ? "translate-x-4" : "translate-x-0"
                        }`}
                      />
                    </button>
                  </div>

                  {settings.statusEnabled && (
                    <div className="flex items-center justify-between gap-4 pt-2 border-t border-slate-100 dark:border-slate-800/80 animate-in slide-in-from-top-1 duration-200">
                      <label className="text-[11px] sm:text-xs text-slate-600 dark:text-slate-300">
                        Update Frequency
                      </label>
                      <select
                        value={settings.statusIntervalMin}
                        onChange={(e) => setSettings({ ...settings, statusIntervalMin: Number(e.target.value) })}
                        className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-1 text-xs text-slate-800 dark:text-slate-200 focus:border-indigo-500 focus:outline-none cursor-pointer"
                      >
                        <option value={1}>Every 1 minute (For testing)</option>
                        <option value={5}>Every 5 minutes (Recommended)</option>
                        <option value={10}>Every 10 minutes</option>
                        <option value={15}>Every 15 minutes</option>
                        <option value={30}>Every 30 minutes</option>
                      </select>
                    </div>
                  )}
                </div>

                {/* Connection Test Action */}
                <div className="pt-2">
                  <button
                    type="button"
                    onClick={handleTestConnection}
                    disabled={testStatus === "sending"}
                    className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-indigo-200 dark:border-indigo-900/60 bg-indigo-50/50 dark:bg-indigo-950/30 py-2 text-xs font-semibold text-indigo-700 dark:text-indigo-300 transition hover:bg-indigo-100 dark:hover:bg-indigo-950/60 active:scale-98 cursor-pointer disabled:opacity-50 shadow-xs"
                  >
                    {testStatus === "sending" ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        <span>Sending Test Notification...</span>
                      </>
                    ) : (
                      <>
                        <Send className="h-3.5 w-3.5" />
                        <span>Test Connection (Send Ping Message)</span>
                      </>
                    )}
                  </button>

                  {/* Connection success notification */}
                  {testStatus === "success" && (
                    <div className="mt-2.5 rounded-lg bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 p-3 text-[11px] text-emerald-800 dark:text-emerald-300 flex items-start gap-2 animate-in fade-in">
                      <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
                      <div>
                        <p className="font-bold">Test notification sent successfully!</p>
                        <p className="opacity-90">Please check your Telegram chat or channel for the test message.</p>
                      </div>
                    </div>
                  )}

                  {/* Connection error notifications */}
                  {testStatus === "error" && (
                    <div className="mt-2.5 rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 p-3 text-[11px] text-rose-800 dark:text-rose-300 flex items-start gap-2 animate-in fade-in">
                      <AlertTriangle className="h-4 w-4 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
                      <div>
                        <p className="font-bold">Telegram test failed</p>
                        <p className="opacity-95">{testError}</p>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Save Button */}
            <div className="pt-4 border-t border-slate-100 dark:border-slate-800/80 flex items-center justify-end gap-3">
              {saveStatus === "success" && (
                <span className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1.5 animate-in fade-in">
                  <CheckCircle2 className="h-4 w-4" /> Settings saved successfully
                </span>
              )}
              {saveStatus === "error" && (
                <span className="text-xs text-rose-600 dark:text-rose-400 flex items-center gap-1.5 animate-in fade-in">
                  <AlertTriangle className="h-4 w-4" /> Save failed
                </span>
              )}
              <button
                type="button"
                onClick={onClose}
                className="rounded-2xl border border-purple-200 dark:border-purple-800 bg-white dark:bg-slate-800 px-4 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-purple-50 dark:hover:bg-slate-700 active:scale-95 cursor-pointer transition"
              >
                Close
              </button>
              <button
                type="submit"
                disabled={isSaving}
                className="inline-flex items-center justify-center gap-1.5 rounded-2xl bg-gradient-to-r from-purple-500 to-indigo-500 hover:from-purple-600 hover:to-indigo-600 px-5 py-2 text-xs font-bold text-white shadow-md shadow-purple-500/20 active:scale-95 transition disabled:opacity-50 cursor-pointer"
              >
                {isSaving ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    <span>Saving...</span>
                  </>
                ) : (
                  <span>Save Settings</span>
                )}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
