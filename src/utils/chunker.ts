import { TextChunk } from "../types";

export interface ChunkOptions {
  targetChunkChars?: number; // default ~2500 characters
  splitByChapters?: boolean;
}

// Regex to detect common Chinese novel chapter headings
const CHAPTER_REGEX =
  /(?:^|\n)\s*(第[0-9零一二三四五六七八九十百千万]+[章回节卷集部篇][^\n]*|Chapter\s+[0-9]+[^\n]*)/gi;

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
 * Main chunking function that takes raw Chinese text and outputs structured TextChunks
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

  // Check if text has chapter markers
  if (splitByChapters) {
    const matches = Array.from(rawText.matchAll(CHAPTER_REGEX));

    if (matches.length >= 2) {
      // Multiple chapters detected!
      const chunks: TextChunk[] = [];
      let currentIndex = 0;

      // Handle any text before the first chapter (e.g. prologue or title)
      const firstMatchIndex = matches[0].index || 0;
      if (firstMatchIndex > 0) {
        const prologue = rawText.slice(0, firstMatchIndex).trim();
        if (prologue) {
          const subChunks = splitTextIntoParagraphChunks(
            prologue,
            targetSize,
            "Prologue / Introduction",
            currentIndex
          );
          chunks.push(...subChunks);
          currentIndex = chunks.length;
        }
      }

      if (targetSize >= 5000) {
        // High-Volume Free Tier Macro-Chunking: combine adjacent short chapters up to targetSize
        let bufferText = "";
        let bufferTitles: string[] = [];

        for (let i = 0; i < matches.length; i++) {
          const match = matches[i];
          const chapterTitle = match[1].trim();
          const startPos = match.index! + match[0].length;
          const endPos =
            i < matches.length - 1 ? matches[i + 1].index! : rawText.length;
          const chapterContent = rawText.slice(startPos, endPos).trim();
          const fullChapterText = `${chapterTitle}\n\n${chapterContent}`;

          if (bufferText && bufferText.length + fullChapterText.length > targetSize * 1.15) {
            // Flush current buffer
            const combinedTitle =
              bufferTitles.length > 1
                ? `${bufferTitles[0]} – ${bufferTitles[bufferTitles.length - 1]}`
                : bufferTitles[0] || `Section ${currentIndex + 1}`;

            chunks.push({
              id: `chunk-${Date.now()}-${currentIndex}-${Math.random().toString(36).slice(2, 7)}`,
              index: currentIndex,
              chapterTitle: combinedTitle,
              chineseText: bufferText.trim(),
              englishText: "",
              charCount: countChineseCharacters(bufferText) || bufferText.length,
              status: "pending",
            });
            currentIndex++;
            bufferText = "";
            bufferTitles = [];
          }

          if (fullChapterText.length > targetSize * 1.3) {
            // Chapter is uniquely massive, split with paragraph splitter
            const subChunks = splitTextIntoParagraphChunks(
              fullChapterText,
              targetSize,
              chapterTitle,
              currentIndex
            );
            chunks.push(...subChunks);
            currentIndex = chunks.length;
          } else {
            bufferText += (bufferText ? "\n\n\n" : "") + fullChapterText;
            bufferTitles.push(chapterTitle);
          }
        }

        if (bufferText.trim()) {
          const combinedTitle =
            bufferTitles.length > 1
              ? `${bufferTitles[0]} – ${bufferTitles[bufferTitles.length - 1]}`
              : bufferTitles[0] || `Section ${currentIndex + 1}`;

          chunks.push({
            id: `chunk-${Date.now()}-${currentIndex}-${Math.random().toString(36).slice(2, 7)}`,
            index: currentIndex,
            chapterTitle: combinedTitle,
            chineseText: bufferText.trim(),
            englishText: "",
            charCount: countChineseCharacters(bufferText) || bufferText.length,
            status: "pending",
          });
        }

        return chunks;
      }

      for (let i = 0; i < matches.length; i++) {
        const match = matches[i];
        const chapterTitle = match[1].trim();
        const startPos = match.index! + match[0].length;
        const endPos =
          i < matches.length - 1 ? matches[i + 1].index! : rawText.length;

        const chapterContent = rawText.slice(startPos, endPos).trim();
        const fullChapterText = `${chapterTitle}\n\n${chapterContent}`;

        if (fullChapterText.length <= targetSize * 1.3) {
          // Chapter fits nicely in one chunk
          chunks.push({
            id: `chunk-${Date.now()}-${currentIndex}-${Math.random().toString(36).slice(2, 7)}`,
            index: currentIndex,
            chapterTitle,
            chineseText: fullChapterText,
            englishText: "",
            charCount: countChineseCharacters(fullChapterText) || fullChapterText.length,
            status: "pending",
          });
          currentIndex++;
        } else {
          // Chapter is long, split sub-chunks
          const subChunks = splitTextIntoParagraphChunks(
            fullChapterText,
            targetSize,
            chapterTitle,
            currentIndex
          );
          chunks.push(...subChunks);
          currentIndex = chunks.length;
        }
      }

      return chunks;
    }
  }

  // Fallback: split by paragraph blocks
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
  const result: TextChunk[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
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
  const continuousChunks = getContiguousCompletedChunks(chunks);
  const contiguousFrontierIndex = continuousChunks.length > 0 ? continuousChunks.length - 1 : -1;

  const allCompletedChunks = chunks.filter(
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
    const c = chunks[i];
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
