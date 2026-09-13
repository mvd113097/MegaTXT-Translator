import React, { useState, useRef } from "react";
import {
  UploadCloud,
  FileText,
  Sparkles,
  Sliders,
  CheckCircle2,
  AlertCircle,
  FileCode,
  Zap,
  BookCheck,
} from "lucide-react";
import { countChineseCharacters } from "../utils/chunker";
import { SAMPLE_CHINESE_NOVEL } from "../data/sampleNovel";

interface UploadSectionProps {
  onLoadText: (text: string, fileName: string, targetChunkChars: number, splitByChapters: boolean) => void;
  serverJob?: any | null;
  onLoadServerJob?: () => void;
}

export const UploadSection: React.FC<UploadSectionProps> = ({
  onLoadText,
  serverJob,
  onLoadServerJob,
}) => {
  const [activeTab, setActiveTab] = useState<"file" | "paste">("file");
  const [dragActive, setDragActive] = useState(false);
  const [pastedText, setPastedText] = useState("");
  const [fileName, setFileName] = useState("");
  const [fileContent, setFileContent] = useState("");
  const [fileStats, setFileStats] = useState<{
    sizeKb: number;
    charCount: number;
    chineseChars: number;
    estimatedChunks: number;
  } | null>(null);

  // Settings (Default to 7,000 for maximum free volume: ~135 requests per 1M characters)
  const [targetChunkChars, setTargetChunkChars] = useState(7000);
  const [splitByChapters, setSplitByChapters] = useState(true);
  const [isReading, setIsReading] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Handle uploaded file
  const handleFileProcess = (file: File) => {
    if (!file) return;
    setIsReading(true);
    setFileName(file.name);

    const reader = new FileReader();
    reader.onload = (e) => {
      const content = (e.target?.result as string) || "";
      setFileContent(content);
      const chineseChars = countChineseCharacters(content);
      const totalChars = content.length;
      const estimatedChunks = Math.max(1, Math.ceil(totalChars / targetChunkChars));

      setFileStats({
        sizeKb: Math.round(file.size / 1024),
        charCount: totalChars,
        chineseChars,
        estimatedChunks,
      });
      setIsReading(false);
    };

    reader.onerror = () => {
      alert("Error reading text file. Please ensure it is a valid UTF-8 text file.");
      setIsReading(false);
    };

    reader.readAsText(file, "UTF-8");
  };

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFileProcess(e.dataTransfer.files[0]);
    }
  };

  const handleLoadSample = () => {
    setFileName("sample_doupo_cangqiong.txt");
    setFileContent(SAMPLE_CHINESE_NOVEL);
    const chineseChars = countChineseCharacters(SAMPLE_CHINESE_NOVEL);
    setFileStats({
      sizeKb: Math.round(new Blob([SAMPLE_CHINESE_NOVEL]).size / 1024),
      charCount: SAMPLE_CHINESE_NOVEL.length,
      chineseChars,
      estimatedChunks: 3,
    });
  };

  const handleConfirm = () => {
    const textToLoad = activeTab === "file" ? fileContent : pastedText;
    const name = activeTab === "file" ? fileName || "chinese_document.txt" : "pasted_text.txt";
    if (!textToLoad.trim()) return;

    onLoadText(textToLoad, name, targetChunkChars, splitByChapters);
  };

  return (
    <div className="mx-auto max-w-4xl py-6">
      {/* Existing Server Job Available Banner */}
      {serverJob && (
        <div
          id="server-job-recovery-banner"
          className="mb-6 rounded-2xl border border-emerald-400 dark:border-emerald-700 bg-gradient-to-r from-emerald-50 via-teal-50 to-emerald-50 dark:from-emerald-950/70 dark:via-slate-900 dark:to-emerald-950/70 p-5 shadow-lg shadow-emerald-500/10 transition animate-in fade-in"
        >
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-start gap-3.5">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-600 text-white shadow-xs">
                <CheckCircle2 className="h-6 w-6" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="rounded-full bg-emerald-600 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white">
                    {serverJob.status === "completed" ? "Completed" : "In Progress"}
                  </span>
                  <h3 className="text-sm font-bold text-slate-900 dark:text-white truncate max-w-xs sm:max-w-md">
                    {serverJob.fileName}
                  </h3>
                </div>
                <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">
                  {serverJob.status === "completed"
                    ? `🎉 Translation Completed! All ${serverJob.chunks?.length || 102} chapters are 100% finished and stored on the server.`
                    : `Cloud translation is active (${serverJob.completedChunks || 0} chapters translated).`}
                </p>
              </div>
            </div>

            {onLoadServerJob && (
              <button
                type="button"
                id="resume-server-job-btn"
                onClick={onLoadServerJob}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-xs font-bold text-white shadow-md hover:bg-emerald-700 active:scale-95 transition cursor-pointer shrink-0"
              >
                <BookCheck className="h-4 w-4" />
                <span>{serverJob.status === "completed" ? "Open & Download Completed Novel" : "Open Cloud Job"}</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* Intro hero banner */}
      <div className="mb-6 text-center">
        <div className="inline-flex items-center gap-1.5 rounded-full border border-indigo-200 dark:border-indigo-800/60 bg-indigo-50 dark:bg-indigo-950/60 px-3 py-1 text-xs font-semibold text-indigo-800 dark:text-indigo-300">
          <Zap className="h-3.5 w-3.5 text-indigo-600 dark:text-indigo-400" />
          Translating Massive Chinese Files (Up to 1,000,000+ Characters)
        </div>
        <h2 className="mt-3 text-2xl font-extrabold tracking-tight text-slate-900 dark:text-slate-100 sm:text-3xl">
          Upload or Paste Your Chinese Text File
        </h2>
        <p className="mx-auto mt-2 max-w-2xl text-sm leading-relaxed text-slate-600 dark:text-slate-400">
          Built specifically for large Chinese webnovels, long documents, and multi-chapter manuscripts.
          Smart chapter parsing and glossary consistency keep character names and realms unified across all million characters.
        </p>
      </div>

      {/* Main card */}
      <div className="overflow-hidden rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm transition-colors duration-200">
        {/* Tabs */}
        <div className="flex border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-800/60 p-2">
          <button
            id="tab-upload-file"
            onClick={() => setActiveTab("file")}
            className={`flex items-center gap-2 rounded-lg px-4 py-2 text-xs font-semibold transition ${
              activeTab === "file"
                ? "bg-white dark:bg-slate-700 text-indigo-600 dark:text-indigo-300 shadow-sm"
                : "text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white"
            }`}
          >
            <UploadCloud className="h-4 w-4" />
            <span>Upload TXT File</span>
          </button>
          <button
            id="tab-paste-text"
            onClick={() => setActiveTab("paste")}
            className={`flex items-center gap-2 rounded-lg px-4 py-2 text-xs font-semibold transition ${
              activeTab === "paste"
                ? "bg-white dark:bg-slate-700 text-indigo-600 dark:text-indigo-300 shadow-sm"
                : "text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white"
            }`}
          >
            <FileText className="h-4 w-4" />
            <span>Direct Text Input</span>
          </button>
        </div>

        <div className="p-6 sm:p-8">
          {activeTab === "file" ? (
            <div>
              {/* Drag and drop area */}
              <div
                onDragEnter={handleDrag}
                onDragLeave={handleDrag}
                onDragOver={handleDrag}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className={`group relative flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed p-8 text-center transition ${
                  dragActive
                    ? "border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/30"
                    : fileContent
                    ? "border-emerald-300 dark:border-emerald-700 bg-emerald-50/30 dark:bg-emerald-950/20 hover:border-emerald-400"
                    : "border-slate-300 dark:border-slate-700 hover:border-indigo-400 dark:hover:border-indigo-500 hover:bg-slate-50 dark:hover:bg-slate-800/50"
                }`}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".txt,text/plain"
                  className="hidden"
                  onChange={(e) => {
                    if (e.target.files && e.target.files[0]) {
                      handleFileProcess(e.target.files[0]);
                    }
                  }}
                />

                {fileContent ? (
                  <div className="flex flex-col items-center">
                    <div className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-900/60 text-emerald-600 dark:text-emerald-300">
                      <CheckCircle2 className="h-7 w-7" />
                    </div>
                    <p className="mt-3 text-sm font-semibold text-slate-800 dark:text-slate-200">
                      {fileName}
                    </p>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      Click or drag to replace file
                    </p>
                  </div>
                ) : (
                  <div className="flex flex-col items-center">
                    <div className="flex h-14 w-14 items-center justify-center rounded-full bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400 transition group-hover:scale-105">
                      <UploadCloud className="h-7 w-7" />
                    </div>
                    <p className="mt-3 text-sm font-semibold text-slate-800 dark:text-slate-200">
                      Click to upload or drag & drop your .txt file here
                    </p>
                    <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                      Supports files from a few thousand up to 1,000,000+ Chinese characters (10MB+)
                    </p>
                  </div>
                )}
              </div>

              {/* Sample loader button */}
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                  <span>Don't have a file ready right now?</span>
                </div>
                <button
                  id="load-sample-novel-btn"
                  onClick={handleLoadSample}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-200 dark:border-indigo-800 bg-indigo-50 dark:bg-indigo-950/60 px-3 py-1.5 text-xs font-semibold text-indigo-700 dark:text-indigo-300 transition hover:bg-indigo-100 dark:hover:bg-indigo-900/60"
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  Load Sample Chinese Fantasy Novel (3 Chapters)
                </button>
              </div>
            </div>
          ) : (
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                Paste Chinese Text:
              </label>
              <textarea
                id="pasted-text-input"
                rows={8}
                value={pastedText}
                onChange={(e) => {
                  setPastedText(e.target.value);
                  const chars = countChineseCharacters(e.target.value);
                  setFileStats({
                    sizeKb: Math.round(new Blob([e.target.value]).size / 1024),
                    charCount: e.target.value.length,
                    chineseChars: chars,
                    estimatedChunks: Math.max(1, Math.ceil(e.target.value.length / targetChunkChars)),
                  });
                }}
                placeholder="Paste Chinese text or web novel chapters here..."
                className="mt-1 w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 p-3 font-mono text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
            </div>
          )}

          {/* File Statistics Analysis (if loaded) */}
          {fileStats && (
            <div className="mt-6 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 p-4">
              <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                File Analysis & Metrics
              </h4>
              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div className="rounded-lg border border-slate-100 dark:border-slate-700 bg-white dark:bg-slate-800 p-3 shadow-xs">
                  <div className="text-xs text-slate-500 dark:text-slate-400">Chinese Characters</div>
                  <div className="mt-0.5 text-lg font-bold text-indigo-600 dark:text-indigo-400">
                    {fileStats.chineseChars.toLocaleString()}
                  </div>
                </div>
                <div className="rounded-lg border border-slate-100 dark:border-slate-700 bg-white dark:bg-slate-800 p-3 shadow-xs">
                  <div className="text-xs text-slate-500 dark:text-slate-400">Total Characters</div>
                  <div className="mt-0.5 text-lg font-bold text-slate-900 dark:text-slate-100">
                    {fileStats.charCount.toLocaleString()}
                  </div>
                </div>
                <div className="rounded-lg border border-slate-100 dark:border-slate-700 bg-white dark:bg-slate-800 p-3 shadow-xs">
                  <div className="text-xs text-slate-500 dark:text-slate-400">File Size</div>
                  <div className="mt-0.5 text-lg font-bold text-slate-900 dark:text-slate-100">
                    {fileStats.sizeKb > 1024
                       ? `${(fileStats.sizeKb / 1024).toFixed(2)} MB`
                      : `${fileStats.sizeKb} KB`}
                  </div>
                </div>
                <div className="rounded-lg border border-slate-100 dark:border-slate-700 bg-white dark:bg-slate-800 p-3 shadow-xs">
                  <div className="text-xs text-slate-500 dark:text-slate-400">Estimated Chunks</div>
                  <div className="mt-0.5 text-lg font-bold text-indigo-600 dark:text-indigo-400">
                    ~{fileStats.estimatedChunks}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Chunker Configuration */}
          <div className="mt-6 border-t border-slate-200 dark:border-slate-800 pt-6">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              <Sliders className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
              <span>Smart Chunking Engine Configuration</span>
            </div>
            <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  Target Chunk Size (Characters per API Batch)
                </label>
                <select
                  id="chunk-size-select"
                  value={targetChunkChars}
                  onChange={(e) => setTargetChunkChars(Number(e.target.value))}
                  className="mt-1 w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 focus:border-indigo-500 focus:outline-none"
                >
                  <option value={7000}>
                    ⚡ 7,000 Chars (~3,500 words) — 5 Books/Day Free Tier Preset (Recommended for High Volume)
                  </option>
                  <option value={9000}>
                    ⚡ 9,000 Chars (~4,500 words) — Max Free Capacity (~110 requests/book, Up to 10 Books/Day Free)
                  </option>
                  <option value={2500}>
                    2,500 Chars (~1,200 words) — Standard Chapter-by-Chapter (~400 requests/book)
                  </option>
                  <option value={1800}>
                    1,800 Chars (~800 words) — Fine-Grained Precision & Shorter Sections
                  </option>
                </select>
                <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                  {targetChunkChars >= 7000
                    ? "✨ Macro-Chunking reduces a 1,000,000-char book to only ~130 requests, easily allowing 5+ full books/day on Google's free 1,500 RPD tier!"
                    : "Chunks are split strictly on clean chapter/paragraph boundaries to preserve literary context."}
                </p>
              </div>

              <div className="flex items-start gap-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/50 p-3">
                <input
                  id="split-chapters-toggle"
                  type="checkbox"
                  checked={splitByChapters}
                  onChange={(e) => setSplitByChapters(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                />
                <div>
                  <label
                    htmlFor="split-chapters-toggle"
                    className="text-xs font-semibold text-slate-800 dark:text-slate-200"
                  >
                    Auto-Detect Chapter Headings (第X章 / Chapter X)
                  </label>
                  <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                    Automatically creates individual chapter cards with chapter titles for easy reading and navigation.
                  </p>
                </div>
              </div>
            </div>

            {/* 5-Books/Day Free Tier High-Volume Guarantee Badge */}
            <div className="mt-4 rounded-xl border border-emerald-200 dark:border-emerald-800/70 bg-emerald-50/60 dark:bg-emerald-950/40 p-3.5 text-xs text-emerald-900 dark:text-emerald-200">
              <div className="flex items-center gap-2 font-bold text-emerald-800 dark:text-emerald-300">
                <Zap className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                <span>Configured for Up to 5+ Full Books/Day (Strictly Free)</span>
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-emerald-700 dark:text-emerald-300/90">
                At <strong>7,000 characters per chunk</strong>, a 1-million-character book requires only <strong>~140 requests</strong>. 5 full books consume just ~700 requests, well within Google's free 1,500 daily requests allowance! If one model reaches rate limits, the system automatically fails over to backup free models (Gemini 2.5 Flash / Flash-Lite).
              </p>
            </div>
          </div>

          {/* Confirm button */}
          <div className="mt-8 flex justify-end">
            <button
              id="confirm-prepare-btn"
              onClick={handleConfirm}
              disabled={isReading || (activeTab === "file" ? !fileContent : !pastedText.trim())}
              className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-6 py-3 text-sm font-semibold text-white shadow-sm shadow-indigo-200 dark:shadow-none transition hover:bg-indigo-700 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <FileCode className="h-4 w-4" />
              <span>Process & Prepare Text Chunks</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
