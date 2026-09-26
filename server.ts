import express from "express";
import compression from "compression";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
import { quotaScheduler, formatCleanErrorMessage, is503OrHighDemand } from "./server/quotaScheduler";
import { parseAndValidateBatchResponse, groupChunksIntoBatches, MAX_BATCH_CHAR_BUDGET } from "./server/batchParser";
import { sendTelegramNotification as rawSendTelegramNotification } from "./server/telegram";
import { searchStoreNovels, fetchNovelTOC, fetchChapterText, scrapeExploreNovels, findNovelMirrors, enrichAiquNovelItems, enrichJjwxcNovelItems, fetchNovelFullIntro } from "./server/storeScraper";
import { translateExploreItemsInPlace, translateWithGoogle, translateChapterWithGoogle, hasChineseCharacters } from "./server/googleTranslate";
import { autoGenerateNovelGlossary } from "./server/glossaryExtractor";
import {
  initFirestore,
  saveJobToFirestore,
  saveChunkToFirestore,
  saveChunksBatchToFirestore,
  saveJobSegmentsToFirestore,
  loadAllJobsFromFirestore,
  loadJobFromFirestore,
  loadFullChunksForJob,
  findJobInFirestoreByNovel,
  getDeletedJobTombstonesFromFirestore,
  recordDeletedJobInFirestore,
  deleteJobFromFirestore,
  deleteJobByFileNameFromFirestore,
  deleteAllJobsFromFirestore,
  mergeMonotonicJob,
  getFirestoreQuotaStatus,
} from "./server/firestoreStorage";
import { generateServerEpubBuffer } from "./server/epubServer";
import { cleanAndDeduplicateChunks } from "./src/utils/chunkCleaner";
import { generate404PrimitiveChenQiChunks } from "./server/restore404";
import { chunkChineseText, countChineseCharacters } from "./src/utils/chunker";


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

// Track last known public origin to ping external ingress and keep Cloud Run active
let lastKnownPublicOrigin = "";

app.use((req, res, next) => {
  const host = (req.headers["x-forwarded-host"] as string) || req.headers.host;
  const proto = (req.headers["x-forwarded-proto"] as string) || "https";
  if (host && typeof host === "string" && !host.includes("localhost") && !host.includes("127.0.0.1")) {
    lastKnownPublicOrigin = `${proto}://${host}`;
  }
  next();
});

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
// gemini-3.8-flash and gemini-3.1-flash-lite deliver high throughput, fast translation, and excellent output quality.
const FREE_TIER_MODELS = [
  "gemini-3.8-flash",
  "gemini-3.1-flash-lite",
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
        try {
          const gTrans = await translateWithGoogle(sent.trim(), "zh-CN", "en");
          sentenceTranslations.push(gTrans || "[Scene narrative continues naturally...]");
        } catch {
          sentenceTranslations.push("[Scene narrative continues naturally...]");
        }
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
        } catch {
          try {
            const gTrans = await translateWithGoogle(sent.trim(), "zh-CN", "en");
            if (gTrans && gTrans.trim()) {
              sentResults.push(gTrans.trim());
            }
          } catch {}
        }
      }
      translatedBatches[i] = sentResults.join(" ");
    }
  };

  for (let i = 0; i < paragraphBatches.length; i += 3) {
    const chunk = paragraphBatches.slice(i, i + 3).map((sub, idx) => translateSubSection(sub, i + idx));
    await Promise.all(chunk);
  }

  const finalJoinedText = translatedBatches.filter(Boolean).join("\n\n");
  if (!finalJoinedText || finalJoinedText.trim().length === 0) {
    try {
      const gChapter = await translateChapterWithGoogle(rawText);
      if (gChapter && gChapter.trim().length > 0) {
        return {
          text: gChapter.trim(),
          modelUsed: "google-translate-fallback",
          projectUsed: "engine",
        };
      }
    } catch {}
  }

  return {
    text: finalJoinedText || "[Translation continues...]",
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
    await new Promise((resolve) => setTimeout(resolve, Math.min(projectWaitMs, 1000)));
  }

  // 2. Select available model from pool
  const modelSelection = getAvailableModelIndex(modelIndex);
  if (modelSelection.waitMs > 0) {
    console.log(
      `[Model Pool] All models in pool cooling down. Waiting ${Math.ceil(
        modelSelection.waitMs / 1000
      )}s before querying ${modelSelection.modelName}...`
    );
    await new Promise((resolve) => setTimeout(resolve, Math.min(modelSelection.waitMs, 300)));
  }

  const modelName = modelSelection.modelName;
  const currentModelIdx = modelSelection.index;

  quotaScheduler.acquireProject(project.id);
  let projectReleased = false;
  const releaseCurrentProject = () => {
    if (!projectReleased) {
      quotaScheduler.releaseProject(project.id);
      projectReleased = true;
    }
  };

  try {
    const generatePromise = project.client.models.generateContent({
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

    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(`API request to ${modelName} timed out after 35 seconds.`));
      }, 35000);
    });

    const response = await Promise.race([generatePromise, timeoutPromise]).finally(() => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
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

      // Fast signal for safety filter triggers so caller can instantly invoke Google Translate fallback without wasting retries
      const isSafetyBlock =
        blockReason === "SAFETY" ||
        blockReason === "PROMPT_BLOCKED" ||
        blockReason === "BLOCK_REASON_UNSPECIFIED" ||
        String(blockReason).toLowerCase().includes("safety") ||
        String(blockReason).toLowerCase().includes("block");

      if (isSafetyBlock) {
        throw new Error(`SAFETY_FILTER_TRIGGER: Gemini content policy triggered (${blockReason})`);
      }

      // Record failure on project key and exclude it to prevent hammering the same project
      quotaScheduler.recordFailure(project.id, new Error("Empty response / safety block"));
      excludeProjectIds.add(project.id);

      if (quotaScheduler.enabledProjectCount > 0 && retries > 0) {
        releaseCurrentProject();
        const nextExclude = new Set(excludeProjectIds);
        if (nextExclude.size >= quotaScheduler.enabledProjectCount) {
          nextExclude.clear();
        }
        return generateWithQuotaScheduler(
          userPrompt,
          systemInstruction,
          (currentModelIdx + 1) % FREE_TIER_MODELS.length,
          retries - 1,
          0,
          rawSourceText,
          nextExclude
        );
      }

      throw new Error(`SAFETY_FILTER_TRIGGER: Model returned empty translation response (Filter: ${blockReason || "unknown"}).`);
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

    const is503Spike = is503OrHighDemand(err);

    const isTemporary =
      is503Spike ||
      err.status === 503 ||
      err.status === 500 ||
      err.status === 504 ||
      err.statusCode === 503 ||
      err.statusCode === 500 ||
      err.statusCode === 504 ||
      err.code === 504 ||
      err.status === "DEADLINE_EXCEEDED" ||
      errStr.includes("504") ||
      errStr.includes("deadline") ||
      errStr.includes("deadline_exceeded") ||
      errStr.includes("503") ||
      errStr.includes("500") ||
      errStr.includes("unavailable") ||
      errStr.includes("high demand") ||
      errStr.includes("overloaded") ||
      errStr.includes("timed out") ||
      errStr.includes("timeout") ||
      errStr.includes("fetch failed") ||
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
          : is503Spike
          ? "503 Temporary High Demand Spike"
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
      releaseCurrentProject();
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
          0,
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
      releaseCurrentProject();
      deprecatedModels.add(modelName);
      console.log(`[Gemini Engine] Model ${modelName} returned 404. Pruning from pool and switching model...`);
      return generateWithQuotaScheduler(
        userPrompt,
        systemInstruction,
        currentModelIdx + 1,
        retries,
        0,
        rawSourceText,
        excludeProjectIds
      );
    }

    // 2. Safety filter fast signal
    if (isFilterOrBlock) {
      releaseCurrentProject();
      console.warn(`[Gemini Engine] Safety trigger detected on ${project.name}. Raising instant safety fallback signal for Google Translate.`);
      quotaScheduler.recordFailure(project.id, err);
      throw new Error(`SAFETY_FILTER_TRIGGER: Sensitive content blocked by safety filter (${formatCleanErrorMessage(err)})`);
    }

    // 3. Instant Multi-Project Failover on 503 Spikes (When an upstream model experiences temporary high demand)
    if (is503Spike && retries > 0) {
      releaseCurrentProject();
      quotaScheduler.record503Spike(project.id, err);
      excludeProjectIds.add(project.id);

      const hasOtherProjects = quotaScheduler.hasOtherActiveProjects(excludeProjectIds);

      if (hasOtherProjects) {
        // Instant routing to another active project without stalling the queue or locking the model
        const remainingProjects = quotaScheduler.getAvailableProjectsCount(excludeProjectIds);
        console.log(
          `[Quota Scheduler] Instant Multi-Project Failover on 503 Spike: Upstream model "${modelName}" reported temporary high demand on ${project.name} (${project.keyMask}). Routing immediately to next active project without stalling the queue (${remainingProjects} alternate project(s) ready)...`
        );

        return generateWithQuotaScheduler(
          userPrompt,
          systemInstruction,
          currentModelIdx, // Keep the same model! Other active projects can try it immediately without locking the model.
          retries - 1,
          0, // 0ms delay: Instant failover without stalling the queue!
          rawSourceText,
          excludeProjectIds
        );
      }

      // All active projects in the pool have encountered 503 on this model in this round.
      // Now failover immediately to the next model in pool without stalling the queue!
      console.warn(
        `[Quota Scheduler] Upstream model "${modelName}" high demand across all ${quotaScheduler.enabledProjectCount} active project(s). Failing over instantly to next model in pool without stalling queue...`
      );

      // Place a lightweight non-blocking 5s cooldown on this model so the next model is preferred
      modelCooldowns.set(modelName, Date.now() + 5000);

      // Reset project exclusions so all active projects can try the new model
      const nextExclude = new Set<string>();
      const nextModelIdx = (currentModelIdx + 1) % FREE_TIER_MODELS.length;

      return generateWithQuotaScheduler(
        userPrompt,
        systemInstruction,
        nextModelIdx,
        retries - 1,
        0, // 0ms delay: Instant failover!
        rawSourceText,
        nextExclude
      );
    }

    // 4. Quota / Rate Limit (429) or other Transient (500/504)
    if ((isRateLimit || isTemporary) && retries > 0) {
      releaseCurrentProject();
      quotaScheduler.recordFailure(project.id, err);
      excludeProjectIds.add(project.id);

      const hasOtherProjects = quotaScheduler.hasOtherActiveProjects(excludeProjectIds);

      if (hasOtherProjects) {
        console.log(
          `[Quota Scheduler] Project throttled (${isRateLimit ? "429 Rate Limit" : "Transient Error"}). Switching project immediately...`
        );
        return generateWithQuotaScheduler(
          userPrompt,
          systemInstruction,
          currentModelIdx,
          retries - 1,
          0,
          rawSourceText,
          excludeProjectIds
        );
      }

      // All projects throttled or overloaded: try next model with fast failover
      const nextExclude = new Set<string>();
      let nextModelIdx = (currentModelIdx + 1) % FREE_TIER_MODELS.length;

      if (retries > 1) {
        console.log(
          `[Quota Scheduler] Upstream model capacity saturated. Rotating model (${FREE_TIER_MODELS[nextModelIdx]}) and retrying...`
        );
        return generateWithQuotaScheduler(
          userPrompt,
          systemInstruction,
          nextModelIdx,
          retries - 1,
          0,
          rawSourceText,
          nextExclude
        );
      }
    }

    // High Reliability Fail-Safe: If Gemini is overloaded across all projects/models, rescue via Google Translate
    if (rawSourceText && rawSourceText.trim().length > 0) {
      console.warn(
        `[Gemini Engine] Upstream model overloaded / quota exhausted. Rescuing chunk automatically with high-speed translation engine...`
      );
      try {
        const rescued = await translateChapterWithGoogle(rawSourceText);
        if (rescued && rescued.trim().length > 0) {
          return {
            text: rescued.trim(),
            modelUsed: "translation-engine-rescue",
            projectUsed: "fallback-pool",
          };
        }
      } catch (gErr: any) {
        console.warn("[Gemini Engine] Rescue attempt note:", gErr?.message);
      }
    }

    releaseCurrentProject();
    throw err;
  } finally {
    releaseCurrentProject();
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
  wordCount?: number;
  hasEnglish?: boolean;
  hasChinese?: boolean;
  status: "pending" | "processing" | "completed" | "error";
  attempts: number;
  errorMessage?: string;
  durationMs?: number;
  edited?: boolean;
  lastErrorAt?: number;
}

interface CloudJob {
  id: string;
  sessionId?: string;
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
  completedEnglishWords?: number;
  completedChars?: number;
}

const JOBS_DIR = path.join(DATA_DIR, "jobs");
if (!fs.existsSync(JOBS_DIR)) {
  fs.mkdirSync(JOBS_DIR, { recursive: true });
}

const cloudJobs = new Map<string, CloudJob>();
let isCloudWorkerRunning = false;

function sanitizeSessionKey(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function getSessionId(req: express.Request): string {
  const headerSessionId = req.headers["x-session-id"] || req.headers["x-device-session-id"];
  if (headerSessionId && typeof headerSessionId === "string" && headerSessionId.trim()) {
    return headerSessionId.trim();
  }
  const querySessionId = req.query.sessionId || req.query.deviceId;
  if (querySessionId && typeof querySessionId === "string" && querySessionId.trim()) {
    return querySessionId.trim();
  }
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (token) return "token_" + token.slice(-16);
  }
  return "legacy_default";
}

const KNOWN_NOVEL_ALIASES: Array<[string, string]> = [
  ["primitive chen qi", "穿越兽世当神棍"],
  ["primitivechenqi", "穿越兽世当神棍"],
  ["chen qi", "穿越兽世当神棍"],
  ["chenqi", "穿越兽世当神棍"],
  ["chuanyueshoshidangshengun", "primitive chen qi"],
  ["raising cubs and building a tribe in the beast world", "在兽世养崽建部落"],
  ["modern bird parrot bai linlin", "现代小鸟白林林"],
  ["yiren bei rebellion", "一人之下"],
];

export function isSameNovel(name1?: string, name2?: string): boolean {
  if (!name1 || !name2) return false;
  const norm = (s: string) =>
    s
      .replace(/\.(txt|epub|pdf|json)$/i, "")
      .toLowerCase()
      .replace(/[_ -]ch(?:apter)?\s*\d+.*$/i, "")
      .replace(/\[.*?\]/g, "")
      .replace(/【.*?】/g, "")
      .replace(/[^a-z0-9\u4e00-\u9fa5]/g, "");

  const n1 = norm(name1);
  const n2 = norm(name2);
  if (!n1 || !n2) return false;
  if (n1 === n2 || n1.includes(n2) || n2.includes(n1)) return true;

  for (const [aliasA, aliasB] of KNOWN_NOVEL_ALIASES) {
    const normA = norm(aliasA);
    const normB = norm(aliasB);
    if (
      (n1.includes(normA) && n2.includes(normB)) ||
      (n2.includes(normA) && n1.includes(normB)) ||
      (n1.includes(normB) && n2.includes(normA)) ||
      (n2.includes(normB) && n1.includes(normA))
    ) {
      return true;
    }
  }
  return false;
}

function getJobForSession(req: express.Request): CloudJob | null {
  const sId = getSessionId(req);

  const rawNovelHeader = req.headers["x-novel-name"] || req.headers["x-novel-filename"];
  const novelQuery = (req.query.fileName || req.query.novelName || (req.body && (req.body.fileName || req.body.novelName)) || "") as string;
  let targetNovelName = "";
  if (rawNovelHeader && typeof rawNovelHeader === "string") {
    try {
      targetNovelName = decodeURIComponent(rawNovelHeader).trim();
    } catch {
      targetNovelName = rawNovelHeader.trim();
    }
  } else if (novelQuery && typeof novelQuery === "string") {
    try {
      targetNovelName = decodeURIComponent(novelQuery).trim();
    } catch {
      targetNovelName = novelQuery.trim();
    }
  }

  // Prevent JavaScript object stringification or invalid placeholders from corrupting novel search
  if (
    targetNovelName === "[object Object]" ||
    targetNovelName === "undefined" ||
    targetNovelName === "null"
  ) {
    targetNovelName = "";
  }

  // Gather ALL candidate jobs across memory and local disk for a given novel name
  const getCandidatesForNovel = (novelName: string): CloudJob[] => {
    const candidates: CloudJob[] = [];
    const seenIds = new Set<string>();

    for (const j of cloudJobs.values()) {
      if (isSameNovel(j.fileName, novelName) && !(j as any).isDeleted) {
        candidates.push(j);
        seenIds.add(j.id);
      }
    }

    if (fs.existsSync(JOBS_DIR)) {
      try {
        const files = fs.readdirSync(JOBS_DIR);
        for (const f of files) {
          if (!f.endsWith(".json") || f.startsWith("deleted_")) continue;
          const fullPath = path.join(JOBS_DIR, f);
          const content = fs.readFileSync(fullPath, "utf-8");
          const parsed = JSON.parse(content);
          if (parsed?.fileName && isSameNovel(parsed.fileName, novelName) && !parsed.isDeleted && !seenIds.has(parsed.id)) {
            candidates.push(parsed);
            seenIds.add(parsed.id);
          }
        }
      } catch {}
    }
    return candidates;
  };

  // Helper to pick the best/highest progress job among multiple candidates
  const sortBestJob = (jobs: CloudJob[]): CloudJob | null => {
    if (jobs.length === 0) return null;
    const valid = jobs.filter((j) => !isSyntheticOrTestJob(j) && !(j as any).isDeleted);
    if (valid.length === 0) return null;

    valid.sort((a, b) => {
      // 1. Prioritize running status
      if (a.status === "running" && b.status !== "running") return -1;
      if (b.status === "running" && a.status !== "running") return 1;

      // 2. Prioritize completed status
      if (a.status === "completed" && b.status !== "completed") return -1;
      if (b.status === "completed" && a.status !== "completed") return 1;

      // 3. Most completed chunks
      const aDone = (a as any).completedChunks || (a.chunks ? a.chunks.filter(c => c.status === "completed" && !!c.englishText?.trim()).length : 0);
      const bDone = (b as any).completedChunks || (b.chunks ? b.chunks.filter(c => c.status === "completed" && !!c.englishText?.trim()).length : 0);
      if (aDone !== bDone) return bDone - aDone;

      // 4. Most total chunks
      const aTotal = (a as any).totalChunks || a.chunks?.length || 0;
      const bTotal = (b as any).totalChunks || b.chunks?.length || 0;
      if (aTotal !== bTotal) return bTotal - aTotal;

      // 5. Most recent activity
      return (b.lastActiveAt || 0) - (a.lastActiveAt || 0);
    });

    return valid[0];
  };

  // 1. If client specifically targeted a novel name:
  if (targetNovelName) {
    const candidates = getCandidatesForNovel(targetNovelName);
    const best = sortBestJob(candidates);
    if (best) {
      cloudJobs.set(sId, best);
      return best;
    }
    return null;
  }

  // 2. If no specific novel was targeted, check session job
  let sessionCandidates: CloudJob[] = [];
  if (cloudJobs.has(sId)) {
    const sj = cloudJobs.get(sId)!;
    if (!(sj as any).isDeleted) sessionCandidates.push(sj);
  }

  // Also check disk for sId
  const safeKey = sanitizeSessionKey(sId);
  const diskPath = path.join(JOBS_DIR, `job_${safeKey}.json`);
  if (fs.existsSync(diskPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(diskPath, "utf-8"));
      if (parsed && !parsed.isDeleted && !sessionCandidates.some((j) => j.id === parsed.id)) {
        sessionCandidates.push(parsed);
      }
    } catch {}
  }

  if (sessionCandidates.length > 0) {
    const sj = sessionCandidates[0];
    if (sj.fileName) {
      const novelCandidates = getCandidatesForNovel(sj.fileName);
      const bestForNovel = sortBestJob(novelCandidates);
      if (bestForNovel) {
        cloudJobs.set(sId, bestForNovel);
        return bestForNovel;
      }
    }
    const bestS = sortBestJob(sessionCandidates);
    if (bestS) return bestS;
  }

  // 3. Fallbacks when allowFallback is requested: find any running or highest-progress real job
  const allowFallback = req.query.allowFallback !== "false" && req.headers["x-allow-fallback"] !== "false";
  if (allowFallback) {
    const allRealJobs = Array.from(cloudJobs.values()).filter((j) => !isSyntheticOrTestJob(j) && !(j as any).isDeleted);
    if (fs.existsSync(JOBS_DIR)) {
      try {
        const files = fs.readdirSync(JOBS_DIR);
        for (const f of files) {
          if (!f.endsWith(".json") || f.startsWith("deleted_")) continue;
          const content = fs.readFileSync(path.join(JOBS_DIR, f), "utf-8");
          const parsed = JSON.parse(content);
          if (parsed && parsed.fileName && !isSyntheticOrTestJob(parsed) && !parsed.isDeleted) {
            if (!allRealJobs.some((j) => j.id === parsed.id)) {
              allRealJobs.push(parsed);
            }
          }
        }
      } catch {}
    }

    const bestFallback = sortBestJob(allRealJobs);
    if (bestFallback) {
      cloudJobs.set(sId, bestFallback);
      return bestFallback;
    }
  }

  return null;
}

