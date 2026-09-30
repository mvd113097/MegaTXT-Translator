import { TextChunk } from "../types";
import { isStubOrEmptyText } from "./chunkCleaner";

export interface ChapterIntegrityIssue {
  type:
    | "missing_chapter"
    | "duplicate_chapter"
    | "index_gap"
    | "subchunk_mismatch"
    | "overlap_detected"
    | "empty_content"
    | "title_anomaly";
  severity: "error" | "warning";
  chapterIndex?: number;
  chapterTitle?: string;
  expected?: string | number;
  actual?: string | number;
  message: string;
}

export interface ValidationResult {
  isValid: boolean;
  canExport: boolean;
  totalChapters: number;
  completedChapters: number;
  pendingChapters: number;
  errorChapters: number;
  issues: ChapterIntegrityIssue[];
  summary: string;
}

// Convert Chinese numerals (e.g., "五十三", "一百四十") to integer
const CHINESE_NUM_MAP: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
  百: 100,
  千: 1000,
  万: 10000,
};

export function parseChineseNumber(str: string): number | null {
  if (!str) return null;
  const trimmed = str.trim();
  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10);
  }

  let total = 0;
  let current = 0;
  let section = 0;

  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];
    const val = CHINESE_NUM_MAP[char];

    if (val === undefined) {
      continue;
    }

    if (val === 10000) {
      section = (section + (current || 1)) * 10000;
      total += section;
      section = 0;
      current = 0;
    } else if (val >= 10) {
      current = (current === 0 ? 1 : current) * val;
      section += current;
      current = 0;
    } else {
      current = val;
    }
  }

  section += current;
  total += section;

  return total > 0 ? total : null;
}

/**
 * Extracts the explicit numeric chapter number from a title.
 * Handles "第53章", "Chapter 53", "第140章", "第一百四十章", etc.
 */
export function extractChapterNumber(title?: string): number | null {
  if (!title) return null;

  // 1. Match "第 <number> 章/回/节/卷"
  const zhMatch = title.match(/第\s*([0-9零〇一二两三四五六七八九十百千万]+)\s*[章回节卷集部篇]/i);
  if (zhMatch) {
    const parsed = parseChineseNumber(zhMatch[1]);
    if (parsed !== null) return parsed;
  }

  // 2. Match "Chapter <number>"
  const enMatch = title.match(/Chapter\s*(\d+)/i);
  if (enMatch) {
    return parseInt(enMatch[1], 10);
  }

  // 3. Match leading numbers "53. " or "53 "
  const leadMatch = title.match(/^(\d+)[\s.:、]/);
  if (leadMatch) {
    return parseInt(leadMatch[1], 10);
  }

  return null;
}

/**
 * Automatic Chapter Integrity Validator
 * 
 * Verifies:
 * 1. Sequential chapter IDs and indices (0..N-1 contiguous unbroken range).
 * 2. Chapter title numbering sequence (catches skips like 53 -> 55, or duplicate 53).
 * 3. Sub-chunk merging order & completeness (for long chapters split internally).
 * 4. Cross-chapter overlap (detects duplicate sentences between adjacent chapters).
 * 5. Source coverage against original text (if provided).
 * 
 * If validation fails, flags/blocks export instead of silently altering content.
 */
