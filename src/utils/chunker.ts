import { TextChunk, SubChunkItem } from "../types";
export {
  isStubOrEmptyText,
  isStubOrEmptyChunk,
  extractChapterNormalizedKey,
  cleanChapterTitle,
  cleanAndDeduplicateChunks,
  cleanAndDeduplicateChapterList,
} from "./chunkCleaner";

export interface ChunkOptions {
  targetChunkChars?: number; // default ~2500 characters
  splitByChapters?: boolean;
}

// Regex to detect common Chinese novel chapter headings
const CHAPTER_REGEX =
  /(?:^|\n)\s*(第\s*[0-9零一二三四五六七八九十百千万]+\s*[章回节卷集部篇][^\n]*|Chapter\s+[0-9]+[^\n]*|卷\s*[0-9零一二三四五六七八九十百千万]+[^\n]*|【\s*第\s*[0-9零一二三四五六七八九十百千万]+\s*[章回节卷集部篇][^\n]*】|\([0-9]+\)[^\n]*)/gi;

/**
 * Counts the exact number of Chinese CJK characters in a string
 */
export function countChineseCharacters(text: string): number {
  const matches = text.match(/[\u4e00-\u9fa5\u3400-\u4dbf\uf900-\ufaff]/g);
  return matches ? matches.length : 0;
}

/**
 * Counts the approximate number of English words in a string
 */
export function countEnglishWords(text: string): number {
  if (!text || !text.trim()) return 0;
  const matches = text.trim().match(/\b[A-Za-z0-9'-]+\b/g);
  return matches ? matches.length : 0;
}

/**
 * Splits text into internal sub-chunk segments for safe translation execution without creating rogue chapters.
 */
export function splitTextIntoSubChunks(
  text: string,
  targetSize: number = 2500,
  parentChapterId?: string
): SubChunkItem[] {
  const subChunks: SubChunkItem[] = [];
  if (!text.trim()) return subChunks;

  const paragraphs = text.split(/\n+/);
  let currentChunkText = "";

  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i].trim();
    if (!p) continue;

    if (
      currentChunkText.length > 0 &&
      currentChunkText.length + p.length > targetSize
    ) {
      subChunks.push({
        id: `${parentChapterId || "sub"}-part-${subChunks.length + 1}`,
        subIndex: subChunks.length,
        totalSubChunks: 0,
        chineseText: currentChunkText.trim(),
        charCount: countChineseCharacters(currentChunkText) || currentChunkText.length,
        status: "pending",
      });
      currentChunkText = "";
    }

    if (p.length > targetSize) {
      const sentences = p.split(/(?<=[。！？\.\!\?])\s*/);
      for (const s of sentences) {
        if (!s) continue;
        if (
          currentChunkText.length > 0 &&
          currentChunkText.length + s.length > targetSize
        ) {
          subChunks.push({
            id: `${parentChapterId || "sub"}-part-${subChunks.length + 1}`,
            subIndex: subChunks.length,
            totalSubChunks: 0,
            chineseText: currentChunkText.trim(),
            charCount: countChineseCharacters(currentChunkText) || currentChunkText.length,
            status: "pending",
          });
          currentChunkText = "";
        }
        currentChunkText += (currentChunkText ? " " : "") + s;
      }
    } else {
      currentChunkText += (currentChunkText ? "\n\n" : "") + p;
    }
  }

  if (currentChunkText.trim()) {
    subChunks.push({
      id: `${parentChapterId || "sub"}-part-${subChunks.length + 1}`,
      subIndex: subChunks.length,
      totalSubChunks: 0,
      chineseText: currentChunkText.trim(),
      charCount: countChineseCharacters(currentChunkText) || currentChunkText.length,
      status: "pending",
    });
  }

  for (const item of subChunks) {
    item.totalSubChunks = subChunks.length;
  }

  return subChunks;
}

/**
 * Splits continuous text into chunks with smart boundary detection (paragraphs, sentences).
 */