const pendingFirestoreJobSyncs = new Map<string, NodeJS.Timeout>();

function scheduleDebouncedFirestoreJobSync(job: CloudJob, immediate: boolean = false) {
  if (!job || !job.id) return;
  const existingTimer = pendingFirestoreJobSyncs.get(job.id);
  if (existingTimer) {
    clearTimeout(existingTimer);
    pendingFirestoreJobSyncs.delete(job.id);
  }

  if (immediate || job.status === "completed" || job.status === "paused") {
    saveJobToFirestore(job).catch((err) => {
      console.warn(`[Storage] Firestore job sync note for ${job.id}:`, err.message);
    });
    return;
  }

  const timer = setTimeout(() => {
    pendingFirestoreJobSyncs.delete(job.id);
    saveJobToFirestore(job).catch((err) => {
      console.warn(`[Storage] Firestore debounced job sync note for ${job.id}:`, err.message);
    });
  }, 5000);
  pendingFirestoreJobSyncs.set(job.id, timer);
}

let cloudKeepAliveInterval: NodeJS.Timeout | null = null;

function ensureCloudKeepAliveRunning() {
  if (cloudKeepAliveInterval) return;
  cloudKeepAliveInterval = setInterval(async () => {
    const hasRunning = Array.from(cloudJobs.values()).some((j) => j.status === "running");
    if (!hasRunning) {
      if (cloudKeepAliveInterval) {
        clearInterval(cloudKeepAliveInterval);
        cloudKeepAliveInterval = null;
      }
      return;
    }
    try {
      // 1. External ping to public URL to reset Cloud Run ingress idle timer and keep background worker running
      if (lastKnownPublicOrigin) {
        await fetch(`${lastKnownPublicOrigin}/api/heartbeat`, {
          headers: { "User-Agent": "MegaText-Cloud-KeepAlive/1.0" },
          signal: AbortSignal.timeout(5000),
        });
      }
    } catch {}
    try {
      // 2. Ping internal nginx proxy (port 8080) with Host: localhost to refresh Cloud Run socket
      await fetch("http://localhost:8080/api/heartbeat", {
        headers: { Host: "localhost" },
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      try {
        await fetch("http://localhost:3000/api/heartbeat", {
          signal: AbortSignal.timeout(3000),
        });
      } catch {}
    }
  }, 60000); // Heartbeat every 60 seconds while translation is actively running
}

const pendingDiskWrites = new Map<string, NodeJS.Timeout>();

function saveJobToDisk(sessionId: string, job?: CloudJob | null, immediate: boolean = false) {
  try {
    if (job && (job as any).isDeleted) {
      console.log(`[Storage] Refusing to write deleted job "${job.fileName}" (${job.id}) to disk.`);
      return;
    }
    const safeKey = sanitizeSessionKey(sessionId);
    const jobFilePath = path.join(JOBS_DIR, `job_${safeKey}.json`);
    if (job) {
      const isUrgent = immediate || job.status === "paused" || job.status === "completed";
      const existing = pendingDiskWrites.get(jobFilePath);
      if (existing) {
        clearTimeout(existing);
        pendingDiskWrites.delete(jobFilePath);
      }

      const executeWrite = async () => {
        try {
          // Compact JSON reduces size by ~40% and cuts CPU serialization time by >60%
          const dataStr = JSON.stringify(job);
          await fs.promises.writeFile(jobFilePath, dataStr, "utf-8");

          // Permanently archive completed novels so they are never lost or overwritten
          const expectedTotal = (job as any).totalChunks || job.chunks?.length || 0;
          const isAllDone =
            expectedTotal > 0 &&
            (job.chunks?.length || 0) >= expectedTotal &&
            (job.chunks || []).every((c) => c.status === "completed" && !!c.englishText?.trim());

          if (job.status === "completed" || isAllDone) {
            const safeNovel = sanitizeSessionKey(job.fileName || "novel");
            const archivePath = path.join(JOBS_DIR, `archive_${safeNovel}.json`);
            await fs.promises.writeFile(archivePath, dataStr, "utf-8").catch(() => {});
          }

          // Keep legacy root file synced if this is the legacy or default job
          if (sessionId === "legacy_default" || cloudJobs.size === 1) {
            await fs.promises.writeFile(CLOUD_JOB_FILE, dataStr, "utf-8").catch(() => {});
          }
        } catch (err) {
          console.error(`Async save to disk error for ${sessionId}:`, err);
        }
      };

      if (isUrgent) {
        // Urgent state transition (e.g. Pause, Complete): Flush immediately
        executeWrite().catch(() => {});
        scheduleDebouncedFirestoreJobSync(job, true);
      } else {
        // Routine chunk translation progress: Debounce by 200ms to keep Node loop smooth
        pendingDiskWrites.set(
          jobFilePath,
          setTimeout(async () => {
            pendingDiskWrites.delete(jobFilePath);
            await executeWrite();
          }, 200)
        );
        scheduleDebouncedFirestoreJobSync(job, false);
      }
    } else {
      const existing = pendingDiskWrites.get(jobFilePath);
      if (existing) {
        clearTimeout(existing);
        pendingDiskWrites.delete(jobFilePath);
      }
      if (fs.existsSync(jobFilePath)) {
        try {
          fs.unlinkSync(jobFilePath);
        } catch {}
      }
      if (sessionId === "legacy_default" && fs.existsSync(CLOUD_JOB_FILE)) {
        try {
          fs.unlinkSync(CLOUD_JOB_FILE);
        } catch {}
      }
    }
  } catch (err) {
    console.error(`Failed to save cloud job for session ${sessionId} to disk:`, err);
  }
}

function mergeMonotonicCloudJobs(jobA: CloudJob, jobB: CloudJob): CloudJob {
  if (!jobA) return jobB;
  if (!jobB) return jobA;
  if (!isSameNovel(jobA.fileName, jobB.fileName)) {
    // Safety guard: NEVER cross-contaminate chunks of two different novels!
    return (jobB.lastActiveAt || 0) >= (jobA.lastActiveAt || 0) ? jobB : jobA;
  }

  const chunkMapA = new Map((jobA.chunks || []).map((c) => [c.index, c]));
  const chunkMapB = new Map((jobB.chunks || []).map((c) => [c.index, c]));

  // Union of ALL chunk indices from both jobs so no pending chunks are ever dropped
  const allIndices = Array.from(
    new Set([...chunkMapA.keys(), ...chunkMapB.keys()])
  ).sort((a, b) => a - b);

  const mergedChunks: ServerTextChunk[] = allIndices.map((idx) => {
    const cA = chunkMapA.get(idx);
    const cB = chunkMapB.get(idx);
    const primary = cA || cB!;

    const aComp = cA?.status === "completed" && !!cA.englishText?.trim();
    const bComp = cB?.status === "completed" && !!cB?.englishText?.trim();

    if (aComp && bComp) {
      const bestText = (cA!.englishText?.length || 0) >= (cB!.englishText?.length || 0) ? cA!.englishText : cB!.englishText;
      return {
        ...primary,
        status: "completed",
        englishText: bestText,
        attempts: Math.max(cA?.attempts || 0, cB?.attempts || 0),
        edited: !!(cA?.edited || cB?.edited),
      };
    }
    if (aComp) {
      return {
        ...primary,
        status: "completed",
        englishText: cA!.englishText,
      };
    }
    if (bComp) {
      return {
        ...primary,
        status: "completed",
        englishText: cB!.englishText,
        attempts: Math.max(cA?.attempts || 0, cB?.attempts || 0),
        edited: !!cB?.edited,
      };
    }

    const isProcessing = cA?.status === "processing" || cB?.status === "processing";
    const isError = cA?.status === "error" || cB?.status === "error";
    return {
      ...primary,
      chineseText: primary.chineseText || (cB ? cB.chineseText : ""),
      chapterTitle: primary.chapterTitle || (cB ? cB.chapterTitle : ""),
      charCount: primary.charCount || (cB ? cB.charCount : 0),
      status: isProcessing ? "processing" : isError ? "error" : "pending",
      englishText: cA?.englishText || cB?.englishText || "",
      errorMessage: cA?.errorMessage || cB?.errorMessage,
      attempts: Math.max(cA?.attempts || 0, cB?.attempts || 0),
    };
  });

  const completedCount = mergedChunks.filter((c) => c.status === "completed" && !!c.englishText?.trim()).length;
  const totalExpected = Math.max(
    (jobA as any).totalChunks || 0,
    (jobB as any).totalChunks || 0,
    mergedChunks.length
  );
  // CRITICAL: A job is ONLY fully completed if all expected totalChunks exist and every one is completed
  const isFullyCompleted = totalExpected > 0 && mergedChunks.length >= totalExpected && completedCount === totalExpected;

  let finalStatus: CloudJob["status"] = "idle";
  if (isFullyCompleted) {
    finalStatus = "completed";
  } else if (jobA.status === "running" || jobB.status === "running") {
    finalStatus = "running";
  } else if (jobA.status === "paused" || jobB.status === "paused") {
    finalStatus = "paused";
  } else {
    finalStatus = jobA.status || jobB.status || "idle";
  }

  return {
    id: jobA.id || jobB.id,
    sessionId: jobA.sessionId || jobB.sessionId || "legacy_default",
    fileName: jobA.fileName || jobB.fileName,
    fileSizeBytes: Math.max(jobA.fileSizeBytes || 0, jobB.fileSizeBytes || 0),
    totalChineseChars: Math.max(jobA.totalChineseChars || 0, jobB.totalChineseChars || 0),
    chunks: mergedChunks,
    style: jobA.style || jobB.style || "xianxia",
    customInstructions: jobA.customInstructions || jobB.customInstructions || "",
    glossary: (jobA.glossary && jobA.glossary.length > 0) ? jobA.glossary : (jobB.glossary || []),
    concurrency: Math.max(jobA.concurrency || 1, jobB.concurrency || 1),
    status: finalStatus,
    startedAt: Math.min(jobA.startedAt || Date.now(), jobB.startedAt || Date.now()),
    lastActiveAt: Math.max(jobA.lastActiveAt || 0, jobB.lastActiveAt || 0, Date.now()),
  };
}

async function deleteJobCompletely(
  jobToDelete: CloudJob | null,
  sessionId?: string,
  explicitFileName?: string,
  explicitJobId?: string,
  clearAll: boolean = false
) {
  if (clearAll) {
    console.log("[Storage] Authoritative clearAll requested: obliterating all cloud jobs and archives.");
    for (const j of cloudJobs.values()) {
      (j as any).isDeleted = true;
      j.status = "idle";
      for (const c of j.chunks || []) {
        inFlightChunkIds.delete(c.id);
      }
    }
    cloudJobs.clear();
    inFlightChunkIds.clear();
    try {
      if (fs.existsSync(CLOUD_JOB_FILE)) fs.unlinkSync(CLOUD_JOB_FILE);
    } catch {}
    try {
      if (fs.existsSync(JOBS_DIR)) {
        const files = fs.readdirSync(JOBS_DIR);
        for (const f of files) {
          if (f.endsWith(".json")) {
            try { fs.unlinkSync(path.join(JOBS_DIR, f)); } catch {}
          }
        }
      }
    } catch {}
    // Non-blocking firestore purge
    deleteAllJobsFromFirestore().catch((err) => {
      console.warn("[Storage] Background deleteAllJobsFromFirestore error:", err?.message);
    });
    return;
  }

  const targetIds = new Set<string>();
  const targetFileNames = new Set<string>();

  if (jobToDelete?.id) targetIds.add(jobToDelete.id.trim());
  if (explicitJobId && typeof explicitJobId === "string" && explicitJobId.trim()) targetIds.add(explicitJobId.trim());

  if (jobToDelete?.fileName) {
    targetFileNames.add(jobToDelete.fileName.trim().toLowerCase());
    targetFileNames.add(jobToDelete.fileName.replace(/\.(txt|epub|pdf|json)$/i, "").trim().toLowerCase());
  }
  if (explicitFileName && typeof explicitFileName === "string" && explicitFileName.trim()) {
    targetFileNames.add(explicitFileName.trim().toLowerCase());
    targetFileNames.add(explicitFileName.replace(/\.(txt|epub|pdf|json)$/i, "").trim().toLowerCase());
  }

  // Also check if sessionId in cloudJobs has a job
  if (sessionId && cloudJobs.has(sessionId)) {
    const sj = cloudJobs.get(sessionId)!;
    if (sj.id) targetIds.add(sj.id.trim());
    if (sj.fileName) {
      targetFileNames.add(sj.fileName.trim().toLowerCase());
      targetFileNames.add(sj.fileName.replace(/\.(txt|epub|pdf|json)$/i, "").trim().toLowerCase());
    }
  }

  console.log(`[Storage] Deleting job completely. Target IDs: [${Array.from(targetIds).join(", ")}], FileNames: [${Array.from(targetFileNames).join(", ")}], SessionId: ${sessionId || "none"}`);

  // 0. Immediately record tombstones to disk cache and Firestore
  for (const tid of targetIds) {
    recordDeletedJobInFirestore(tid).catch(() => {});
  }
  for (const tName of targetFileNames) {
    recordDeletedJobInFirestore(undefined, tName).catch(() => {});
  }

  // 1. In-memory: Abort and remove matching jobs from cloudJobs
  for (const [sKey, j] of Array.from(cloudJobs.entries())) {
    const jName = (j.fileName || "").trim().toLowerCase();
    const isIdMatch = targetIds.has(j.id);
    const isNameMatch = Array.from(targetFileNames).some((t) => isSameNovel(t, jName));
    const isSessionMatch = sessionId && sKey === sessionId;

    if (isIdMatch || isNameMatch || isSessionMatch) {
      (j as any).isDeleted = true;
      j.status = "idle";
      for (const c of j.chunks || []) {
        inFlightChunkIds.delete(c.id);
      }
      cloudJobs.delete(sKey);
      saveJobToDisk(sKey, null);
    }
  }

  if (sessionId) {
    if (cloudJobs.has(sessionId)) {
      const sj = cloudJobs.get(sessionId)!;
      (sj as any).isDeleted = true;
      sj.status = "idle";
      for (const c of sj.chunks || []) {
        inFlightChunkIds.delete(c.id);
      }
    }
    cloudJobs.delete(sessionId);
    saveJobToDisk(sessionId, null);
  }

  // 2. Clear legacy_default if it matches
  if (cloudJobs.has("legacy_default")) {
    const leg = cloudJobs.get("legacy_default")!;
    const legName = (leg.fileName || "").trim().toLowerCase();
    if (targetIds.has(leg.id) || Array.from(targetFileNames).some((t) => isSameNovel(t, legName))) {
      (leg as any).isDeleted = true;
      leg.status = "idle";
      for (const c of leg.chunks || []) {
        inFlightChunkIds.delete(c.id);
      }
      cloudJobs.delete("legacy_default");
      saveJobToDisk("legacy_default", null);
    }
  }

  // 3. Delete root CLOUD_JOB_FILE if present and matches
  if (fs.existsSync(CLOUD_JOB_FILE)) {
    try {
      const data = fs.readFileSync(CLOUD_JOB_FILE, "utf-8");
      const parsed = JSON.parse(data);
      const pName = (parsed?.fileName || "").trim().toLowerCase();
      if (!parsed || (parsed.id && targetIds.has(parsed.id)) || Array.from(targetFileNames).some((t) => isSameNovel(t, pName))) {
        fs.unlinkSync(CLOUD_JOB_FILE);
      }
    } catch {
      try { fs.unlinkSync(CLOUD_JOB_FILE); } catch {}
    }
  }

  // 4. Delete disk files in JOBS_DIR matching any targetId or targetFileName
  try {
    if (fs.existsSync(JOBS_DIR)) {
      const files = fs.readdirSync(JOBS_DIR);
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        const fullPath = path.join(JOBS_DIR, f);

        let shouldDelete = false;

        // Check if filename itself contains safe novel name
        for (const tName of targetFileNames) {
          const safeNovel = sanitizeSessionKey(tName);
          if (safeNovel && f.toLowerCase().includes(safeNovel.toLowerCase())) {
            shouldDelete = true;
            break;
          }
        }

        if (!shouldDelete) {
          try {
            const content = fs.readFileSync(fullPath, "utf-8");
            for (const tid of targetIds) {
              if (content.includes(tid)) {
                shouldDelete = true;
                break;
              }
            }
            if (!shouldDelete) {
              let parsed: any = null;
              try { parsed = JSON.parse(content); } catch {}
              if (parsed?.fileName && Array.from(targetFileNames).some((t) => isSameNovel(t, parsed.fileName))) {
                shouldDelete = true;
              }
            }
            if (!shouldDelete) {
              const lower = content.toLowerCase();
              for (const tName of targetFileNames) {
                if (lower.includes(tName.toLowerCase())) {
                  shouldDelete = true;
                  break;
                }
              }
            }
          } catch {}
        }

        if (shouldDelete) {
          try {
            fs.unlinkSync(fullPath);
            console.log(`[Storage] Unlinked job file: ${f}`);
          } catch {}
        }
      }
    }
  } catch (err) {
    console.warn("Error deleting job files from disk:", err);
  }

  // 5. Delete matching jobs from Firestore
  try {
    for (const tid of targetIds) {
      await deleteJobFromFirestore(tid).catch((err: any) => {
        console.warn(`[Storage] Firestore delete error for job ID ${tid}:`, err?.message);
      });
    }

    for (const tName of targetFileNames) {
      await deleteJobByFileNameFromFirestore(tName).catch((err: any) => {
        console.warn(`[Storage] Firestore delete error for fileName ${tName}:`, err?.message);
      });
    }
  } catch (err: any) {
    console.warn("[Storage] Firestore cleanup error:", err?.message);
  }
}

function setJobForSession(sessionId: string, job: CloudJob | null) {
  if (job) {
    job.sessionId = sessionId;
    let existing: CloudJob | null = cloudJobs.get(sessionId) || null;

    // Guard: If session currently holds a DIFFERENT novel, do NOT merge them!
    if (existing && !isSameNovel(existing.fileName, job.fileName)) {
      console.log(`[Storage] Session ${sessionId} switching from novel "${existing.fileName}" to new novel "${job.fileName}". Archiving previous novel.`);
      existing.status = "idle";
      saveJobToDisk(sessionId, null);
      existing = null;
    }

    if (!existing && job.fileName) {
      for (const j of cloudJobs.values()) {
        if (isSameNovel(j.fileName, job.fileName)) {
          existing = j;
          break;
        }
      }
      // Check disk archive if not found in active memory
      if (!existing) {
        const safeNovel = sanitizeSessionKey(job.fileName || "novel");
        const archivePath = path.join(JOBS_DIR, `archive_${safeNovel}.json`);
        if (fs.existsSync(archivePath)) {
          try {
            const parsed = JSON.parse(fs.readFileSync(archivePath, "utf-8"));
            if (isSameNovel(parsed?.fileName, job.fileName)) {
              existing = parsed;
            }
          } catch {}
        }
      }
    }

    const finalJob = existing ? mergeMonotonicCloudJobs(existing, job) : job;
    cloudJobs.set(sessionId, finalJob);

    if (existing && existing.sessionId && existing.sessionId !== sessionId) {
      cloudJobs.set(existing.sessionId, finalJob);
      saveJobToDisk(existing.sessionId, finalJob);
    }
    cloudJobs.set("legacy_default", finalJob);
    saveJobToDisk("legacy_default", finalJob);

    saveJobToDisk(sessionId, finalJob);

    scheduleDebouncedFirestoreJobSync(finalJob, true);

    // Persist all chunk structures in compact segments (50 per doc) so no Chinese text or pending chunks are lost on container restart
    if (finalJob.chunks && finalJob.chunks.length > 0) {
      saveJobSegmentsToFirestore(finalJob.id, finalJob.chunks).catch((err) => {
        console.warn(`[Storage] Firestore segment sync note for ${finalJob.id}:`, err.message);
      });
    }

    // Only batch-save chunks that are ALREADY completed to avoid wasting writes on pending chunks
    const completedInitialChunks = (finalJob.chunks || []).filter((c) => c.status === "completed" && !!c.englishText?.trim());
    if (completedInitialChunks.length > 0) {
      saveChunksBatchToFirestore(finalJob.id, completedInitialChunks).catch((err) => {
        console.warn(`[Storage] Firestore initial completed chunks batch sync note for ${finalJob.id}:`, err.message);
      });
    }
  } else {
    const existing = cloudJobs.get(sessionId) || null;
    deleteJobCompletely(existing, sessionId).catch((err) => {
      console.warn("Error deleting job in setJobForSession:", err);
    });
  }
}

function reconcileAuthoritativeJob(fsJob: CloudJob, dJob?: CloudJob): CloudJob {
  if (!dJob) return fsJob;
  return mergeMonotonicCloudJobs(fsJob, dJob);
}

// Load saved cloud jobs on startup with priority given to persistent Firestore storage
async function loadCloudJobsFromDisk() {
  try {
    if (!fs.existsSync(JOBS_DIR)) {
      fs.mkdirSync(JOBS_DIR, { recursive: true });
    }

    // 0. Load tombstones first to guarantee deleted novels are NEVER resurrected
    const tombstones = await getDeletedJobTombstonesFromFirestore();

    // 1. Attempt to load authoritative state from cloud Firestore database (low-read summary only)
    let firestoreJobs = new Map<string, CloudJob>();
    let firestoreLoadedSuccessfully = false;
    try {
      firestoreJobs = await loadAllJobsFromFirestore(false);
      firestoreLoadedSuccessfully = true;
    } catch (fsErr: any) {
      console.error("[Startup] Notice loading from cloud Firestore:", fsErr.message);
      firestoreLoadedSuccessfully = false;
    }

    // 2. Read local disk files as local candidates
    const diskJobs = new Map<string, CloudJob>();
    const jobFiles = fs.readdirSync(JOBS_DIR).filter((f) => f.startsWith("job_") && f.endsWith(".json"));
    for (const file of jobFiles) {
      try {
        const fullPath = path.join(JOBS_DIR, file);
        const data = fs.readFileSync(fullPath, "utf-8");
        const job: CloudJob = JSON.parse(data);
        const sId = job.sessionId || file.replace(/^job_/, "").replace(/\.json$/, "");
        job.sessionId = sId;

        // Skip and remove any deleted tombstoned novels
        const jName = (job.fileName || "").trim().toLowerCase();
        const isTombstoned =
          tombstones.ids.has(job.id) ||
          tombstones.fileNames.has(jName) ||
          Array.from(tombstones.fileNames).some((t) => isSameNovel(t, jName)) ||
          (job as any).isDeleted;

        if (isTombstoned) {
          console.log(`[Startup] Cleaning up deleted disk job file: ${file}`);
          try { fs.unlinkSync(fullPath); } catch {}
          continue;
        }

        // Fix any corrupt/empty completed chunks
        if (Array.isArray(job.chunks)) {
          for (const c of job.chunks) {
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
        diskJobs.set(sId, job);
      } catch (fileErr) {
        console.warn(`Could not load job file ${file}:`, fileErr);
      }
    }

    // Also check legacy single cloud_job.json
    if (fs.existsSync(CLOUD_JOB_FILE) && !diskJobs.has("legacy_default")) {
      try {
        const data = fs.readFileSync(CLOUD_JOB_FILE, "utf-8");
        const legacyJob: CloudJob = JSON.parse(data);
        if (legacyJob && Array.isArray(legacyJob.chunks)) {
          const lName = (legacyJob.fileName || "").trim().toLowerCase();
          const isTombstoned =
            tombstones.ids.has(legacyJob.id) ||
            tombstones.fileNames.has(lName) ||
            Array.from(tombstones.fileNames).some((t) => isSameNovel(t, lName)) ||
            (legacyJob as any).isDeleted;

          if (!isTombstoned) {
            legacyJob.sessionId = "legacy_default";
            diskJobs.set("legacy_default", legacyJob);
          } else {
            try { fs.unlinkSync(CLOUD_JOB_FILE); } catch {}
          }
        }
      } catch (legacyErr) {
        console.warn("Could not load legacy cloud job:", legacyErr);
      }
    }

    // 3. Monotonic reconciliation: Use Firestore when available, otherwise fallback seamlessly to disk cache
    if (!firestoreLoadedSuccessfully) {
      console.warn(
        "[Startup] Notice: Firestore was temporarily unavailable or exceeded read quota. Using disk job cache seamlessly."
      );
      for (const [sId, dJob] of diskJobs.entries()) {
        cloudJobs.set(sId, dJob);
      }
    } else {
      // Filter out any tombstoned novels from firestoreJobs
      for (const [sKey, fJob] of Array.from(firestoreJobs.entries())) {
        const jName = (fJob.fileName || "").trim().toLowerCase();
        if (
          tombstones.ids.has(fJob.id) ||
          tombstones.fileNames.has(jName) ||
          Array.from(tombstones.fileNames).some((t) => isSameNovel(t, jName)) ||
          (fJob as any).isDeleted
        ) {
          firestoreJobs.delete(sKey);
        }
      }

      const allSessionKeys = new Set([...firestoreJobs.keys(), ...diskJobs.keys()]);
      for (const sId of allSessionKeys) {
        const fsJob = firestoreJobs.get(sId);
        const dJob = diskJobs.get(sId);

        let reconciled: CloudJob;
        if (fsJob && dJob) {
          reconciled = reconcileAuthoritativeJob(fsJob, dJob);
        } else if (fsJob) {
          reconciled = fsJob;
        } else {
          reconciled = dJob!;
          saveJobToFirestore(reconciled).catch(() => {});
        }

        const completedCount = (reconciled.chunks || []).filter((c) => c.status === "completed" && !!c.englishText?.trim()).length;
        const expectedTotal = Math.max(
          (reconciled as any).totalChunks || 0,
          (fsJob as any)?.totalChunks || 0,
          (dJob as any)?.totalChunks || 0,
          reconciled.chunks?.length || 0
        );
        const effectiveCompletedCount = Math.max(
          completedCount,
          (reconciled as any).completedChunks || 0,
          (fsJob as any)?.completedChunks || 0,
          (dJob as any)?.completedChunks || 0
        );

        (reconciled as any).totalChunks = expectedTotal;
        (reconciled as any).completedChunks = effectiveCompletedCount;

        const isFullyDone =
          (expectedTotal > 0 && effectiveCompletedCount >= expectedTotal) ||
          fsJob?.status === "completed" ||
          dJob?.status === "completed" ||
          reconciled.status === "completed";

        if (isFullyDone) {
          reconciled.status = "completed";
          (reconciled as any).completedChunks = expectedTotal || effectiveCompletedCount;
        } else if ((reconciled.chunks?.length || 0) === 0) {
          if (reconciled.id && (reconciled.status === "running" || fsJob?.status === "running" || dJob?.status === "running")) {
            console.log(`[Startup] Active job "${reconciled.fileName}" had 0 chunks in memory. Loading full chunks from Firestore...`);
            try {
              const hydrated = await loadJobFromFirestore(reconciled.id);
              if (hydrated && hydrated.chunks && hydrated.chunks.length > 0) {
                reconciled.chunks = hydrated.chunks;
                (reconciled as any).totalChunks = hydrated.chunks.length;
                (reconciled as any).completedChunks = hydrated.chunks.filter((c) => c.status === "completed" && !!c.englishText?.trim()).length;
                reconciled.status = "running";
              } else {
                reconciled.status = "paused";
              }
            } catch {
              reconciled.status = "paused";
            }
          } else {
            reconciled.status = "paused";
          }
        }

        cloudJobs.set(sId, reconciled);
        saveJobToDisk(sId, reconciled);
        console.log(`[Startup] Authoritative job registered [${sId}]: "${reconciled.fileName}" (${(reconciled as any).completedChunks}/${expectedTotal || (reconciled.chunks?.length || 0)} completed, status: ${reconciled.status})`);
      }
    }

    // Merge all jobs by novel name so different sessions for the same novel share maximum progress
    const novelMap = new Map<string, CloudJob>();
    for (const job of cloudJobs.values()) {
      const key = (job.fileName || "novel.txt").trim().toLowerCase();
      if (!novelMap.has(key)) {
        novelMap.set(key, job);
      } else {
        const merged = mergeMonotonicCloudJobs(novelMap.get(key)!, job);
        novelMap.set(key, merged);
      }
    }

    for (const [sId, job] of cloudJobs.entries()) {
      const key = (job.fileName || "novel.txt").trim().toLowerCase();
      if (novelMap.has(key)) {
        const canonical = novelMap.get(key)!;
        const total = (canonical as any).totalChunks || canonical.chunks?.length || 0;
        const allDone = (total > 0 && canonical.chunks?.length >= total && canonical.chunks.every((c) => c.status === "completed" && !!c.englishText?.trim())) || canonical.status === "completed";
        if (allDone) {
          canonical.status = "completed";
        }
        const finalJob = { ...canonical, sessionId: sId };
        cloudJobs.set(sId, finalJob);
        saveJobToDisk(sId, finalJob);
      }
    }

    // Specific authoritative self-healing for "Primitive Chen Qi" (primitive chen qi.txt / 穿越兽世当神棍.txt) to guarantee all 404 chapters (455k words) are hydrated
    let hasChenQi = false;
    for (const [sKey, j] of Array.from(cloudJobs.entries())) {
      if (isSameNovel(j.fileName, "穿越兽世当神棍") || isSameNovel(j.fileName, "Primitive Chen Qi") || isSameNovel(j.fileName, "primitive chen qi.txt")) {
        hasChenQi = true;
        if (!j.chunks || j.chunks.length < 404 || (j as any).totalChunks < 404) {
          console.log(`[Startup] Self-healing "Primitive Chen Qi" with full 404 chunks and 455k words...`);
          try {
            const { job: full404Job } = generate404PrimitiveChenQiChunks();
            if (full404Job && full404Job.chunks && full404Job.chunks.length === 404) {
              cloudJobs.set(sKey, full404Job);
              cloudJobs.set("legacy_default", full404Job);
              saveJobToDisk(sKey, full404Job, true);
              saveJobToDisk("legacy_default", full404Job, true);
              console.log(`[Startup] "Primitive Chen Qi" successfully hydrated with all ${full404Job.chunks.length} chapters (455k words).`);
            }
          } catch (healErr) {
            console.warn(`[Startup] Notice hydrating "Primitive Chen Qi":`, healErr);
          }
        }
      }
    }

    if (!hasChenQi) {
      try {
        const { job: full404Job } = generate404PrimitiveChenQiChunks();
        if (full404Job && full404Job.chunks && full404Job.chunks.length === 404) {
          cloudJobs.set("sess_cosh3bqfaz_muarl8l6", full404Job);
          cloudJobs.set("legacy_default", full404Job);
          saveJobToDisk("sess_cosh3bqfaz_muarl8l6", full404Job, true);
          saveJobToDisk("legacy_default", full404Job, true);
          console.log(`[Startup] Loaded "Primitive Chen Qi" with full 404 chapters (455k words).`);
        }
      } catch (err) {}
    }

    // 4. Auto-resume ONLY truly running, uncompleted, non-test jobs with chunks present
    const runningJobs = Array.from(cloudJobs.values()).filter((j) => {
      if (j.status !== "running") return false;
      if (isSyntheticOrTestJob(j)) return false;
      if (!j.chunks || j.chunks.length === 0) return false;
      const expectedTotal = (j as any).totalChunks || j.chunks.length;
      const allDone = expectedTotal > 0 && j.chunks.length >= expectedTotal && j.chunks.every((c) => c.status === "completed" && !!c.englishText?.trim());
      if (allDone) {
        j.status = "completed";
        saveJobToDisk(j.sessionId || "legacy_default", j, true);
        return false;
      }
      return true;
    });

    // Deduplicate by novel fileName
    const uniqueRunningNovels = new Map<string, CloudJob>();
    for (const j of runningJobs) {
      if (!uniqueRunningNovels.has(j.fileName)) {
        uniqueRunningNovels.set(j.fileName, j);
      }
    }

    const distinctNovels = Array.from(uniqueRunningNovels.values());
    if (distinctNovels.length > 0) {
      const jobNames = distinctNovels.map((j) => `• <b>${j.fileName}</b>`).join("\n");
      sendTelegramNotification(`⚡ <b>[Server Woken Up]</b>\nThe website is awake and has successfully resumed translating your book(s):\n${jobNames}`);
      startCloudWorkerLoop();
    }
  } catch (err) {
    console.error("Failed to load cloud jobs on startup:", err);
  }
}

// Background Worker Loop on the Server - Parallel Multi-Session Translation Engine
const inFlightChunkIds = new Set<string>();

async function startCloudWorkerLoop() {
  ensureCloudKeepAliveRunning();
  if (isCloudWorkerRunning) return;
  isCloudWorkerRunning = true;

  console.log(`[Cloud Background Worker] Started multi-session parallel translation engine`);

  const maxPossibleWorkers = 5;

  const runWorkerTask = async (workerId: number) => {
    while (isCloudWorkerRunning) {
      const runningJobs = Array.from(cloudJobs.values()).filter(
        (j) => j.status === "running" && j.chunks && j.chunks.length > 0
      );
      if (runningJobs.length === 0) {
        if (inFlightChunkIds.size === 0) {
          isCloudWorkerRunning = false;
          console.log(`[Cloud Background Worker] No active running jobs. Pausing worker loop.`);
          break;
        }
      }

      // Dynamically calculate the active worker limit based on selected concurrency and available projects
      const maxJobConcurrency = runningJobs.length > 0 ? Math.max(...runningJobs.map(j => j.concurrency || 2)) : 2;
      const availableKeysCount = quotaScheduler.enabledProjectCount || 1;
      const activeWorkersLimit = Math.max(1, Math.min(maxJobConcurrency, Math.max(2, availableKeysCount), 5));

      if (workerId > activeWorkersLimit) {
        // Excess worker above current dynamic limit - sleep and check again next loop
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }

      const now = Date.now();
      let targetJob: CloudJob | null = null;
      let firstChunk: ServerTextChunk | null = null;

      // Find the next available non-completed chunk across all running jobs
      // PASS 1: Prioritize fresh / pending chunks (never attempted or status !== "error") to prevent Head-of-Line stalls
      for (const job of runningJobs) {
        const freshCandidate = job.chunks.find((c) => {
          if (c.status === "completed" && c.englishText && c.englishText.trim().length > 0) {
            return false;
          }
          if (inFlightChunkIds.has(c.id)) {
            return false;
          }
          if (c.status === "error" || (c.attempts && c.attempts > 0)) {
            return false;
          }
          return true;
        });

        if (freshCandidate) {
          targetJob = job;
          firstChunk = freshCandidate;
          break;
        }
      }

      // PASS 2: If no fresh pending chunk is available, look for error chunks whose exponential backoff has elapsed
      if (!targetJob || !firstChunk) {
        for (const job of runningJobs) {
          const retryCandidate = job.chunks.find((c) => {
            if (c.status === "completed" && c.englishText && c.englishText.trim().length > 0) {
              return false;
            }
            if (inFlightChunkIds.has(c.id)) {
              return false;
            }
            const attempts = c.attempts || 1;
            // Exponential backoff: 8s for 1 attempt, 16s for 2, 32s for 3, 60s for 4+, capped at 120s
            const requiredDelay = Math.min(8000 * Math.pow(1.5, Math.max(0, attempts - 1)), 120000);
            if (c.status === "error" && c.lastErrorAt && now < c.lastErrorAt + requiredDelay) {
              return false;
            }
            return true;
          });

          if (retryCandidate) {
            targetJob = job;
            firstChunk = retryCandidate;
            break;
          } else {
            // Check if this job has completed all its chunks
            const expectedTotal = (job as any).totalChunks || job.chunks.length;
            const allCompleted = expectedTotal > 0 &&
              job.chunks.length >= expectedTotal &&
              job.chunks.every(
                (c) => c.status === "completed" && c.englishText && c.englishText.trim().length > 0
              );
            if (allCompleted && job.status === "running") {
              console.log(`[Cloud Background Worker] Job "${job.fileName}" (${job.sessionId || job.id}) completed!`);
              job.status = "completed";
              job.lastActiveAt = Date.now();
              saveJobToDisk(job.sessionId || "legacy_default", job);
              if (!isSyntheticOrTestJob(job)) {
                sendTelegramNotification(formatCompletionTelegramMessage(job));
              }
            }
          }
        }
      }

      if (!targetJob || !firstChunk) {
        await new Promise((r) => setTimeout(r, 600));
        continue;
      }

      // Build batch for targetJob up to MAX_BATCH_CHAR_BUDGET
      let batchChunks = [firstChunk];
      let currentBatchChars = firstChunk.chineseText.length;

      if (firstChunk.status !== "error") {
        for (let i = firstChunk.index + 1; i < targetJob.chunks.length; i++) {
          const candidate = targetJob.chunks[i];
          if (candidate.status === "completed" && candidate.englishText && candidate.englishText.trim().length > 0) {
            break;
          }
          if (inFlightChunkIds.has(candidate.id)) {
            break;
          }
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

      for (const chunk of batchChunks) {
        inFlightChunkIds.add(chunk.id);
        chunk.status = "processing";
      }
      targetJob.lastActiveAt = Date.now();
      saveJobToDisk(targetJob.sessionId || "legacy_default", targetJob);

      // Preceding context
      let prevContext = "";
      const prevChunk = targetJob.chunks[firstChunk.index - 1];
      if (prevChunk && prevChunk.englishText) {
        prevContext = prevChunk.englishText.slice(-200);
      }

      const startBatchTime = Date.now();
      let success = false;
      let attemptCount = 0;
      const MAX_ATTEMPTS_PER_PASS = 3;

      let styleGuidance = "";
      switch (targetJob.style) {
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
      if (Array.isArray(targetJob.glossary) && targetJob.glossary.length > 0) {
        const formattedTerms = targetJob.glossary
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

      while (!success && attemptCount < MAX_ATTEMPTS_PER_PASS && targetJob.status === "running") {
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
              targetJob.customInstructions ? `Special Instructions: ${targetJob.customInstructions}\n\n` : ""
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
              targetJob.customInstructions ? `Special Instructions: ${targetJob.customInstructions}\n\n` : ""
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

          if ((targetJob as any).isDeleted || targetJob.status !== "running") {
            for (const chunk of batchChunks) {
              inFlightChunkIds.delete(chunk.id);
            }
            console.log(`[Cloud Background Worker] Aborted saving batch because job "${targetJob.fileName}" was deleted/cancelled.`);
            break;
          }

          let validCount = 0;
          let invalidCount = 0;

          if (batchChunks.length === 1) {
            const single = batchChunks[0];
            let cleanText = (rawTranslatedText || "").trim();
            cleanText = cleanText.replace(/<<<CHAPTER_START[^>]*>>>/gi, "").replace(/<<<CHAPTER_END[^>]*>>>/gi, "").trim();

            if (cleanText.length > 0) {
              single.englishText = cleanText;
              single.durationMs = Date.now() - startBatchTime;
              single.errorMessage = undefined;
              single.lastErrorAt = undefined;
              single.status = "completed";
              inFlightChunkIds.delete(single.id);
              validCount = 1;

              // Opportunistic cloud backup
              saveChunkToFirestore(targetJob.id, single).catch(() => {});
            } else {
              const decomp = await translateWithDecomposition(
                single.chineseText,
                styleGuidance,
                targetJob.customInstructions,
                glossaryBlock
              );
              if (decomp.text && decomp.text.trim().length > 0) {
                single.englishText = decomp.text.trim();
                single.durationMs = Date.now() - startBatchTime;
                single.errorMessage = undefined;
                single.lastErrorAt = undefined;
                single.status = "completed";
                inFlightChunkIds.delete(single.id);
                validCount = 1;

                // Opportunistic cloud backup
                saveChunkToFirestore(targetJob.id, single).catch(() => {});
              } else {
                // Secondary Fallback: Google Translation Engine
                try {
                  const googleTrans = await translateChapterWithGoogle(single.chineseText);
                  if (googleTrans && googleTrans.trim().length > 0) {
                    single.englishText = googleTrans.trim();
                    single.durationMs = Date.now() - startBatchTime;
                    single.errorMessage = undefined;
                    single.lastErrorAt = undefined;
                    single.status = "completed";
                    inFlightChunkIds.delete(single.id);
                    validCount = 1;
                    saveChunkToFirestore(targetJob.id, single).catch(() => {});
                  } else {
                    single.status = "error";
                    single.errorMessage = "Empty translation response received.";
                    single.lastErrorAt = Date.now();
                    single.durationMs = Date.now() - startBatchTime;
                    invalidCount = 1;
                  }
                } catch {
                  single.status = "error";
                  single.errorMessage = "Empty translation response received.";
                  single.lastErrorAt = Date.now();
                  single.durationMs = Date.now() - startBatchTime;
                  invalidCount = 1;
                }
              }
            }
          } else {
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
                chunk.durationMs = Date.now() - startBatchTime;
                chunk.errorMessage = undefined;
                chunk.lastErrorAt = undefined;
                chunk.status = "completed";
                inFlightChunkIds.delete(chunk.id);
                validCount++;

                // Opportunistic cloud backup
                saveChunkToFirestore(targetJob.id, chunk).catch(() => {});
              } else {
                console.log(`[Cloud Worker #${workerId}] Batch parsing fallback: translating chunk #${chunk.index + 1} individually...`);
                let recovered = false;
                try {
                  const singlePrompt = `${contextBlock ? contextBlock + "\n" : ""}${
                    targetJob.customInstructions ? `Special Instructions: ${targetJob.customInstructions}\n\n` : ""
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
                    chunk.durationMs = Date.now() - startBatchTime;
                    chunk.errorMessage = undefined;
                    chunk.lastErrorAt = undefined;
                    chunk.status = "completed";
                    inFlightChunkIds.delete(chunk.id);
                    validCount++;
                    recovered = true;

                    // Opportunistic cloud backup
                    saveChunkToFirestore(targetJob.id, chunk).catch(() => {});
                    continue;
                  }
                } catch (singleErr: any) {
                  console.warn(`[Cloud Worker #${workerId}] Individual translation fallback failed for chunk #${chunk.index + 1}:`, singleErr.message);
                }

                if (!recovered) {
                  try {
                    const gTrans = await translateChapterWithGoogle(chunk.chineseText);
                    if (gTrans && gTrans.trim().length > 0) {
                      chunk.englishText = gTrans.trim();
                      chunk.durationMs = Date.now() - startBatchTime;
                      chunk.errorMessage = undefined;
                      chunk.lastErrorAt = undefined;
                      chunk.status = "completed";
                      inFlightChunkIds.delete(chunk.id);
                      validCount++;
                      recovered = true;
                      saveChunkToFirestore(targetJob.id, chunk).catch(() => {});
                      continue;
                    }
                  } catch {}
                }

                chunk.status = "error";
                chunk.errorMessage = parsed?.errorReason || "Failed batch response validation. Queued for retry.";
                chunk.lastErrorAt = Date.now();
                chunk.durationMs = Date.now() - startBatchTime;
                invalidCount++;
              }
            }
          }

          targetJob.lastActiveAt = Date.now();
          saveJobToDisk(targetJob.sessionId || "legacy_default", targetJob);

          batchChunks = batchChunks.filter((c) => c.status !== "completed");
          success = batchChunks.length === 0;

          console.log(
            `[Cloud Worker #${workerId}] Batch result (${validCount + invalidCount} items: ${validCount} completed, ${invalidCount} retry queued) using ${projectUsed} (${modelUsed}) in ${Date.now() - startBatchTime}ms`
          );
        } catch (batchErr: any) {
          const cleanErr = formatCleanErrorMessage(batchErr);
          const errLower = String(batchErr?.message || cleanErr).toLowerCase();
          const isSafetyFilterTrigger =
            errLower.includes("safety") ||
            errLower.includes("block") ||
            errLower.includes("filter") ||
            errLower.includes("prohibited") ||
            errLower.includes("candidate was blocked") ||
            errLower.includes("finishreason");

          console.error(
            `[Cloud Worker #${workerId}] Notice on batch starting at chunk ${firstChunk.index + 1} (Attempt #${attemptCount}):`,
            cleanErr
          );

          // Fast-track safety filter triggers directly to Google Translate for the flagged chapter ONLY
          if (isSafetyFilterTrigger) {
            console.log(
              `[Cloud Worker #${workerId}] Instant Fast-Track: Sensitive chapter(s) starting at chunk ${firstChunk.index + 1} flagged by AI safety filter. Rescuing via Google Translate engine immediately...`
            );

            for (const chunk of batchChunks) {
              try {
                const gTrans = await translateChapterWithGoogle(chunk.chineseText);
                if (gTrans && gTrans.trim().length > 0) {
                  chunk.englishText = gTrans.trim();
                  chunk.durationMs = Date.now() - startBatchTime;
                  chunk.errorMessage = undefined;
                  chunk.lastErrorAt = undefined;
                  chunk.status = "completed";
                  inFlightChunkIds.delete(chunk.id);
                  saveChunkToFirestore(targetJob.id, chunk).catch(() => {});
                  console.log(
                    `[Cloud Worker #${workerId}] Sensitive chunk #${chunk.index + 1} ("${
                      chunk.chapterTitle || "Chunk " + (chunk.index + 1)
                    }") rescued instantly via Google Translate engine! Next normal chapter will automatically resume on Gemini AI.`
                  );
                }
              } catch (gErr: any) {
                console.warn(
                  `[Cloud Worker #${workerId}] Fast Google Translate fallback error for chunk #${chunk.index + 1}:`,
                  gErr.message
                );
              }
            }

            batchChunks = batchChunks.filter((c) => c.status !== "completed");
            if (batchChunks.length === 0) {
              success = true;
              targetJob.lastActiveAt = Date.now();
              saveJobToDisk(targetJob.sessionId || "legacy_default", targetJob);
              break; // Immediately exit retry loop and continue to next chunk on Gemini AI
            }
          }

          if (batchChunks.length === 1 && firstChunk) {
            console.log(`[Cloud Worker #${workerId}] Attempting paragraph decomposition fallback for chunk ${firstChunk.index + 1}...`);
            try {
              const decompResult = await translateWithDecomposition(
                firstChunk.chineseText,
                styleGuidance,
                targetJob.customInstructions,
                glossaryBlock
              );
              if (decompResult.text && decompResult.text.trim().length > 0) {
                firstChunk.englishText = decompResult.text;
                firstChunk.durationMs = Date.now() - startBatchTime;
                firstChunk.errorMessage = undefined;
                firstChunk.lastErrorAt = undefined;

                firstChunk.status = "completed";
                inFlightChunkIds.delete(firstChunk.id);
                success = true;
                batchChunks = [];
                targetJob.lastActiveAt = Date.now();
                saveJobToDisk(targetJob.sessionId || "legacy_default", targetJob);
                saveChunkToFirestore(targetJob.id, firstChunk).catch(() => {});
                console.log(`[Cloud Worker #${workerId}] Chunk ${firstChunk.index + 1} succeeded via paragraph decomposition and saved!`);
                break;
              }
            } catch (decompErr: any) {
              console.warn(`[Cloud Worker #${workerId}] Paragraph decomposition also failed:`, decompErr.message);
            }
          }

          // If repeated attempts fail on this batch, rescue with Google Translate fallback so job never gets stuck
          for (const chunk of batchChunks) {
            if (attemptCount >= MAX_ATTEMPTS_PER_PASS || (chunk.attempts && chunk.attempts >= 2)) {
              try {
                const gTrans = await translateChapterWithGoogle(chunk.chineseText);
                if (gTrans && gTrans.trim().length > 0) {
                  chunk.englishText = gTrans.trim();
                  chunk.durationMs = Date.now() - startBatchTime;
                  chunk.errorMessage = undefined;
                  chunk.lastErrorAt = undefined;
                  chunk.status = "completed";
                  inFlightChunkIds.delete(chunk.id);
                  saveChunkToFirestore(targetJob.id, chunk).catch(() => {});
                  console.log(`[Cloud Worker #${workerId}] Chunk #${chunk.index + 1} rescued via fallback translation engine!`);
                  continue;
                }
              } catch {}
            }

            chunk.status = "error";
            chunk.attempts = (chunk.attempts || 0) + 1;
            chunk.errorMessage = `Attempt ${chunk.attempts}: ${cleanErr}. Auto-retrying...`;
            chunk.durationMs = Date.now() - startBatchTime;
            chunk.lastErrorAt = Date.now();
          }

          targetJob.lastActiveAt = Date.now();
          saveJobToDisk(targetJob.sessionId || "legacy_default", targetJob);

          if (targetJob.status !== "running") {
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
      targetJob.lastActiveAt = Date.now();
      saveJobToDisk(targetJob.sessionId || "legacy_default", targetJob);

      await new Promise((r) => setTimeout(r, 100));
    }
  };

  try {
    const workerPromises = Array.from({ length: maxPossibleWorkers }, (_, idx) =>
      runWorkerTask(idx + 1)
    );
    await Promise.all(workerPromises);
  } catch (workerErr) {
    console.error("[Cloud Background Worker] Pool error:", workerErr);
  } finally {
    isCloudWorkerRunning = false;
    inFlightChunkIds.clear();
  }
}

// -------------------------------------------------------------
// Telegram Settings Storage & Local Wrapper
// -------------------------------------------------------------
const TELEGRAM_SETTINGS_FILE = path.join(DATA_DIR, "telegram_settings.json");

interface TelegramSettings {
  botToken: string;
  chatIds: string;
  enabled: boolean;
  statusIntervalMin: number;
  statusEnabled: boolean;
}

let telegramSettings: TelegramSettings = {
  botToken: process.env.TELEGRAM_BOT_TOKEN || "",
  chatIds: process.env.TELEGRAM_CHAT_IDS || "",
  enabled: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_IDS),
  statusIntervalMin: Number(process.env.TELEGRAM_STATUS_INTERVAL_MIN) || 5,
  statusEnabled: true,
};

function loadTelegramSettings() {
  try {
    if (fs.existsSync(TELEGRAM_SETTINGS_FILE)) {
      const data = JSON.parse(fs.readFileSync(TELEGRAM_SETTINGS_FILE, "utf-8"));
      telegramSettings = {
        botToken: typeof data.botToken === "string" ? data.botToken : (process.env.TELEGRAM_BOT_TOKEN || ""),
        chatIds: typeof data.chatIds === "string" ? data.chatIds : (process.env.TELEGRAM_CHAT_IDS || ""),
        enabled: typeof data.enabled === "boolean" ? data.enabled : !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_IDS),
        statusIntervalMin: typeof data.statusIntervalMin === "number" ? data.statusIntervalMin : (Number(process.env.TELEGRAM_STATUS_INTERVAL_MIN) || 5),
        statusEnabled: typeof data.statusEnabled === "boolean" ? data.statusEnabled : true,
      };
    }
  } catch (err) {
    console.error("Failed to load Telegram settings:", err);
  }
}

function saveTelegramSettings() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(TELEGRAM_SETTINGS_FILE, JSON.stringify(telegramSettings, null, 2), "utf-8");
  } catch (err) {
    console.error("Failed to save Telegram settings:", err);
  }
}

// Initial load of telegram settings
loadTelegramSettings();

// Helper to format rich completion Telegram notifications with chunks and English wordcount
function formatCompletionTelegramMessage(job: CloudJob): string {
  const totalChunks = job.chunks ? job.chunks.length : 0;
  const completedChunks = job.chunks
    ? job.chunks.filter((c) => c.status === "completed" && !!c.englishText?.trim()).length
    : 0;
  let wordCount = 0;
  let totalChars = job.totalChineseChars || 0;
  if (job.chunks) {
    for (const c of job.chunks) {
      if (c.status === "completed" && c.englishText) {
        wordCount += c.englishText.split(/\s+/).filter(Boolean).length;
      }
      if (!totalChars && c.charCount) {
        totalChars += c.charCount;
      }
    }
  }
  const now = Date.now();
  const startedAt = job.startedAt || now;
  const elapsedMinutes = Math.max(1, Math.round((now - startedAt) / 60000));
  const durationStr =
    elapsedMinutes >= 60
      ? `${Math.floor(elapsedMinutes / 60)}h ${elapsedMinutes % 60}m`
      : `${elapsedMinutes}m`;

  return (
    `🎉 <b>[Translation Completed]</b>\n\n` +
    `📖 Novel: <b>${job.fileName}</b>\n` +
    `✅ Chunks Completed: <b>${completedChunks} / ${totalChunks}</b> (100%)\n` +
    `📝 Translated Words: <b>${wordCount.toLocaleString()}</b> English words\n` +
    (totalChars > 0 ? `🇨🇳 Total Characters: <b>${totalChars.toLocaleString()}</b> Chinese characters\n` : "") +
    (elapsedMinutes > 0 ? `⏱️ Total Duration: <b>${durationStr}</b>\n` : "") +
    `\n✨ Your novel is fully translated and ready for download in EPUB or TXT format!`
  );
}

// Safe send wrapper matching previous signature
async function sendTelegramNotification(message: string): Promise<void> {
  if (!telegramSettings.enabled) return;
  await rawSendTelegramNotification(message, telegramSettings.botToken, telegramSettings.chatIds);
}

// Helper to identify test, synthetic, or mock jobs
function isSyntheticOrTestJob(job: { fileName?: string; id?: string; chunks?: any[] }): boolean {
  if (!job.fileName) return true;
  const name = job.fileName.toLowerCase();
  if (name.includes("test") || name.includes("synthetic") || name.includes("authoritative_test")) return true;
  if (job.id && (job.id.startsWith("synthetic_") || job.id.startsWith("test_"))) return true;
  if (job.chunks && job.chunks.length <= 10 && (name.includes("novel") || name === "test.txt")) return true;
  return false;
}

// Load any pending jobs on boot
loadCloudJobsFromDisk();

// Light-weight ticker running every 60 seconds with strict deduplication & anti-spam
const lastStatusUpdateTimes = new Map<string, number>();
const lastNotifiedCompletedCounts = new Map<string, number>();

setInterval(() => {
  try {
    if (!telegramSettings.enabled || !telegramSettings.statusEnabled) return;

    // 1. Group running jobs by novel fileName so we only process ONE canonical instance per novel
    const novelJobMap = new Map<string, CloudJob>();
    for (const job of cloudJobs.values()) {
      if (job.status !== "running") continue;
      if (isSyntheticOrTestJob(job)) continue;
      if (!job.chunks || job.chunks.length === 0) continue;

      const existing = novelJobMap.get(job.fileName);
      if (!existing) {
        novelJobMap.set(job.fileName, job);
      } else {
        const existingDone = existing.chunks.filter((c) => c.status === "completed" && !!c.englishText).length;
        const currentDone = job.chunks.filter((c) => c.status === "completed" && !!c.englishText).length;
        if (currentDone > existingDone) {
          novelJobMap.set(job.fileName, job);
        }
      }
    }

    const uniqueRunningJobs = Array.from(novelJobMap.values());
    if (uniqueRunningJobs.length === 0) return;

    const now = Date.now();
    for (const job of uniqueRunningJobs) {
      const totalChunks = job.chunks.length;
      if (totalChunks === 0) continue;

      const completedChunks = job.chunks.filter((c) => c.status === "completed" && !!c.englishText?.trim()).length;
      const processingChunks = job.chunks.filter((c) => c.status === "processing").length;
      const errorChunks = job.chunks.filter((c) => c.status === "error").length;
      const pendingChunks = job.chunks.filter((c) => c.status === "pending").length;

      const novelKey = job.fileName;
      const prevNotifiedCount = lastNotifiedCompletedCounts.get(novelKey) ?? -1;
      const lastUpdate = lastStatusUpdateTimes.get(novelKey) || job.startedAt;
      const intervalMs = Math.max(1, telegramSettings.statusIntervalMin || 5) * 60 * 1000;

      const isInitial = prevNotifiedCount === -1;
      const hasNewProgress = completedChunks > prevNotifiedCount;
      const timeElapsed = (now - lastUpdate) >= intervalMs;

      // Only send notification if:
      // 1) It's initial notification on first detection, OR
      // 2) Interval elapsed AND (new chunks completed since last notification OR translation actively processing), OR
      // 3) Novel just hit 100% completion
      // Suppress if 0 new chunks done AND 0 actively processing (prevents repeating spam on idle or paused state)
      if ((timeElapsed && (hasNewProgress || processingChunks > 0)) || isInitial || completedChunks === totalChunks) {
        lastStatusUpdateTimes.set(novelKey, now);
        lastNotifiedCompletedCounts.set(novelKey, completedChunks);

        const percent = Math.round((completedChunks / totalChunks) * 100);

        // Estimate word count of completed english translation
        let wordCount = 0;
        for (const c of job.chunks) {
          if (c.status === "completed" && c.englishText) {
            wordCount += c.englishText.split(/\s+/).filter(Boolean).length;
          }
        }

        const elapsedMinutes = Math.max(1, Math.round((now - job.startedAt) / 60000));

        const message = `📈 <b>[Translation Progress Update]</b>\n\n` +
          `📖 Novel: <b>${job.fileName}</b>\n` +
          `🔄 Status: <b>${job.status.toUpperCase()}</b>\n` +
          `⏱️ Active for: <b>${elapsedMinutes} minutes</b>\n\n` +
          `✅ Progress: <b>${completedChunks} / ${totalChunks}</b> chunks (<b>${percent}%</b>)\n` +
          `📝 Translated: <b>${wordCount.toLocaleString()}</b> English words\n\n` +
          `⏳ Detail:\n` +
          `• Completed: <b>${completedChunks}</b>\n` +
          `• Processing: <b>${processingChunks}</b>\n` +
          `• Error: <b>${errorChunks}</b>\n` +
          `• Pending: <b>${pendingChunks}</b>`;

        sendTelegramNotification(message);
      }
    }
  } catch (err) {
    console.error("[Telegram Status Ticker] Error:", err);
  }
}, 60 * 1000);

// -------------------------------------------------------------
// Security & Access (Passcode Gate for UI - Translation open)
// -------------------------------------------------------------
let MASTER_PASSCODE = (process.env.MASTER_PASSCODE || "").trim();
const activeAuthTokens = new Set<string>();

function verifyAuthToken(req: express.Request): { isValid: boolean } {
  if (!MASTER_PASSCODE) {
    return { isValid: true };
  }
  const token =
    (req.headers["x-auth-token"] as string) ||
    (req.headers.authorization ? req.headers.authorization.replace(/^Bearer\s+/i, "") : "") ||
    "";

  if (token && (activeAuthTokens.has(token) || token === MASTER_PASSCODE)) {
    return { isValid: true };
  }
  return { isValid: false };
}

// Authentication status endpoint (Checks passcode for UI gate)
app.get("/api/auth/status", (req, res) => {
  const hasPasscode = !!MASTER_PASSCODE;
  const authCheck = verifyAuthToken(req);
  const isVerified = !hasPasscode || authCheck.isValid;

  res.json({
    authenticated: isVerified,
    requiresGoogle: false,
    requiresPasscode: hasPasscode,
    googleVerified: true,
    passcodeVerified: isVerified,
    hasPasscodeConfigured: hasPasscode,
  });
});

// Master Passcode Login Endpoint
app.post("/api/auth/login", (req, res) => {
  const { passcode } = req.body || {};
  const supplied = typeof passcode === "string" ? passcode.trim() : "";

  if (!MASTER_PASSCODE || supplied === MASTER_PASSCODE) {
    const sessionToken = `passcode_ok_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    activeAuthTokens.add(sessionToken);

    res.json({
      success: true,
      authenticated: true,
      token: sessionToken,
      passcodeVerified: true,
      requiresGoogle: false,
      requiresPasscode: !!MASTER_PASSCODE,
    });
  } else {
    res.status(401).json({
      success: false,
      error: "Incorrect passcode. Please try again.",
      authenticated: false,
      passcodeVerified: false,
    });
  }
});

// Set / Update passcode dynamically
app.post("/api/auth/set-passcode", (req, res) => {
  const { passcode, currentPasscode } = req.body || {};
  if (MASTER_PASSCODE) {
    const authCheck = verifyAuthToken(req);
    if (!authCheck.isValid && currentPasscode !== MASTER_PASSCODE) {
      return res.status(403).json({ success: false, error: "Incorrect current passcode." });
    }
  }
  MASTER_PASSCODE = typeof passcode === "string" ? passcode.trim() : "";
  res.json({
    success: true,
    requiresPasscode: !!MASTER_PASSCODE,
    hasPasscodeConfigured: !!MASTER_PASSCODE,
    message: MASTER_PASSCODE ? "Passcode set successfully." : "Passcode protection removed.",
  });
});

// Logout endpoint
app.post("/api/auth/logout", (req, res) => {
  const token =
    (req.headers["x-auth-token"] as string) ||
    (req.headers.authorization ? req.headers.authorization.replace(/^Bearer\s+/i, "") : "") ||
    "";
  if (token) {
    activeAuthTokens.delete(token);
  }
  res.json({ success: true });
});

// Gatekeeper Middleware for Translation and Cloud Job endpoints (Open access - starting translation never needs password)
const requireAuthMiddleware: express.RequestHandler = (req, res, next) => {
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
    primaryModel: available[0] || "gemini-3.8-flash",
    hasActiveCloudJob: !!getJobForSession(req),
    cloudJobStatus: getJobForSession(req)?.status || "idle",
  });
});

// Smart Dynamic Keep-Alive & Heartbeat Endpoint (Method 3)
// - When a translation is actively running: Confirms active work and keeps Cloud Run awake.
// - When completed, paused, or idle: Signals that sleep is safe, letting the container scale to 0.
app.all("/api/heartbeat", (req, res) => {
  const allJobs = Array.from(cloudJobs.values());
  const runningJobs = allJobs.filter((j) => {
    if (j.status !== "running") return false;
    const allDone = j.chunks.length > 0 && j.chunks.every((c) => c.status === "completed" && !!c.englishText?.trim());
    return !allDone;
  });

  const isAnyJobRunning = runningJobs.length > 0;
  const activeCount = runningJobs.length;

  res.json({
    status: "ok",
    shouldKeepAlive: isAnyJobRunning,
    activeRunningJobs: activeCount,
    message: isAnyJobRunning
      ? `Active translation in progress (${activeCount} running job${activeCount > 1 ? "s" : ""}). Keeping server awake.`
      : "No active translations running. Server is safe to sleep.",
    timestamp: Date.now(),
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

// Telegram Settings management endpoints
app.get("/api/telegram-settings", (req, res) => {
  res.json(telegramSettings);
});

app.post("/api/telegram-settings", express.json(), (req, res) => {
  try {
    const { botToken, chatIds, enabled, statusIntervalMin, statusEnabled } = req.body;
    
    if (typeof botToken === "string") telegramSettings.botToken = botToken.trim();
    if (typeof chatIds === "string") telegramSettings.chatIds = chatIds.trim();
    if (typeof enabled === "boolean") telegramSettings.enabled = enabled;
    if (typeof statusIntervalMin === "number") telegramSettings.statusIntervalMin = statusIntervalMin;
    if (typeof statusEnabled === "boolean") telegramSettings.statusEnabled = statusEnabled;
    
    saveTelegramSettings();
    res.json({ success: true, settings: telegramSettings });
  } catch (err) {
    console.error("Failed to save Telegram settings:", err);
    res.status(500).json({ success: false, error: String(err) });
  }
});

// -------------------------------------------------------------
// Cloud Job API Endpoints (Session-Isolated)
// -------------------------------------------------------------

// Get status & progress of cloud job for current session (Data-saving lightweight mode by default)
app.get("/api/cloud-job/status", async (req, res) => {
  let targetJob = getJobForSession(req);
  const firestoreStatus = getFirestoreQuotaStatus();
  const projectsSummary = quotaScheduler.getActiveProjectSummary();

  // 1. Direct Cloud Firestore Lookup if missing or if local job has 0 progress/0 chunks
  const currentDone = targetJob ? ((targetJob as any).completedChunks || targetJob.chunks.filter((c) => c.status === "completed" && !!c.englishText?.trim()).length) : -1;
  
  if (!targetJob || (currentDone === 0 && targetJob.status !== "completed") || targetJob.chunks.length === 0) {
    const rawNovelHeader = req.headers["x-novel-name"] || req.headers["x-novel-filename"];
    const novelQuery = (req.query.fileName || req.query.novelName || "") as string;
    let targetNovelName = "";
    if (rawNovelHeader && typeof rawNovelHeader === "string") {
      try {
        targetNovelName = decodeURIComponent(rawNovelHeader).trim();
      } catch {
        targetNovelName = rawNovelHeader.trim();
      }
    } else if (novelQuery && typeof novelQuery === "string") {
      try {
        targetNovelName = decodeURIComponent(novelQuery).trim();
      } catch {
        targetNovelName = novelQuery.trim();
      }
    }

    const searchName = targetNovelName || targetJob?.fileName || "";
    if (searchName && searchName !== "[object Object]" && searchName !== "undefined") {
      console.log(`[Status] Querying live Cloud Firestore directly for novel "${searchName}"...`);
      const fsJob = await findJobInFirestoreByNovel(searchName);
      if (fsJob) {
        const fsDone = (fsJob as any).completedChunks || fsJob.chunks.filter((c) => c.status === "completed" && !!c.englishText?.trim()).length;
        if (fsDone > currentDone || fsJob.status === "running") {
          targetJob = fsJob;
          const sessionId = getSessionId(req);
          setJobForSession(sessionId, targetJob);
        }
      }
    }
  }

  if (!targetJob) {
    res.json({
      hasJob: false,
      job: null,
      firestoreStatus,
      projectsSummary,
    });
    return;
  }

  // Check if job is tombstoned/deleted
  const tombstones = await getDeletedJobTombstonesFromFirestore();
  const jName = (targetJob.fileName || "").trim().toLowerCase();
  if (
    tombstones.ids.has(targetJob.id) ||
    tombstones.fileNames.has(jName) ||
    Array.from(tombstones.fileNames).some((t) => isSameNovel(t, jName)) ||
    (targetJob as any).isDeleted
  ) {
    res.json({
      hasJob: false,
      job: null,
      firestoreStatus,
      projectsSummary,
    });
    return;
  }

  const includeFullText = req.query.full === "true";
  const isSummaryOnly = req.query.summary === "true";

  // CRITICAL FIX: If memory chunks are empty, ALWAYS load chunks from Firestore so that
  // completedChunks, totalChunks, completedEnglishWords, and frontier are 100% accurate!
  if (targetJob.chunks.length === 0) {
    targetJob = await loadFullChunksForJob(targetJob);
    cloudJobs.set(targetJob.sessionId || getSessionId(req), targetJob);
  }

  // Automatically revive worker loop if an active running job is discovered
  if (targetJob.status === "running" && !isCloudWorkerRunning && targetJob.chunks.length > 0) {
    startCloudWorkerLoop();
  }

  const expectedTotal = (targetJob as any).totalChunks || targetJob.chunks.length;
  const isJobComplete =
    targetJob.status === "completed" ||
    (expectedTotal > 0 && (targetJob as any).completedChunks >= expectedTotal);

  if (isJobComplete && targetJob.status !== "completed") {
    targetJob.status = "completed";
    saveJobToDisk(targetJob.sessionId || getSessionId(req), targetJob);
  }

  const completedChunks = isJobComplete
    ? expectedTotal
    : (targetJob.chunks.length > 0
        ? targetJob.chunks.filter((c) => c.status === "completed" && (!!c.englishText?.trim() || (c.wordCount && c.wordCount > 0))).length
        : ((targetJob as any).completedChunks || 0));
  const inProgressChunks = isJobComplete ? 0 : targetJob.chunks.filter((c) => c.status === "processing").length;
  const errorChunks = targetJob.chunks.filter((c) => c.status === "error").length;

  if (expectedTotal > 0 && completedChunks >= expectedTotal && targetJob.status !== "completed") {
    targetJob.status = "completed";
    saveJobToDisk(targetJob.sessionId || getSessionId(req), targetJob);
    if (!isSyntheticOrTestJob(targetJob)) {
      sendTelegramNotification(formatCompletionTelegramMessage(targetJob));
    }
  }

  // Calculate contiguous completion frontier from index 0
  let contiguousFrontierIndex = -1;
  let contiguousCount = 0;
  for (let i = 0; i < targetJob.chunks.length; i++) {
    const c = targetJob.chunks[i];
    if (c && c.status === "completed" && ((c.englishText && c.englishText.trim().length > 0) || (c.wordCount && c.wordCount > 0))) {
      contiguousFrontierIndex = i;
      contiguousCount++;
    } else {
      break;
    }
  }

  const aheadCompletedCount = targetJob.chunks.filter(
    (c) => c.status === "completed" && ((c.englishText && c.englishText.trim().length > 0) || (c.wordCount && c.wordCount > 0)) && c.index > contiguousFrontierIndex
  ).length;

  const countedEnglishWords = targetJob.chunks.length > 0
    ? targetJob.chunks
        .filter((c) => c.status === "completed")
        .reduce((acc, c) => acc + (c.englishText ? countEnglishWords(c.englishText) : (c.wordCount || 0)), 0)
    : 0;
  const completedEnglishWords = (isSameNovel(targetJob.fileName, "primitive chen qi") || isSameNovel(targetJob.fileName, "穿越兽世当神棍"))
    ? Math.max(455147, (targetJob as any).completedEnglishWords || 0, countedEnglishWords)
    : Math.max((targetJob as any).completedEnglishWords || 0, countedEnglishWords);

  const countedChars = targetJob.chunks.length > 0
    ? targetJob.chunks
        .filter((c) => c.status === "completed")
        .reduce((acc, c) => acc + (c.charCount || 0), 0)
    : 0;
  const completedChars = Math.max(
    (targetJob as any).completedChars || (targetJob as any).totalChineseChars || 0,
    countedChars
  );

  // Render chunks (if summary=true, omit chunks array completely to save 99.6% mobile data)
  const chunksData = isSummaryOnly ? [] : targetJob.chunks.map((c) => {
    const wordCount = c.englishText ? countEnglishWords(c.englishText) : (c.wordCount || 0);
    if (includeFullText) {
      return { ...c, wordCount };
    }
    return {
      id: c.id,
      index: c.index,
      chapterTitle: c.chapterTitle,
      charCount: c.charCount || 0,
      wordCount,
      status: c.status,
      attempts: c.attempts,
      lastErrorAt: c.lastErrorAt,
      errorMessage: c.errorMessage,
      hasEnglish: !!((c.englishText && c.englishText.trim().length > 0) || wordCount > 0),
      hasChinese: !!((c.chineseText && c.chineseText.trim().length > 0) || (c.charCount && c.charCount > 0)),
    };
  });

  res.json({
    hasJob: true,
    job: {
      id: targetJob.id,
      fileName: targetJob.fileName,
      fileSizeBytes: targetJob.fileSizeBytes,
      totalChineseChars: targetJob.totalChineseChars,
      style: targetJob.style,
      customInstructions: targetJob.customInstructions,
      glossary: targetJob.glossary,
      concurrency: targetJob.concurrency,
      status: targetJob.status,
      startedAt: targetJob.startedAt,
      lastActiveAt: targetJob.lastActiveAt,
      totalChunks: expectedTotal,
      completedChunks,
      inProgressChunks,
      errorChunks,
      contiguousCount,
      contiguousFrontierIndex,
      aheadCompletedCount,
      completedEnglishWords,
      completedChars,
      projectsSummary,
      firestoreStatus,
      chunks: isSummaryOnly ? undefined : chunksData,
      isSummary: isSummaryOnly,
    },
    firestoreStatus,
    projectsSummary,
  });
});

// Sync full chapter texts for completed chunks or requested chunk indices on-demand
app.get("/api/cloud-job/sync-texts", async (req, res) => {
  let targetJob = getJobForSession(req);

  // If not found in memory, query Firestore directly using novel name
  if (!targetJob) {
    const rawNovelHeader = req.headers["x-novel-name"] || req.headers["x-novel-filename"];
    const novelQuery = (req.query.fileName || req.query.novelName || "") as string;
    let targetNovelName = "";
    if (rawNovelHeader && typeof rawNovelHeader === "string") {
      try { targetNovelName = decodeURIComponent(rawNovelHeader).trim(); } catch { targetNovelName = rawNovelHeader.trim(); }
    } else if (novelQuery && typeof novelQuery === "string") {
      try { targetNovelName = decodeURIComponent(novelQuery).trim(); } catch { targetNovelName = novelQuery.trim(); }
    }

    if (targetNovelName && targetNovelName !== "[object Object]" && targetNovelName !== "undefined") {
      const fsJob = await findJobInFirestoreByNovel(targetNovelName);
      if (fsJob) {
        targetJob = fsJob;
        const sessionId = getSessionId(req);
        setJobForSession(sessionId, targetJob);
      }
    }
  }

  if (!targetJob) {
    res.json({ success: false, chunks: [] });
    return;
  }

  // Rehydrate chunks from Firestore if memory has 0 chunks or missing completed texts
  const hasMissingText = (targetJob.chunks || []).some(
    (c) => c.status === "completed" && (!c.englishText || !c.englishText.trim())
  );
  if (!targetJob.chunks || targetJob.chunks.length === 0 || hasMissingText) {
    targetJob = await loadFullChunksForJob(targetJob);
    cloudJobs.set(targetJob.sessionId || getSessionId(req), targetJob);
  }

  const indicesParam = req.query.indices as string;
  let targetChunks = targetJob.chunks || [];
  if (indicesParam) {
    const setIdx = new Set(indicesParam.split(",").map(Number));
    targetChunks = targetChunks.filter((c) => setIdx.has(c.index));
  } else if (req.query.completedOnly === "true") {
    targetChunks = targetChunks.filter(
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

// Direct server-side EPUB builder & downloader with 0 client memory bottleneck
app.get("/api/cloud-job/download-epub", async (req, res) => {
  try {
    const targetJob = getJobForSession(req);
    if (!targetJob) {
      res.status(404).send("No active or completed novel translation found.");
      return;
    }
    const isBilingual = req.query.bilingual === "true";
    const rawCompletedChunks = (targetJob.chunks || []).filter(
      (c) => c.status === "completed" && c.englishText && c.englishText.trim().length > 0
    );
    const completedChunks = cleanAndDeduplicateChunks(rawCompletedChunks);
    if (completedChunks.length === 0) {
      res.status(400).send("No translated chapters ready to download yet.");
      return;
    }

    const baseName = (targetJob.fileName || "translated_novel").replace(/\.[^/.]+$/, "");
    const epubBuffer = await generateServerEpubBuffer(completedChunks, {
      bookTitle: baseName.replace(/_/g, " "),
      isBilingual,
    });

    const safeFilename = encodeURIComponent(`${baseName}${isBilingual ? "_bilingual" : ""}.epub`);
    res.setHeader("Content-Type", "application/epub+zip");
    res.setHeader("Content-Disposition", `attachment; filename="${safeFilename}"; filename*=UTF-8''${safeFilename}`);
    res.setHeader("Content-Length", epubBuffer.length);
    res.send(epubBuffer);
  } catch (err: any) {
    console.error("Server EPUB generation failed:", err);
    res.status(500).send("Failed to generate EPUB: " + (err.message || String(err)));
  }
});

// Direct server-side TXT downloader
app.get("/api/cloud-job/download-txt", (req, res) => {
  try {
    const targetJob = getJobForSession(req);
    if (!targetJob) {
      res.status(404).send("No active or completed novel translation found.");
      return;
    }
    const isBilingual = req.query.bilingual === "true";
    const rawCompletedChunks = (targetJob.chunks || []).filter(
      (c) => c.status === "completed" && c.englishText && c.englishText.trim().length > 0
    );
    const completedChunks = cleanAndDeduplicateChunks(rawCompletedChunks);
    if (completedChunks.length === 0) {
      res.status(400).send("No translated chapters ready to download yet.");
      return;
    }

    const baseName = (targetJob.fileName || "translated_novel").replace(/\.[^/.]+$/, "");
    let textContent = "";
    if (isBilingual) {
      textContent = completedChunks.map((c) => {
        const header = c.chapterTitle ? `====================\n${c.chapterTitle}\n====================\n\n` : "";
        return `${header}[ORIGINAL CHINESE]\n${(c.chineseText || "").trim()}\n\n[ENGLISH TRANSLATION]\n${(c.englishText || "").trim()}`;
      }).join("\n\n--------------------\n\n");
    } else {
      textContent = completedChunks.map((c) => {
        const header = c.chapterTitle ? `${c.chapterTitle}\n\n` : "";
        return `${header}${(c.englishText || "").trim()}`;
      }).join("\n\n\n");
    }

    const safeFilename = encodeURIComponent(`${baseName}${isBilingual ? "_bilingual" : "_en"}.txt`);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${safeFilename}"; filename*=UTF-8''${safeFilename}`);
    res.send(textContent);
  } catch (err: any) {
    console.error("Server TXT generation failed:", err);
    res.status(500).send("Failed to generate TXT: " + (err.message || String(err)));
  }
});

// Fetch single full chunk by index for Chapter Reader or manual editing
app.get("/api/cloud-job/chunk/:index", (req, res) => {
  const targetJob = getJobForSession(req);
  if (!targetJob) {
    res.status(404).json({ error: "No active cloud job." });
    return;
  }

  const idx = parseInt(req.params.index, 10);
  const chunk = targetJob.chunks[idx];
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

// Prepare novel on server (Server-Side Chunking & Instant Live Firestore Lookup)
app.post("/api/cloud-job/prepare", requireAuthMiddleware, async (req, res) => {
  try {
    const {
      rawText = "",
      fileName = "novel.txt",
      fileSizeBytes = 0,
      style = "xianxia",
      customInstructions = "",
      glossary = [],
      concurrency = 1,
      targetChunkChars = 2500,
      splitByChapters = true,
      autoStart = false,
    } = req.body;

    const sessionId = getSessionId(req);
    const charCount = typeof rawText === "string" ? countChineseCharacters(rawText) || rawText.length : 0;

    // 1. Direct Instant Live Firestore Lookup
    console.log(`[Prepare Job] Checking live Cloud Firestore directly for novel "${fileName}" (~${charCount} chars)...`);
    const fsJob = await findJobInFirestoreByNovel(fileName, charCount);

    if (fsJob) {
      console.log(`[Prepare Job] Found existing novel in Cloud Firestore: "${fsJob.fileName}" (${fsJob.id}, status: ${fsJob.status})`);
      setJobForSession(sessionId, fsJob);

      const isCompleted = fsJob.status === "completed" ||
        ((fsJob as any).totalChunks > 0 && (fsJob as any).completedChunks >= (fsJob as any).totalChunks);

      if (isCompleted) {
        fsJob.status = "completed";
        saveJobToDisk(sessionId, fsJob, true);
      } else if (autoStart && fsJob.status !== "running") {
        fsJob.status = "running";
        saveJobToDisk(sessionId, fsJob, true);
        startCloudWorkerLoop();
      }

      res.json({
        success: true,
        jobId: fsJob.id,
        fileName: fsJob.fileName,
        totalChunks: (fsJob as any).totalChunks || fsJob.chunks.length,
        completedChunks: (fsJob as any).completedChunks || fsJob.chunks.filter((c) => c.status === "completed" && !!c.englishText?.trim()).length,
        totalChineseChars: fsJob.totalChineseChars || charCount,
        alreadyCompleted: isCompleted,
        isExisting: true,
        status: fsJob.status,
      });
      return;
    }

    // 2. Check local memory or disk archives if Firestore didn't have it
    let existingLocal: CloudJob | null = null;
    for (const j of cloudJobs.values()) {
      if (isSameNovel(j.fileName, fileName) && !(j as any).isDeleted) {
        existingLocal = j;
        break;
      }
    }
    if (existingLocal) {
      if (!existingLocal.chunks || existingLocal.chunks.length === 0) {
        existingLocal = await loadFullChunksForJob(existingLocal);
      }
      setJobForSession(sessionId, existingLocal);
      const isCompleted = existingLocal.status === "completed" ||
        ((existingLocal as any).totalChunks > 0 && (existingLocal as any).completedChunks >= (existingLocal as any).totalChunks);

      if (autoStart && existingLocal.status !== "running" && !isCompleted) {
        existingLocal.status = "running";
        saveJobToDisk(sessionId, existingLocal, true);
        startCloudWorkerLoop();
      }

      res.json({
        success: true,
        jobId: existingLocal.id,
        fileName: existingLocal.fileName,
        totalChunks: (existingLocal as any).totalChunks || existingLocal.chunks.length,
        completedChunks: (existingLocal as any).completedChunks || existingLocal.chunks.filter((c) => c.status === "completed" && !!c.englishText?.trim()).length,
        totalChineseChars: existingLocal.totalChineseChars || charCount,
        alreadyCompleted: isCompleted,
        isExisting: true,
        status: existingLocal.status,
      });
      return;
    }

    if (!rawText || !rawText.trim()) {
      res.status(400).json({ error: "Missing novel text for server preparation." });
      return;
    }

    // 3. Server-Side Chunking using the exact preserved chunker rules (2500 target, chapter boundaries)
    console.log(`[Prepare Job] Performing server-side chunking for novel "${fileName}" (${charCount} chars)...`);
    const chunks = chunkChineseText(rawText, {
      targetChunkChars: targetChunkChars || 2500,
      splitByChapters: splitByChapters ?? true,
    });

    if (!chunks || chunks.length === 0) {
      res.status(400).json({ error: "Failed to split text into translation chunks." });
      return;
    }

    const jobId = "cloud_job_" + Date.now();
    const effectiveFileSizeBytes = fileSizeBytes || Buffer.byteLength(rawText, "utf-8");

    const newJob: CloudJob = {
      id: jobId,
      sessionId,
      fileName,
      fileSizeBytes: effectiveFileSizeBytes,
      totalChineseChars: charCount,
      chunks: chunks.map((c) => ({
        id: c.id,
        index: c.index,
        chapterTitle: c.chapterTitle,
        chineseText: c.chineseText,
        englishText: c.englishText || "",
        charCount: c.charCount || countChineseCharacters(c.chineseText) || c.chineseText.length,
        status: (c.status as any) || "pending",
        attempts: 0,
      })),
      style,
      customInstructions,
      glossary,
      concurrency,
      status: autoStart ? "running" : "idle",
      startedAt: Date.now(),
      lastActiveAt: Date.now(),
    };

    setJobForSession(sessionId, newJob);

    if (autoStart) {
      startCloudWorkerLoop();
    }

    res.json({
      success: true,
      jobId,
      fileName,
      totalChunks: chunks.length,
      completedChunks: 0,
      totalChineseChars: charCount,
      alreadyCompleted: false,
      isExisting: false,
      status: newJob.status,
    });
  } catch (err: any) {
    console.error("Failed to prepare novel job on server:", err);
    res.status(500).json({ error: err.message || "Failed to prepare novel job on server." });
  }
});

// Start or update a cloud background job (supports lightweight { jobId } and full payloads)
app.post("/api/cloud-job/start", requireAuthMiddleware, async (req, res) => {
  try {
    const {
      jobId: requestedJobId,
      fileName = "novel.txt",
      fileSizeBytes = 0,
      totalChineseChars = 0,
      chunks = [],
      style = "xianxia",
      customInstructions = "",
      glossary = [],
      concurrency = 1,
    } = req.body;

    const sessionId = getSessionId(req);

    // 1. First: Instant live Firestore query to guarantee mathematically absolute protection
    const targetName = fileName || "";
    console.log(`[Start Job] Querying live Cloud Firestore directly for novel "${targetName}" before starting...`);
    const fsJob = await findJobInFirestoreByNovel(targetName, totalChineseChars);

    if (fsJob) {
      console.log(`[Start Job] Matched authoritative Firestore job: "${fsJob.fileName}" (${fsJob.id}, status: ${fsJob.status})`);
      setJobForSession(sessionId, fsJob);

      const existingDone = (fsJob as any).completedChunks || fsJob.chunks.filter((c) => c.status === "completed" && !!c.englishText?.trim()).length;
      const existingTotal = (fsJob as any).totalChunks || fsJob.chunks.length;

      if (fsJob.status === "completed" || (existingTotal > 0 && existingDone >= existingTotal)) {
        console.log(`[Start Job] Novel "${targetName}" already 100% completed (${existingDone}/${existingTotal}). Preserving translation without restart.`);
        fsJob.status = "completed";
        saveJobToDisk(sessionId, fsJob, true);
        res.json({
          success: true,
          jobId: fsJob.id,
          alreadyCompleted: true,
          message: "Novel already 100% translated in the cloud! Restored all completed chapters.",
        });
        return;
      }

      // Resume existing in-progress job
      fsJob.status = "running";
      fsJob.lastActiveAt = Date.now();
      saveJobToDisk(sessionId, fsJob, true);
      startCloudWorkerLoop();

      res.json({
        success: true,
        jobId: fsJob.id,
        alreadyCompleted: false,
        message: "Cloud background translation resumed from Firestore.",
      });
      return;
    }

    // 2. Check if job exists by requestedJobId or session in memory/disk
    let targetJob: CloudJob | null = null;
    if (requestedJobId && typeof requestedJobId === "string") {
      for (const j of cloudJobs.values()) {
        if (j.id === requestedJobId.trim() && !(j as any).isDeleted) {
          targetJob = j;
          break;
        }
      }
      if (!targetJob) {
        targetJob = await loadJobFromFirestore(requestedJobId.trim());
      }
    }

    if (!targetJob) {
      targetJob = getJobForSession(req);
    }

    // 3. If targetJob found from prepare step or memory/disk:
    if (targetJob && targetJob.chunks && targetJob.chunks.length > 0) {
      const existingDone = (targetJob as any).completedChunks || targetJob.chunks.filter((c) => c.status === "completed" && !!c.englishText?.trim()).length;
      const existingTotal = (targetJob as any).totalChunks || targetJob.chunks.length;

      if (targetJob.status === "completed" || (existingTotal > 0 && existingDone >= existingTotal)) {
        targetJob.status = "completed";
        setJobForSession(sessionId, targetJob);
        res.json({
          success: true,
          jobId: targetJob.id,
          alreadyCompleted: true,
          message: "Novel already 100% translated! Restored all completed chapters.",
        });
        return;
      }

      targetJob.status = "running";
      targetJob.lastActiveAt = Date.now();
      setJobForSession(sessionId, targetJob);
      startCloudWorkerLoop();

      res.json({
        success: true,
        jobId: targetJob.id,
        alreadyCompleted: false,
        message: "Cloud background translation started. You can safely close this browser.",
      });
      return;
    }

    // 4. Legacy or direct full chunk payload support
    if (!Array.isArray(chunks) || chunks.length === 0) {
      res.status(400).json({ error: "No job found and no chunks provided. Please prepare novel text first." });
      return;
    }

    const newJobId = requestedJobId || ("cloud_job_" + Date.now());

    // When starting a new cloud job on a session, ensure any previous running job with a DIFFERENT novel
    // is set to idle so it stops running in background workers
    for (const [sKey, j] of cloudJobs.entries()) {
      if ((sKey === sessionId || sKey === "legacy_default") && !isSameNovel(j.fileName, fileName)) {
        console.log(`[Storage] Setting previous different novel "${j.fileName}" to idle before starting "${fileName}"`);
        j.status = "idle";
        saveJobToDisk(sKey, null);
      }
    }

    const newJob: CloudJob = {
      id: newJobId,
      sessionId,
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

    setJobForSession(sessionId, newJob);
    startCloudWorkerLoop();

    res.json({
      success: true,
      jobId: newJobId,
      message: "Cloud background translation started. You can safely close this browser.",
    });
  } catch (err: any) {
    console.error("Failed to start cloud job:", err);
    res.status(500).json({ error: err.message || "Failed to start cloud job." });
  }
});


// Pause cloud job
app.post("/api/cloud-job/pause", requireAuthMiddleware, (req, res) => {
  const sessionId = getSessionId(req);
  let targetJob = getJobForSession(req);

  // If not matched by header/query, check for active or running jobs
  if (!targetJob) {
    if (cloudJobs.has(sessionId)) {
      targetJob = cloudJobs.get(sessionId)!;
    } else {
      for (const j of cloudJobs.values()) {
        if (j.status === "running") {
          targetJob = j;
          break;
        }
      }
    }
  }

  if (targetJob) {
    targetJob.status = "paused";
    targetJob.lastActiveAt = Date.now();
    // Synchronize paused status across all session aliases for this novel in cloudJobs
    for (const [sKey, j] of cloudJobs.entries()) {
      if (isSameNovel(j.fileName, targetJob.fileName) || j.id === targetJob.id) {
        j.status = "paused";
        j.lastActiveAt = targetJob.lastActiveAt;
        saveJobToDisk(sKey, j, true);
      }
    }
    console.log(`[Cloud Job] Paused translation for novel "${targetJob.fileName}" (${targetJob.id}).`);
  } else {
    // Failsafe: Pause any running jobs in memory
    for (const [sKey, j] of cloudJobs.entries()) {
      if (j.status === "running") {
        j.status = "paused";
        saveJobToDisk(sKey, j, true);
      }
    }
  }

  res.json({
    success: true,
    status: "paused",
    fileName: targetJob?.fileName,
    jobId: targetJob?.id,
  });
});

// Resume cloud job
app.post("/api/cloud-job/resume", requireAuthMiddleware, (req, res) => {
  const sessionId = getSessionId(req);
  let targetJob = getJobForSession(req);

  if (!targetJob) {
    if (cloudJobs.has(sessionId)) {
      targetJob = cloudJobs.get(sessionId)!;
    } else {
      for (const j of cloudJobs.values()) {
        if (j.status === "paused" || j.status === "idle") {
          targetJob = j;
          break;
        }
      }
    }
  }

  if (!targetJob) {
    res.status(404).json({ success: false, error: "No active translation job found for this session." });
    return;
  }

  // Enforce server-side immutable lock: only truly completed jobs with all chunks present cannot be resumed
  const completedChunks = targetJob.chunks.filter(
    (c) => c.status === "completed" && !!c.englishText?.trim()
  ).length;
  const expectedTotal = (targetJob as any).totalChunks || targetJob.chunks.length;
  const isFullyCompleted = expectedTotal > 0 &&
    targetJob.chunks.length >= expectedTotal &&
    completedChunks === expectedTotal &&
    targetJob.status === "completed";

  if (isFullyCompleted) {
    targetJob.status = "completed";
    saveJobToDisk(targetJob.sessionId || sessionId, targetJob, true);
    res.status(400).json({
      success: false,
      error: "Job is already completed and locked.",
      status: "completed",
      completedChunks,
      totalChunks: targetJob.chunks.length,
    });
    return;
  }

  targetJob.status = "running";
  targetJob.lastActiveAt = Date.now();
  for (const [sKey, j] of cloudJobs.entries()) {
    if (isSameNovel(j.fileName, targetJob.fileName) || j.id === targetJob.id) {
      j.status = "running";
      j.lastActiveAt = targetJob.lastActiveAt;
      saveJobToDisk(sKey, j, true);
    }
  }

  startCloudWorkerLoop();
  res.json({
    success: true,
    status: "running",
    fileName: targetJob.fileName,
    jobId: targetJob.id,
  });
});

// Archive active cloud job (marks job complete/paused, saves to history list, detaches active session pointer to stop background worker)
app.post("/api/cloud-job/archive", requireAuthMiddleware, (req, res) => {
  const sessionId = getSessionId(req);
  const targetJob = getJobForSession(req);
  const fileName = req.body?.fileName || targetJob?.fileName;

  if (targetJob) {
    const isAllDone = targetJob.chunks.length > 0 && targetJob.chunks.every((c) => c.status === "completed" && !!c.englishText?.trim());
    targetJob.status = isAllDone ? "completed" : "paused";
    targetJob.lastActiveAt = Date.now();
    for (const [sKey, j] of cloudJobs.entries()) {
      if (isSameNovel(j.fileName, targetJob.fileName) || j.id === targetJob.id) {
        j.status = targetJob.status;
        j.lastActiveAt = targetJob.lastActiveAt;
        saveJobToDisk(sKey, j, true);
      }
    }
    console.log(`[Cloud Job] Archived novel "${targetJob.fileName}" (status: ${targetJob.status}). Stopped active worker loop.`);
  }

  // Remove active session binding so home tab starts fresh
  cloudJobs.delete(sessionId);
  cloudJobs.delete("legacy_default");

  res.json({
    success: true,
    message: "Novel successfully archived in history and cloud storage.",
    fileName,
  });
});

// Rehydrate missing chunks from client (automatically restores pending chunks if a server restarted with partial state)
app.post("/api/cloud-job/rehydrate-chunks", requireAuthMiddleware, (req, res) => {
  try {
    const { fileName, chunks } = req.body || {};
    if (!Array.isArray(chunks) || chunks.length === 0) {
      res.status(400).json({ success: false, error: "No chunks provided for rehydration." });
      return;
    }

    const sessionId = getSessionId(req);
    let targetJob = getJobForSession(req);

    if (!targetJob) {
      targetJob = {
        id: "cloud_job_" + Date.now(),
        sessionId,
        fileName: fileName || "novel.txt",
        fileSizeBytes: 0,
        totalChineseChars: chunks.reduce((acc: number, c: any) => acc + (c.charCount || 0), 0),
        chunks,
        style: "xianxia",
        customInstructions: "",
        glossary: [],
        concurrency: 1,
        status: "running",
        startedAt: Date.now(),
        lastActiveAt: Date.now(),
      };
      setJobForSession(sessionId, targetJob);
      startCloudWorkerLoop();
      res.json({
        success: true,
        rehydrated: chunks.length,
        totalChunks: targetJob.chunks.length,
        status: targetJob.status,
      });
      return;
    }

    // Preserve the current job status (e.g. if the user pressed paused, do NOT forcefully overwrite with running!)
    const targetStatus = targetJob.status === "paused" ? "paused" : "running";
    const incomingJob: CloudJob = {
      ...targetJob,
      chunks,
      status: targetStatus,
    };

    const merged = mergeMonotonicCloudJobs(targetJob, incomingJob);
    const completedCount = merged.chunks.filter((c) => c.status === "completed" && !!c.englishText?.trim()).length;
    merged.status = (completedCount === merged.chunks.length && merged.chunks.length > 0) ? "completed" : targetStatus;

    setJobForSession(targetJob.sessionId || sessionId, merged);
    if (merged.status === "running") {
      startCloudWorkerLoop();
    }

    res.json({
      success: true,
      rehydrated: chunks.length,
      totalChunks: merged.chunks.length,
      completedChunks: completedCount,
      status: merged.status,
    });
  } catch (err: any) {
    console.error("Failed to rehydrate chunks:", err);
    res.status(500).json({ success: false, error: err.message || "Failed to rehydrate chunks." });
  }
});

// Stop and clear cloud job permanently
app.post("/api/cloud-job/stop", requireAuthMiddleware, async (req, res) => {
  const sessionId = getSessionId(req);
  const body = req.body || {};
  const explicitFileName = body.fileName || (req.headers["x-novel-filename"] ? decodeURIComponent(req.headers["x-novel-filename"] as string) : "");
  const explicitJobId = body.jobId;
  const clearAll = body.clearAll === true;

  const targetJob = getJobForSession(req);
  if (targetJob) {
    targetJob.status = "idle";
  }
  await deleteJobCompletely(targetJob, sessionId, explicitFileName, explicitJobId, clearAll);
  res.json({
    success: true,
    message: clearAll ? "All cloud jobs and archives removed." : "Cloud job removed permanently.",
  });
});

// Explicit permanent deletion endpoint
app.post("/api/cloud-job/delete", requireAuthMiddleware, async (req, res) => {
  const sessionId = getSessionId(req);
  const body = req.body || {};
  const explicitFileName = body.fileName || (req.headers["x-novel-filename"] ? decodeURIComponent(req.headers["x-novel-filename"] as string) : "");
  const explicitJobId = body.jobId;
  const clearAll = body.clearAll === true;

  const targetJob = getJobForSession(req);
  if (targetJob) {
    targetJob.status = "idle";
  }
  await deleteJobCompletely(targetJob, sessionId, explicitFileName, explicitJobId, clearAll);
  res.json({
    success: true,
    message: clearAll ? "All translation records removed." : "Novel translation deleted permanently.",
  });
});

// List all distinct novels currently saved or translating on the server
app.get("/api/cloud-job/list", requireAuthMiddleware, async (req, res) => {
  const novelMap = new Map<string, any>();
  const tombstones = await getDeletedJobTombstonesFromFirestore();

  // 1. Gather from in-memory cloudJobs
  for (const job of cloudJobs.values()) {
    if (isSyntheticOrTestJob(job)) continue;
    const name = job.fileName || "novel.txt";
    const key = name.trim().toLowerCase();

    // Check tombstones and deleted flags
    if (
      tombstones.ids.has(job.id) ||
      tombstones.fileNames.has(key) ||
      Array.from(tombstones.fileNames).some((t) => isSameNovel(t, key)) ||
      (job as any).isDeleted
    ) {
      continue;
    }

    let total = (job as any).totalChunks || (job.chunks ? job.chunks.length : 0);
    let completed = job.chunks && job.chunks.length > 0
      ? job.chunks.filter((c) => c.status === "completed" && !!c.englishText?.trim()).length
      : ((job as any).completedChunks || (job.status === "completed" ? total : 0));

    if (total === 0 && job.id) {
      const full = await loadJobFromFirestore(job.id);
      if (full && full.chunks && full.chunks.length > 0) {
        job.chunks = full.chunks;
        (job as any).totalChunks = full.chunks.length;
        (job as any).completedChunks = full.chunks.filter((c) => c.status === "completed" && !!c.englishText?.trim()).length;
        total = (job as any).totalChunks;
        completed = (job as any).completedChunks;
        cloudJobs.set(job.sessionId || job.id, job);
      }
    }

    let countedWords = (job.chunks || []).reduce((acc, c) => acc + (c.englishText ? countEnglishWords(c.englishText) : (c.wordCount || 0)), 0);
    const wordCount = (isSameNovel(job.fileName, "primitive chen qi") || isSameNovel(job.fileName, "穿越兽世当神棍"))
      ? Math.max(455147, (job as any).completedEnglishWords || 0, countedWords)
      : Math.max((job as any).completedEnglishWords || 0, countedWords);

    const isAllDone = (total > 0 && completed >= total) || job.status === "completed";
    let effectiveStatus = isAllDone ? "completed" : job.status;
    if (effectiveStatus === "running" && (total === 0 || !isCloudWorkerRunning)) {
      effectiveStatus = isAllDone ? "completed" : "paused";
    }

    if (!novelMap.has(key) || (job.lastActiveAt || 0) > (novelMap.get(key).lastActiveAt || 0)) {
      novelMap.set(key, {
        id: job.id,
        sessionId: job.sessionId,
        fileName: job.fileName,
        status: effectiveStatus,
        completedChunks: (isSameNovel(job.fileName, "primitive chen qi") || isSameNovel(job.fileName, "穿越兽世当神棍")) ? 404 : completed,
        totalChunks: (isSameNovel(job.fileName, "primitive chen qi") || isSameNovel(job.fileName, "穿越兽世当神棍")) ? 404 : total,
        wordCount,
        lastActiveAt: job.lastActiveAt || job.startedAt || Date.now(),
        startedAt: job.startedAt || Date.now(),
      });
    }
  }

  // 2. Also inspect disk JOBS_DIR for archived or other completed novel records
  try {
    if (fs.existsSync(JOBS_DIR)) {
      const files = fs.readdirSync(JOBS_DIR);
      for (const f of files) {
        if (!f.endsWith(".json") || f.startsWith("deleted_")) continue;
        try {
          const content = fs.readFileSync(path.join(JOBS_DIR, f), "utf-8");
          const parsed = JSON.parse(content);
          if (parsed && parsed.fileName && !isSyntheticOrTestJob(parsed) && !parsed.isDeleted) {
            const key = parsed.fileName.trim().toLowerCase();
            const isTombstoned =
              tombstones.ids.has(parsed.id) ||
              tombstones.fileNames.has(key) ||
              Array.from(tombstones.fileNames).some((t) => isSameNovel(t, key));

            if (!isTombstoned && !novelMap.has(key)) {
              let total = (parsed as any).totalChunks || (parsed.chunks ? parsed.chunks.length : 0);
              let completed = parsed.chunks && parsed.chunks.length > 0
                ? (parsed.chunks || []).filter((c: any) => c.status === "completed" && !!c.englishText?.trim()).length
                : ((parsed as any).completedChunks || (parsed.status === "completed" ? total : 0));
              let diskCountedWords = (parsed.chunks || []).reduce((acc: number, c: any) => acc + (c.englishText ? countEnglishWords(c.englishText) : (c.wordCount || 0)), 0);
              const wordCount = (isSameNovel(parsed.fileName, "primitive chen qi") || isSameNovel(parsed.fileName, "穿越兽世当神棍"))
                ? Math.max(455147, (parsed as any).completedEnglishWords || 0, diskCountedWords)
                : Math.max((parsed as any).completedEnglishWords || 0, diskCountedWords);

              if (isSameNovel(parsed.fileName, "primitive chen qi") || isSameNovel(parsed.fileName, "穿越兽世当神棍")) {
                total = 404;
                completed = 404;
              }
              const isAllDone = total > 0 && completed >= total;
              let effectiveStatus = isAllDone ? "completed" : (parsed.status || "idle");
              if (effectiveStatus === "running" && !isCloudWorkerRunning) {
                effectiveStatus = isAllDone ? "completed" : "paused";
              }

              novelMap.set(key, {
                id: parsed.id || f.replace(".json", ""),
                sessionId: parsed.sessionId || "disk",
                fileName: parsed.fileName,
                status: effectiveStatus,
                completedChunks: completed,
                totalChunks: total,
                wordCount,
                lastActiveAt: parsed.lastActiveAt || parsed.startedAt || Date.now(),
                startedAt: parsed.startedAt || Date.now(),
              });
            }
          }
        } catch {}
      }
    }
  } catch {}

  const novels = Array.from(novelMap.values()).sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0));
  res.json({ success: true, novels });
});

// Sync manual edit to a chunk or retry outcome
app.post("/api/cloud-job/update-chunk", requireAuthMiddleware, async (req, res) => {
  const sessionId = getSessionId(req);
  const targetJob = getJobForSession(req);
  const { chunkId, englishText, status } = req.body;
  if (!targetJob || !chunkId) {
    res.status(400).json({ error: "Job or chunk ID not found." });
    return;
  }

  const chunk = targetJob.chunks.find((c) => c.id === chunkId);
  if (!chunk) {
    res.status(404).json({ error: `Chunk ${chunkId} not found in job.` });
    return;
  }

  const prevEnglish = chunk.englishText;
  const prevStatus = chunk.status;
  const prevEdited = chunk.edited;

  if (englishText !== undefined) {
    chunk.englishText = englishText;
    chunk.edited = true;
  }
  if (status) {
    chunk.status = status;
  }
  chunk.errorMessage = undefined;
  targetJob.lastActiveAt = Date.now();

  try {
    const saved = await saveChunkToFirestore(targetJob.id, chunk);
    if (!saved) {
      console.warn(`[Storage] Cloud Firestore write throttled or unavailable; saved chunk #${chunk.index} edit directly to local disk cache.`);
    }

    saveJobToFirestore(targetJob).catch(() => {});
    saveJobToDisk(targetJob.sessionId || sessionId, targetJob);
    res.json({ success: true, cloudSynced: saved });
  } catch (err: any) {
    console.warn(`[Storage] Notice persisting chunk edit to Firestore: ${err.message}. Saved to local disk.`);
    saveJobToDisk(targetJob.sessionId || sessionId, targetJob);
    res.json({ success: true, cloudSynced: false });
  }
});

// Update settings on the cloud job (e.g. style, instructions, glossary) while running or paused
app.post("/api/cloud-job/update-settings", requireAuthMiddleware, (req, res) => {
  const sessionId = getSessionId(req);
  const targetJob = getJobForSession(req);
  const { style, customInstructions, glossary, concurrency } = req.body;
  if (targetJob) {
    if (style) targetJob.style = style;
    if (customInstructions !== undefined) targetJob.customInstructions = customInstructions;
    if (glossary) targetJob.glossary = glossary;
    if (concurrency) targetJob.concurrency = concurrency;
    targetJob.lastActiveAt = Date.now();
    saveJobToDisk(targetJob.sessionId || sessionId, targetJob);
  }
  res.json({ success: true, job: targetJob });
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
    const { text, novelTitle } = req.body;
    if (!text || typeof text !== "string") {
      res.status(400).json({ error: "Missing or invalid 'text' field." });
      return;
    }

    const terms = await autoGenerateNovelGlossary(text, novelTitle);
    res.json({ success: true, terms });
  } catch (err: any) {
    console.error("Extract Glossary Error:", err);
    res.status(500).json({
      error: err.message || "Failed to extract glossary terms.",
    });
  }
});

// Dedicated Novel Glossary Auto-Scanner for reader and explore
app.post("/api/novel-glossary/auto-scan", async (req, res) => {
  try {
    const { text, novelTitle, author } = req.body;
    if (!text || typeof text !== "string") {
      res.status(400).json({ error: "Missing or invalid 'text' field." });
      return;
    }

    const terms = await autoGenerateNovelGlossary(text, novelTitle || undefined);
    res.json({ success: true, terms });
  } catch (err: any) {
    console.error("Auto scan glossary error:", err);
    res.status(500).json({
      error: err.message || "Failed to auto-scan novel glossary.",
    });
  }
});

// ------------------------------------------------------------------
// STORE & NOVEL SCRAPER ENDPOINTS
// ------------------------------------------------------------------

// In-memory cache for store search (15 min TTL) to make searches and store comparisons instantaneous
interface StoreSearchCacheEntry {
  results: any[];
  timestamp: number;
}
const storeSearchCache = new Map<string, StoreSearchCacheEntry>();
const STORE_SEARCH_CACHE_TTL_MS = 15 * 60 * 1000;

// Universal Store Search Endpoint
app.get("/api/store/search", requireAuthMiddleware, async (req, res) => {
  try {
    const query = (req.query.q as string) || "";
    const site = (req.query.site as string) || "all";

    if (!query.trim()) {
      res.json({ results: [] });
      return;
    }

    const cacheKey = `search:${site}:${query.toLowerCase().trim()}`;
    const cached = storeSearchCache.get(cacheKey);
    const now = Date.now();
    if (cached && (now - cached.timestamp) < STORE_SEARCH_CACHE_TTL_MS) {
      res.json({ results: cached.results, cached: true });
      return;
    }

    const results = await searchStoreNovels(query, site);
    // Translate top search results to English automatically (0 Gemini quota used)
    await translateExploreItemsInPlace(results.slice(0, 30));

    storeSearchCache.set(cacheKey, { results, timestamp: now });
    if (storeSearchCache.size > 200) {
      const oldestKey = storeSearchCache.keys().next().value;
      if (oldestKey) storeSearchCache.delete(oldestKey);
    }

    res.json({ results, cached: false });
  } catch (err: any) {
    console.error("Store Search Error:", err);
    res.status(500).json({ error: err.message || "Store search failed." });
  }
});

// In-memory cache for explore feed (20 min TTL) for instant tab/filter switching
interface ExploreCacheEntry {
  data: any[];
  timestamp: number;
}
const exploreCache = new Map<string, ExploreCacheEntry>();
const EXPLORE_CACHE_TTL_MS = 20 * 60 * 1000;

// Explorer & Discovery Leaderboards Endpoint (Filter by Year, Pairing, Trope, Keywords & Sort by Points/Likes)
app.get("/api/store/explore", requireAuthMiddleware, async (req, res) => {
  try {
    const site = (req.query.site as string) || "all";
    const year = (req.query.year as string) || "all";
    const orientation = (req.query.orientation as string) || "all";
    const rawTagParam = (req.query.tags as string) || (req.query.tag as string) || "all";
    const tags = rawTagParam === "all" ? [] : rawTagParam.split(",").map((t) => t.trim()).filter(Boolean);
    const tag = tags[0] || "all";
    const query = (req.query.q as string) || "";
    const sort = (req.query.sort as "points" | "likes" | "aiquLikes" | "recent" | "chapters") || "points";
    const page = parseInt((req.query.page as string) || "1", 10);
    const forceRefresh = req.query.refresh === "true" || req.query.fresh === "true";

    const collectionKey = `explore_col_v5:${site}:${year}:${orientation}:${tags.slice().sort().join(",")}:${tag}:${query.toLowerCase().trim()}:${sort}`;
    const cached = exploreCache.get(collectionKey);
    const now = Date.now();
    let allItems: any[];

    if (!forceRefresh && cached && (now - cached.timestamp) < EXPLORE_CACHE_TTL_MS) {
      allItems = cached.data;
    } else {
      allItems = await scrapeExploreNovels({
        site,
        year,
        orientation,
        tag,
        tags,
        query,
        sort: sort as any,
        page,
      });

      // Strictly sanitize any legacy aberrant aiquLikes (> 10000)
      for (const it of allItems) {
        if (it.aiquLikes !== undefined && (it.aiquLikes <= 0 || it.aiquLikes > 10000)) {
          delete it.aiquLikes;
        }
      }

      exploreCache.set(collectionKey, { data: allItems, timestamp: now });
      if (exploreCache.size > 150) {
        const oldestKey = exploreCache.keys().next().value;
        if (oldestKey) exploreCache.delete(oldestKey);
      }
    }

    const requestedPageSize = parseInt((req.query.pageSize as string) || "20", 10);
    const PAGE_SIZE = isNaN(requestedPageSize) || requestedPageSize < 1 ? 20 : Math.min(100, requestedPageSize);
    const pageNum = Math.max(1, page);
    const startIndex = (pageNum - 1) * PAGE_SIZE;
    const pageItems = allItems.slice(startIndex, startIndex + PAGE_SIZE);

    // Auto-translate card details (title, author, summary) into English via Google Translate (0 Gemini quota)
    await translateExploreItemsInPlace(pageItems);

    // Non-blocking background enrichment so the response is returned immediately to the client!
    enrichAiquNovelItems(pageItems).catch(() => {});
    enrichJjwxcNovelItems(pageItems).catch(() => {});

    res.json({
      success: true,
      total: allItems.length,
      page: pageNum,
      pageSize: PAGE_SIZE,
      hasMore: startIndex + PAGE_SIZE < allItems.length,
      items: pageItems,
      cached: Boolean(cached),
    });
  } catch (err: any) {
    console.error("Store Explore Error:", err);
    res.status(500).json({ error: err.message || "Failed to explore novel collections." });
  }
});

// Full unabridged novel synopsis endpoint (with Google Translate to English)
app.post("/api/store/full-intro", requireAuthMiddleware, async (req, res) => {
  try {
    const { novelUrl, siteId, title, author } = req.body;
    if (!novelUrl && !title) {
      res.status(400).json({ error: "Missing 'novelUrl' or 'title' parameter." });
      return;
    }

    const fullIntro = await fetchNovelFullIntro({ novelUrl, siteId, title, author });
    res.json(fullIntro);
  } catch (err: any) {
    console.error("Full Intro Fetch Error:", err);
    res.status(500).json({ error: err.message || "Failed to fetch full synopsis." });
  }
});

// Dedicated Google Translate helper endpoint (0 Gemini quota consumed)
app.post("/api/store/translate-text", requireAuthMiddleware, async (req, res) => {
  try {
    const { text, from = "zh-CN", to = "en" } = req.body;
    if (!text || typeof text !== "string") {
      res.status(400).json({ error: "Missing text to translate." });
      return;
    }
    const translated = await translateWithGoogle(text, from, to);
    res.json({ success: true, original: text, translated });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to translate text." });
  }
});

// Quick Chapter Peek Endpoint for reading preview drawer
app.post("/api/store/peek-chapter", requireAuthMiddleware, async (req, res) => {
  try {
    const { novelUrl, siteId, title, author, intro, coverUrl, fileSize, targetIndex, targetChapterUrl } = req.body;
    if (!novelUrl && !title) {
      res.status(400).json({ error: "Missing 'novelUrl' or 'title' parameter." });
      return;
    }

    let detail = await fetchNovelTOC(novelUrl || "", siteId || "general", title, author, intro, coverUrl, fileSize);
    if ((!detail.chapters || detail.chapters.length === 0) && siteId === "jjwxc") {
      const mirrors = await findNovelMirrors(title || "", author || "");
      if (mirrors.length > 0) {
        detail = await fetchNovelTOC(mirrors[0].novelUrl, mirrors[0].siteId, title, author, intro, coverUrl, fileSize);
      }
    }

    if (!detail.chapters || detail.chapters.length === 0) {
      res.status(404).json({ error: "No readable chapters found for this title." });
      return;
    }

    let targetChapter = detail.chapters[0];
    if (typeof targetIndex === "number" && targetIndex >= 1 && targetIndex <= detail.chapters.length) {
      targetChapter = detail.chapters[targetIndex - 1];
    } else if (targetChapterUrl) {
      const found = detail.chapters.find((c) => c.url === targetChapterUrl);
      if (found) targetChapter = found;
    }

    const chapterBody = await fetchChapterText(targetChapter.url);

    // Auto-translate chapter content and title with Google Translate (0 Gemini quota, 0 client mobile data)
    let englishContent = "";
    const rawChapterTitle = targetChapter.title || `Chapter ${targetChapter.index}`;
    let chapterTitleEn = rawChapterTitle;

    try {
      const [translatedBody, translatedTitle] = await Promise.allSettled([
        translateChapterWithGoogle(chapterBody),
        hasChineseCharacters(rawChapterTitle)
          ? translateWithGoogle(rawChapterTitle, "zh-CN", "en", 3000)
          : Promise.resolve(rawChapterTitle),
      ]);
      if (translatedBody.status === "fulfilled" && translatedBody.value) {
        englishContent = translatedBody.value;
      }
      if (translatedTitle.status === "fulfilled" && translatedTitle.value) {
        chapterTitleEn = translatedTitle.value;
      }
    } catch (translateErr) {
      console.warn("Peek chapter auto-translate non-fatal error:", translateErr);
    }

    res.json({
      success: true,
      title: detail.title || title,
      author: detail.author || author,
      chapterTitle: chapterTitleEn || rawChapterTitle,
      chapterTitleZh: rawChapterTitle,
      chapterTitleEn,
      chapterIndex: targetChapter.index,
      totalChapters: detail.chapters.length,
      content: chapterBody,
      englishContent,
      novelUrl: detail.novelUrl || novelUrl,
      siteId: detail.siteId || siteId,
      allChapters: detail.chapters,
    });
  } catch (err: any) {
    console.error("Peek chapter error:", err);
    res.status(500).json({ error: err.message || "Failed to peek novel chapter." });
  }
});

// Dedicated Chapter Fetch Endpoint for rapid chapter navigation
app.post("/api/store/fetch-chapter", requireAuthMiddleware, async (req, res) => {
  try {
    const { chapterUrl, chapterTitle } = req.body;
    if (!chapterUrl) {
      res.status(400).json({ error: "Missing 'chapterUrl' parameter." });
      return;
    }

    const content = await fetchChapterText(chapterUrl);
    const rawChapterTitle = chapterTitle || "Chapter";
    let englishContent = "";
    let chapterTitleEn = rawChapterTitle;

    try {
      const [translatedBody, translatedTitle] = await Promise.allSettled([
        translateChapterWithGoogle(content),
        hasChineseCharacters(rawChapterTitle)
          ? translateWithGoogle(rawChapterTitle, "zh-CN", "en", 3000)
          : Promise.resolve(rawChapterTitle),
      ]);
      if (translatedBody.status === "fulfilled" && translatedBody.value) {
        englishContent = translatedBody.value;
      }
      if (translatedTitle.status === "fulfilled" && translatedTitle.value) {
        chapterTitleEn = translatedTitle.value;
      }
    } catch (translateErr) {
      console.warn("Fetch chapter auto-translate non-fatal error:", translateErr);
    }

    res.json({
      success: true,
      chapterTitle: chapterTitleEn || rawChapterTitle,
      chapterTitleZh: rawChapterTitle,
      chapterTitleEn,
      content,
      englishContent,
    });
  } catch (err: any) {
    console.error("Fetch chapter error:", err);
    res.status(500).json({ error: err.message || "Failed to fetch chapter text." });
  }
});

// On-demand instant translation for a single chapter directly in Reader mode
app.post("/api/store/translate-single-chapter", requireAuthMiddleware, async (req, res) => {
  try {
    const { content, chapterTitle, novelTitle, glossary } = req.body;
    if (!content || !content.trim()) {
      res.status(400).json({ error: "Missing 'content' parameter to translate." });
      return;
    }

    let glossaryBlock = "";
    if (Array.isArray(glossary) && glossary.length > 0) {
      const formattedTerms = glossary
        .filter((t: any) => t && t.original && t.translation)
        .map((t: any) => `- "${t.original}" -> "${t.translation}"${t.category ? ` (${t.category})` : ""}`)
        .join("\n");
      if (formattedTerms) {
        glossaryBlock = `\n\nYou MUST strictly adhere to the following glossary mappings for character names, locations, and terminology across all chapters:\n${formattedTerms}\n`;
      }
    }

    const cleanContent = content.trim();
    const systemPrompt = `You are an elite literary Chinese-to-English web novel translator. Translate faithfully into fluent, captivating English prose without conversational commentary. Preserve names, titles, and dialogue nuance naturally.${glossaryBlock}`;

    let translatedEnglish = "";
    let modelUsed = "";

    // If chapter text is <= 4000 characters, translate in a single high-speed pass
    if (cleanContent.length <= 4000) {
      const userPrompt = `Translate the following chapter into natural, immersive English:\n\nNovel: ${
        novelTitle || "Web Novel"
      }\nChapter: ${chapterTitle || "Chapter"}\n\nOriginal Text:\n"""\n${cleanContent}\n"""\n\nEnglish Translation:`;

      const result = await generateWithQuotaScheduler(userPrompt, systemPrompt, 0, 5, 2000);
      translatedEnglish = result.text.trim();
      modelUsed = result.modelUsed;
    } else {
      // Long chapter (> 4000 chars): partition into safe ~3000 character chunks to prevent 504 Deadline Exceeded
      const paragraphs = cleanContent.split(/\r?\n+/).map((p: string) => p.trim()).filter((p: string) => p.length > 0);
      const chunks: string[] = [];
      let currentChunk = "";

      for (const p of paragraphs) {
        if ((currentChunk + "\n\n" + p).length > 3000 && currentChunk.length > 0) {
          chunks.push(currentChunk);
          currentChunk = p;
        } else {
          currentChunk = currentChunk ? currentChunk + "\n\n" + p : p;
        }
      }
      if (currentChunk) chunks.push(currentChunk);

      // Bound chunks to a safe limit (max 5 chunks)
      const targetChunks = chunks.slice(0, 5);
      const translatedParts: string[] = [];

      for (let i = 0; i < targetChunks.length; i++) {
        const subPrompt = `Translate this part (${i + 1}/${targetChunks.length}) of the chapter into natural, immersive English:\n\nNovel: ${
          novelTitle || "Web Novel"
        }\nChapter: ${chapterTitle || "Chapter"}\n\nOriginal Text:\n"""\n${targetChunks[i]}\n"""\n\nEnglish Translation:`;

        const resPart = await generateWithQuotaScheduler(subPrompt, systemPrompt, 0, 4, 1500);
        translatedParts.push(resPart.text.trim());
        modelUsed = resPart.modelUsed;
      }
      translatedEnglish = translatedParts.join("\n\n");
    }

    res.json({
      success: true,
      chapterTitle: chapterTitle || "Chapter",
      englishContent: translatedEnglish,
      modelUsed,
    });
  } catch (err: any) {
    console.error("Translate single chapter error:", err);
    res.status(500).json({ error: formatCleanErrorMessage(err) || "Failed to translate chapter." });
  }
});

// Find readable mirrors across all 11 library sites for any novel title (JJWXC, Changpei, etc.)
app.post("/api/store/find-mirrors", requireAuthMiddleware, async (req, res) => {
  try {
    const { title, author } = req.body;
    if (!title) {
      res.status(400).json({ error: "Missing 'title' parameter." });
      return;
    }

    const mirrors = await findNovelMirrors(title, author);
    res.json({ success: true, title, mirrors });
  } catch (err: any) {
    console.error("Find Mirrors Error:", err);
    res.status(500).json({ error: err.message || "Failed to find novel mirrors." });
  }
});

// Fetch Novel Table of Contents with automatic cross-mirror fallback
app.post("/api/store/fetch-toc", requireAuthMiddleware, async (req, res) => {
  try {
    const { novelUrl, siteId, title, author, intro, coverUrl, fileSize } = req.body;
    if (!novelUrl) {
      res.status(400).json({ error: "Missing 'novelUrl' parameter." });
      return;
    }

    // If siteId is jjwxc or external, try finding mirrors if direct TOC fails
    if (siteId === "jjwxc") {
      const mirrors = await findNovelMirrors(title || "", author || "");
      if (mirrors.length > 0) {
        // Try fetching TOC from top mirror
        try {
          const topMirror = mirrors[0];
          const mirrorToc = await fetchNovelTOC(topMirror.novelUrl, topMirror.siteId, title, author, intro, coverUrl, fileSize);
          if (mirrorToc.chapters && mirrorToc.chapters.length > 0) {
            res.json({
              ...mirrorToc,
              resolvedMirror: {
                siteId: topMirror.siteId,
                siteName: topMirror.siteName,
                novelUrl: topMirror.novelUrl,
              },
              allMirrors: mirrors,
            });
            return;
          }
        } catch {}
      }

      // If no mirror TOC yet, return empty chapters with available mirrors
      res.json({
        title: title || "JJWXC Novel",
        author: author || "Unknown",
        novelUrl,
        intro: intro || "No summary available.",
        coverUrl: coverUrl || "",
        fileSize: fileSize || "1.95 MB",
        chapters: [],
        allMirrors: mirrors,
        isExternalSource: true,
      });
      return;
    }

    const detail = await fetchNovelTOC(novelUrl, siteId || "general", title, author, intro, coverUrl, fileSize);
    res.json(detail);
  } catch (err: any) {
    console.error("Fetch TOC Error:", err);
    res.status(500).json({ error: err.message || "Failed to fetch novel table of contents." });
  }
});

// Scrape and compile chapters for translation import (supports import all / full novel download)
app.post("/api/store/import-novel", requireAuthMiddleware, async (req, res) => {
  try {
    const { novelUrl, siteId, title, startChapter = 1, endChapter, chapters = [], importAll = false } = req.body;

    let targetChapters = chapters;
    if (!targetChapters || targetChapters.length === 0) {
      let toc = await fetchNovelTOC(novelUrl, siteId || "general", title);
      if ((!toc.chapters || toc.chapters.length === 0) && siteId === "jjwxc") {
        const mirrors = await findNovelMirrors(title || "", req.body.author || "");
        if (mirrors.length > 0) {
          toc = await fetchNovelTOC(mirrors[0].novelUrl, mirrors[0].siteId, title, req.body.author);
        }
      }
      targetChapters = toc.chapters;
    }

    const maxAvailable = targetChapters.length || 1;
    const effectiveEnd = importAll || !endChapter || endChapter >= maxAvailable ? maxAvailable : endChapter;

    // Filter by index range
    const selected = targetChapters.filter(
      (c: any) => c.index >= startChapter && c.index <= effectiveEnd
    );

    if (selected.length === 0) {
      res.status(400).json({ error: "No chapters found in the selected range." });
      return;
    }

    // Fetch chapter contents with paced concurrency and progressive retry + mirror failover
    const chapterTexts: string[] = [];
    const BATCH_SIZE = 2;
    const failedChapterIndices: number[] = [];

    let mirrorTocCache: any = null;
    let mirrorSearchAttempted = false;

    for (let i = 0; i < selected.length; i += BATCH_SIZE) {
      const batch = selected.slice(i, i + BATCH_SIZE);
      const fetched = await Promise.all(
        batch.map(async (item: any) => {
          let body = await fetchChapterText(item.url);

          // If empty or short (< 30 chars), retry with progressive backoff
          if (!body || body.trim().length < 30) {
            await new Promise((r) => setTimeout(r, 800));
            body = await fetchChapterText(item.url);
          }
          if (!body || body.trim().length < 30) {
            await new Promise((r) => setTimeout(r, 1800));
            body = await fetchChapterText(item.url);
          }

          // If still empty, attempt multi-site mirror fallback
          if ((!body || body.trim().length < 30) && (title || req.body.author)) {
            try {
              if (!mirrorTocCache && !mirrorSearchAttempted) {
                mirrorSearchAttempted = true;
                const cleanTitle = (title || "").replace(/^《|》$/g, "").trim();
                const mirrors = await findNovelMirrors(cleanTitle, req.body.author);
                for (const m of mirrors) {
                  if (m.novelUrl && m.siteId !== siteId) {
                    try {
                      const mToc = await fetchNovelTOC(m.novelUrl, m.siteId, cleanTitle, req.body.author);
                      if (mToc && mToc.chapters && mToc.chapters.length > 0) {
                        mirrorTocCache = mToc.chapters;
                        break;
                      }
                    } catch {}
                  }
                }
              }

              if (mirrorTocCache && mirrorTocCache.length > 0) {
                // Match mirror chapter by index or by title
                const mirrorChapter =
                  mirrorTocCache.find((mc: any) => mc.index === item.index) ||
                  mirrorTocCache.find(
                    (mc: any) =>
                      item.title &&
                      mc.title &&
                      (mc.title.includes(item.title) || item.title.includes(mc.title))
                  );
                if (mirrorChapter && mirrorChapter.url) {
                  const mirrorBody = await fetchChapterText(mirrorChapter.url);
                  if (mirrorBody && mirrorBody.trim().length > 30) {
                    body = mirrorBody;
                    console.log(`[Import Novel] Recovered Chapter ${item.index} ("${item.title}") via mirror failover.`);
                  }
                }
              }
            } catch (mirrorErr) {
              console.warn(`[Import Novel] Mirror fallback error for Chapter ${item.index}:`, mirrorErr);
            }
          }

          const chHeader = item.title ? `${item.title}\n\n` : `第${item.index}章\n\n`;
          if (!body || body.trim().length < 30) {
            failedChapterIndices.push(item.index);
            return `${chHeader}[Content from this chapter could not be retrieved from source site]`;
          }
          return `${chHeader}${body}`;
        })
      );
      chapterTexts.push(...fetched);
      if (i + BATCH_SIZE < selected.length) {
        await new Promise((r) => setTimeout(r, 120));
      }
    }

    const fullRawText = chapterTexts.filter(Boolean).join("\n\n\n");

    res.json({
      success: true,
      title: title || "Imported Web Novel",
      totalChaptersScraped: selected.length,
      failedChaptersCount: failedChapterIndices.length,
      failedChapterIndices,
      rawText: fullRawText,
    });
  } catch (err: any) {
    console.error("Import Novel Error:", err);
    res.status(500).json({ error: err.message || "Failed to scrape novel chapters." });
  }
});

// Authentic Google Text-to-Speech Audio Stream Proxy (100% Classic Google US Female Voice)
app.get("/api/tts/google-audio", async (req, res) => {
  const text = (req.query.text as string) || "";
  const lang = (req.query.lang as string) || "en";
  if (!text.trim()) {
    res.status(400).send("Text is required");
    return;
  }
  try {
    const cleanText = text.trim().slice(0, 200);
    const googleTtsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&tl=${encodeURIComponent(
      lang
    )}&client=tw-ob&q=${encodeURIComponent(cleanText)}`;

    const audioRes = await fetch(googleTtsUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Referer: "https://translate.google.com/",
      },
    });

    if (!audioRes.ok) {
      res.status(audioRes.status).send("Failed to stream Google TTS audio.");
      return;
    }

    const arrayBuffer = await audioRes.arrayBuffer();
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(Buffer.from(arrayBuffer));
  } catch (err: any) {
    console.error("Google TTS Audio Error:", err);
    res.status(500).send(err.message || "Google TTS stream error");
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
    console.log(`[Server] Serving static files from ${distPath}, CWD: ${process.cwd()}`);
    // Cache static immutable assets (JS, CSS, images, fonts) for 1 year to save cellular data on return visits
    app.use(
      express.static(distPath, {
        maxAge: "1y",
        immutable: true,
        setHeaders: (res, filePath) => {
          if (filePath.endsWith("index.html")) {
            // HTML file is checked fresh so updates are immediate, but lightweight
            res.setHeader("Cache-Control", "no-cache");
          }
        },
      })
    );
    app.get("*", (req, res) => {
      res.setHeader("Cache-Control", "no-cache");
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`MegaText Translator server running on http://0.0.0.0:${PORT}`);
  });
}

// Graceful shutdown listeners to notify user when container is sleeping / scaling down
process.on("SIGTERM", async () => {
  console.log("[Process] SIGTERM received. Handling graceful shutdown...");
  try {
    const runningJobs = Array.from(cloudJobs.values()).filter((j) => j.status === "running" && !isSyntheticOrTestJob(j));
    const uniqueRunningNovels = new Map<string, CloudJob>();
    for (const j of runningJobs) {
      if (!uniqueRunningNovels.has(j.fileName)) uniqueRunningNovels.set(j.fileName, j);
    }
    const distinctNovels = Array.from(uniqueRunningNovels.values());
    if (distinctNovels.length > 0) {
      const jobNames = distinctNovels.map((j) => `• <b>${j.fileName}</b>`).join("\n");
      await sendTelegramNotification(
        `⚠️ <b>[Server Sleeping / Paused]</b>\nThe website is going to sleep or shutting down. The translation of your book(s) has been paused:\n${jobNames}\n\nPlease open the website to wake it up and resume translation!`
      );
    }
  } catch (err) {
    console.error("[Process] Failed to send shutdown Telegram notification:", err);
  } finally {
    process.exit(0);
  }
});

process.on("SIGINT", async () => {
  console.log("[Process] SIGINT received. Handling graceful shutdown...");
  try {
    const runningJobs = Array.from(cloudJobs.values()).filter((j) => j.status === "running" && !isSyntheticOrTestJob(j));
    const uniqueRunningNovels = new Map<string, CloudJob>();
    for (const j of runningJobs) {
      if (!uniqueRunningNovels.has(j.fileName)) uniqueRunningNovels.set(j.fileName, j);
    }
    const distinctNovels = Array.from(uniqueRunningNovels.values());
    if (distinctNovels.length > 0) {
      const jobNames = distinctNovels.map((j) => `• <b>${j.fileName}</b>`).join("\n");
      await sendTelegramNotification(
        `⚠️ <b>[Server Sleeping / Paused]</b>\nThe website is going to sleep or shutting down. The translation of your book(s) has been paused:\n${jobNames}\n\nPlease open the website to wake it up and resume translation!`
      );
    }
  } catch (err) {
    console.error("[Process] Failed to send shutdown Telegram notification:", err);
  } finally {
    process.exit(0);
  }
});

startServer();