export function validateChapterIntegrity(
  chunks: TextChunk[],
  originalSourceText?: string
): ValidationResult {
  const issues: ChapterIntegrityIssue[] = [];

  if (!chunks || chunks.length === 0) {
    return {
      isValid: false,
      canExport: false,
      totalChapters: 0,
      completedChapters: 0,
      pendingChapters: 0,
      errorChapters: 0,
      issues: [
        {
          type: "missing_chapter",
          severity: "error",
          message: "No chapters available in translation session.",
        },
      ],
      summary: "No chapters found.",
    };
  }

  const totalChapters = chunks.length;
  let completedChapters = 0;
  let pendingChapters = 0;
  let errorChapters = 0;

  // Sort strictly by index
  const sortedChunks = [...chunks].sort((a, b) => a.index - b.index);

  // 1. Index Continuity Check
  for (let i = 0; i < sortedChunks.length; i++) {
    const chunk = sortedChunks[i];
    if (chunk.status === "completed") completedChapters++;
    else if (chunk.status === "error") errorChapters++;
    else pendingChapters++;

    if (chunk.index !== i) {
      issues.push({
        type: "index_gap",
        severity: "error",
        chapterIndex: chunk.index,
        chapterTitle: chunk.chapterTitle,
        expected: i,
        actual: chunk.index,
        message: `Chapter index gap detected: Expected index ${i}, but found chunk with index ${chunk.index} ("${chunk.chapterTitle || "Untitled"}").`,
      });
    }
  }

  // 2. Chapter Title & Numbering Sequence Check
  let prevChapterNum: number | null = null;
  const seenChapterNumbers = new Map<number, number>(); // chapterNum -> chunk index

  for (let i = 0; i < sortedChunks.length; i++) {
    const chunk = sortedChunks[i];
    const chapterNum = extractChapterNumber(chunk.chapterTitle);

    if (chapterNum !== null) {
      if (seenChapterNumbers.has(chapterNum)) {
        const prevIndex = seenChapterNumbers.get(chapterNum)!;
        issues.push({
          type: "duplicate_chapter",
          severity: "error",
          chapterIndex: chunk.index,
          chapterTitle: chunk.chapterTitle,
          expected: `Unique Chapter ${chapterNum}`,
          actual: `Duplicate Chapter ${chapterNum} at indices ${prevIndex + 1} and ${chunk.index + 1}`,
          message: `Duplicate chapter detected: Chapter ${chapterNum} appears multiple times ("${chunk.chapterTitle}").`,
        });
      } else {
        seenChapterNumbers.set(chapterNum, chunk.index);
      }

      if (prevChapterNum !== null) {
        const diff = chapterNum - prevChapterNum;
        if (diff > 1) {
          issues.push({
            type: "missing_chapter",
            severity: "error",
            chapterIndex: chunk.index,
            chapterTitle: chunk.chapterTitle,
            expected: `Chapter ${prevChapterNum + 1}`,
            actual: `Chapter ${chapterNum}`,
            message: `Missing chapter(s) detected: Gap between Chapter ${prevChapterNum} and Chapter ${chapterNum} (missing Chapter ${prevChapterNum + 1}).`,
          });
        } else if (diff < 0) {
          issues.push({
            type: "title_anomaly",
            severity: "warning",
            chapterIndex: chunk.index,
            chapterTitle: chunk.chapterTitle,
            message: `Out-of-order chapter numbering: Chapter ${prevChapterNum} is followed by Chapter ${chapterNum}.`,
          });
        }
      }
      prevChapterNum = chapterNum;
    }
  }

  // 3. Sub-Chunk Merging Verification
  for (const chunk of sortedChunks) {
    if (chunk.subChunks && chunk.subChunks.length > 1) {
      const subChunks = chunk.subChunks;
      const unmergedParts: number[] = [];

      for (const sub of subChunks) {
        if (chunk.status === "completed") {
          if (!sub.englishText || !chunk.englishText.includes(sub.englishText.trim().slice(0, 40))) {
            unmergedParts.push(sub.subIndex + 1);
          }
        }
      }

      if (unmergedParts.length > 0 && chunk.status === "completed") {
        issues.push({
          type: "subchunk_mismatch",
          severity: "error",
          chapterIndex: chunk.index,
          chapterTitle: chunk.chapterTitle,
          message: `Internal sub-chunk merge mismatch in Chapter #${chunk.index + 1} ("${chunk.chapterTitle}"): Sub-chunks [${unmergedParts.join(", ")}] were not merged back into the chapter in complete sequential order.`,
        });
      }
    }
  }

  // 4. Cross-Chapter Boundary Overlap Check
  for (let i = 0; i < sortedChunks.length - 1; i++) {
    const cur = sortedChunks[i];
    const nxt = sortedChunks[i + 1];

    if (cur.chineseText && nxt.chineseText) {
      const curTail = cur.chineseText.trim().slice(-60);
      const nxtHead = nxt.chineseText.trim().slice(0, 60);

      // Check for substantial duplicate leakage
      if (curTail.length >= 30 && nxtHead.includes(curTail.slice(-30))) {
        issues.push({
          type: "overlap_detected",
          severity: "warning",
          chapterIndex: nxt.index,
          chapterTitle: nxt.chapterTitle,
          message: `Potential cross-chapter overlap detected between Chapter #${cur.index + 1} and #${nxt.index + 1}.`,
        });
      }
    }
  }

  // 5. Source Text Coverage (if raw original text is provided)
  if (originalSourceText && originalSourceText.trim()) {
    const rawMatches = Array.from(
      originalSourceText.matchAll(
        /(?:^|\n)\s*(第\s*[0-9零一二三四五六七八九十百千万]+\s*[章回节卷集部篇][^\n]*|Chapter\s+[0-9]+[^\n]*)/gi
      )
    );

    if (rawMatches.length > 0) {
      const rawCount = rawMatches.length;
      if (rawCount !== sortedChunks.length) {
        issues.push({
          type: "missing_chapter",
          severity: "error",
          expected: `${rawCount} chapters from original Chinese text`,
          actual: `${sortedChunks.length} chapters parsed`,
          message: `Source chapter count mismatch: Original Chinese novel contains ${rawCount} chapters, but ${sortedChunks.length} chapters were registered in the session.`,
        });
      }
    }
  }

  // 6. Stub or Corrupted Completed Chapters Check
  for (const chunk of sortedChunks) {
    if (chunk.status === "completed") {
      if (isStubOrEmptyText(chunk.englishText)) {
        issues.push({
          type: "empty_content",
          severity: "error",
          chapterIndex: chunk.index,
          chapterTitle: chunk.chapterTitle,
          message: `Chapter #${chunk.index + 1} ("${chunk.chapterTitle}") is marked completed but contains empty or stub text.`,
        });
      }
    }
  }

  const errorIssues = issues.filter((i) => i.severity === "error");
  const isValid = errorIssues.length === 0;
  const canExport = isValid && completedChapters > 0;

  let summary = `Integrity Verified: ${totalChapters} chapters validated in continuous 1:1 sequence.`;
  if (errorIssues.length > 0) {
    summary = `Integrity Issues Detected (${errorIssues.length} error(s)): ${errorIssues.map((e) => e.message).join("; ")}`;
  } else if (issues.length > 0) {
    summary = `Validation passed with ${issues.length} warning(s). All chapters mapped 1:1.`;
  }

  return {
    isValid,
    canExport,
    totalChapters,
    completedChapters,
    pendingChapters,
    errorChapters,
    issues,
    summary,
  };
}
