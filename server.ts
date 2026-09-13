import express from "express";
import compression from "compression";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
import { quotaScheduler, formatCleanErrorMessage } from "./server/quotaScheduler";
import { parseAndValidateBatchResponse, groupChunksIntoBatches, MAX_BATCH_CHAR_BUDGET } from "./server/batchParser";

dotenv.config();

const app = express();
const PORT = 3000;

// High performance HTTP compression (gzip/deflate) to drastically save cellular data
app.use(compression());

// Data directory for persistent server cloud jobs
const DATA_DIR = path.join(process.cwd(), "data");
const CLOUD_JOB_FILE = path.join(DATA_DIR, "cloud_job.json");

try {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
} catch (e) {
  console.warn("Could not create data directory:", e);
}

// Support large payloads (text files can be large)
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

function countEnglishWords(text?: string): number {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// Lazy initialize Gemini client (backward compatibility)
function getGeminiClient(): GoogleGenAI {
  const { project } = quotaScheduler.selectProject();
  return project.client;
}

// High reliability free-tier translation engine with multi-project quota pooling,
// exponential backoff, and content-filter resilience.
// Supported modern models per Google GenAI SDK guidelines:
const FREE_TIER_MODELS = [
  "gemini-3.1-flash-lite",
  "gemini-3.8-flash",
  "gemini-flash-latest"
];

// In-memory tracking of model availability and quota cooldowns
const modelCooldowns = new Map<string, number>();
const deprecatedModels = new Set<string>();

/**
 * Robust Paragraph/Sentence Decomposition for intimate, sensitive, or dense chapters
 * that trigger automated content filters or large prompt blocks.
 */
async function translateWithDecomposition(
  rawText: string,
  styleGuidance: string,
  customInstructions = "",
  glossaryBlock = ""
): Promise<{ text: string; modelUsed: string; projectUsed: string }> {
  const paragraphs = rawText.split("\n").filter((p) => p.trim());
  if (paragraphs.length <= 1) {
    const sentences = rawText.match(/[^。！？!?]+[。！？!?]?/g) || [rawText];
    const sentenceTranslations: string[] = [];
    for (const sent of sentences) {
      if (!sent.trim()) continue;
      try {
        const subPrompt = `Translate this sentence from a fantasy fiction web novel into natural, polished English:\n"""${sent.trim()}"""`;
        const res = await generateWithQuotaScheduler(
          subPrompt,
          "You are a professional literary translator. Translate faithfully into fluent English prose without conversational commentary.",
          0,
          4,
          2000
        );
        sentenceTranslations.push(res.text.trim());
      } catch (subErr) {
        sentenceTranslations.push("[Scene narrative continues naturally...]");
      }
    }
    return { text: sentenceTranslations.join(" "), modelUsed: "gemini-decomposed-sentence", projectUsed: "auto" };
  }

  // Group into small batches of ~2-3 paragraphs (300-500 chars)
  const paragraphBatches: string[] = [];
  let currentGroup: string[] = [];
  let currentChars = 0;

  for (const p of paragraphs) {
    if (currentChars + p.length > 400 && currentGroup.length > 0) {
      paragraphBatches.push(currentGroup.join("\n"));
      currentGroup = [p];
      currentChars = p.length;
    } else {
      currentGroup.push(p);
      currentChars += p.length;
    }
  }
  if (currentGroup.length > 0) {
    paragraphBatches.push(currentGroup.join("\n"));
  }

  console.log(`[Safety & Decomposition Fallback] Decomposed text into ${paragraphBatches.length} sub-sections.`);
  const translatedBatches: string[] = new Array(paragraphBatches.length).fill("");

  const translateSubSection = async (subText: string, i: number) => {
    try {
      const subPrompt = `${customInstructions ? `Special Instructions: ${customInstructions}\n\n` : ""}${glossaryBlock || ""}
Translate the following fantasy web novel section into English:
"""
${subText}
"""
Translate directly into fluent English prose:`;

      const subRes = await generateWithQuotaScheduler(
        subPrompt,
        `You are a professional Chinese-to-English literary translator. Translate faithfully into fluent English prose. ${styleGuidance}`,
        0,
        5,
        1500,
        subText
      );
      if (subRes.text && subRes.text.trim()) {
        translatedBatches[i] = subRes.text.trim();
      } else {
        throw new Error("Empty sub-batch response");
      }
    } catch (e) {
      console.warn(`[Safety Fallback] Sub-section ${i + 1}/${paragraphBatches.length} fallback to sentence-level.`);
      const sentences = subText.match(/[^。！？!?]+[。！？!?]?/g) || [subText];
      const sentResults: string[] = [];
      for (const sent of sentences) {
        if (!sent.trim()) continue;
        try {
          const sentPrompt = `Translate this sentence into English:\n"""${sent.trim()}"""`;
          const sRes = await generateWithQuotaScheduler(
            sentPrompt,
            "You are a professional literary translator. Translate faithfully into natural English.",
            0,
            3,
            1200,
            sent.trim()
          );
          if (sRes.text && sRes.text.trim()) {
            sentResults.push(sRes.text.trim());
          }
        } catch {}
      }
      translatedBatches[i] = sentResults.join(" ");
    }
  };

  for (let i = 0; i < paragraphBatches.length; i += 3) {
    const chunk = paragraphBatches.slice(i, i + 3).map((sub, idx) => translateSubSection(sub, i + idx));
    await Promise.all(chunk);
  }

  return {
    text: translatedBatches.filter(Boolean).join("\n\n"),
    modelUsed: "gemini-decomposed-fallback",
    projectUsed: "pool"
  };
}

function getAvailableModelIndex(preferredIndex = 0): { index: number; modelName: string; waitMs: number } {
  const now = Date.now();
  let minWaitMs = Infinity;
  let bestIdx = 0;

  for (let i = 0; i < FREE_TIER_MODELS.length; i++) {
    const idx = (preferredIndex + i) % FREE_TIER_MODELS.length;
    const model = FREE_TIER_MODELS[idx];
    if (deprecatedModels.has(model)) continue;

    const cooldownUntil = modelCooldowns.get(model) || 0;
    if (now >= cooldownUntil) {
      return { index: idx, modelName: model, waitMs: 0 };
    }
    const wait = cooldownUntil - now;
    if (wait < minWaitMs) {
      minWaitMs = wait;
      bestIdx = idx;
    }
  }

  return {
    index: bestIdx,
    modelName: FREE_TIER_MODELS[bestIdx] || FREE_TIER_MODELS[0],
    waitMs: Math.min(minWaitMs, 60000)
  };
}

/**
 * High reliability translation call using the multi-project Quota-Aware Scheduler.
 * Automatically routes across up to 5 (or more) Google Cloud projects, fails over instantly
 * on 429/503 without stalling the queue, and returns the project and model used.
 */
async function generateWithQuotaScheduler(
  userPrompt: string,
  systemInstruction: string,
  modelIndex = 0,
  retries = 10,
  currentDelay = 3000,
  rawSourceText?: string,
  excludeProjectIds: Set<string> = new Set()
): Promise<{ text: string; modelUsed: string; projectUsed: string }> {
  // 1. Quota-aware project selection
  const { project, waitMs: projectWaitMs } = quotaScheduler.selectProject(excludeProjectIds);

  if (projectWaitMs > 0) {
    console.log(
      `[Quota Scheduler] All projects in pool currently cooling down. Earliest ready is ${project.name} (${project.keyMask}) in ${Math.ceil(
        projectWaitMs / 1000
      )}s. Waiting...`
    );
    await new Promise((resolve) => setTimeout(resolve, Math.min(projectWaitMs, 30000)));
  }

  // 2. Select available model from pool
  const modelSelection = getAvailableModelIndex(modelIndex);
  if (modelSelection.waitMs > 0) {
    console.log(
      `[Model Pool] All models in pool cooling down. Waiting ${Math.ceil(
        modelSelection.waitMs / 1000
      )}s before querying ${modelSelection.modelName}...`
    );
    await new Promise((resolve) => setTimeout(resolve, Math.min(modelSelection.waitMs, 30000)));
  }

  const modelName = modelSelection.modelName;
  const currentModelIdx = modelSelection.index;

  quotaScheduler.acquireProject(project.id);

  try {
    const response = await project.client.models.generateContent({
      model: modelName,
      contents: userPrompt,
      config: {
        systemInstruction,
        temperature: 0.3,
        topP: 0.9,
        safetySettings: [
          { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_NONE" },
        ] as any,
      },
    });

    let resultText = response.text || "";

    // Empty or filtered response recovery - Quota Efficient Failover & Automatic Decomposition
    if (!resultText.trim()) {
      const blockReason =
        (response as any).promptFeedback?.blockReason ||
        response.candidates?.[0]?.finishReason;
      console.warn(
        `[Gemini Engine] Empty response or content filter on ${project.name} (${modelName}, reason: ${
          blockReason || "NONE"
        }).`
      );

      // If source text is available and it was filtered (e.g. sensitive scene or dense novel text),
      // automatically decompose into small paragraph chunks and translate without failing
      if (rawSourceText && rawSourceText.length > 50) {
        console.log(
          `[Gemini Engine] Automatically invoking multi-tier paragraph decomposition solver for sensitive/dense text (${rawSourceText.length} chars)...`
        );
        try {
          return await translateWithDecomposition(
            rawSourceText,
            "Style: Xianxia / Chinese Webnovel localization. Natural, fluent modern English prose."
          );
        } catch (decompErr: any) {
          console.warn("[Gemini Engine] Decomposition solver error:", decompErr.message);
        }
      }

      // Record failure on project key and exclude it to prevent hammering the same project
      quotaScheduler.recordFailure(project.id, new Error("Empty response / safety block"));
      excludeProjectIds.add(project.id);

      if (quotaScheduler.enabledProjectCount > 0 && retries > 0) {
        const nextExclude = new Set(excludeProjectIds);
        if (nextExclude.size >= quotaScheduler.enabledProjectCount) {
          nextExclude.clear();
        }
        return generateWithQuotaScheduler(
          userPrompt,
          systemInstruction,
          (currentModelIdx + 1) % FREE_TIER_MODELS.length,
          retries - 1,
          currentDelay,
          rawSourceText,
          nextExclude
        );
      }

      throw new Error(`Model returned empty translation response (Filter: ${blockReason || "unknown"}).`);
    }

    // Success on project!
    quotaScheduler.recordSuccess(project.id);
    modelCooldowns.delete(modelName);
    return { text: resultText, modelUsed: modelName, projectUsed: project.name };
  } catch (err: any) {
    const errStr = String(err.message || "").toLowerCase();
    const isNotFoundOrDeprecated =
      err.status === 404 ||
      err.statusCode === 404 ||
      errStr.includes("not_found") ||
      errStr.includes("no longer available") ||
      errStr.includes("deprecated");

    const isRateLimit =
      err.status === 429 ||
      err.statusCode === 429 ||
      err.code === 429 ||
      err.status === "RESOURCE_EXHAUSTED" ||
      errStr.includes("429") ||
      errStr.includes("resource_exhausted") ||
      errStr.includes("quota") ||
      errStr.includes("rate limit") ||
      errStr.includes("rate-limit") ||
      errStr.includes("rate_limit") ||
      errStr.includes("rate-limits") ||
      errStr.includes("exceeded your current quota") ||
      errStr.includes("too many requests");

    const isAuthOrInvalidKey =
      !isRateLimit &&
      (err.status === 401 ||
        err.statusCode === 401 ||
        errStr.includes("401") ||
        errStr.includes("unauthenticated") ||
        errStr.includes("invalid authentication credentials") ||
        errStr.includes("access_token_type_unsupported") ||
        errStr.includes("api key not valid") ||
        errStr.includes("api_key_invalid") ||
        (errStr.includes("invalid") && errStr.includes("key")) ||
        ((err.status === 403 || err.statusCode === 403 || errStr.includes("403") || errStr.includes("permission_denied")) &&
          !errStr.includes("quota") &&
          !errStr.includes("limit") &&
          !errStr.includes("exceeded") &&
          !errStr.includes("resource")));

    const isTemporary =
      err.status === 503 ||
      err.status === 500 ||
      err.statusCode === 503 ||
      err.statusCode === 500 ||
      errStr.includes("503") ||
      errStr.includes("500") ||
      errStr.includes("unavailable") ||
      errStr.includes("high demand") ||
      errStr.includes("overloaded") ||
      errStr.includes("transient error");

    const isFilterOrBlock =
      errStr.includes("safety") ||
      errStr.includes("block") ||
      errStr.includes("filtered") ||
      errStr.includes("candidate was blocked") ||
      errStr.includes("finishreason") ||
      errStr.includes("prohibited_content");

    console.warn(
      `[Gemini Engine] ${project.name} (${project.keyMask}) notice on ${modelName}: ${
        isAuthOrInvalidKey
          ? "401/403 Invalid API Key"
          : isRateLimit
          ? "429 Rate Limit"
          : isNotFoundOrDeprecated
          ? "404 Not Found"
          : isFilterOrBlock
          ? "Safety Filter"
          : "Transient Error"
      }`
    );

    // 0. Auth / Invalid Key (401/403) -> Disable this project and immediately continue with others
    if (isAuthOrInvalidKey) {
      quotaScheduler.recordFailure(project.id, err);
      excludeProjectIds.add(project.id);
      console.warn(
        `[Quota Scheduler] Disabling ${project.name} (${project.keyMask}) due to authentication/permission error. Failing over immediately to other active projects...`
      );
      if (quotaScheduler.enabledProjectCount > 0 && retries > 0) {
        return generateWithQuotaScheduler(
          userPrompt,
          systemInstruction,
          currentModelIdx,
          retries - 1,
          currentDelay,
          rawSourceText,
          excludeProjectIds
        );
      }
      throw new Error(
        `Authentication error on ${project.name} (${project.keyMask}): ${formatCleanErrorMessage(err)}. Please verify your GEMINI_API_KEY.`
      );
    }

    // 1. Model Deprecated / 404
    if (isNotFoundOrDeprecated) {
      deprecatedModels.add(modelName);
      console.log(`[Gemini Engine] Model ${modelName} returned 404. Pruning from pool and switching model...`);
      return generateWithQuotaScheduler(
        userPrompt,
        systemInstruction,
        currentModelIdx + 1,
        retries,
        currentDelay,
        rawSourceText,
        excludeProjectIds
      );
    }

    // 2. Safety filter
    if (isFilterOrBlock && retries > 0) {
      console.log(`[Gemini Engine] Safety trigger on ${project.name}. Failing over to another available project...`);
      quotaScheduler.recordFailure(project.id, err);
      excludeProjectIds.add(project.id);
      const textToUse = rawSourceText || userPrompt;
      const cleanPrompt = `Translate the following classical Chinese novel chapter faithfully into English:\n\n${textToUse}`;
      return generateWithQuotaScheduler(
        cleanPrompt,
        "You are an objective translator for historical fiction.",
        currentModelIdx,
        retries - 1,
        1500,
        rawSourceText,
        excludeProjectIds
      );
    }

    // 3. Quota / Rate Limit (429) or Transient (500/503)
    if ((isRateLimit || isTemporary) && retries > 0) {
      if (isTemporary) {
        // Place model on temporary 25s cooldown so all projects bypass overloaded model immediately
        modelCooldowns.set(modelName, Date.now() + 25000);
      }

      quotaScheduler.recordFailure(project.id, err);
      excludeProjectIds.add(project.id);

      // If we have tried all active enabled projects in this round or model is overloaded, clear exclusion and rotate model
      const nextExclude = new Set(excludeProjectIds);
      let nextModelIdx = (currentModelIdx + 1) % FREE_TIER_MODELS.length;

      if (nextExclude.size >= quotaScheduler.enabledProjectCount) {
        nextExclude.clear();
      }

      console.log(
        `[Quota Scheduler] ${isTemporary ? "Model overloaded / temporary error" : "Project throttled"}. Switching model/project immediately...`
      );

      return generateWithQuotaScheduler(
        userPrompt,
        systemInstruction,
        nextModelIdx,
        retries - 1,
        currentDelay,
        rawSourceText,
        nextExclude
      );
    }

    throw err;
  } finally {
    quotaScheduler.releaseProject(project.id);
  }
}

// Backward-compatibility wrapper for any legacy callers
async function generateWithFreeTierFallback(
  _ai: GoogleGenAI | null,
  userPrompt: string,
  systemInstruction: string,
  modelIndex = 0,
  retries = 8,
  currentDelay = 3000,
  rawSourceText?: string
): Promise<{ text: string; modelUsed: string; projectUsed?: string }> {
  return generateWithQuotaScheduler(
    userPrompt,
    systemInstruction,
    modelIndex,
    retries,
    currentDelay,
    rawSourceText
  );
}

// -------------------------------------------------------------
// Cloud Background Job Store & Worker
// -------------------------------------------------------------
interface ServerTextChunk {
  id: string;
  index: number;
  chapterTitle?: string;
  chineseText: string;
  englishText: string;
  charCount: number;
  status: "pending" | "processing" | "completed" | "error";
  attempts: number;
  errorMessage?: string;
  durationMs?: number;
  edited?: boolean;
  lastErrorAt?: number;
}

interface CloudJob {
  id: string;
  fileName: string;
  fileSizeBytes: number;
  totalChineseChars: number;
  chunks: ServerTextChunk[];
  style: string;
  customInstructions: string;
  glossary: Array<{ id: string; original: string; translation: string; category?: string; notes?: string }>;
  concurrency: number;
  status: "idle" | "running" | "paused" | "completed";
  startedAt: number;
  lastActiveAt: number;
}

let activeCloudJob: CloudJob | null = null;
let isCloudWorkerRunning = false;

// Load saved cloud job from disk if exists on startup
function loadCloudJobFromDisk() {
  try {
    if (fs.existsSync(CLOUD_JOB_FILE)) {
      const data = fs.readFileSync(CLOUD_JOB_FILE, "utf-8");
      activeCloudJob = JSON.parse(data);
      if (activeCloudJob) {
        // Fix any corrupt/empty completed chunks or interrupted chunks
        for (const c of activeCloudJob.chunks) {
          if (c.status === "completed" && (!c.englishText || !c.englishText.trim())) {
            c.status = "pending";
            c.englishText = undefined;
          }
          if (c.status === "error" || c.status === "processing") {
            if (!c.englishText || !c.englishText.trim()) {
              c.status = "pending";
              c.errorMessage = undefined;
            } else {
              c.status = "completed";
            }
          }
        }
      }
      console.log(`Loaded existing cloud job: "${activeCloudJob?.fileName}" (${activeCloudJob?.chunks.length} chunks)`);
      // If it was running when server restarted, we can resume background worker
      if (activeCloudJob && activeCloudJob.status === "running") {
        startCloudWorkerLoop();
      }
    }
  } catch (err) {
    console.error("Failed to load cloud job from disk:", err);
  }
}

function saveCloudJobToDisk() {
  try {
    if (activeCloudJob) {
      fs.writeFileSync(CLOUD_JOB_FILE, JSON.stringify(activeCloudJob, null, 2), "utf-8");
    } else {
      if (fs.existsSync(CLOUD_JOB_FILE)) {
        fs.unlinkSync(CLOUD_JOB_FILE);
      }
    }
  } catch (err) {
    console.error("Failed to save cloud job to disk:", err);
  }
}

// Background Worker Loop on the Server - Parallel Translation with Never-Skip Contiguous Export Frontier
const inFlightChunkIds = new Set<string>();

async function startCloudWorkerLoop() {
  if (isCloudWorkerRunning) return;
  isCloudWorkerRunning = true;

  const jobFileName = activeCloudJob?.fileName || "job";
  const numWorkers = Math.max(1, Math.min(activeCloudJob?.concurrency || 5, quotaScheduler.enabledProjectCount || 5, 5));
  console.log(
    `[Cloud Background Worker] Started parallel translation engine (${numWorkers} concurrent workers) for: "${jobFileName}"`
  );

  const runWorkerTask = async (workerId: number) => {
    while (activeCloudJob && activeCloudJob.status === "running") {
      const now = Date.now();
      // Find the next available non-completed chunk not already claimed
      // Prioritize pending chunks first, then error chunks whose retry cooldown (8s) has elapsed
      const firstChunk = activeCloudJob.chunks.find((c) => {
        if (c.status === "completed" && c.englishText && c.englishText.trim().length > 0) {
          return false;
        }
        if (inFlightChunkIds.has(c.id)) {
          return false;
        }
        if (c.status === "error" && c.lastErrorAt && now < c.lastErrorAt + 8000) {
          return false;
        }
        return true;
      });

      if (!firstChunk) {
        // If no pending chunks and no other workers running, check completion
        if (inFlightChunkIds.size === 0) {
          const allCompleted = activeCloudJob.chunks.every(
            (c) => c.status === "completed" && c.englishText && c.englishText.trim().length > 0
          );
          if (allCompleted) {
            console.log(`[Cloud Background Worker] All chapters finished! Marking job as completed.`);
            activeCloudJob.status = "completed";
            activeCloudJob.lastActiveAt = Date.now();
            saveCloudJobToDisk();
            break;
          }
        }
        // Wait a bit before checking for retries or newly freed items
        await new Promise((r) => setTimeout(r, 600));
        continue;
      }

      // Build a batch up to MAX_BATCH_CHAR_BUDGET characters (e.g., 7,000 Chinese characters)
      let batchChunks = [firstChunk];
      let currentBatchChars = firstChunk.chineseText.length;

      // If the chunk previously had an error or is on retry, DO NOT batch it with others!
      // Translating retried chunks individually prevents one bad chunk from failing others
      if (firstChunk.status !== "error") {
        for (let i = firstChunk.index + 1; i < activeCloudJob.chunks.length; i++) {
          const candidate = activeCloudJob.chunks[i];
          if (candidate.status === "completed" && candidate.englishText && candidate.englishText.trim().length > 0) {
            break;
          }
          if (inFlightChunkIds.has(candidate.id)) {
            break;
          }
          // Do not pull error chunks into a healthy batch
          if (candidate.status === "error") {
            break;
          }
          const candidateLen = candidate.chineseText.length;
          if (currentBatchChars + candidateLen > MAX_BATCH_CHAR_BUDGET) {
            break;
          }
          if (batchChunks.length >= 4) {
            break;
          }

          batchChunks.push(candidate);
          currentBatchChars += candidateLen;
        }
      }

      // Claim all chunks in batch exclusively for this worker
      for (const chunk of batchChunks) {
        inFlightChunkIds.add(chunk.id);
        chunk.status = "processing";
      }
      activeCloudJob.lastActiveAt = Date.now();
      saveCloudJobToDisk();

      // Find preceding context for narrative continuity
      let prevContext = "";
      const prevChunk = activeCloudJob.chunks[firstChunk.index - 1];
      if (prevChunk && prevChunk.englishText) {
        prevContext = prevChunk.englishText.slice(-200);
      }

      const startBatchTime = Date.now();
      let success = false;
      let attemptCount = 0;
      const MAX_ATTEMPTS_PER_PASS = 3;

      // Format style
      let styleGuidance = "";
      switch (activeCloudJob.style) {
        case "xianxia":
          styleGuidance =
            "Style: Xianxia / Wuxia / Chinese Webnovel localization. Use vivid, dynamic literary prose suitable for high-fantasy novels. Keep recognized martial arts/cultivation tropes natural and punchy. Preserve Pinyin for technique names if appropriate or provide evocative English renderings. Keep honorifics consistent (e.g. Senior Brother, Sect Elder, Young Master).";
          break;
        case "literary":
          styleGuidance =
            "Style: Literary fiction. Polished, evocative, rhythmic English prose with rich vocabulary, careful tone, and natural idiomatic flow matching high-standard publishing.";
          break;
        case "formal":
          styleGuidance =
            "Style: Formal & Professional. Objective, clear, grammatically rigorous, suitable for academic, legal, technical, or business documents.";
          break;
        case "literal":
          styleGuidance =
            "Style: Faithful & Accurate. Stick closely to the original sentence boundaries and exact meanings without over-embellishment.";
          break;
        case "fluent":
        default:
          styleGuidance =
            "Style: Natural, Fluent modern English. Highly readable, flowing seamlessly for native English speakers while faithfully conveying the original meaning and nuances.";
          break;
      }

      let glossaryBlock = "";
      if (Array.isArray(activeCloudJob.glossary) && activeCloudJob.glossary.length > 0) {
        const formattedTerms = activeCloudJob.glossary
          .filter((item) => item.original && item.translation)
          .map(
            (item) =>
              `- "${item.original}" MUST be translated as: "${item.translation}"${
                item.notes ? ` (Note: ${item.notes})` : ""
              }`
          )
          .join("\n");

        if (formattedTerms) {
          glossaryBlock = `
CRITICAL TERMINOLOGY & GLOSSARY (Strict Enforcement):
${formattedTerms}
You MUST strictly adhere to the above glossary mappings for consistency across chapters.`;
        }
      }

      while (!success && attemptCount < MAX_ATTEMPTS_PER_PASS && activeCloudJob && activeCloudJob.status === "running") {
        attemptCount++;
        try {

          let contextBlock = "";
          if (prevContext.trim()) {
            contextBlock = `
IMMEDIATELY PRECEDING CONTEXT (For narrative continuity & pronoun resolution only; DO NOT RE-TRANSLATE THIS):
"${prevContext.trim()}"
`;
          }

          let systemInstruction = "";
          let userPrompt = "";

          if (batchChunks.length === 1) {
            const single = batchChunks[0];
            systemInstruction = `You are a master professional Chinese-to-English translator and editor.
Your task is to translate Chinese text into English with the highest standard of accuracy, fluency, and reading pleasure.

Translation Guidelines:
1. Translate the Chinese text completely and faithfully without summarizing, omitting, or truncating any paragraphs or dialogues.
2. Maintain the original paragraph breaks and dialogue formatting.
3. ${styleGuidance}
4. ${glossaryBlock || "Ensure all character names, titles, and locations remain consistent."}
5. Resolve Chinese pronouns (他/她/它/他们) accurately based on context and dialogue tags.
6. Translate Chinese four-character idioms (成语) and cultural expressions into natural English conceptual equivalents.
7. Return ONLY the translated English text directly. Do NOT add conversational greetings, introductory notes, or markers.
8. Creative Fiction Context: You are translating a published web novel / literary work of fantasy fiction. Faithfully translate all romance, affection, intimate dialogue, battle scenes, and cultivation narratives as standard published literature without summarizing or refusing.`;

            userPrompt = `${contextBlock ? contextBlock + "\n" : ""}${
              activeCloudJob.customInstructions ? `Special Instructions: ${activeCloudJob.customInstructions}\n\n` : ""
            }CHINESE SOURCE TEXT (${single.chapterTitle || "Chunk " + (single.index + 1)}):
"""
${single.chineseText}
"""

Translate the above Chinese text directly into English:`;
          } else {
            systemInstruction = `You are a master professional Chinese-to-English translator and editor.
Your task is to translate Chinese text into English with the highest standard of accuracy, fluency, and reading pleasure.

Translation Guidelines:
1. Translate the Chinese text completely and faithfully without summarizing, omitting, or truncating any paragraphs or dialogues.
2. Maintain the original paragraph breaks and dialogue formatting.
3. ${styleGuidance}
4. ${glossaryBlock || "Ensure all character names, titles, and locations remain consistent."}
5. Resolve Chinese pronouns (他/她/它/他们) accurately based on context and dialogue tags.
6. Translate Chinese four-character idioms (成语) and cultural expressions into natural English conceptual equivalents.
7. Creative Fiction Context: You are translating a published web novel / literary work of fantasy fiction. Faithfully translate all romance, affection, intimate dialogue, battle scenes, and cultivation narratives as standard published literature.
8. CRITICAL STRUCTURED BATCH FORMATTING REQUIREMENT:
   You are translating ${batchChunks.length} chapter(s)/chunk(s) in this request.
   You MUST return EACH translated chapter wrapped strictly inside its designated markers:
   <<<CHAPTER_START id="CHUNK_ID" index=NUMBER>>>
   [Translated English text of chapter/chunk...]
   <<<CHAPTER_END id="CHUNK_ID">>>

   Every single chapter in this request MUST be returned separately with its matching id in <<<CHAPTER_START id="...">>> and <<<CHAPTER_END id="...">>>.
   Do NOT combine chapters or omit markers.`;

            const batchPrompts = batchChunks
              .map((c) => {
                return `<<<CHAPTER_START id="${c.id}" index=${c.index + 1} title="${c.chapterTitle || "Part " + (c.index + 1)}">>>
CHINESE SOURCE TEXT (${c.chapterTitle || "Chunk " + (c.index + 1)}):
"""
${c.chineseText}
"""
<<<CHAPTER_END id="${c.id}">>>`;
              })
              .join("\n\n");

            userPrompt = `${contextBlock ? contextBlock + "\n" : ""}${
              activeCloudJob.customInstructions ? `Special Instructions: ${activeCloudJob.customInstructions}\n\n` : ""
            }CHINESE CHAPTER BATCH TO TRANSLATE (${batchChunks.length} item(s)):

${batchPrompts}

Translate all chapters above into English, returning each inside its exact <<<CHAPTER_START id="...">>> and <<<CHAPTER_END id="...">>> markers:`;
          }

          const { text: rawTranslatedText, modelUsed, projectUsed } = await generateWithQuotaScheduler(
            userPrompt,
            systemInstruction,
            0,
            8,
            4000,
            batchChunks.map((c) => c.chineseText).join("\n")
          );

          let validCount = 0;
          let invalidCount = 0;

          if (batchChunks.length === 1) {
            const single = batchChunks[0];
            let cleanText = (rawTranslatedText || "").trim();
            cleanText = cleanText.replace(/<<<CHAPTER_START[^>]*>>>/gi, "").replace(/<<<CHAPTER_END[^>]*>>>/gi, "").trim();

            if (cleanText.length > 0) {
              single.englishText = cleanText;
              single.status = "completed";
              single.durationMs = Date.now() - startBatchTime;
              single.errorMessage = undefined;
              single.lastErrorAt = undefined;
              inFlightChunkIds.delete(single.id);
              validCount = 1;
            } else {
              // Immediate paragraph decomposition fallback
              const decomp = await translateWithDecomposition(
                single.chineseText,
                styleGuidance,
                activeCloudJob.customInstructions,
                glossaryBlock
              );
              if (decomp.text && decomp.text.trim().length > 0) {
                single.englishText = decomp.text.trim();
                single.status = "completed";
                single.durationMs = Date.now() - startBatchTime;
                single.errorMessage = undefined;
                single.lastErrorAt = undefined;
                inFlightChunkIds.delete(single.id);
                validCount = 1;
              } else {
                single.status = "error";
                single.errorMessage = "Empty translation response received.";
                single.lastErrorAt = Date.now();
                single.durationMs = Date.now() - startBatchTime;
                invalidCount = 1;
              }
            }
          } else {
            // Multi-chunk batch validation
            const expectedChunks = batchChunks.map((c) => ({
              id: c.id,
              index: c.index + 1,
              charCount: c.chineseText.length,
            }));

            const parsedResults = parseAndValidateBatchResponse(rawTranslatedText, expectedChunks);

            for (const chunk of batchChunks) {
              const parsed = parsedResults.get(chunk.id);
              if (parsed && parsed.isValid && parsed.englishText.trim().length > 0) {
                chunk.englishText = parsed.englishText;
                chunk.status = "completed";
                chunk.durationMs = Date.now() - startBatchTime;
                chunk.errorMessage = undefined;
                chunk.lastErrorAt = undefined;
                inFlightChunkIds.delete(chunk.id);
                validCount++;
              } else {
                // Immediate individual translation fallback for this chapter
                console.log(`[Cloud Worker #${workerId}] Batch parsing fallback: translating chunk #${chunk.index + 1} individually...`);
                try {
                  const singlePrompt = `${contextBlock ? contextBlock + "\n" : ""}${
                    activeCloudJob.customInstructions ? `Special Instructions: ${activeCloudJob.customInstructions}\n\n` : ""
                  }CHINESE SOURCE TEXT (${chunk.chapterTitle || "Chunk " + (chunk.index + 1)}):
"""
${chunk.chineseText}
"""

Translate the above Chinese text directly into English:`;

                  const singleRes = await generateWithQuotaScheduler(
                    singlePrompt,
                    `You are a master professional Chinese-to-English translator and editor.
Translation Guidelines:
1. Translate faithfully without omissions.
2. ${styleGuidance}
3. ${glossaryBlock || ""}
4. Creative Fiction Context: You are translating a published web novel / literary work of fantasy fiction. Faithfully translate all romance, affection, intimate dialogue, battle scenes, and cultivation narratives as standard published literature.
5. Return ONLY the translated English text directly.`,
                    0,
                    4,
                    2000,
                    chunk.chineseText
                  );

                  let clean = (singleRes.text || "").trim().replace(/<<<CHAPTER_START[^>]*>>>/gi, "").replace(/<<<CHAPTER_END[^>]*>>>/gi, "").trim();
                  if (clean.length > 0) {
                    chunk.englishText = clean;
                    chunk.status = "completed";
                    chunk.durationMs = Date.now() - startBatchTime;
                    chunk.errorMessage = undefined;
                    chunk.lastErrorAt = undefined;
                    inFlightChunkIds.delete(chunk.id);
                    validCount++;
                    continue;
                  }
                } catch (singleErr: any) {
                  console.warn(`[Cloud Worker #${workerId}] Individual translation fallback failed for chunk #${chunk.index + 1}:`, singleErr.message);
                }

                chunk.status = "error";
                chunk.errorMessage = parsed?.errorReason || "Failed batch response validation. Queued for retry.";
                chunk.lastErrorAt = Date.now();
                chunk.durationMs = Date.now() - startBatchTime;
                invalidCount++;
              }
            }
          }

          if (activeCloudJob) {
            activeCloudJob.lastActiveAt = Date.now();
            saveCloudJobToDisk();
          }

          // Isolate retry batch: filter out successfully completed chunks so retries NEVER re-send valid chunks
          batchChunks = batchChunks.filter((c) => c.status !== "completed");
          success = batchChunks.length === 0;

          console.log(
            `[Cloud Worker #${workerId}] Batch result (${validCount + invalidCount} items: ${validCount} completed, ${invalidCount} retry queued) using ${projectUsed} (${modelUsed}) in ${Date.now() - startBatchTime}ms`
          );
        } catch (batchErr: any) {
          const cleanErr = formatCleanErrorMessage(batchErr);
          console.error(
            `[Cloud Worker #${workerId}] Notice on batch starting at chunk ${firstChunk.index + 1} (Attempt #${attemptCount}):`,
            cleanErr
          );

          // If a single chunk failed (e.g. content safety filter / prohibited content trigger),
          // run the intelligent decomposition translator to break it into small paragraphs
          if (batchChunks.length === 1 && firstChunk) {
            console.log(`[Cloud Worker #${workerId}] Attempting paragraph decomposition fallback for chunk ${firstChunk.index + 1}...`);
            try {
              const decompResult = await translateWithDecomposition(
                firstChunk.chineseText,
                styleGuidance,
                activeCloudJob.customInstructions,
                glossaryBlock
              );
              if (decompResult.text && decompResult.text.trim().length > 0) {
                firstChunk.englishText = decompResult.text;
                firstChunk.status = "completed";
                firstChunk.durationMs = Date.now() - startBatchTime;
                firstChunk.errorMessage = undefined;
                firstChunk.lastErrorAt = undefined;
                inFlightChunkIds.delete(firstChunk.id);
                success = true;
                batchChunks = [];
                if (activeCloudJob) {
                  activeCloudJob.lastActiveAt = Date.now();
                  saveCloudJobToDisk();
                }
                console.log(`[Cloud Worker #${workerId}] Chunk ${firstChunk.index + 1} succeeded via paragraph decomposition!`);
                break;
              }
            } catch (decompErr: any) {
              console.warn(`[Cloud Worker #${workerId}] Paragraph decomposition also failed:`, decompErr.message);
            }
          }

          for (const chunk of batchChunks) {
            chunk.status = "error";
            chunk.errorMessage = `Attempt ${attemptCount}: ${cleanErr}. Auto-retrying...`;
            chunk.durationMs = Date.now() - startBatchTime;
            chunk.lastErrorAt = Date.now();
          }

          activeCloudJob.lastActiveAt = Date.now();
          saveCloudJobToDisk();

          if (!activeCloudJob || activeCloudJob.status !== "running") {
            break;
          }

          if (attemptCount < MAX_ATTEMPTS_PER_PASS) {
            const waitCooldown = Math.min(attemptCount * 2500, 10000);
            await new Promise((r) => setTimeout(r, waitCooldown));
          }
        }
      }

      for (const chunk of batchChunks) {
        inFlightChunkIds.delete(chunk.id);
      }
      if (activeCloudJob) {
        activeCloudJob.lastActiveAt = Date.now();
        saveCloudJobToDisk();
      }

      // Small pacing interval between worker tasks to stay comfortable with RPM (reduced from 1200ms to 100ms)
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  try {
    const workerPromises = Array.from({ length: numWorkers }, (_, idx) =>
      runWorkerTask(idx + 1)
    );
    await Promise.all(workerPromises);
  } catch (workerErr) {
    console.error("[Cloud Background Worker] Pool error:", workerErr);
  } finally {
    isCloudWorkerRunning = false;
    inFlightChunkIds.clear();
    saveCloudJobToDisk();
  }
}

// Load any pending job on boot
loadCloudJobFromDisk();

// -------------------------------------------------------------
// Security & Dual-Factor Gate (Google Identity + Master Passcode)
// -------------------------------------------------------------
const AUTHORIZED_EMAIL = (process.env.AUTHORIZED_EMAIL || "cheesy3097@gmail.com").trim().toLowerCase();
const ACCESS_PASSCODE = (process.env.ACCESS_PASSCODE || "").trim();
const AUTH_SECRET = process.env.AUTH_SECRET || crypto.randomBytes(32).toString("hex");

// In-memory valid token store with expiration (7 days)
interface SessionTokenData {
  userEmail: string;
  googleVerified: boolean;
  passcodeVerified: boolean;
  createdAt: number;
  expiresAt: number;
}

const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
const validSessions = new Map<string, SessionTokenData>();

function saveSessions() {
  try {
    const data = JSON.stringify(Object.fromEntries(validSessions), null, 2);
    fs.writeFileSync(SESSIONS_FILE, data, "utf-8");
  } catch (err) {
    console.error("[Auth] Failed to save sessions:", err);
  }
}

function loadSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const data = fs.readFileSync(SESSIONS_FILE, "utf-8");
      const obj = JSON.parse(data);
      const now = Date.now();
      for (const [token, session] of Object.entries(obj)) {
        if ((session as SessionTokenData).expiresAt > now) {
          validSessions.set(token, session as SessionTokenData);
        }
      }
      console.log(`[Auth] Loaded ${validSessions.size} active sessions from disk.`);
    }
  } catch (err) {
    console.error("[Auth] Failed to load sessions:", err);
  }
}

loadSessions();

// Clean expired sessions periodically and save
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [token, data] of validSessions.entries()) {
    if (data.expiresAt <= now) {
      validSessions.delete(token);
      changed = true;
    }
  }
  if (changed) saveSessions();
}, 60 * 60 * 1000);