function splitTextIntoParagraphChunks(
  text: string,
  targetSize: number,
  baseChapterTitle?: string,
  startIndex = 0
): TextChunk[] {
  const chunks: TextChunk[] = [];
  if (!text.trim()) return chunks;

  const paragraphs = text.split(/\n+/);
  let currentChunkText = "";
  let subIndex = 1;

  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i].trim();
    if (!p) continue;

    // If adding this paragraph exceeds target size and current chunk isn't empty, flush it
    if (
      currentChunkText.length > 0 &&
      currentChunkText.length + p.length > targetSize
    ) {
      const idx = startIndex + chunks.length;
      chunks.push({
        id: `chunk-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 7)}`,
        index: idx,
        chapterTitle: baseChapterTitle
          ? `${baseChapterTitle} (Part ${subIndex})`
          : `Section ${idx + 1}`,
        chineseText: currentChunkText.trim(),
        englishText: "",
        charCount: countChineseCharacters(currentChunkText) || currentChunkText.length,
        status: "pending",
      });
      subIndex++;
      currentChunkText = "";
    }

    // If single paragraph is itself gigantic (> targetSize), split by sentences
    if (p.length > targetSize) {
      const sentences = p.split(/(?<=[。！？\.\!\?])\s*/);
      for (const s of sentences) {
        if (!s) continue;
        if (
          currentChunkText.length > 0 &&
          currentChunkText.length + s.length > targetSize
        ) {
          const idx = startIndex + chunks.length;
          chunks.push({
            id: `chunk-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 7)}`,
            index: idx,
            chapterTitle: baseChapterTitle
              ? `${baseChapterTitle} (Part ${subIndex})`
              : `Section ${idx + 1}`,
            chineseText: currentChunkText.trim(),
            englishText: "",
            charCount: countChineseCharacters(currentChunkText) || currentChunkText.length,
            status: "pending",
          });
          subIndex++;
          currentChunkText = "";
        }
        currentChunkText += (currentChunkText ? " " : "") + s;
      }
    } else {
      currentChunkText += (currentChunkText ? "\n\n" : "") + p;
    }
  }

  if (currentChunkText.trim()) {
    const idx = startIndex + chunks.length;
    chunks.push({
      id: `chunk-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 7)}`,
      index: idx,
      chapterTitle: baseChapterTitle
        ? subIndex > 1
          ? `${baseChapterTitle} (Part ${subIndex})`
          : baseChapterTitle
        : `Section ${idx + 1}`,
      chineseText: currentChunkText.trim(),
      englishText: "",
      charCount: countChineseCharacters(currentChunkText) || currentChunkText.length,
      status: "pending",
    });
  }

  return chunks;
}

/**
 * Main chunking function that takes raw Chinese text and outputs structured TextChunks.
 * Enforces strict 1:1 Chapter-to-Chunk mapping when splitByChapters is enabled.
 */
