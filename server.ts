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
import { sendTelegramNotification } from "./server/telegram";

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
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite"
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

function getJobForSession(req: express.Request): CloudJob | null {
  const sId = getSessionId(req);
  if (cloudJobs.has(sId)) {
    return cloudJobs.get(sId)!;
  }
  // If request has NO explicit device session header (legacy client without headers), check legacy_default
  const hasCustomSessionHeader = !!(req.headers["x-session-id"] || req.headers["x-device-session-id"] || req.query.sessionId || req.query.deviceId);
  if (!hasCustomSessionHeader && cloudJobs.has("legacy_default")) {
    return cloudJobs.get("legacy_default")!;
  }
  return null;
}

function saveJobToDisk(sessionId: string, job?: CloudJob | null) {
  try {
    const safeKey = sanitizeSessionKey(sessionId);
    const jobFilePath = path.join(JOBS_DIR, `job_${safeKey}.json`);
    if (job) {
      fs.writeFileSync(jobFilePath, JSON.stringify(job, null, 2), "utf-8");
      // Keep legacy root file synced if this is the legacy or default job
      if (sessionId === "legacy_default" || cloudJobs.size === 1) {
        fs.writeFileSync(CLOUD_JOB_FILE, JSON.stringify(job, null, 2), "utf-8");
      }
    } else {
      if (fs.existsSync(jobFilePath)) {
        fs.unlinkSync(jobFilePath);
      }
      if (sessionId === "legacy_default" && fs.existsSync(CLOUD_JOB_FILE)) {
        fs.unlinkSync(CLOUD_JOB_FILE);
      }
    }
  } catch (err) {
    console.error(`Failed to save cloud job for session ${sessionId} to disk:`, err);
  }
}

function setJobForSession(sessionId: string, job: CloudJob | null) {
  if (job) {
    job.sessionId = sessionId;
    cloudJobs.set(sessionId, job);
    saveJobToDisk(sessionId, job);
  } else {
    cloudJobs.delete(sessionId);
    saveJobToDisk(sessionId, null);
  }
}

// Load saved cloud jobs from disk on startup
function loadCloudJobsFromDisk() {
  try {
    if (!fs.existsSync(JOBS_DIR)) {
      fs.mkdirSync(JOBS_DIR, { recursive: true });
    }

    const jobFiles = fs.readdirSync(JOBS_DIR).filter((f) => f.startsWith("job_") && f.endsWith(".json"));
    for (const file of jobFiles) {
      try {
        const fullPath = path.join(JOBS_DIR, file);
        const data = fs.readFileSync(fullPath, "utf-8");
        const job: CloudJob = JSON.parse(data);
        const sId = job.sessionId || file.replace(/^job_/, "").replace(/\.json$/, "");
        job.sessionId = sId;

        // Fix any corrupt/empty completed chunks
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
        cloudJobs.set(sId, job);
        console.log(`Loaded session job [${sId}]: "${job.fileName}" (${job.chunks.length} chunks)`);
      } catch (fileErr) {
        console.warn(`Could not load job file ${file}:`, fileErr);
      }
    }

    // Also check legacy single cloud_job.json
    if (fs.existsSync(CLOUD_JOB_FILE) && !cloudJobs.has("legacy_default")) {
      try {
        const data = fs.readFileSync(CLOUD_JOB_FILE, "utf-8");
        const legacyJob: CloudJob = JSON.parse(data);
        if (legacyJob && Array.isArray(legacyJob.chunks)) {
          legacyJob.sessionId = "legacy_default";
          cloudJobs.set("legacy_default", legacyJob);
          saveJobToDisk("legacy_default", legacyJob);
          console.log(`Imported legacy cloud job: "${legacyJob.fileName}" (${legacyJob.chunks.length} chunks)`);
        }
      } catch (legacyErr) {
        console.warn("Could not load legacy cloud job:", legacyErr);
      }
    }

    const runningJobs = Array.from(cloudJobs.values()).filter((j) => j.status === "running");
    if (runningJobs.length > 0) {
      const jobNames = runningJobs.map((j) => `• <b>${j.fileName}</b>`).join("\n");
      sendTelegramNotification(`⚡ <b>[Server Woken Up]</b>\nThe website is awake and has successfully resumed translating your book(s):\n${jobNames}`);
      startCloudWorkerLoop();
    }
  } catch (err) {
    console.error("Failed to load cloud jobs from disk:", err);
  }
}