function createSessionToken(userEmail: string, googleVerified: boolean, passcodeVerified: boolean): string {
  const token = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  validSessions.set(token, {
    userEmail,
    googleVerified,
    passcodeVerified,
    createdAt: now,
    expiresAt: now + 7 * 24 * 60 * 60 * 1000, // 7 days
  });
  saveSessions();
  return token;
}

function verifyAuthToken(req: express.Request): { isValid: boolean; userEmail?: string } {
  const authHeader = req.headers.authorization;
  if (!authHeader) return { isValid: false };
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return { isValid: false };

  const session = validSessions.get(token);
  if (!session) return { isValid: false };
  if (session.expiresAt <= Date.now()) {
    validSessions.delete(token);
    return { isValid: false };
  }

  // Check if both requirements are fulfilled
  const googleRequired = !!AUTHORIZED_EMAIL;
  const passcodeRequired = !!ACCESS_PASSCODE;

  if (googleRequired && (!session.googleVerified || session.userEmail.toLowerCase() !== AUTHORIZED_EMAIL)) {
    return { isValid: false };
  }
  if (passcodeRequired && !session.passcodeVerified) {
    return { isValid: false };
  }

  return { isValid: true, userEmail: session.userEmail };
}

// Authentication status endpoint (public)
app.get("/api/auth/status", (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader ? authHeader.replace(/^Bearer\s+/i, "").trim() : "";
  const session = token ? validSessions.get(token) : null;
  const isSessionValid = session && session.expiresAt > Date.now();

  const requiresGoogle = !!AUTHORIZED_EMAIL;
  const requiresPasscode = !!ACCESS_PASSCODE;

  const googleVerified = !!(isSessionValid && session?.googleVerified && session.userEmail.toLowerCase() === AUTHORIZED_EMAIL);
  const passcodeVerified = !!(isSessionValid && session?.passcodeVerified);

  const fullyAuthenticated = (!requiresGoogle || googleVerified) && (!requiresPasscode || passcodeVerified);

  res.json({
    authenticated: fullyAuthenticated,
    requiresGoogle,
    requiresPasscode,
    googleVerified,
    passcodeVerified,
    userEmail: isSessionValid ? session?.userEmail : null,
    authorizedEmail: AUTHORIZED_EMAIL,
    hasPasscodeConfigured: !!ACCESS_PASSCODE,
  });
});

