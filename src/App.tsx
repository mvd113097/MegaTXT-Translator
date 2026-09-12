/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from "react";
import { Navbar } from "./components/Navbar";
import { UploadSection } from "./components/UploadSection";
import { TranslationControls } from "./components/TranslationControls";
import { ProgressBar } from "./components/ProgressBar";
import { TranslationQueueHub } from "./components/TranslationQueueHub";
import { GlossaryModal } from "./components/GlossaryModal";
import { ExportModal } from "./components/ExportModal";
import { AuthGateModal } from "./components/AuthGateModal";
import {
  TextChunk,
  TranslationStyle,
  TranslationMode,
  GlossaryTerm,
  TranslationMetrics,
  TranslationSession,
  AuthStatus,
} from "./types";
import {
  chunkChineseText,
  countChineseCharacters,
  countEnglishWords,
} from "./utils/chunker";
import { SAMPLE_GLOSSARY } from "./data/sampleNovel";
import { downloadEpub } from "./utils/epubGenerator";
import { downloadFile } from "./utils/fileDownloader";
import { CheckCircle, ExternalLink, AlertTriangle, Download, Cloud, ShieldCheck } from "lucide-react";

const STORAGE_KEY = "megatext_translator_session_v1";

export default function App() {
  // Theme state
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    try {
      const saved = localStorage.getItem("megatext_theme");
      if (saved === "dark" || saved === "light") return saved;
      if (typeof window !== "undefined" && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
        return "dark";
      }
    } catch {
      // ignore
    }
    return "light";
  });

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "dark") {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
    try {
      localStorage.setItem("megatext_theme", theme);
    } catch {
      // ignore
    }
  }, [theme]);

  const toggleTheme = () => {
    setTheme((prev) => (prev === "dark" ? "light" : "dark"));
  };

  // Authentication State
  const [authToken, setAuthToken] = useState<string>(() => {
    try {
      return localStorage.getItem("megatext_auth_token") || "";
    } catch {
      return "";
    }
  });
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);

  // Check auth status on boot
  const checkAuthStatus = async (tokenToCheck?: string) => {
    const activeTok = tokenToCheck !== undefined ? tokenToCheck : authToken;
    try {
      const res = await fetch("/api/auth/status", {
        headers: activeTok ? { Authorization: `Bearer ${activeTok}` } : {},
      });
      const data = await res.json();
      setAuthStatus(data);
      if (data.authenticated && activeTok) {
        setAuthToken(activeTok);
      }
    } catch (e) {
      console.warn("Auth status check warning:", e);
    } finally {
      setIsAuthLoading(false);
    }
  };

  useEffect(() => {
    checkAuthStatus();
  }, [authToken]);

  const handleLogout = async () => {
    try {
      if (authToken) {
        await fetch("/api/auth/logout", {
          method: "POST",
          headers: { Authorization: `Bearer ${authToken}` },
        });
      }
    } catch {}
    localStorage.removeItem("megatext_auth_token");
    setAuthToken("");
    setAuthStatus((prev) => (prev ? { ...prev, authenticated: false, googleVerified: false, passcodeVerified: false } : null));
    setToastData({
      message: "🔒 Logged out successfully. Master lockscreen engaged.",
      type: "warning",
    });
    setTimeout(() => setToastData(null), 4000);
  };

  // Helper to attach authorization header
  const getAuthHeaders = () => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (authToken) {
      headers["Authorization"] = `Bearer ${authToken}`;
    }
    return headers;
  };

  // Translation Mode state: Option 1 (cloud) vs Option 2 (browser)
  const [mode, setMode] = useState<TranslationMode>(() => {
    try {
      const saved = localStorage.getItem("megatext_mode");
      if (saved === "cloud" || saved === "browser") return saved;
    } catch {
      // ignore
    }
    return "cloud"; // Default to Option 1: Cloud Mode for browser-closed translation
  });

  const handleModeChange = (newMode: TranslationMode) => {
    setMode(newMode);
    try {
      localStorage.setItem("megatext_mode", newMode);
    } catch {}
    setSession((prev) => (prev ? { ...prev, mode: newMode } : null));
  };

  // Main Session State
  const [session, setSession] = useState<TranslationSession | null>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        return JSON.parse(saved);
      }
    } catch (e) {
      console.error("Failed to read session from localStorage:", e);
    }
    return null;
  });

  // Runner state
  const [isRunning, setIsRunning] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [concurrency, setConcurrency] = useState(2);
  const [style, setStyle] = useState<TranslationStyle>(session?.style || "xianxia");
  const [customInstructions, setCustomInstructions] = useState(
    session?.customInstructions || ""
  );
  const [glossary, setGlossary] = useState<GlossaryTerm[]>(
    session?.glossary || SAMPLE_GLOSSARY
  );

  // Modals
  const [isGlossaryOpen, setIsGlossaryOpen] = useState(false);
  const [isExportOpen, setIsExportOpen] = useState(false);
  const [toastData, setToastData] = useState<{
    message: string;
    downloadUrl?: string;
    filename?: string;
    type?: "success" | "warning" | "error";
  } | null>(null);

  // Metrics
  const [startTime, setStartTime] = useState<number | null>(null);
  const [charsTranslatedInRun, setCharsTranslatedInRun] = useState(0);

  // Refs for queue management
  const stopRequestedRef = useRef(false);
  const pauseRequestedRef = useRef(false);
  const activeRequestsRef = useRef(0);
  const chunksRef = useRef<TextChunk[]>(session?.chunks || []);

  // Synchronize chunksRef with state
  useEffect(() => {
    if (session?.chunks) {
      chunksRef.current = session.chunks;
    }
  }, [session?.chunks]);

  // Persist session changes to localStorage
  useEffect(() => {
    if (session) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
      } catch (err) {
        // LocalStorage may exceed quota for gigantic files (e.g. >5MB), handle gracefully
        console.warn("LocalStorage storage quota exceeded or disabled", err);
      }
    }
  }, [session]);

  // Auto-check and recover existing cloud job from server on initial load (or when authenticated)
  useEffect(() => {
    async function checkServerCloudJob() {
      try {
        const res = await fetch("/api/cloud-job/status", {
          headers: getAuthHeaders(),
        });
        const data = await res.json();
        if (data.hasJob && data.job) {
          const sJob = data.job;
          setSession((prev) => {
            if (!prev || prev.fileName === sJob.fileName) {
              return {
                fileName: sJob.fileName,
                fileSizeBytes: sJob.fileSizeBytes || 0,
                totalChineseChars: sJob.totalChineseChars || 0,
                chunks: sJob.chunks,
                style: (sJob.style as TranslationStyle) || "xianxia",
                customInstructions: sJob.customInstructions || "",
                glossary: sJob.glossary || [],
                mode: "cloud",
                createdAt: sJob.startedAt,
                lastUpdated: sJob.lastActiveAt,
                lastDownloadedWordCount: prev?.lastDownloadedWordCount,
                lastDownloadedAt: prev?.lastDownloadedAt,
              };
            }
            return prev;
          });
          chunksRef.current = sJob.chunks;
          if (sJob.status === "running") {
            setIsRunning(true);
            setIsPaused(false);
          } else if (sJob.status === "paused") {
            setIsRunning(false);
            setIsPaused(true);
          }
        }
      } catch (err) {
        console.warn("Could not check cloud job on server:", err);
      }
    }
    checkServerCloudJob();
  }, [authToken]);

  // Cloud polling loop: polls server while in cloud mode to reflect progress live
  useEffect(() => {
    if (mode !== "cloud") return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch("/api/cloud-job/status", {
          headers: getAuthHeaders(),
        });
        const data = await res.json();
        if (data.hasJob && data.job) {
          const sJob = data.job;
          setSession((prev) => {
            if (!prev || prev.fileName !== sJob.fileName) return prev;
            return {
              ...prev,
              chunks: sJob.chunks,
              lastUpdated: sJob.lastActiveAt,
            };
          });
          chunksRef.current = sJob.chunks;
          if (sJob.status === "running") {
            setIsRunning(true);
            setIsPaused(false);
          } else if (sJob.status === "paused") {
            setIsRunning(false);
            setIsPaused(true);
          } else if (sJob.status === "completed" || sJob.status === "idle") {
            setIsRunning(false);
            setIsPaused(false);
          }
        }
      } catch (err) {
        // silent poll error
      }
    }, 2500);

    return () => clearInterval(interval);
  }, [mode, authToken]);

  // Handle file or text load
  const handleLoadText = (
    text: string,
    fileName: string,
    targetChunkChars: number,
    splitByChapters: boolean
  ) => {
    const rawChunks = chunkChineseText(text, {
      targetChunkChars,
      splitByChapters,
    });

    const totalChars = countChineseCharacters(text) || text.length;

    const newSession: TranslationSession = {
      fileName,
      fileSizeBytes: new Blob([text]).size,
      totalChineseChars: totalChars,
      chunks: rawChunks,
      style,
      customInstructions,
      glossary,
      mode,
      createdAt: Date.now(),
      lastUpdated: Date.now(),
    };

    setSession(newSession);
    chunksRef.current = rawChunks;
    setIsRunning(false);
    setIsPaused(false);
    setStartTime(null);
    setCharsTranslatedInRun(0);
  };

  // Reset workspace
  const handleReset = async () => {
    if (
      isRunning &&
      !window.confirm("Translation is in progress. Are you sure you want to stop and reset?")
    ) {
      return;
    }
    stopRequestedRef.current = true;
    setIsRunning(false);
    setIsPaused(false);
    setSession(null);
    localStorage.removeItem(STORAGE_KEY);

    try {
      await fetch("/api/cloud-job/stop", {
        method: "POST",
        headers: getAuthHeaders(),
      });
    } catch {
      // ignore
    }
  };

  // Start cloud translation on server
  const startCloudTranslation = async () => {
    if (!session) return;
    setIsRunning(true);
    setIsPaused(false);

    try {
      const res = await fetch("/api/cloud-job/start", {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({
          fileName: session.fileName,
          fileSizeBytes: session.fileSizeBytes,
          totalChineseChars: session.totalChineseChars,
          chunks: session.chunks,
          style,
          customInstructions,
          glossary,
          concurrency,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to start cloud job on server");
      }

      setToastData({
        message: "☁️ Cloud Mode Activated: The server is translating your novel in the background. You can safely close your browser or turn off your screen anytime. Come back whenever you want to download your chapters!",
        type: "success",
      });
      setTimeout(() => setToastData(null), 10000);
    } catch (err: any) {
      setIsRunning(false);
      setToastData({
        message: "Could not start cloud job: " + (err.message || String(err)),
        type: "error",
      });
      setTimeout(() => setToastData(null), 7000);
    }
  };

  // Single chunk translator helper (for Browser Mode or manual steps)
  const translateSingleChunk = async (
    chunk: TextChunk,
    currentGlossary: GlossaryTerm[],
    currentStyle: TranslationStyle,
    instructions: string,
    prevContext?: string
  ): Promise<{ success: boolean; englishText?: string; error?: string }> => {
    try {
      const res = await fetch("/api/translate-chunk", {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({
          text: chunk.chineseText,
          chunkIndex: chunk.index,
          totalChunks: session?.chunks.length || 1,
          previousContext: prevContext,
          glossary: currentGlossary,
          style: currentStyle,
          customInstructions: instructions,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        return {
          success: false,
          error: data.error || `HTTP ${res.status}: Failed to translate`,
        };
      }

      return {
        success: true,
        englishText: data.translatedText,
      };
    } catch (err: any) {
      return {
        success: false,
        error: err.message || "Network error while contacting server",
      };
    }
  };

  // Run in-browser batch translation queue (Option 2 - Strict Sequential "Never-Skip")
  const runBrowserBatch = async () => {
    if (!session) return;
    stopRequestedRef.current = false;
    pauseRequestedRef.current = false;
    setIsRunning(true);
    setIsPaused(false);

    if (!startTime) {
      setStartTime(Date.now());
    }

    while (!stopRequestedRef.current && !pauseRequestedRef.current) {
      // Find the lowest-index non-completed chunk (strictly sequential)
      const chunkToProcess = chunksRef.current.find((c) => c.status !== "completed");

      if (!chunkToProcess) break;

      updateChunkStatus(chunkToProcess.id, "processing");

      let prevContext = "";
      const prevChunk = chunksRef.current[chunkToProcess.index - 1];
      if (prevChunk && prevChunk.englishText) {
        prevContext = prevChunk.englishText.slice(-200);
      }

      const startChunkTime = Date.now();
      let success = false;
      let attempt = 0;

      while (!success && !stopRequestedRef.current && !pauseRequestedRef.current) {
        attempt++;
        const result = await translateSingleChunk(
          chunkToProcess,
          glossary,
          style,
          customInstructions,
          prevContext
        );

        const duration = Date.now() - startChunkTime;

        if (result.success && result.englishText) {
          updateChunkSuccess(chunkToProcess.id, result.englishText, duration);
          setCharsTranslatedInRun((prev) => prev + chunkToProcess.charCount);
          success = true;
        } else {
          updateChunkError(
            chunkToProcess.id,
            `Attempt ${attempt}: ${result.error || "Translation failed"}. Retrying strictly...`,
            duration
          );
          // Wait exponential backoff cooldown before retrying this specific chunk
          const cooldownMs = Math.min(attempt * 3000, 15000);
          await new Promise((r) => setTimeout(r, cooldownMs));
        }
      }

      // Pacing pause between chunks to protect free-tier RPM limits
      await new Promise((r) => setTimeout(r, 2500));
    }

    setIsRunning(false);
    if (pauseRequestedRef.current) {
      setIsPaused(true);
    }
  };

  // Main start handler dispatching based on mode
  const handleStart = () => {
    if (mode === "cloud") {
      startCloudTranslation();
    } else {
      runBrowserBatch();
    }
  };

  // Helpers to update session chunk states cleanly
  const updateChunkStatus = (chunkId: string, status: TextChunk["status"]) => {
    setSession((prev) => {
      if (!prev) return null;
      const nextChunks = prev.chunks.map((c) =>
        c.id === chunkId ? { ...c, status } : c
      );
      chunksRef.current = nextChunks;
      return { ...prev, chunks: nextChunks, lastUpdated: Date.now() };
    });
  };

  const updateChunkSuccess = (
    chunkId: string,
    englishText: string,
    durationMs: number
  ) => {
    setSession((prev) => {
      if (!prev) return null;
      const nextChunks = prev.chunks.map((c) =>
        c.id === chunkId
          ? {
              ...c,
              englishText,
              status: "completed" as const,
              durationMs,
              errorMessage: undefined,
            }
          : c
      );
      chunksRef.current = nextChunks;
      return { ...prev, chunks: nextChunks, lastUpdated: Date.now() };
    });
  };

  const updateChunkError = (
    chunkId: string,
    errorMessage: string,
    durationMs: number
  ) => {
    setSession((prev) => {
      if (!prev) return null;
      const nextChunks = prev.chunks.map((c) =>
        c.id === chunkId
          ? {
              ...c,
              status: "error" as const,
              errorMessage,
              durationMs,
            }
          : c
      );
      chunksRef.current = nextChunks;
      return { ...prev, chunks: nextChunks, lastUpdated: Date.now() };
    });
  };

  // Translate a specific chunk on demand
  const handleTranslateSpecificChunk = async (chunkId: string) => {
    const chunk = chunksRef.current.find((c) => c.id === chunkId);
    if (!chunk) return;

    updateChunkStatus(chunkId, "processing");

    let prevContext = "";
    const prevChunk = chunksRef.current[chunk.index - 1];
    if (prevChunk && prevChunk.englishText) {
      prevContext = prevChunk.englishText.slice(-200);
    }

    const startChunkTime = Date.now();
    try {
      const result = await translateSingleChunk(
        chunk,
        glossary,
        style,
        customInstructions,
        prevContext
      );
      const duration = Date.now() - startChunkTime;

      if (result.success && result.englishText && result.englishText.trim()) {
        updateChunkSuccess(chunkId, result.englishText, duration);
        // Sync immediately with the server's cloud job so polling doesn't overwrite it
        await fetch("/api/cloud-job/update-chunk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chunkId,
            englishText: result.englishText,
            status: "completed",
          }),
        }).catch(() => {});
        setToastData({
          message: `✨ Chapter #${chunk.index + 1} translated successfully! (${countEnglishWords(result.englishText)} words)`,
          type: "success",
        });
        setTimeout(() => setToastData(null), 4000);
      } else {
        updateChunkError(chunkId, result.error || "Translation returned empty text", duration);
        setToastData({
          message: `⚠️ Chapter #${chunk.index + 1} error: ${result.error || "Empty response from AI"}`,
          type: "error",
        });
        setTimeout(() => setToastData(null), 6000);
      }
    } catch (e: any) {
      updateChunkError(chunkId, e.message || "Failed to translate", Date.now() - startChunkTime);
    }
  };

  // Translate next single chunk for testing
  const handleTranslateNextSingle = () => {
    const nextChunk = chunksRef.current.find(
      (c) => c.status === "pending" || c.status === "error"
    );
    if (nextChunk) {
      handleTranslateSpecificChunk(nextChunk.id);
    }
  };

  // Pause translation
  const handlePause = async () => {
    if (mode === "cloud") {
      try {
        await fetch("/api/cloud-job/pause", {
          method: "POST",
          headers: getAuthHeaders(),
        });
      } catch {}
    }
    pauseRequestedRef.current = true;
    setIsPaused(true);
    setIsRunning(false);
  };

  // Resume translation
  const handleResume = async () => {
    if (mode === "cloud") {
      try {
        await fetch("/api/cloud-job/resume", {
          method: "POST",
          headers: getAuthHeaders(),
        });
      } catch {}
      setIsPaused(false);
      setIsRunning(true);
    } else {
      pauseRequestedRef.current = false;
      runBrowserBatch();
    }
  };

  // Retry all failed chunks
  const handleRetryFailed = () => {
    setSession((prev) => {
      if (!prev) return null;
      const nextChunks = prev.chunks.map((c) =>
        c.status === "error" ? { ...c, status: "pending" as const } : c
      );
      chunksRef.current = nextChunks;
      return { ...prev, chunks: nextChunks };
    });
    setTimeout(() => {
      if (mode === "cloud") {
        startCloudTranslation();
      } else {
        runBrowserBatch();
      }
    }, 100);
  };

  // Update English text from manual inline edit
  const handleUpdateChunkText = (chunkId: string, newEnglishText: string) => {
    setSession((prev) => {
      if (!prev) return null;
      const nextChunks = prev.chunks.map((c) =>
        c.id === chunkId
          ? { ...c, englishText: newEnglishText, edited: true }
          : c
      );
      chunksRef.current = nextChunks;
      return { ...prev, chunks: nextChunks, lastUpdated: Date.now() };
    });

    if (mode === "cloud") {
      fetch("/api/cloud-job/update-chunk", {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({ chunkId, englishText: newEnglishText }),
      }).catch(() => {});
    }
  };

  // Dedicated progress downloader: downloads all completed English words so far as EPUB (or TXT) WITHOUT stopping background translation
  const handleDownloadProgress = async (format: "epub" | "txt" = "epub") => {
    if (!session) return;
    const completedChunksList = session.chunks.filter(
      (c) => c.status === "completed" && c.englishText && c.englishText.trim()
    );

    if (completedChunksList.length === 0) {
      setToastData({
        message: "No chapters have completed translation yet. Click 'Start Cloud Translation' or 'Translate Next Chunk' first!",
        type: "warning",
      });
      setTimeout(() => setToastData(null), 5000);
      return;
    }

    const wordsCount = completedChunksList.reduce(
      (acc, c) => acc + countEnglishWords(c.englishText),
      0
    );

    const baseName = session.fileName.replace(/\.[^/.]+$/, "") || "translated_novel";

    try {
      if (format === "epub") {
        const res = await downloadEpub(completedChunksList, session.fileName, {
          bookTitle: baseName.replace(/_/g, " "),
        });

        // Save that user downloaded up to this point so we can track incremental new words
        setSession((prev) =>
          prev
            ? {
                ...prev,
                lastDownloadedWordCount: wordsCount,
                lastDownloadedAt: Date.now(),
              }
            : null
        );

        setToastData({
          message: `EPUB eBook "${res.filename}" (${wordsCount.toLocaleString()} words, ${completedChunksList.length} chapters) prepared! Background translation continues uninterrupted.`,
          downloadUrl: res.downloadUrl,
          filename: res.filename,
          type: "success",
        });
        setTimeout(() => setToastData(null), 8000);
        return;
      }

      // Plain TXT export
      const startCh = completedChunksList[0].chapterTitle || `Part 1`;
      const lastCh =
        completedChunksList[completedChunksList.length - 1].chapterTitle ||
        `Part ${completedChunksList.length}`;

      const header = `================================================================================
TRANSLATION PROGRESS SNAPSHOT: ${session.fileName}
Total English Words Translated: ${wordsCount.toLocaleString()} words
Completed Chunks: ${completedChunksList.length} of ${session.chunks.length} total
Coverage: ${startCh} → ${lastCh}
Background Translation Status: ACTIVE & RUNNING UNINTERRUPTED
Export Timestamp: ${new Date().toLocaleString()}
================================================================================\n\n`;

      const body = completedChunksList
        .map((c) => {
          const title = c.chapterTitle
            ? `${c.chapterTitle}\n\n`
            : `Section ${c.index + 1}\n\n`;
          return `${title}${c.englishText.trim()}`;
        })
        .join("\n\n\n");

      const fullContent = header + body;
      const wordSuffix =
        wordsCount >= 1000
          ? `${(wordsCount / 1000).toFixed(1)}k_words`
          : `${wordsCount}_words`;
      const downloadName = `${baseName}_progress_${wordSuffix}.txt`;

      const res = await downloadFile(fullContent, downloadName, "text/plain;charset=utf-8");

      setSession((prev) =>
        prev
          ? {
              ...prev,
              lastDownloadedWordCount: wordsCount,
              lastDownloadedAt: Date.now(),
            }
          : null
      );

      setToastData({
        message: `TXT progress snapshot "${downloadName}" (${wordsCount.toLocaleString()} words) prepared! Background translation continues uninterrupted.`,
        downloadUrl: res.downloadUrl,
        filename: downloadName,
        type: "success",
      });
      setTimeout(() => setToastData(null), 8000);
    } catch (err: any) {
      setToastData({
        message: "Download failed: " + (err.message || String(err)),
        type: "error",
      });
      setTimeout(() => setToastData(null), 6000);
    }
  };

  // Calculate real-time metrics
  const totalChunks = session?.chunks.length || 0;
  const completedChunks =
    session?.chunks.filter((c) => c.status === "completed").length || 0;
  const inProgressChunks =
    session?.chunks.filter((c) => c.status === "processing").length || 0;
  const errorChunks =
    session?.chunks.filter((c) => c.status === "error").length || 0;

  const totalChineseChars = session?.totalChineseChars || 0;
  const completedChars =
    session?.chunks
      .filter((c) => c.status === "completed")
      .reduce((acc, curr) => acc + curr.charCount, 0) || 0;

  // Calculate total English words produced so far
  const completedEnglishWords =
    session?.chunks
      .filter((c) => c.status === "completed" && c.englishText)
      .reduce((acc, curr) => acc + countEnglishWords(curr.englishText), 0) || 0;

  const lastDownloadedWordCount = session?.lastDownloadedWordCount || 0;
  const newWordsSinceLastDownload = Math.max(
    0,
    completedEnglishWords - lastDownloadedWordCount
  );

  const elapsedMs = startTime ? Date.now() - startTime : 0;
  const charsPerSec =
    elapsedMs > 1000 && charsTranslatedInRun > 0
      ? (charsTranslatedInRun / elapsedMs) * 1000
      : 0;

  const remainingChars = Math.max(0, totalChineseChars - completedChars);
  const estimatedRemainingSeconds =
    charsPerSec > 0 ? remainingChars / charsPerSec : 0;

  const metrics: TranslationMetrics = {
    totalChars: totalChineseChars,
    completedChars,
    totalChunks,
    completedChunks,
    inProgressChunks,
    errorChunks,
    completedEnglishWords,
    lastDownloadedWordCount,
    newWordsSinceLastDownload,
    startTime,
    elapsedMs,
    charsPerSecond: charsPerSec,
    estimatedRemainingSeconds,
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 flex flex-col font-sans transition-colors duration-200">
      {/* Navigation header */}
      <Navbar
        hasFile={!!session}
        totalChars={totalChineseChars}
        completedChars={completedChars}
        onReset={handleReset}
        onOpenGlossary={() => setIsGlossaryOpen(true)}
        glossaryCount={glossary.length}
        theme={theme}
        onToggleTheme={toggleTheme}
        userEmail={authStatus?.userEmail}
        onLogout={handleLogout}
      />

      {/* Full-screen Dual-Factor Security Gate (Google Auth + Passcode) */}
      {!isAuthLoading && authStatus && !authStatus.authenticated && (
        <AuthGateModal
          authStatus={authStatus}
          onLoginSuccess={(token, userEmail) => {
            setAuthToken(token);
            setAuthStatus((prev) =>
              prev
                ? {
                    ...prev,
                    authenticated: true,
                    googleVerified: true,
                    passcodeVerified: true,
                    userEmail,
                  }
                : null
            );
            checkAuthStatus(token);
            setToastData({
              message: `🔓 Access granted. Welcome back, ${userEmail}!`,
              type: "success",
            });
            setTimeout(() => setToastData(null), 5000);
          }}
        />
      )}

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {!session ? (
          /* Step 1: Upload or paste Chinese text */
          <UploadSection onLoadText={handleLoadText} />
        ) : (
          /* Step 2: Main translation studio */
          <div className="space-y-4">
            {/* Top Stats & Progress Bar */}
            <ProgressBar
              metrics={metrics}
              fileName={session.fileName}
              onQuickDownloadProgress={handleDownloadProgress}
              isRunning={isRunning}
            />

            {/* Translation Action Controls */}
            <TranslationControls
              mode={mode}
              onChangeMode={handleModeChange}
              style={style}
              onChangeStyle={(s) => {
                setStyle(s);
                setSession((prev) => (prev ? { ...prev, style: s } : null));
              }}
              customInstructions={customInstructions}
              onChangeCustomInstructions={(inst) => {
                setCustomInstructions(inst);
                setSession((prev) =>
                  prev ? { ...prev, customInstructions: inst } : null
                );
              }}
              concurrency={concurrency}
              onChangeConcurrency={setConcurrency}
              isRunning={isRunning}
              isPaused={isPaused}
              onStart={handleStart}
              onPause={handlePause}
              onResume={handleResume}
              onTranslateNext={handleTranslateNextSingle}
              onRetryFailed={handleRetryFailed}
              onOpenExport={() => setIsExportOpen(true)}
              onDownloadProgress={handleDownloadProgress}
              hasErrors={errorChunks > 0}
              completedChunks={completedChunks}
              totalChunks={totalChunks}
              completedEnglishWords={completedEnglishWords}
              lastDownloadedWords={lastDownloadedWordCount}
            />

            {/* Moon+ Reader Focused Batch Queue & Download Hub */}
            <TranslationQueueHub
              chunks={session.chunks}
              fileName={session.fileName}
              completedEnglishWords={completedEnglishWords}
              lastDownloadedWords={lastDownloadedWordCount}
              onDownloadProgress={handleDownloadProgress}
              onOpenExport={() => setIsExportOpen(true)}
              onTranslateChunk={handleTranslateSpecificChunk}
              isRunning={isRunning}
              mode={mode}
            />
          </div>
        )}
      </main>

      {/* Terminology & Glossary Modal */}
      <GlossaryModal
        isOpen={isGlossaryOpen}
        onClose={() => setIsGlossaryOpen(false)}
        glossary={glossary}
        onSaveGlossary={(newGlossary) => {
          setGlossary(newGlossary);
          setSession((prev) =>
            prev ? { ...prev, glossary: newGlossary } : null
          );
        }}
        sampleChineseText={session?.chunks[0]?.chineseText || ""}
      />

      {/* Export & Download Modal */}
      {session && (
        <ExportModal
          isOpen={isExportOpen}
          onClose={() => setIsExportOpen(false)}
          chunks={session.chunks}
          fileName={session.fileName}
        />
      )}

      {/* Floating Toast notification when user downloads progress or gets a status alert */}
      {toastData && (
        <div className={`fixed bottom-6 right-6 z-50 flex max-w-md flex-col gap-2 rounded-xl border p-4 text-xs shadow-2xl backdrop-blur-xs animate-in fade-in slide-in-from-bottom-4 ${
          toastData.type === "error"
            ? "border-rose-400 bg-rose-950/95 text-rose-100"
            : toastData.type === "warning"
            ? "border-amber-400 bg-amber-950/95 text-amber-100"
            : "border-emerald-400 bg-emerald-950/95 text-emerald-100"
        }`}>
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2">
              {toastData.type === "error" || toastData.type === "warning" ? (
                <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400 mt-0.5" />
              ) : (
                <CheckCircle className="h-4 w-4 shrink-0 text-emerald-400 mt-0.5" />
              )}
              <span className="leading-relaxed">{toastData.message}</span>
            </div>
            <button
              onClick={() => setToastData(null)}
              className="rounded p-0.5 text-slate-300 hover:bg-black/20 hover:text-white"
            >
              ✕
            </button>
          </div>

          {toastData.downloadUrl && (
            <div className="mt-1 flex items-center gap-2 border-t border-white/10 pt-2">
              <a
                href={toastData.downloadUrl}
                target="_blank"
                rel="noopener noreferrer"
                download={toastData.filename}
                className="inline-flex items-center gap-1.5 rounded-lg bg-white/20 px-2.5 py-1 font-semibold text-white hover:bg-white/30 transition"
              >
                <Download className="h-3.5 w-3.5" />
                <span>Direct Download Link (New Tab)</span>
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