export function chunkChineseText(
  rawText: string,
  options: ChunkOptions = {}
): TextChunk[] {
  const targetSize = options.targetChunkChars || 2500;
  const splitByChapters = options.splitByChapters ?? true;

  if (!rawText || !rawText.trim()) {
    return [];
  }

  const cleanedText = rawText.replace(/^\uFEFF/, "").trimStart();

  // Check if text has chapter markers
  if (splitByChapters) {
    const matches = Array.from(cleanedText.matchAll(CHAPTER_REGEX));

    if (matches.length >= 2) {
      // Multiple chapters detected!
      const chunks: TextChunk[] = [];
      let currentIndex = 0;

      // Handle any text before the first chapter (e.g. prologue, novel title, or preamble)
      const firstMatchIndex = matches[0].index || 0;
      if (firstMatchIndex > 0) {
        const preamble = cleanedText.slice(0, firstMatchIndex).trim();
        if (preamble) {
          const lines = preamble.split(/\n+/).map((l) => l.trim()).filter(Boolean);
          let preambleTitle = "Prologue / Introduction";
          if (lines.length > 0 && lines[0].length < 60 && !/[.!?…。]$/.test(lines[0])) {
            preambleTitle = lines[0];
          }
          const preambleId = `chapter-preamble-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
          const subChunks =
            preamble.length > targetSize * 1.3
              ? splitTextIntoSubChunks(preamble, targetSize, preambleId)
              : undefined;

          chunks.push({
            id: preambleId,
            index: currentIndex,
            chapterTitle: preambleTitle,
            chineseText: preamble,
            englishText: "",
            charCount: countChineseCharacters(preamble) || preamble.length,
            status: "pending",
            subChunks: subChunks && subChunks.length > 1 ? subChunks : undefined,
          });
          currentIndex++;
        }
      }

      // Enforce strict 1:1 Chapter Mapping: Every original novel chapter produces EXACTLY ONE TextChunk
      for (let i = 0; i < matches.length; i++) {
        const match = matches[i];
        const chapterTitle = match[1].trim();
        const startPos = match.index! + match[0].length;
        const endPos =
          i < matches.length - 1 ? matches[i + 1].index! : cleanedText.length;

        const chapterContent = cleanedText.slice(startPos, endPos).trim();
        const fullChapterText = `${chapterTitle}\n\n${chapterContent}`;
        const chapterId = `chapter-${Date.now()}-${currentIndex}-${Math.random().toString(36).slice(2, 7)}`;

        let subChunks: SubChunkItem[] | undefined = undefined;
        // If chapter exceeds target size * 1.25, decompose into internal sub-chunks for translation
        if (fullChapterText.length > targetSize * 1.25) {
          subChunks = splitTextIntoSubChunks(fullChapterText, targetSize, chapterId);
        }

        chunks.push({
          id: chapterId,
          index: currentIndex,
          chapterTitle,
          chineseText: fullChapterText,
          englishText: "",
          charCount: countChineseCharacters(fullChapterText) || fullChapterText.length,
          status: "pending",
          subChunks: subChunks && subChunks.length > 1 ? subChunks : undefined,
        });
        currentIndex++;
      }

      return chunks;
    }
  }

  // Fallback: split continuous text into paragraph blocks
  return splitTextIntoParagraphChunks(rawText, targetSize, undefined, 0);
}

export interface ContinuityReport {
  hasGaps: boolean;
  continuousChunks: TextChunk[];
  allCompletedChunks: TextChunk[];
  missingChunks: TextChunk[];
  highestCompletedIndex: number;
  continuousWordCount: number;
  totalCompletedWordCount: number;
  contiguousFrontierIndex: number; // 0-indexed highest contiguous completed index (-1 if none)
  aheadCompletedCount: number; // Chunks completed beyond the contiguous frontier
}

/**
 * Returns strictly the contiguous sequence of completed chunks starting from chunk 1 (index 0).
 * If chunk 4 is incomplete, returns only chunks 1..3 regardless of whether 5 and 6 are completed.
 */
export function getContiguousCompletedChunks(chunks: TextChunk[]): TextChunk[] {
  // Always sort chunks strictly by index to guarantee correct order of pages/chapters
  const sortedChunks = [...chunks].sort((a, b) => a.index - b.index);
  const result: TextChunk[] = [];
  for (let i = 0; i < sortedChunks.length; i++) {
    const c = sortedChunks[i];
    if (c && c.status === "completed" && c.englishText && c.englishText.trim().length > 0) {
      result.push(c);
    } else {
      break; // Stop strictly at the first gap
    }
  }
  return result;
}

/**
 * Analyzes whether completed chapters form an unbroken continuous sequence from chapter 1,
 * or if parallel processing caused chapters ahead to finish while middle chapters are still loading.
 */
export function analyzeChunkContinuity(chunks: TextChunk[]): ContinuityReport {
  // Always work with sorted chunks strictly by index
  const sortedChunks = [...chunks].sort((a, b) => a.index - b.index);
  const continuousChunks = getContiguousCompletedChunks(sortedChunks);
  const contiguousFrontierIndex = continuousChunks.length > 0 ? continuousChunks.length - 1 : -1;

  const allCompletedChunks = sortedChunks.filter(
    (c) => c.status === "completed" && !!c.englishText?.trim()
  );

  if (allCompletedChunks.length === 0) {
    return {
      hasGaps: false,
      continuousChunks: [],
      allCompletedChunks: [],
      missingChunks: [],
      highestCompletedIndex: -1,
      continuousWordCount: 0,
      totalCompletedWordCount: 0,
      contiguousFrontierIndex: -1,
      aheadCompletedCount: 0,
    };
  }

  const highestCompletedIndex = Math.max(...allCompletedChunks.map((c) => c.index));
  const missingChunks: TextChunk[] = [];
  for (let i = 0; i <= highestCompletedIndex; i++) {
    const c = sortedChunks.find((ch) => ch.index === i);
    if (!c || c.status !== "completed" || !c.englishText?.trim()) {
      if (c) missingChunks.push(c);
    }
  }

  const continuousWordCount = continuousChunks.reduce(
    (acc, c) => acc + countEnglishWords(c.englishText),
    0
  );
  const totalCompletedWordCount = allCompletedChunks.reduce(
    (acc, c) => acc + countEnglishWords(c.englishText),
    0
  );

  const aheadCompletedCount = allCompletedChunks.filter(
    (c) => c.index > contiguousFrontierIndex
  ).length;

  return {
    hasGaps: missingChunks.length > 0,
    continuousChunks,
    allCompletedChunks,
    missingChunks,
    highestCompletedIndex,
    continuousWordCount,
    totalCompletedWordCount,
    contiguousFrontierIndex,
    aheadCompletedCount,
  };
}