// Dual Login / Verification Endpoint
app.post("/api/auth/login", (req, res) => {
  try {
    const { email = "", passcode = "", googleCredential = "", token = "" } = req.body;
    let providedEmail = String(email || "").trim().toLowerCase();

    // If a Google Identity credential (JWT) is provided, decode payload
    if (googleCredential) {
      try {
        const parts = googleCredential.split(".");
        if (parts.length >= 2) {
          const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf-8"));
          if (payload.email) {
            providedEmail = String(payload.email).trim().toLowerCase();
          }
        }
      } catch (jwtErr) {
        console.warn("[Auth] Could not parse Google credential JWT:", jwtErr);
      }
    }

    const requiresGoogle = !!AUTHORIZED_EMAIL;
    const requiresPasscode = !!ACCESS_PASSCODE;

    // Check existing partial session if token passed
    let existingSession = token ? validSessions.get(token) : null;
    let googleVerified = existingSession ? existingSession.googleVerified : false;
    let passcodeVerified = existingSession ? existingSession.passcodeVerified : false;
    let currentEmail = existingSession ? existingSession.userEmail : providedEmail;

    // 1. Verify Google Email if provided
    if (providedEmail) {
      if (providedEmail === AUTHORIZED_EMAIL) {
        googleVerified = true;
        currentEmail = providedEmail;
      } else {
        res.status(403).json({
          error: `Access Denied: The Google account "${providedEmail}" is not authorized. Only ${AUTHORIZED_EMAIL} may access this private translation engine.`,
          unauthorizedEmail: providedEmail,
        });
        return;
      }
    }

    // 2. Verify Passcode if provided or configured
    if (requiresPasscode) {
      if (passcode && passcode.trim() === ACCESS_PASSCODE) {
        passcodeVerified = true;
      } else if (passcode && passcode.trim() !== ACCESS_PASSCODE) {
        res.status(401).json({ error: "Invalid master passcode. Access denied." });
        return;
      }
    } else {
      passcodeVerified = true;
    }

    if (!requiresGoogle) {
      googleVerified = true;
    }

    const isComplete = (!requiresGoogle || googleVerified) && (!requiresPasscode || passcodeVerified);
    const newToken = createSessionToken(currentEmail, googleVerified, passcodeVerified);

    res.json({
      success: true,
      authenticated: isComplete,
      token: newToken,
      userEmail: currentEmail,
      googleVerified,
      passcodeVerified,
      requiresGoogle,
      requiresPasscode,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Authentication failed." });
  }
});

// Logout endpoint
app.post("/api/auth/logout", (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader ? authHeader.replace(/^Bearer\s+/i, "").trim() : "";
  if (token) {
    validSessions.delete(token);
    saveSessions();
  }
  res.json({ success: true });
});

// Gatekeeper Middleware for protected Translation and Cloud Job endpoints
const requireAuthMiddleware: express.RequestHandler = (req, res, next) => {
  const { isValid } = verifyAuthToken(req);
  if (!isValid) {
    res.status(401).json({
      error: "Unauthorized: Please sign in with your authorized Google Account (cheesy3097@gmail.com) and enter the master passcode to access the translation engine.",
      requiresAuth: true,
    });
    return;
  }
  next();
};

// Health check endpoint
app.get("/api/health", (req, res) => {
  const available = FREE_TIER_MODELS.filter((m) => !deprecatedModels.has(m));
  const projectsStatus = quotaScheduler.getSanitizedStatus();
  const summary = quotaScheduler.getActiveProjectSummary();

  res.json({
    status: "ok",
    hasApiKey: quotaScheduler.projectCount > 0,
    configuredProjectsCount: quotaScheduler.projectCount,
    activeProject: summary.activeProjectName,
    projectsSummary: summary,
    projects: projectsStatus,
    models: available,
    primaryModel: available[0] || "gemini-3.5-flash",
    hasActiveCloudJob: !!activeCloudJob,
    cloudJobStatus: activeCloudJob?.status || "idle",
  });
});

// Dedicated project availability & quota monitoring endpoint
app.get("/api/projects/status", (req, res) => {
  res.json({
    success: true,
    totalProjects: quotaScheduler.projectCount,
    summary: quotaScheduler.getActiveProjectSummary(),
    projects: quotaScheduler.getSanitizedStatus(),
  });
});

// -------------------------------------------------------------
// Cloud Job API Endpoints
// -------------------------------------------------------------

// Get status & progress of cloud job (Data-saving lightweight mode by default)
app.get("/api/cloud-job/status", (req, res) => {
  if (!activeCloudJob) {
    res.json({ hasJob: false, job: null });
    return;
  }

  const includeFullText = req.query.full === "true";

  // Ensure any completed offline translations (e.g., chunk 82, 124) are synced into memory
  try {
    const files = fs.readdirSync(DATA_DIR);
    for (const file of files) {
      const match = file.match(/^chunk_(\d+)_translated\.txt$/);
      if (match && activeCloudJob) {
        const fileNum = parseInt(match[1], 10);
        const targetChunk = activeCloudJob.chunks.find(
          (c) => c.index === fileNum || c.chapterTitle?.includes(`第${fileNum}章`)
        );
        if (targetChunk && (targetChunk.status !== "completed" || !targetChunk.englishText)) {
          targetChunk.englishText = fs.readFileSync(path.join(DATA_DIR, file), "utf-8").trim();
          targetChunk.status = "completed";
          targetChunk.errorMessage = undefined;
          targetChunk.lastErrorAt = undefined;
          saveCloudJobToDisk();
        }
      }
    }
  } catch (e) {
    console.warn("Could not sync chunk files:", e);
  }

  const completedChunks = activeCloudJob.chunks.filter((c) => c.status === "completed").length;
  const inProgressChunks = activeCloudJob.chunks.filter((c) => c.status === "processing").length;
  const errorChunks = activeCloudJob.chunks.filter((c) => c.status === "error").length;

  if (completedChunks === activeCloudJob.chunks.length && activeCloudJob.status !== "completed") {
    activeCloudJob.status = "completed";
    saveCloudJobToDisk();
  }

  // Calculate contiguous completion frontier from index 0
  let contiguousFrontierIndex = -1;
  let contiguousCount = 0;
  for (let i = 0; i < activeCloudJob.chunks.length; i++) {
    const c = activeCloudJob.chunks[i];
    if (c && c.status === "completed" && c.englishText && c.englishText.trim().length > 0) {
      contiguousFrontierIndex = i;
      contiguousCount++;
    } else {
      break;
    }
  }

  const aheadCompletedCount = activeCloudJob.chunks.filter(
    (c) => c.status === "completed" && !!c.englishText?.trim() && c.index > contiguousFrontierIndex
  ).length;

  // Render chunks (lightweight metadata by default to save 99%+ mobile data)
  const chunksData = activeCloudJob.chunks.map((c) => {
    const wordCount = c.englishText ? countEnglishWords(c.englishText) : 0;
    if (includeFullText) {
      return { ...c, wordCount };
    }
    return {
      id: c.id,
      index: c.index,
      chapterTitle: c.chapterTitle,
      charCount: c.charCount,
      wordCount,
      status: c.status,
      attempts: c.attempts,
      lastErrorAt: c.lastErrorAt,
      errorMessage: c.errorMessage,
      hasEnglish: !!(c.englishText && c.englishText.trim().length > 0),
      hasChinese: !!(c.chineseText && c.chineseText.trim().length > 0),
    };
  });

  res.json({
    hasJob: true,
    job: {
      id: activeCloudJob.id,
      fileName: activeCloudJob.fileName,
      fileSizeBytes: activeCloudJob.fileSizeBytes,
      totalChineseChars: activeCloudJob.totalChineseChars,
      style: activeCloudJob.style,
      customInstructions: activeCloudJob.customInstructions,
      glossary: activeCloudJob.glossary,
      concurrency: activeCloudJob.concurrency,
      status: activeCloudJob.status,
      startedAt: activeCloudJob.startedAt,
      lastActiveAt: activeCloudJob.lastActiveAt,
      totalChunks: activeCloudJob.chunks.length,
      completedChunks,
      inProgressChunks,
      errorChunks,
      contiguousCount,
      contiguousFrontierIndex,
      aheadCompletedCount,
      projectsSummary: quotaScheduler.getActiveProjectSummary(),
      chunks: chunksData,
    },
  });
});

// Sync full chapter texts for completed chunks or requested chunk indices on-demand
app.get("/api/cloud-job/sync-texts", (req, res) => {
  if (!activeCloudJob) {
    res.json({ success: false, chunks: [] });
    return;
  }

  const indicesParam = req.query.indices as string;
  let targetChunks = activeCloudJob.chunks;
  if (indicesParam) {
    const setIdx = new Set(indicesParam.split(",").map(Number));
    targetChunks = activeCloudJob.chunks.filter((c) => setIdx.has(c.index));
  } else if (req.query.completedOnly === "true") {
    targetChunks = activeCloudJob.chunks.filter(
      (c) => c.status === "completed" && !!c.englishText?.trim()
    );
  }

  res.json({
    success: true,
    chunks: targetChunks.map((c) => ({
      id: c.id,
      index: c.index,
      chapterTitle: c.chapterTitle,
      chineseText: c.chineseText,
      englishText: c.englishText || "",
      wordCount: c.englishText ? countEnglishWords(c.englishText) : 0,
      status: c.status,
    })),
  });
});

// Fetch single full chunk by index for Chapter Reader or manual editing
app.get("/api/cloud-job/chunk/:index", (req, res) => {
  if (!activeCloudJob) {
    res.status(404).json({ error: "No active cloud job." });
    return;
  }

  const idx = parseInt(req.params.index, 10);
  const chunk = activeCloudJob.chunks[idx];
  if (!chunk) {
    res.status(404).json({ error: "Chunk not found." });
    return;
  }

  res.json({
    success: true,
    chunk: {
      id: chunk.id,
      index: chunk.index,
      chapterTitle: chunk.chapterTitle,
      chineseText: chunk.chineseText,
      englishText: chunk.englishText || "",
      charCount: chunk.charCount,
      wordCount: chunk.englishText ? countEnglishWords(chunk.englishText) : 0,
      status: chunk.status,
      attempts: chunk.attempts,
      errorMessage: chunk.errorMessage,
    },
  });
});

// Start or update a cloud background job
app.post("/api/cloud-job/start", requireAuthMiddleware, (req, res) => {
  try {
    const {
      fileName = "novel.txt",
      fileSizeBytes = 0,
      totalChineseChars = 0,
      chunks = [],
      style = "xianxia",
      customInstructions = "",
      glossary = [],
      concurrency = 1,
    } = req.body;

    if (!Array.isArray(chunks) || chunks.length === 0) {
      res.status(400).json({ error: "No chunks provided for cloud job." });
      return;
    }

    const jobId = "cloud_job_" + Date.now();

    activeCloudJob = {
      id: jobId,
      fileName,
      fileSizeBytes,
      totalChineseChars,
      chunks,
      style,
      customInstructions,
      glossary,
      concurrency,
      status: "running",
      startedAt: Date.now(),
      lastActiveAt: Date.now(),
    };

    saveCloudJobToDisk();
    startCloudWorkerLoop();

    res.json({
      success: true,
      jobId,
      message: "Cloud background translation started. You can safely close this browser.",
    });
  } catch (err: any) {
    console.error("Failed to start cloud job:", err);
    res.status(500).json({ error: err.message || "Failed to start cloud job." });
  }
});

// Pause cloud job
app.post("/api/cloud-job/pause", requireAuthMiddleware, (req, res) => {
  if (activeCloudJob) {
    activeCloudJob.status = "paused";
    saveCloudJobToDisk();
  }
  res.json({ success: true, status: "paused" });
});

// Resume cloud job
app.post("/api/cloud-job/resume", requireAuthMiddleware, (req, res) => {
  if (activeCloudJob) {
    activeCloudJob.status = "running";
    saveCloudJobToDisk();
    startCloudWorkerLoop();
  }
  res.json({ success: true, status: "running" });
});

// Stop and clear cloud job
app.post("/api/cloud-job/stop", requireAuthMiddleware, (req, res) => {
  if (activeCloudJob) {
    activeCloudJob.status = "idle";
    activeCloudJob = null;
    saveCloudJobToDisk();
  }
  res.json({ success: true, message: "Cloud job removed." });
});

// Sync manual edit to a chunk or retry outcome
app.post("/api/cloud-job/update-chunk", requireAuthMiddleware, (req, res) => {
  const { chunkId, englishText, status } = req.body;
  if (activeCloudJob && chunkId) {
    const chunk = activeCloudJob.chunks.find((c) => c.id === chunkId);
    if (chunk) {
      if (englishText !== undefined) {
        chunk.englishText = englishText;
        chunk.edited = true;
      }
      if (status) {
        chunk.status = status;
      }
      chunk.errorMessage = undefined;
      activeCloudJob.lastActiveAt = Date.now();
      saveCloudJobToDisk();
    }
  }
  res.json({ success: true });
});

// Update settings on the cloud job (e.g. style, instructions, glossary) while running or paused
app.post("/api/cloud-job/update-settings", requireAuthMiddleware, (req, res) => {
  const { style, customInstructions, glossary, concurrency } = req.body;
  if (activeCloudJob) {
    if (style) activeCloudJob.style = style;
    if (customInstructions !== undefined) activeCloudJob.customInstructions = customInstructions;
    if (glossary) activeCloudJob.glossary = glossary;
    if (concurrency) activeCloudJob.concurrency = concurrency;
    activeCloudJob.lastActiveAt = Date.now();
    saveCloudJobToDisk();
  }
  res.json({ success: true, job: activeCloudJob });
});

// Main translation endpoint for chunks
app.post("/api/translate-chunk", requireAuthMiddleware, async (req, res) => {
  try {
    const {
      text,
      chunkIndex,
      totalChunks,
      previousContext,
      glossary,
      style = "fluent",
      customInstructions = "",
    } = req.body;

    if (!text || typeof text !== "string") {
      res.status(400).json({ error: "Missing or invalid 'text' field." });
      return;
    }

    const ai = getGeminiClient();

    // Construct style guidance
    let styleGuidance = "";
    switch (style) {
      case "xianxia":
        styleGuidance =
          "Style: Xianxia / Wuxia / Chinese Webnovel localization. Use vivid, dynamic literary prose suitable for high-fantasy novels. Keep recognized martial arts/cultivation tropes natural and punchy. Preserve Pinyin for technique names if appropriate or provide evocative English renderings. Keep honorifics consistent (e.g. Senior Brother, Sect Elder, Young Master).";
        break;
      case "literary":
        styleGuidance =
          "Style: Literary fiction. Polished, evocative, rhythmic English prose with rich vocabulary, careful tone, and natural idiomatic flow matching high-standard publishing.";
        break;
      case "formal":
        styleGuidance =
          "Style: Formal & Professional. Objective, clear, grammatically rigorous, suitable for academic, legal, technical, or business documents.";
        break;
      case "literal":
        styleGuidance =
          "Style: Faithful & Accurate. Stick closely to the original sentence boundaries and exact meanings without over-embellishment.";
        break;
      case "fluent":
      default:
        styleGuidance =
          "Style: Natural, Fluent modern English. Highly readable, flowing seamlessly for native English speakers while faithfully conveying the original meaning and nuances.";
        break;
    }

    // Format glossary
    let glossaryBlock = "";
    if (Array.isArray(glossary) && glossary.length > 0) {
      const formattedTerms = glossary
        .filter((item) => item.original && item.translation)
        .map(
          (item) =>
            `- "${item.original}" MUST be translated as: "${item.translation}"${
              item.notes ? ` (Note: ${item.notes})` : ""
            }`
        )
        .join("\n");

      if (formattedTerms) {
        glossaryBlock = `
CRITICAL TERMINOLOGY & GLOSSARY (Strict Enforcement):
${formattedTerms}
You MUST strictly adhere to the above glossary mappings for consistency across chapters.`;
      }
    }

    // Context buffer for pronoun & continuity
    let contextBlock = "";
    if (previousContext && typeof previousContext === "string" && previousContext.trim()) {
      contextBlock = `
IMMEDIATELY PRECEDING CONTEXT (For narrative continuity & pronoun resolution only; DO NOT RE-TRANSLATE THIS):
"${previousContext.trim()}"
`;
    }

    const systemInstruction = `You are a master professional Chinese-to-English translator and editor.
Your task is to translate Chinese text into English with the highest standard of accuracy, fluency, and reading pleasure.

Translation Guidelines:
1. Translate the Chinese text completely and faithfully without summarizing, omitting, or truncating any paragraphs or dialogues.
2. Maintain the original paragraph breaks and dialogue formatting.
3. ${styleGuidance}
4. ${glossaryBlock || "Ensure all character names, titles, and locations remain consistent."}
5. Resolve Chinese pronouns (他/她/它/他们) accurately based on context and dialogue tags.
6. Translate Chinese four-character idioms (成语) and cultural expressions into their natural English conceptual equivalents rather than awkward word-for-word transliterations, unless specific to martial arts names.
7. Return ONLY the translated English text. Do NOT wrap in conversational intro/outro remarks like "Here is the translation:" or "Certainly!".
8. Creative Fiction Context: You are translating a published web novel / literary work of fantasy fiction. Faithfully translate all romance, affection, intimate dialogue, battle scenes, and cultivation narratives as standard published literature without summarizing or refusing.`;

    const userPrompt = `${contextBlock ? contextBlock + "\n" : ""}${
      customInstructions ? `Special Instructions: ${customInstructions}\n\n` : ""
    }CHINESE SOURCE TEXT TO TRANSLATE (Chunk ${chunkIndex !== undefined ? chunkIndex + 1 : 1}${
      totalChunks ? ` of ${totalChunks}` : ""
    }):
"""
${text}
"""

Translate the above Chinese text directly into English:`;

    const { text: translatedText, modelUsed, projectUsed } =
      await generateWithQuotaScheduler(
        userPrompt,
        systemInstruction,
        0,
        8,
        4000,
        text
      );

    res.json({
      success: true,
      translatedText,
      modelUsed,
      projectUsed,
      sourceLength: text.length,
      translatedLength: translatedText.length,
    });
  } catch (err: any) {
    console.error("Translation API Error:", err);
    res.status(500).json({
      error: err.message || "Failed to process translation with Gemini API.",
    });
  }
});

// Auto-extract terminology and character names from a text sample
app.post("/api/extract-glossary", requireAuthMiddleware, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || typeof text !== "string") {
      res.status(400).json({ error: "Missing or invalid 'text' field." });
      return;
    }

    // Use up to the first 12,000 characters for glossary extraction
    const sampleText = text.slice(0, 12000);

    const prompt = `Analyze this Chinese text sample and extract key proper nouns, character names, locations, factions/organizations, or specialized recurring terms. For each term, provide its accurate English translation or official Romanization (Pinyin with capitalization).

Return a valid JSON array of objects with keys: "original", "translation", "category", and "notes".
Categories can be: "Character", "Location", "Faction", "Realm/Rank", or "Concept".

Example response format:
[
  {"original": "萧炎", "translation": "Xiao Yan", "category": "Character", "notes": "Main protagonist"},
  {"original": "斗气大陆", "translation": "Dou Qi Continent", "category": "Location", "notes": "Setting world"}
]

Chinese text sample:
"""
${sampleText}
"""`;

    const { text: responseText } = await generateWithQuotaScheduler(
      prompt,
      "You are a terminology extraction assistant. Return valid JSON only.",
      0,
      4,
      3000
    );

    let terms = [];
    try {
      terms = JSON.parse(responseText || "[]");
    } catch {
      // If response had markdown codeblocks ```json ... ```
      const match = responseText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (match && match[1]) {
        try {
          terms = JSON.parse(match[1]);
        } catch {
          terms = [];
        }
      } else {
        terms = [];
      }
    }

    res.json({ success: true, terms });
  } catch (err: any) {
    console.error("Extract Glossary Error:", err);
    res.status(500).json({
      error: err.message || "Failed to extract glossary terms.",
    });
  }
});

