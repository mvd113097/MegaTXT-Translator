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
  getContiguousCompletedChunks,
  analyzeChunkContinuity,
} from "./utils/chunker";
import { SAMPLE_GLOSSARY } from "./data/sampleNovel";
import { downloadEpub } from "./utils/epubGenerator";
import { downloadFile } from "./utils/fileDownloader";
import {
  CheckCircle,
  CheckCircle2,
  ExternalLink,
  AlertTriangle,
  Download,
  Cloud,
  ShieldCheck,
  BookOpen,
  RefreshCw,
  BookCheck,
  Layers,
  FileText,
} from "lucide-react";

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

  // Track active or finished background cloud job discovered on server
  const [serverCloudJob, setServerCloudJob] = useState<any | null>(null);

  // Runner state
  const [isRunning, setIsRunning] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [concurrency, setConcurrency] = useState<number>(() => {
    try {
      const saved = localStorage.getItem("megatext_concurrency");
      if (saved) {
        const val = parseInt(saved, 10);
        if (val >= 1 && val <= 5) return val;
      }
    } catch {}
    return 2;
  });
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

  // On-demand sync of full translated chapter texts for completed chunks
  const syncCompletedTexts = async () => {
    if (mode !== "cloud") return;
    try {
      const res = await fetch("/api/cloud-job/sync-texts?completedOnly=true", {
        headers: getAuthHeaders(),
      });
      const data = await res.json();
      if (data.success && Array.isArray(data.chunks)) {
        const textMap = new Map<number, { chineseText: string; englishText: string }>();
        data.chunks.forEach((c: any) => {
          textMap.set(c.index, { chineseText: c.chineseText || "", englishText: c.englishText || "" });
        });

        setSession((prev) => {
          if (!prev) return null;
          const updated = prev.chunks.map((c) => {
            const synced = textMap.get(c.index);
            if (synced && synced.englishText) {
              return {
                ...c,
                chineseText: synced.chineseText || c.chineseText,
                englishText: synced.englishText,
              };
            }
            return c;
          });
          chunksRef.current = updated;
          return { ...prev, chunks: updated };
        });
      }
    } catch (err) {
      console.warn("Error syncing completed chapter texts:", err);
    }
  };

  // Auto-check and recover existing cloud job from server on initial load (or when authenticated)
  useEffect(() => {
    async function checkServerCloudJob() {
      try {
        const res = await fetch("/api/cloud-job/status?full=true", {
          headers: getAuthHeaders(),
        });
        const data = await res.json();
        if (data.hasJob && data.job) {
          const sJob = data.job;
          setServerCloudJob(sJob);
          setSession((prev) => {
            const prevCompleted = prev?.chunks?.filter((c) => c.status === "completed").length || 0;
            const serverCompleted = sJob.completedChunks || (sJob.chunks ? sJob.chunks.filter((c: any) => c.status === "completed").length : 0);
            if (!prev || prev.fileName === sJob.fileName || (serverCompleted > prevCompleted)) {
              return {
                fileName: sJob.fileName,
                fileSizeBytes: sJob.fileSizeBytes || 0,
                totalChineseChars: sJob.totalChineseChars || 0,
                chunks: sJob.chunks,
                style: (sJob.style as TranslationStyle) || "xianxia",
                customInstructions: sJob.customInstructions || "",
                glossary: sJob.glossary || [],
                mode: "cloud",
                status: sJob.status,
                createdAt: sJob.startedAt,
                lastUpdated: sJob.lastActiveAt,
                lastDownloadedWordCount: prev?.lastDownloadedWordCount,
                lastDownloadedAt: prev?.lastDownloadedAt,
              };
            }
            return prev;
          });
          chunksRef.current = sJob.chunks;
          if (typeof sJob.concurrency === "number" && sJob.concurrency >= 1 && sJob.concurrency <= 5) {
            setConcurrency(sJob.concurrency);
            try {
              localStorage.setItem("megatext_concurrency", String(sJob.concurrency));
            } catch {}
          }
          if (sJob.status === "running") {
            setIsRunning(true);
            setIsPaused(false);
          } else if (sJob.status === "paused") {
            setIsRunning(false);
            setIsPaused(true);
          } else if (sJob.status === "completed") {
            setIsRunning(false);
            setIsPaused(false);
            syncCompletedTexts();
          }
        }
      } catch (err) {
        console.warn("Could not check cloud job on server:", err);
      }
    }
    checkServerCloudJob();
  }, [authToken]);

  // Load existing server job explicitly if requested
  const handleLoadServerJob = () => {
    if (!serverCloudJob) return;
    setSession({
      fileName: serverCloudJob.fileName,
      fileSizeBytes: serverCloudJob.fileSizeBytes || 0,
      totalChineseChars: serverCloudJob.totalChineseChars || 0,
      chunks: serverCloudJob.chunks,
      style: (serverCloudJob.style as TranslationStyle) || "xianxia",
      customInstructions: serverCloudJob.customInstructions || "",
      glossary: serverCloudJob.glossary || [],
      mode: "cloud",
      status: serverCloudJob.status,
      createdAt: serverCloudJob.startedAt,
      lastUpdated: serverCloudJob.lastActiveAt,
    });
    chunksRef.current = serverCloudJob.chunks;
    if (serverCloudJob.status === "running") {
      setIsRunning(true);
      setIsPaused(false);
    } else {
      setIsRunning(false);
      setIsPaused(false);
    }
    syncCompletedTexts();
  };

  // Cloud polling loop: polls lightweight status (~1.5KB compressed) to save 99.9% mobile data
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
          setServerCloudJob(sJob);
          let needsTextSync = false;

          setSession((prev) => {
            if (!prev || prev.fileName !== sJob.fileName) return prev;
            const prevChunks = prev.chunks || [];
            const mergedChunks = sJob.chunks.map((incChunk: any) => {
              const existing = prevChunks.find((c) => c.id === incChunk.id || c.index === incChunk.index);
              const hasEnglishLocally = existing && existing.englishText && existing.englishText.trim().length > 0;
              if (incChunk.hasEnglish && !hasEnglishLocally) {
                needsTextSync = true;
              }
              return {
                ...existing,
                ...incChunk,
                chineseText: incChunk.chineseText !== undefined ? incChunk.chineseText : (existing?.chineseText || ""),
                englishText: incChunk.englishText !== undefined ? incChunk.englishText : (existing?.englishText || ""),
              };
            });

            chunksRef.current = mergedChunks;
            return {
              ...prev,
              status: sJob.status,
              chunks: mergedChunks,
              lastUpdated: sJob.lastActiveAt,
            };
          });

          if (needsTextSync) {
            syncCompletedTexts();
          }

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

    const inFlightIds = new Set<string>();
    const numWorkers = 2; // Bounded concurrent browser tasks

    const runWorker = async () => {
      while (!stopRequestedRef.current && !pauseRequestedRef.current) {
        // Find next pending chunk not already being translated
        const chunkToProcess = chunksRef.current.find(
          (c) =>
            (c.status !== "completed" || !c.englishText || !c.englishText.trim()) &&
            !inFlightIds.has(c.id)
        );

        if (!chunkToProcess) {
          if (inFlightIds.size === 0) {
            break;
          }
          await new Promise((r) => setTimeout(r, 400));
          continue;
        }

        inFlightIds.add(chunkToProcess.id);
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
              `Attempt ${attempt}: ${result.error || "Translation failed"}. Retrying...`,
              duration
            );
            if (stopRequestedRef.current || pauseRequestedRef.current) break;
            const cooldownMs = Math.min(attempt * 2500, 10000);
            await new Promise((r) => setTimeout(r, cooldownMs));
          }
        }

        inFlightIds.delete(chunkToProcess.id);
        await new Promise((r) => setTimeout(r, 1200));
      }
    };

    await Promise.all(Array.from({ length: numWorkers }, () => runWorker()));

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

  // Dedicated progress downloader: downloads strictly the unbroken continuous chapters from Chapter 1 without stopping background translation
  const handleDownloadProgress = async (format: "epub" | "txt" = "epub") => {
    if (!session) return;
    if (mode === "cloud") {
      await syncCompletedTexts();
    }
    const currentChunks = chunksRef.current.length > 0 ? chunksRef.current : session.chunks;
    const continuity = analyzeChunkContinuity(currentChunks);
    const continuousList = continuity.continuousChunks;

    if (continuousList.length === 0) {
      setToastData({
        message:
          "Chapter 1 has not completed translation yet. The Never-Skip Engine guarantees all downloaded books start from Chapter 1 with zero gaps. Please wait for Chapter 1 to finish!",
        type: "warning",
      });
      setTimeout(() => setToastData(null), 6000);
      return;
    }

    const wordsCount = continuousList.reduce(
      (acc, c) => acc + countEnglishWords(c.englishText),
      0
    );

    const baseName = session.fileName.replace(/\.[^/.]+$/, "") || "translated_novel";

    try {
      if (format === "epub") {
        const res = await downloadEpub(continuousList, session.fileName, {
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

        const aheadNotice =
          continuity.aheadCompletedCount > 0
            ? ` (${continuity.aheadCompletedCount} upcoming chapter(s) ready ahead)`
            : "";

        setToastData({
          message: `EPUB eBook "${res.filename}" (Chapters 1–${continuousList.length}, ${wordsCount.toLocaleString()} words)${aheadNotice} prepared! Background translation continues uninterrupted.`,
          downloadUrl: res.downloadUrl,
          filename: res.filename,
          type: "success",
        });
        setTimeout(() => setToastData(null), 8000);
        return;
      }

      // Plain TXT export strictly contiguous
      const startCh = continuousList[0].chapterTitle || `Part 1`;
      const lastCh =
        continuousList[continuousList.length - 1].chapterTitle ||
        `Part ${continuousList.length}`;

      const header = `================================================================================
TRANSLATION PROGRESS SNAPSHOT: ${session.fileName}
Total English Words Translated (Continuous Sequence): ${wordsCount.toLocaleString()} words
Completed Frontier: Chapters 1 through ${continuousList.length} of ${session.chunks.length} total
Coverage: ${startCh} → ${lastCh}
Background Translation Status: ACTIVE & RUNNING UNINTERRUPTED
Export Timestamp: ${new Date().toLocaleString()}
================================================================================\n\n`;

      const body = continuousList
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
      const downloadName = `${baseName}_continuous_ch1_to_${continuousList.length}_${wordSuffix}.txt`;

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

      const aheadNotice =
        continuity.aheadCompletedCount > 0
          ? ` (${continuity.aheadCompletedCount} upcoming chapter(s) ready ahead)`
          : "";

      setToastData({
        message: `TXT continuous snapshot "${downloadName}" (Chapters 1–${continuousList.length}, ${wordsCount.toLocaleString()} words)${aheadNotice} prepared! Background translation continues uninterrupted.`,
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
      .filter((c) => c.status === "completed")
      .reduce(
        (acc, curr) => acc + (curr.wordCount || countEnglishWords(curr.englishText)),
        0
      ) || 0;

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

  // Explicit completion flag: verified if chunks finished, session status completed, or server job completed
  const isCompleted =
    (totalChunks > 0 && completedChunks === totalChunks) ||
    session?.status === "completed" ||
    Boolean(serverCloudJob && session && serverCloudJob.fileName === session.fileName && serverCloudJob.status === "completed");

  // Dynamic document title reflecting progress or 100% completion
  useEffect(() => {
    if (isCompleted && session) {
      document.title = `✅ [Completed] ${session.fileName} - MegaText Translator`;
    } else if (isRunning && session) {
      const pct = totalChunks > 0 ? Math.round((completedChunks / totalChunks) * 100) : 0;
      document.title = `⚡ [${pct}%] Translating ${session.fileName} - MegaText`;
    } else if (session) {
      document.title = `${session.fileName} - MegaText Translator`;
    } else {
      document.title = "MegaText Chinese to English Translator";
    }
  }, [isCompleted, isRunning, completedChunks, totalChunks, session?.fileName]);

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
    <div className="min-h-screen w-full overflow-x-hidden bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 flex flex-col font-sans transition-colors duration-200">
      {/* Navigation header */}
      <Navbar
        hasFile={!!session}
        totalChars={totalChineseChars}
        completedChars={completedChars}
        isCompleted={isCompleted}
        isRunning={isRunning}
        completedChunks={completedChunks}
        totalChunks={totalChunks}
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
          <UploadSection
            onLoadText={handleLoadText}
            serverJob={serverCloudJob}
            onLoadServerJob={handleLoadServerJob}
          />
        ) : (
          /* Step 2: Main translation studio */
          <div className="space-y-4">
            {/* Dedicated High-Visibility "Completed" Banner */}
            {isCompleted && (
              <div
                id="translation-completed-hero-banner"
                className="rounded-2xl border-2 border-emerald-500/80 dark:border-emerald-600 bg-gradient-to-br from-emerald-500/10 via-teal-500/5 to-emerald-500/15 dark:from-emerald-950/60 dark:via-slate-900 dark:to-emerald-950/60 p-5 sm:p-6 shadow-xl shadow-emerald-500/10 transition animate-in fade-in zoom-in-95 duration-200"
              >
                <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-5">
                  <div className="flex items-start gap-4">
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-md shadow-emerald-500/30">
                      <CheckCircle2 className="h-7 w-7" />
                    </div>
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-600 text-white px-3 py-0.5 text-xs font-black uppercase tracking-wider shadow-xs">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          Translation Completed
                        </span>
                        <span className="rounded-full bg-emerald-100 dark:bg-emerald-900/60 px-2.5 py-0.5 text-xs font-bold text-emerald-800 dark:text-emerald-200 border border-emerald-300 dark:border-emerald-700">
                          100% Translated (0 Gaps)
                        </span>
                      </div>
                      <h2 className="text-lg sm:text-xl font-black text-slate-900 dark:text-white tracking-tight">
                        {session.fileName} is 100% Finished!
                      </h2>
                      <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-300 leading-relaxed max-w-2xl">
                        All <strong className="text-slate-900 dark:text-white">{totalChunks} chapters</strong> ({completedChars.toLocaleString()} Chinese characters) were successfully translated into{" "}
                        <strong className="text-emerald-700 dark:text-emerald-400 font-bold">~{completedEnglishWords.toLocaleString()} English words</strong>. Your novel is fully preserved and ready for offline reading in Moon+ Reader or Kindle.
                      </p>
                    </div>
                  </div>

                  {/* Immediate 1-Click Action Buttons */}
                  <div className="flex flex-wrap items-center gap-2.5 sm:gap-3 shrink-0 pt-2 lg:pt-0">
                    <button
                      id="completed-banner-download-epub-btn"
                      type="button"
                      onClick={() => handleDownloadProgress("epub")}
                      className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 px-4 sm:px-5 py-3 text-xs sm:text-sm font-bold text-white shadow-lg shadow-emerald-600/30 hover:shadow-emerald-600/50 active:scale-95 transition cursor-pointer"
                      title="Download the full translated novel as an EPUB eBook"
                    >
                      <BookCheck className="h-4 w-4 sm:h-5 sm:w-5" />
                      <span>Download Complete Book (EPUB)</span>
                    </button>

                    <button
                      id="completed-banner-download-txt-btn"
                      type="button"
                      onClick={() => handleDownloadProgress("txt")}
                      className="inline-flex items-center justify-center gap-2 rounded-xl border border-emerald-400/80 dark:border-emerald-700 bg-white dark:bg-slate-800 hover:bg-emerald-50 dark:hover:bg-slate-750 px-3.5 sm:px-4 py-3 text-xs sm:text-sm font-bold text-emerald-800 dark:text-emerald-200 shadow-xs active:scale-95 transition cursor-pointer"
                      title="Download as standard UTF-8 text file"
                    >
                      <FileText className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                      <span>Download TXT</span>
                    </button>

                    <button
                      id="completed-banner-export-modal-btn"
                      type="button"
                      onClick={() => setIsExportOpen(true)}
                      className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 px-3 py-3 text-xs font-semibold text-slate-700 dark:text-slate-200 shadow-xs active:scale-95 transition cursor-pointer"
                      title="Open full export options (bilingual, markdown, formatting)"
                    >
                      <Layers className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
                      <span>Export Options</span>
                    </button>

                    <button
                      id="completed-banner-new-book-btn"
                      type="button"
                      onClick={handleReset}
                      className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-rose-50 dark:hover:bg-rose-950/40 hover:text-rose-600 dark:hover:text-rose-400 hover:border-rose-300 px-3 py-3 text-xs font-semibold text-slate-700 dark:text-slate-200 shadow-xs active:scale-95 transition cursor-pointer"
                      title="Translate a new novel"
                    >
                      <RefreshCw className="h-4 w-4" />
                      <span className="hidden sm:inline">New Book</span>
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Top Stats & Progress Bar */}
            <ProgressBar
              metrics={metrics}
              fileName={session.fileName}
              onQuickDownloadProgress={handleDownloadProgress}
              isRunning={isRunning}
              isCompleted={isCompleted}
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
              onChangeConcurrency={(newConc) => {
                setConcurrency(newConc);
                try {
                  localStorage.setItem("megatext_concurrency", String(newConc));
                } catch {}
                if (mode === "cloud" && session) {
                  fetch("/api/cloud-job/update-settings", {
                    method: "POST",
                    headers: getAuthHeaders(),
                    body: JSON.stringify({ concurrency: newConc }),
                  }).catch(() => {});
                }
              }}
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
              onReset={handleReset}
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
