import React, { useState } from "react";
import {
  X,
  Download,
  Copy,
  Check,
  FileText,
  BookOpen,
  Layers,
  BookCheck,
  Loader2,
  ExternalLink,
  AlertCircle,
  Eye,
  CheckCircle2,
} from "lucide-react";
import { TextChunk } from "../types";
import { countEnglishWords } from "../utils/chunker";
import { downloadEpub } from "../utils/epubGenerator";
import { downloadFile } from "../utils/fileDownloader";

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  chunks: TextChunk[];
  fileName: string;
}

type ExportFormat =
  | "epub"
  | "bilingual_epub"
  | "english_txt"
  | "bilingual_txt"
  | "markdown"
  | "chinese_txt";

export const ExportModal: React.FC<ExportModalProps> = ({
  isOpen,
  onClose,
  chunks,
  fileName,
}) => {
  const [exportFormat, setExportFormat] = useState<ExportFormat>("epub");
  const [copied, setCopied] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [downloadSuccess, setDownloadSuccess] = useState<{
    filename: string;
    url?: string;
  } | null>(null);

  if (!isOpen) return null;

  const translatedChunks = chunks.filter(
    (c) => c.englishText && c.englishText.trim()
  );
  const totalEnglishWords = translatedChunks.reduce(
    (acc, c) => acc + countEnglishWords(c.englishText),
    0
  );
  const baseName = fileName.replace(/\.[^/.]+$/, "") || "translated_novel";
  const hasTranslations = translatedChunks.length > 0;

  // Generate output string based on format (for TXT, MD, Chinese, and clipboard)
  const generateExportContent = (): string => {
    if (exportFormat === "chinese_txt") {
      return chunks
        .map((c) => {
          const header = c.chapterTitle ? `${c.chapterTitle}\n\n` : "";
          return `${header}${c.chineseText.trim()}`;
        })
        .join("\n\n\n");
    }

    if (exportFormat === "english_txt" || exportFormat === "epub") {
      return translatedChunks
        .map((c) => {
          const header = c.chapterTitle ? `${c.chapterTitle}\n\n` : "";
          return `${header}${c.englishText.trim()}`;
        })
        .join("\n\n\n");
    }

    if (exportFormat === "bilingual_txt" || exportFormat === "bilingual_epub") {
      return translatedChunks
        .map((c) => {
          const header = c.chapterTitle
            ? `====================\n${c.chapterTitle}\n====================\n\n`
            : "";
          return `${header}[ORIGINAL CHINESE]\n${c.chineseText.trim()}\n\n[ENGLISH TRANSLATION]\n${c.englishText.trim()}`;
        })
        .join("\n\n--------------------\n\n");
    }

    if (exportFormat === "markdown") {
      return translatedChunks
        .map((c) => {
          const title = c.chapterTitle
            ? `# ${c.chapterTitle}\n\n`
            : `## Section ${c.index + 1}\n\n`;
          return `${title}${c.englishText.trim()}`;
        })
        .join("\n\n\n");
    }

    return "";
  };

  const handleDownload = async () => {
    setErrorMessage(null);
    setDownloadSuccess(null);

    // If requesting English/bilingual format but nothing translated yet
    if (exportFormat !== "chinese_txt" && translatedChunks.length === 0) {
      setErrorMessage(
        "No translated chapters ready yet. Please close this dialog and click 'Translate All Chunks' first to generate English translations, or switch format to 'Original Chinese TXT'."
      );
      return;
    }

    // EPUB format export
    if (exportFormat === "epub" || exportFormat === "bilingual_epub") {
      try {
        setIsExporting(true);
        const res = await downloadEpub(translatedChunks, fileName, {
          bookTitle: baseName.replace(/_/g, " "),
          isBilingual: exportFormat === "bilingual_epub",
        });

        setDownloadSuccess({
          filename: res.filename,
          url: res.downloadUrl,
        });
      } catch (err: any) {
        setErrorMessage(
          "Failed to build EPUB: " + (err.message || String(err))
        );
      } finally {
        setIsExporting(false);
      }
      return;
    }

    // Text & Markdown format export
    try {
      setIsExporting(true);
      const content = generateExportContent();
      const ext = exportFormat === "markdown" ? "md" : "txt";
      const suffix =
        exportFormat === "bilingual_txt"
          ? "_bilingual"
          : exportFormat === "chinese_txt"
          ? "_source_zh"
          : "_en";
      const downloadName = `${baseName}${suffix}.${ext}`;
      const mimeType =
        exportFormat === "markdown"
          ? "text/markdown;charset=utf-8"
          : "text/plain;charset=utf-8";

      const res = await downloadFile(content, downloadName, mimeType);

      setDownloadSuccess({
        filename: downloadName,
        url: res.downloadUrl,
      });
    } catch (err: any) {
      setErrorMessage(
        "Failed to download file: " + (err.message || String(err))
      );
    } finally {
      setIsExporting(false);
    }
  };

  const handleCopyAll = () => {
    const content = generateExportContent();
    if (!content) {
      setErrorMessage("Nothing to copy. Translate some chunks first!");
      return;
    }
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 dark:bg-black/70 p-4 backdrop-blur-xs">
      <div className="flex w-full max-w-xl max-h-[90vh] flex-col rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xl transition-colors duration-200 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 px-6 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400">
              <Download className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-900 dark:text-slate-100">
                Export Book & Documents
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {translatedChunks.length} of {chunks.length} chunks translated (
                {totalEnglishWords.toLocaleString()} English words)
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-600 dark:hover:text-slate-200"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Scrollable Body */}
        <div className="p-6 space-y-4 overflow-y-auto">
          {/* Status / Notice if no translated chunks */}
          {!hasTranslations && (
            <div className="rounded-xl border border-amber-200 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-950/40 p-3.5 text-xs text-amber-800 dark:text-amber-200 flex items-start gap-2.5">
              <AlertCircle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400 mt-0.5" />
              <div className="leading-relaxed">
                <strong>No translated chapters ready yet.</strong>
                <p className="mt-0.5 text-amber-700 dark:text-amber-300">
                  Click <em>"Translate All Chunks"</em> or <em>"Translate Next Chunk"</em> in the main screen to generate English chapters. You can also export the original Chinese text right now.
                </p>
              </div>
            </div>
          )}

          {/* Success Banner with Direct Download Link (Works across sandboxed iframes) */}
          {downloadSuccess && (
            <div className="rounded-xl border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/60 p-4 text-xs text-emerald-900 dark:text-emerald-100 animate-in fade-in">
              <div className="flex items-center gap-2 font-bold text-emerald-800 dark:text-emerald-200">
                <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                <span>Download Started: {downloadSuccess.filename}</span>
              </div>
              <p className="mt-1 text-[11px] text-emerald-700 dark:text-emerald-300">
                The file has been prepared. If your browser blocked the download inside the preview window, use the direct link below:
              </p>
              {downloadSuccess.url && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <a
                    href={downloadSuccess.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    download={downloadSuccess.filename}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white shadow-xs hover:bg-emerald-700 transition"
                  >
                    <Download className="h-3.5 w-3.5" />
                    <span>Direct File Download (Opens in New Tab)</span>
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              )}
            </div>
          )}

          {/* Error Banner */}
          {errorMessage && (
            <div className="rounded-xl border border-rose-200 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/60 p-3.5 text-xs text-rose-800 dark:text-rose-200 flex items-start gap-2">
              <AlertCircle className="h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400 mt-0.5" />
              <span>{errorMessage}</span>
            </div>
          )}

          {/* Format Choices */}
          <div>
            <div className="flex items-center justify-between">
              <label className="text-xs font-bold text-slate-700 dark:text-slate-200">
                Choose Export Format:
              </label>
              <button
                type="button"
                onClick={() => setShowPreview(!showPreview)}
                className="inline-flex items-center gap-1 text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline"
              >
                <Eye className="h-3.5 w-3.5" />
                <span>{showPreview ? "Hide Preview" : "Preview Document"}</span>
              </button>
            </div>

            <div className="mt-2.5 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              {/* EPUB eBook (Default / Recommended) */}
              <button
                type="button"
                onClick={() => {
                  setExportFormat("epub");
                  setDownloadSuccess(null);
                }}
                className={`relative flex flex-col items-start rounded-xl border p-3.5 text-left transition ${
                  exportFormat === "epub"
                    ? "border-indigo-600 dark:border-indigo-500 bg-indigo-50/60 dark:bg-indigo-950/50 text-indigo-900 dark:text-indigo-200 ring-2 ring-indigo-500"
                    : "border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200"
                }`}
              >
                <div className="flex items-center justify-between w-full">
                  <div className="flex items-center gap-1.5">
                    <BookCheck className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
                    <span className="text-xs font-bold">EPUB eBook (.epub)</span>
                  </div>
                  <span className="rounded-full bg-indigo-600 px-1.5 py-0.5 text-[9px] font-bold text-white uppercase tracking-wider">
                    Recommended
                  </span>
                </div>
                <span className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                  Standard e-reader book for Apple Books, Kindle, Kobo
                </span>
              </button>

              {/* Bilingual EPUB */}
              <button
                type="button"
                onClick={() => {
                  setExportFormat("bilingual_epub");
                  setDownloadSuccess(null);
                }}
                className={`flex flex-col items-start rounded-xl border p-3.5 text-left transition ${
                  exportFormat === "bilingual_epub"
                    ? "border-indigo-600 dark:border-indigo-500 bg-indigo-50/60 dark:bg-indigo-950/50 text-indigo-900 dark:text-indigo-200 ring-2 ring-indigo-500"
                    : "border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200"
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <Layers className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
                  <span className="text-xs font-bold">Bilingual EPUB (.epub)</span>
                </div>
                <span className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                  ZH + EN paired paragraphs in e-reader format
                </span>
              </button>

              {/* English TXT */}
              <button
                type="button"
                onClick={() => {
                  setExportFormat("english_txt");
                  setDownloadSuccess(null);
                }}
                className={`flex flex-col items-start rounded-xl border p-3 text-left transition ${
                  exportFormat === "english_txt"
                    ? "border-indigo-600 dark:border-indigo-500 bg-indigo-50/60 dark:bg-indigo-950/50 text-indigo-900 dark:text-indigo-200 ring-2 ring-indigo-500"
                    : "border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200"
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <FileText className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
                  <span className="text-xs font-bold">English TXT</span>
                </div>
                <span className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                  Clean plain text novel format
                </span>
              </button>

              {/* Bilingual Dual TXT */}
              <button
                type="button"
                onClick={() => {
                  setExportFormat("bilingual_txt");
                  setDownloadSuccess(null);
                }}
                className={`flex flex-col items-start rounded-xl border p-3 text-left transition ${
                  exportFormat === "bilingual_txt"
                    ? "border-indigo-600 dark:border-indigo-500 bg-indigo-50/60 dark:bg-indigo-950/50 text-indigo-900 dark:text-indigo-200 ring-2 ring-indigo-500"
                    : "border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200"
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <Layers className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
                  <span className="text-xs font-bold">Bilingual TXT</span>
                </div>
                <span className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                  ZH + EN paired paragraphs
                </span>
              </button>

              {/* Markdown */}
              <button
                type="button"
                onClick={() => {
                  setExportFormat("markdown");
                  setDownloadSuccess(null);
                }}
                className={`flex flex-col items-start rounded-xl border p-3 text-left transition ${
                  exportFormat === "markdown"
                    ? "border-indigo-600 dark:border-indigo-500 bg-indigo-50/60 dark:bg-indigo-950/50 text-indigo-900 dark:text-indigo-200 ring-2 ring-indigo-500"
                    : "border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200"
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <BookOpen className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
                  <span className="text-xs font-bold">Markdown (.md)</span>
                </div>
                <span className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                  Formatted headers for Obsidian, Notion
                </span>
              </button>

              {/* Original Chinese TXT */}
              <button
                type="button"
                onClick={() => {
                  setExportFormat("chinese_txt");
                  setDownloadSuccess(null);
                }}
                className={`flex flex-col items-start rounded-xl border p-3 text-left transition ${
                  exportFormat === "chinese_txt"
                    ? "border-indigo-600 dark:border-indigo-500 bg-indigo-50/60 dark:bg-indigo-950/50 text-indigo-900 dark:text-indigo-200 ring-2 ring-indigo-500"
                    : "border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200"
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <FileText className="h-4 w-4 text-slate-500 dark:text-slate-400" />
                  <span className="text-xs font-bold">Original Chinese TXT</span>
                </div>
                <span className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                  Export the {chunks.length} raw Chinese sections
                </span>
              </button>
            </div>
          </div>

          {/* Text Preview Window (if enabled) */}
          {showPreview && (
            <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/80 p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold text-slate-700 dark:text-slate-200">
                  Document Preview ({exportFormat}):
                </span>
                <span className="text-[10px] text-slate-400">
                  {generateExportContent().length.toLocaleString()} characters
                </span>
              </div>
              <textarea
                readOnly
                rows={7}
                value={generateExportContent() || "(No translated text ready yet)"}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-2 font-mono text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
              />
            </div>
          )}

          {/* Format Description Callout */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/60 p-3.5 text-xs text-slate-600 dark:text-slate-300">
            {exportFormat === "epub" && (
              <p>
                📚 <strong>EPUB eBook</strong> creates a complete, beautifully styled electronic book with a Title Page, Chapter Table of Contents, and serif typography. Compatible with Apple Books, Kindle (via Send-to-Kindle), Kobo, Moon+ Reader, or Calibre.
              </p>
            )}
            {exportFormat === "bilingual_epub" && (
              <p>
                📖 <strong>Bilingual EPUB</strong> packages both the original Chinese text and English translation together into an e-reader book for study, comparison, or reading practice.
              </p>
            )}
            {exportFormat === "english_txt" && (
              <p>
                📄 Generates standard plain text formatted with UTF-8 BOM and chapter breaks, ready for any text reader.
              </p>
            )}
            {exportFormat === "bilingual_txt" && (
              <p>
                📑 Generates dual-language plain text containing each Chinese original paragraph sequentially paired with its English translation.
              </p>
            )}
            {exportFormat === "markdown" && (
              <p>
                📝 Generates structured Markdown syntax with <code># Chapter</code> headings.
              </p>
            )}
            {exportFormat === "chinese_txt" && (
              <p>
                🇨🇳 Exports all {chunks.length} original Chinese chapters in a single formatted TXT document.
              </p>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-slate-200 dark:border-slate-800 px-6 py-4 bg-slate-50/50 dark:bg-slate-900/50">
          <button
            onClick={handleCopyAll}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 active:scale-95"
            title="Copy text to clipboard"
          >
            {copied ? (
              <>
                <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                <span>Copied to Clipboard!</span>
              </>
            ) : (
              <>
                <Copy className="h-4 w-4" />
                <span>Copy Text</span>
              </>
            )}
          </button>

          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              disabled={isExporting}
              className="rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
            >
              Close
            </button>
            <button
              id="download-file-btn"
              onClick={handleDownload}
              disabled={isExporting}
              className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white shadow-xs hover:bg-indigo-700 active:scale-95 disabled:opacity-50 cursor-pointer"
            >
              {isExporting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Preparing Download...</span>
                </>
              ) : (
                <>
                  <Download className="h-4 w-4" />
                  <span>
                    Download{" "}
                    {exportFormat.includes("epub")
                      ? "EPUB"
                      : exportFormat.includes("txt")
                      ? "TXT"
                      : "MD"}
                  </span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