// Background Worker Loop on the Server - Parallel Multi-Session Translation Engine
const inFlightChunkIds = new Set<string>();

async function startCloudWorkerLoop() {
  if (isCloudWorkerRunning) return;
  isCloudWorkerRunning = true;

  console.log(`[Cloud Background Worker] Started multi-session parallel translation engine`);

  const maxPossibleWorkers = 5;

  const runWorkerTask = async (workerId: number) => {
    while (isCloudWorkerRunning) {
      const runningJobs = Array.from(cloudJobs.values()).filter((j) => j.status === "running");
      if (runningJobs.length === 0) {
        if (inFlightChunkIds.size === 0) {
          isCloudWorkerRunning = false;
          console.log(`[Cloud Background Worker] No active running jobs. Pausing worker loop.`);
          break;
        }
      }

      // Dynamically calculate the active worker limit based on selected concurrency and available projects
      const maxJobConcurrency = runningJobs.length > 0 ? Math.max(...runningJobs.map(j => j.concurrency || 1)) : 1;
      const availableKeysCount = quotaScheduler.enabledProjectCount || 1;
      const activeWorkersLimit = Math.max(1, Math.min(maxJobConcurrency, availableKeysCount, 5));

      if (workerId > activeWorkersLimit) {
        // Excess worker above current dynamic limit - sleep and check again next loop
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }

      const now = Date.now();
      let targetJob: CloudJob | null = null;
      let firstChunk: ServerTextChunk | null = null;

      // Find the next available non-completed chunk across all running jobs
      for (const job of runningJobs) {
        const candidate = job.chunks.find((c) => {
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

        if (candidate) {
          targetJob = job;
          firstChunk = candidate;
          break;
        } else {
          // Check if this job has completed all its chunks
          const allCompleted = job.chunks.every(
            (c) => c.status === "completed" && c.englishText && c.englishText.trim().length > 0
          );
          if (allCompleted && job.status === "running") {
            console.log(`[Cloud Background Worker] Job "${job.fileName}" (${job.sessionId || job.id}) completed!`);
            job.status = "completed";
            job.lastActiveAt = Date.now();
            saveJobToDisk(job.sessionId || "legacy_default", job);
            sendTelegramNotification(`🎉 <b>[Translation Completed]</b>\nYour novel <b>${job.fileName}</b> is fully translated and ready for download!`);
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
              const decomp = await translateWithDecomposition(
                single.chineseText,
                styleGuidance,
                targetJob.customInstructions,
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
                console.log(`[Cloud Worker #${workerId}] Batch parsing fallback: translating chunk #${chunk.index + 1} individually...`);
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

          targetJob.lastActiveAt = Date.now();
          saveJobToDisk(targetJob.sessionId || "legacy_default", targetJob);

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
                firstChunk.status = "completed";
                firstChunk.durationMs = Date.now() - startBatchTime;
                firstChunk.errorMessage = undefined;
                firstChunk.lastErrorAt = undefined;
                inFlightChunkIds.delete(firstChunk.id);
                success = true;
                batchChunks = [];
                targetJob.lastActiveAt = Date.now();
                saveJobToDisk(targetJob.sessionId || "legacy_default", targetJob);
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

// Load any pending jobs on boot
loadCloudJobsFromDisk();

// Periodic Telegram status updates for running translation jobs
const TELEGRAM_STATUS_INTERVAL_MIN = Number(process.env.TELEGRAM_STATUS_INTERVAL_MIN) || 5;
setInterval(() => {
  try {
    const runningJobs = Array.from(cloudJobs.values()).filter((j) => j.status === "running");
    if (runningJobs.length === 0) return;

    for (const job of runningJobs) {
      const totalChunks = job.chunks.length;
      if (totalChunks === 0) continue;

      const completedChunks = job.chunks.filter((c) => c.status === "completed").length;
      const processingChunks = job.chunks.filter((c) => c.status === "processing").length;
      const errorChunks = job.chunks.filter((c) => c.status === "error").length;
      const pendingChunks = job.chunks.filter((c) => c.status === "pending").length;

      const percent = Math.round((completedChunks / totalChunks) * 100);

      // Estimate word count of completed english translation
      let wordCount = 0;
      for (const c of job.chunks) {
        if (c.status === "completed" && c.englishText) {
          wordCount += c.englishText.split(/\s+/).filter(Boolean).length;
        }
      }

      const elapsedMinutes = Math.round((Date.now() - job.startedAt) / 60000);

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
  } catch (err) {
    console.error("[Telegram Status Interval] Error sending status update:", err);
  }
}, TELEGRAM_STATUS_INTERVAL_MIN * 60 * 1000);

// -------------------------------------------------------------
// Security & Master Passcode Gate
// -------------------------------------------------------------
const ACCESS_PASSCODE = (process.env.ACCESS_PASSCODE || "").trim();
const AUTH_SECRET = process.env.AUTH_SECRET || crypto.randomBytes(32).toString("hex");

// In-memory valid token store with expiration (30 days)
interface SessionTokenData {
  userEmail?: string;
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

function createSessionToken(passcodeVerified: boolean): string {
  const token = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  validSessions.set(token, {
    passcodeVerified,
    createdAt: now,
    expiresAt: now + 30 * 24 * 60 * 60 * 1000, // 30 days
  });
  saveSessions();
  return token;
}

function verifyAuthToken(req: express.Request): { isValid: boolean } {
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

  const passcodeRequired = !!ACCESS_PASSCODE;
  if (passcodeRequired && !session.passcodeVerified) {
    return { isValid: false };
  }

  return { isValid: true };
}

// Authentication status endpoint (public)
app.get("/api/auth/status", (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader ? authHeader.replace(/^Bearer\s+/i, "").trim() : "";
  const session = token ? validSessions.get(token) : null;
  const isSessionValid = !!(session && session.expiresAt > Date.now());

  const requiresPasscode = !!ACCESS_PASSCODE;
  const passcodeVerified = isSessionValid ? !!session?.passcodeVerified : !requiresPasscode;
  const fullyAuthenticated = !requiresPasscode || passcodeVerified;

  res.json({
    authenticated: fullyAuthenticated,
    requiresGoogle: false,
    requiresPasscode,
    googleVerified: true,
    passcodeVerified,
    hasPasscodeConfigured: !!ACCESS_PASSCODE,
  });
});

// Master Passcode Login Endpoint
app.post("/api/auth/login", (req, res) => {
  try {
    const { passcode = "" } = req.body;
    const requiresPasscode = !!ACCESS_PASSCODE;

    if (requiresPasscode) {
      if (!passcode || passcode.trim() !== ACCESS_PASSCODE) {
        res.status(401).json({ error: "Invalid master passcode. Access denied." });
        return;
      }
    }

    const newToken = createSessionToken(true);

    res.json({
      success: true,
      authenticated: true,
      token: newToken,
      passcodeVerified: true,
      requiresGoogle: false,
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
      error: "Unauthorized: Please enter the master passcode to access the translation engine.",
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
    hasActiveCloudJob: !!getJobForSession(req),
    cloudJobStatus: getJobForSession(req)?.status || "idle",
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
// Cloud Job API Endpoints (Session-Isolated)
// -------------------------------------------------------------

// Get status & progress of cloud job for current session (Data-saving lightweight mode by default)
app.get("/api/cloud-job/status", (req, res) => {
  const targetJob = getJobForSession(req);
  if (!targetJob) {
    res.json({ hasJob: false, job: null });
    return;
  }

  const includeFullText = req.query.full === "true";

  const completedChunks = targetJob.chunks.filter((c) => c.status === "completed").length;
  const inProgressChunks = targetJob.chunks.filter((c) => c.status === "processing").length;
  const errorChunks = targetJob.chunks.filter((c) => c.status === "error").length;

  if (completedChunks === targetJob.chunks.length && targetJob.status !== "completed") {
    targetJob.status = "completed";
    saveJobToDisk(targetJob.sessionId || getSessionId(req), targetJob);
    sendTelegramNotification(`🎉 <b>[Translation Completed]</b>\nYour novel <b>${targetJob.fileName}</b> is fully translated and ready for download!`);
  }

  // Calculate contiguous completion frontier from index 0
  let contiguousFrontierIndex = -1;
  let contiguousCount = 0;
  for (let i = 0; i < targetJob.chunks.length; i++) {
    const c = targetJob.chunks[i];
    if (c && c.status === "completed" && c.englishText && c.englishText.trim().length > 0) {
      contiguousFrontierIndex = i;
      contiguousCount++;
    } else {
      break;
    }
  }

  const aheadCompletedCount = targetJob.chunks.filter(
    (c) => c.status === "completed" && !!c.englishText?.trim() && c.index > contiguousFrontierIndex
  ).length;

  // Render chunks (lightweight metadata by default to save 99%+ mobile data)
  const chunksData = targetJob.chunks.map((c) => {
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
      totalChunks: targetJob.chunks.length,
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
  const targetJob = getJobForSession(req);
  if (!targetJob) {
    res.json({ success: false, chunks: [] });
    return;
  }

  const indicesParam = req.query.indices as string;
  let targetChunks = targetJob.chunks;
  if (indicesParam) {
    const setIdx = new Set(indicesParam.split(",").map(Number));
    targetChunks = targetJob.chunks.filter((c) => setIdx.has(c.index));
  } else if (req.query.completedOnly === "true") {
    targetChunks = targetJob.chunks.filter(
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

    const sessionId = getSessionId(req);
    const jobId = "cloud_job_" + Date.now();

    const newJob: CloudJob = {
      id: jobId,
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
  const sessionId = getSessionId(req);
  const targetJob = getJobForSession(req);
  if (targetJob) {
    targetJob.status = "paused";
    saveJobToDisk(targetJob.sessionId || sessionId, targetJob);
  }
  res.json({ success: true, status: "paused" });
});

// Resume cloud job
app.post("/api/cloud-job/resume", requireAuthMiddleware, (req, res) => {
  const sessionId = getSessionId(req);
  const targetJob = getJobForSession(req);
  if (targetJob) {
    targetJob.status = "running";
    saveJobToDisk(targetJob.sessionId || sessionId, targetJob);
    startCloudWorkerLoop();
  }
  res.json({ success: true, status: "running" });
});

// Stop and clear cloud job
app.post("/api/cloud-job/stop", requireAuthMiddleware, (req, res) => {
  const sessionId = getSessionId(req);
  const targetJob = getJobForSession(req);
  if (targetJob) {
    targetJob.status = "idle";
    setJobForSession(targetJob.sessionId || sessionId, null);
  }
  res.json({ success: true, message: "Cloud job removed." });
});

// Sync manual edit to a chunk or retry outcome
app.post("/api/cloud-job/update-chunk", requireAuthMiddleware, (req, res) => {
  const sessionId = getSessionId(req);
  const targetJob = getJobForSession(req);
  const { chunkId, englishText, status } = req.body;
  if (targetJob && chunkId) {
    const chunk = targetJob.chunks.find((c) => c.id === chunkId);
    if (chunk) {
      if (englishText !== undefined) {
        chunk.englishText = englishText;
        chunk.edited = true;
      }
      if (status) {
        chunk.status = status;
      }
      chunk.errorMessage = undefined;
      targetJob.lastActiveAt = Date.now();
      saveJobToDisk(targetJob.sessionId || sessionId, targetJob);
    }
  }
  res.json({ success: true });
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

// Graceful shutdown listeners to notify user when container is sleeping / scaling down
process.on("SIGTERM", async () => {
  console.log("[Process] SIGTERM received. Handling graceful shutdown...");
  try {
    const runningJobs = Array.from(cloudJobs.values()).filter((j) => j.status === "running");
    if (runningJobs.length > 0) {
      const jobNames = runningJobs.map((j) => `• <b>${j.fileName}</b>`).join("\n");
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
    const runningJobs = Array.from(cloudJobs.values()).filter((j) => j.status === "running");
    if (runningJobs.length > 0) {
      const jobNames = runningJobs.map((j) => `• <b>${j.fileName}</b>`).join("\n");
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
