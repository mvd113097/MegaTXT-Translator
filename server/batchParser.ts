export interface ParsedBatchChapter {
  id: string;
  index: number;
  englishText: string;
  isValid: boolean;
  errorReason?: string;
}

/** Configurable maximum Chinese character budget for safe batching (6,000–8,000 range) */
export const MAX_BATCH_CHAR_BUDGET = parseInt(process.env.MAX_BATCH_CHAR_BUDGET || "7000", 10);

/**
 * Strict machine-parseable batch response validator.
 * Validates that every expected chapter ID in a batch is returned exactly once
 * inside matching <<<CHAPTER_START id="...">>> and <<<CHAPTER_END id="...">>> markers.
 * 
 * Detects missing chapters, duplicated chapters, unclosed tags, truncated responses,
 * and empty content, enforcing partial batch recovery without losing validated chapters.
 */
export function parseAndValidateBatchResponse(
  rawResponseText: string,
  expectedChunks: Array<{ id: string; index: number; charCount?: number }>
): Map<string, ParsedBatchChapter> {
  const results = new Map<string, ParsedBatchChapter>();
  const occurrences = new Map<string, number>();

  if (!rawResponseText || !rawResponseText.trim()) {
    for (const exp of expectedChunks) {
      results.set(exp.id, {
        id: exp.id,
        index: exp.index,
        englishText: "",
        isValid: false,
        errorReason: "API response text was empty",
      });
    }
    return results;
  }

  // Regex to match <<<CHAPTER_START id="XXX" (optional index=YYY)>>>
  const startRegex = /<<<CHAPTER_START\s+id=["']([^"']+)["'](?:\s+index=(\d+))?[^>]*>>>/g;
  let match: RegExpExecArray | null;

  while ((match = startRegex.exec(rawResponseText)) !== null) {
    const id = match[1];
    const parsedIdx = match[2] ? parseInt(match[2], 10) : 0;
    occurrences.set(id, (occurrences.get(id) || 0) + 1);

    const startIndex = match.index + match[0].length;
    const endTagPattern = `<<<CHAPTER_END\\s+id=["']${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']>>>`;
    const endRegex = new RegExp(endTagPattern, "g");
    endRegex.lastIndex = startIndex;
    const endMatch = endRegex.exec(rawResponseText);

    if (!endMatch) {
      // Unclosed marker or truncated response!
      results.set(id, {
        id,
        index: parsedIdx,
        englishText: "",
        isValid: false,
        errorReason: "Unclosed chapter marker or truncated response (missing CHAPTER_END tag)",
      });
      continue;
    }

    const englishContent = rawResponseText.slice(startIndex, endMatch.index).trim();
    let isValid = true;
    let errorReason: string | undefined = undefined;

    if (!englishContent) {
      isValid = false;
      errorReason = "Empty translation content returned for chapter";
    }

    results.set(id, {
      id,
      index: parsedIdx,
      englishText: englishContent,
      isValid,
      errorReason,
    });
  }

  // Single chunk fallback if no markers were returned but clean non-empty text exists
  if (expectedChunks.length === 1 && occurrences.size === 0) {
    const single = expectedChunks[0];
    const cleanText = rawResponseText.trim();
    if (cleanText && !cleanText.includes("<<<CHAPTER_")) {
      results.set(single.id, {
        id: single.id,
        index: single.index,
        englishText: cleanText,
        isValid: true,
      });
      return results;
    }
  }

  // Validate all expected chunks
  for (const exp of expectedChunks) {
    const parsed = results.get(exp.id);
    const count = occurrences.get(exp.id) || 0;

    if (count === 0) {
      results.set(exp.id, {
        id: exp.id,
        index: exp.index,
        englishText: "",
        isValid: false,
        errorReason: "Chapter marker missing from API response",
      });
    } else if (count > 1) {
      // Duplicate chapter detection!
      results.set(exp.id, {
        id: exp.id,
        index: exp.index,
        englishText: "",
        isValid: false,
        errorReason: `Duplicate chapter marker detected (${count} times) in API response`,
      });
    } else if (parsed && !parsed.isValid) {
      // Already marked invalid above
    }
  }

  return results;
}
