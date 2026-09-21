/**
 * Truncation & Summary Guard for Chinese-to-English Web Novel Translations.
 * Detects whether Gemini or an LLM cut off early, truncated due to output limits,
 * or substituted an action scene with a short prose summary.
 */

export interface QualityCheckResult {
  isFlagged: boolean;
  ratio: number;
  reason?: string;
  charCount: number;
  wordCount: number;
}

const SUMMARY_TRIGGER_PHRASES = [
  /\[?\s*chapter\s*summary\s*\]?/i,
  /\[?\s*summary\s*\]?/i,
  /\bin\s+summary\b/i,
  /\bthe\s+rest\s+of\s+the\s+chapter\s+(depicts|describes|details|tells)\b/i,
  /\bthis\s+chapter\s+(summarizes|describes\s+in\s+brief)\b/i,
  /\b\[?\s*content\s+truncated\s*\]?/i,
  /\bto\s+summarize\b/i,
  /\bthe\s+scene\s+concludes\s+with\s+a\s+summary\b/i,
];

export function checkTranslationQuality(
  chineseText: string,
  englishText: string | undefined
): QualityCheckResult {
  const cleanChinese = (chineseText || "").replace(/\s+/g, "");
  const charCount = cleanChinese.length;

  if (!englishText || !englishText.trim()) {
    return {
      isFlagged: false,
      ratio: 0,
      charCount,
      wordCount: 0,
    };
  }

  const words = englishText.trim().split(/\s+/).filter(Boolean);
  const wordCount = words.length;

  if (charCount === 0) {
    return {
      isFlagged: false,
      ratio: 1,
      charCount,
      wordCount,
    };
  }

  const ratio = wordCount / charCount;

  // 1. Check for obvious summary markers in English text
  for (const regex of SUMMARY_TRIGGER_PHRASES) {
    if (regex.test(englishText)) {
      return {
        isFlagged: true,
        ratio: Math.round(ratio * 100) / 100,
        reason: "Detected summary keyword in output",
        charCount,
        wordCount,
      };
    }
  }

  // 2. Check for abnormally low ratio on non-trivial chunks (e.g. >250 Chinese characters)
  // Standard Xianxia / Web novel ratio is 0.55 - 0.85 words per character.
  // Less than 0.38 indicates aggressive summarization or early token cut-off.
  if (charCount >= 250 && ratio < 0.38) {
    return {
      isFlagged: true,
      ratio: Math.round(ratio * 100) / 100,
      reason: `Low word ratio (${Math.round(ratio * 100)}% vs expected ~65%)`,
      charCount,
      wordCount,
    };
  }

  return {
    isFlagged: false,
    ratio: Math.round(ratio * 100) / 100,
    charCount,
    wordCount,
  };
}
