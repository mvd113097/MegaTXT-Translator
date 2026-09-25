export interface ParsedBatchChapter {
  id: string;
  index: number;
  englishText: string;
  isValid: boolean;
  errorReason?: string;
}

/** Configurable maximum Chinese character budget for safe batching (7,000–10,000 range) */
export const MAX_BATCH_CHAR_BUDGET = parseInt(process.env.MAX_BATCH_CHAR_BUDGET || "9000", 10);

/**
 * Groups adjacent pending chunks into batches up to maxBudget Chinese characters.
 * Large chapters exceeding the budget remain in their own independent single-chunk batch.
 */
export function groupChunksIntoBatches<T extends { id: string; index: number; charCount?: number; chineseText: string }>(
  chunks: T[],
  inFlightIds: Set<string> = new Set(),
  maxBudget: number = MAX_BATCH_CHAR_BUDGET,
  maxItemsPerBatch: number = 5
): T[][] {
  const batches: T[][] = [];
  const claimed = new Set<string>();

  for (let i = 0; i < chunks.length; i++) {
    const first = chunks[i];
    if (inFlightIds.has(first.id) || claimed.has(first.id)) {
      continue;
    }

    const currentBatch = [first];
    claimed.add(first.id);
    let currentChars = first.chineseText.length;

    // Expand batch with contiguous adjacent chunks up to budget
    for (let j = i + 1; j < chunks.length; j++) {
      const next = chunks[j];
      if (next.index !== chunks[j - 1].index + 1) {
        break; // Must be contiguous
      }
      if (inFlightIds.has(next.id) || claimed.has(next.id)) {
        break;
      }
      const len = next.chineseText.length;
      if (currentChars + len > maxBudget) {
        break; // Respect max character budget
      }
      if (currentBatch.length >= maxItemsPerBatch) {
        break;
      }

      currentBatch.push(next);
      claimed.add(next.id);
      currentChars += len;
    }

    batches.push(currentBatch);
  }

  return batches;
}

/**
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

  // Regex to match <<<CHAPTER_START id="XXX" (optional index=YYY)>>> or <<<CHAPTER_START index=YYY id="XXX">>>
  // with or without quotes
  const startRegex = /<<<CHAPTER_START\s+(?:id=["']?([^"'\s>]+)["']?)?(?:\s*index=["']?(\d+)["']?)?[^>]*>>>/gi;
  let match: RegExpExecArray | null;

  while ((match = startRegex.exec(rawResponseText)) !== null) {
    let id = match[1];
    const parsedIdx = match[2] ? parseInt(match[2], 10) : 0;

    // If id was empty or numeric index was passed, find corresponding expected chunk
    if (!id && parsedIdx > 0) {
      const matchedExp = expectedChunks.find((e) => e.index === parsedIdx);
      if (matchedExp) id = matchedExp.id;
    }

    if (!id) continue;
    occurrences.set(id, (occurrences.get(id) || 0) + 1);

    const startIndex = match.index + match[0].length;
    // Look for CHAPTER_END with either id or index
    const endTagPattern = `<<<CHAPTER_END(?:\\s+id=["']?${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']?|\\s+index=["']?${parsedIdx}["']?)?[^>]*>>>`;
    const endRegex = new RegExp(endTagPattern, "i");
    const restText = rawResponseText.slice(startIndex);
    const endMatch = endRegex.exec(restText);

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

    const englishContent = restText.slice(0, endMatch.index).trim();
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