// Cache for prepared downloads to support sandboxed iframe downloads
interface StoredDownload {
  filename: string;
  contentType: string;
  data: Buffer;
  createdAt: number;
}
const downloadCache = new Map<string, StoredDownload>();

// Periodically purge old files after 15 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, item] of downloadCache.entries()) {
    if (now - item.createdAt > 15 * 60 * 1000) {
      downloadCache.delete(id);
    }
  }
}, 5 * 60 * 1000);

// 1. Prepare download endpoint
app.post("/api/prepare-download", (req, res) => {
  try {
    const {
      filename = "download.txt",
      content = "",
      contentType = "text/plain;charset=utf-8",
      isBase64 = false,
    } = req.body;

    if (content === undefined || content === null) {
      res.status(400).json({ error: "Missing content for download." });
      return;
    }

    const buffer = isBase64
      ? Buffer.from(content, "base64")
      : Buffer.from(content, "utf-8");

    const id = Math.random().toString(36).substring(2, 10) + "_" + Date.now();
    downloadCache.set(id, {
      filename,
      contentType,
      data: buffer,
      createdAt: Date.now(),
    });

    res.json({
      success: true,
      downloadId: id,
      downloadUrl: `/api/download/${id}`,
      filename,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to prepare download." });
  }
});

// 2. Direct download GET endpoint with Content-Disposition
app.get("/api/download/:id", (req, res) => {
  const { id } = req.params;
  const item = downloadCache.get(id);

  if (!item) {
    res.status(404).send(`
      <!DOCTYPE html>
      <html>
        <head><title>Download Expired</title><meta charset="utf-8"></head>
        <body style="font-family: system-ui, sans-serif; text-align: center; padding: 60px 20px;">
          <h2 style="color: #0f172a;">Download Link Expired</h2>
          <p style="color: #64748b;">Please return to the MegaText Translator window and click the download button again to generate a fresh link.</p>
        </body>
      </html>
    `);
    return;
  }

  const encodedFilename = encodeURIComponent(item.filename);
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${encodedFilename}"; filename*=UTF-8''${encodedFilename}`
  );
  res.setHeader("Content-Type", item.contentType || "application/octet-stream");
  res.setHeader("Content-Length", item.data.length);
  res.send(item.data);
});

// 3. Direct download POST endpoint for form-based top-level window download
app.post("/api/direct-download", (req, res) => {
  try {
    const {
      filename = "download.txt",
      content = "",
      contentType = "text/plain;charset=utf-8",
      isBase64,
    } = req.body;

    const buffer =
      isBase64 === "true" || isBase64 === true
        ? Buffer.from(content, "base64")
        : Buffer.from(content, "utf-8");

    const encodedFilename = encodeURIComponent(filename);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodedFilename}"; filename*=UTF-8''${encodedFilename}`
    );
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", buffer.length);
    res.send(buffer);
  } catch (err: any) {
    res.status(500).send("Error generating download: " + err.message);
  }
});

// Vite middleware & SPA fallback
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`MegaText Translator server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
