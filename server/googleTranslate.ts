import axios from "axios";

// In-memory cache for translated strings (survives across requests, fast 0ms resolution)
const googleTranslateCache = new Map<string, string>();
const MAX_CACHE_SIZE = 10000;

// In-memory cache for full translated chapters (0ms instant recall, 0 data consumption)
const googleChapterCache = new Map<string, string>();
const MAX_CHAPTER_CACHE_SIZE = 500;

/**
 * Check if text contains Chinese characters (CJK Unified Ideographs)
 */
export function hasChineseCharacters(text?: string): boolean {
  if (!text) return false;
  return /[\u4e00-\u9fa5]/.test(text);
}

/**
 * Server-side translation using Google Translate free web service (0 Gemini quota consumption)
 */
export async function translateWithGoogle(
  text: string,
  from: string = "zh-CN",
  to: string = "en",
  timeoutMs: number = 4000
): Promise<string> {
  if (!text || typeof text !== "string") return "";
  const trimmed = text.trim();
  if (!trimmed) return "";

  // If text has no Chinese characters and target is English, return directly
  if (!hasChineseCharacters(trimmed) && to === "en") {
    return trimmed;
  }

  const cacheKey = `${from}:${to}:${trimmed}`;
  if (googleTranslateCache.has(cacheKey)) {
    return googleTranslateCache.get(cacheKey)!;
  }

  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(
      from
    )}&tl=${encodeURIComponent(to)}&dt=t&q=${encodeURIComponent(trimmed)}`;

    const response = await axios.get(url, {
      timeout: timeoutMs,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        Accept: "*/*",
      },
    });

    if (Array.isArray(response.data) && Array.isArray(response.data[0])) {
      const translated = response.data[0]
        .map((segment: any) => (Array.isArray(segment) && segment[0] ? segment[0] : ""))
        .join("");

      if (translated && translated.trim()) {
        const result = translated.trim();
        googleTranslateCache.set(cacheKey, result);

        if (googleTranslateCache.size > MAX_CACHE_SIZE) {
          const firstKey = googleTranslateCache.keys().next().value;
          if (firstKey) googleTranslateCache.delete(firstKey);
        }

        return result;
      }
    }
  } catch (err: any) {
    // Graceful fallback on network glitch or timeout
  }

  return trimmed;
}

/**
 * Server-side full chapter translation using Google Translate free web service.
 * Chunks paragraphs into safe ~1200 character batches to avoid query parameter limits,
 * parallelizes requests, and caches the completed translation in memory.
 * Consumes 0 Gemini quota and 0 mobile data for the client.
 */
export async function translateChapterWithGoogle(
  content: string,
  from: string = "zh-CN",
  to: string = "en"
): Promise<string> {
  if (!content || typeof content !== "string") return "";
  const trimmed = content.trim();
  if (!trimmed) return "";
  if (!hasChineseCharacters(trimmed)) return trimmed;

  const cacheKey = `${from}:${to}:${trimmed.length}:${trimmed.slice(0, 80)}`;
  if (googleChapterCache.has(cacheKey)) {
    return googleChapterCache.get(cacheKey)!;
  }

  // Split into clean paragraphs
  const paragraphs = trimmed
    .split(/\r?\n+/)
    .map((p) => p.trim())
    .filter(Boolean);

  if (paragraphs.length === 0) return "";

  // Group paragraphs into batches of ~1200 characters each to avoid URL length restrictions
  const batches: string[] = [];
  let currentBatch: string[] = [];
  let currentBatchLen = 0;

  for (const p of paragraphs) {
    if (currentBatchLen + p.length > 1200 && currentBatch.length > 0) {
      batches.push(currentBatch.join("\n\n"));
      currentBatch = [p];
      currentBatchLen = p.length;
    } else {
      currentBatch.push(p);
      currentBatchLen += p.length + 2;
    }
  }
  if (currentBatch.length > 0) {
    batches.push(currentBatch.join("\n\n"));
  }

  // Translate batches in parallel (concurrency: 5)
  const translatedBatches: string[] = [];
  const BATCH_CONCURRENCY = 5;
  for (let i = 0; i < batches.length; i += BATCH_CONCURRENCY) {
    const chunk = batches.slice(i, i + BATCH_CONCURRENCY);
    const results = await Promise.allSettled(
      chunk.map((b) => translateWithGoogle(b, from, to, 5000))
    );
    for (let j = 0; j < chunk.length; j++) {
      const res = results[j];
      if (res.status === "fulfilled" && res.value && res.value.trim()) {
        translatedBatches.push(res.value.trim());
      } else {
        translatedBatches.push(chunk[j]); // fallback to original if batch fails
      }
    }
  }

  const translatedChapter = translatedBatches.join("\n\n");
  if (translatedChapter && translatedChapter.trim()) {
    googleChapterCache.set(cacheKey, translatedChapter);
    if (googleChapterCache.size > MAX_CHAPTER_CACHE_SIZE) {
      const first = googleChapterCache.keys().next().value;
      if (first) googleChapterCache.delete(first);
    }
    return translatedChapter;
  }

  return trimmed;
}

/**
 * Batch translate Explore items to populate English and Chinese fields
 * Mutates/enriches the items with:
 * - titleZh, authorZh, summaryZh (original Chinese)
 * - titleEn, authorEn, summaryEn (translated English)
 * - title, author, summary (defaulting to English)
 */
export async function translateExploreItemsInPlace(items: any[]): Promise<void> {
  if (!items || items.length === 0) return;

  const translationTasks: Array<() => Promise<void>> = [];

  for (const item of items) {
    // Preserve original Chinese text if not already saved
    if (!item.titleZh) item.titleZh = item.title || "";
    if (!item.authorZh) item.authorZh = item.author || "";
    if (!item.summaryZh) item.summaryZh = item.summary || "";

    // 1. Translate Title
    if (!item.titleEn) {
      translationTasks.push(async () => {
        try {
          if (hasChineseCharacters(item.titleZh)) {
            const translated = await translateWithGoogle(item.titleZh, "zh-CN", "en", 3500);
            item.titleEn = translated || item.titleZh;
          } else {
            item.titleEn = item.titleZh;
          }
          // Default title to English
          item.title = item.titleEn;
        } catch {
          item.titleEn = item.titleZh;
          item.title = item.titleZh;
        }
      });
    } else {
      item.title = item.titleEn;
    }

    // 2. Translate Author
    if (!item.authorEn) {
      translationTasks.push(async () => {
        try {
          if (hasChineseCharacters(item.authorZh)) {
            const translated = await translateWithGoogle(item.authorZh, "zh-CN", "en", 3000);
            item.authorEn = translated || item.authorZh;
          } else {
            item.authorEn = item.authorZh;
          }
          // Default author to English
          item.author = item.authorEn;
        } catch {
          item.authorEn = item.authorZh;
          item.author = item.authorZh;
        }
      });
    } else {
      item.author = item.authorEn;
    }

    // 3. Translate Summary
    if (!item.summaryEn) {
      translationTasks.push(async () => {
        try {
          if (hasChineseCharacters(item.summaryZh)) {
            // If summary is very long (> 1500 chars), take first 1200 chars for explore cards
            const textToTranslate = item.summaryZh.length > 1500 ? item.summaryZh.slice(0, 1500) : item.summaryZh;
            const translated = await translateWithGoogle(textToTranslate, "zh-CN", "en", 4000);
            item.summaryEn = translated || item.summaryZh;
          } else {
            item.summaryEn = item.summaryZh;
          }
          // Default summary to English
          item.summary = item.summaryEn;
        } catch {
          item.summaryEn = item.summaryZh;
          item.summary = item.summaryZh;
        }
      });
    } else {
      item.summary = item.summaryEn;
    }
  }

  // Execute in batches of 10 concurrently to avoid rate limits and keep response snappy
  const BATCH_SIZE = 10;
  for (let i = 0; i < translationTasks.length; i += BATCH_SIZE) {
    const batch = translationTasks.slice(i, i + BATCH_SIZE);
    await Promise.allSettled(batch.map((fn) => fn()));
  }
}
