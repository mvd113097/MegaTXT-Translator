import express from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
import { quotaScheduler, formatCleanErrorMessage } from "./server/quotaScheduler";

dotenv.config();

const app = express();
const PORT = 3000;

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

// Lazy initialize Gemini client (backward compatibility)
function getGeminiClient(): GoogleGenAI {
  const { project } = quotaScheduler.selectProject();
  return project.client;
}

// High reliability free-tier translation engine with multi-project quota pooling,
// exponential backoff, and content-filter resilience.
// Deprecated models (gemini-1.5-*, gemini-2.0-*, gemini-2.5-*) are omitted to prevent 404 Not Found errors.
const FREE_TIER_MODELS = [
  "gemini-3.5-flash",
  "gemini-3.8-flash",
  "gemini-flash-latest",
  "gemini-3.1-flash-lite",
  "gemini-3.6-flash"
];

// In-memory tracking of model availability and quota cooldowns
const modelCooldowns = new Map<string, number>();
const deprecatedModels = new Set<string>();

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

  try {
    const response = await project.client.models.generateContent({
      model: modelName,
      contents: userPrompt,
      config: {
        systemInstruction,
        temperature: 0.3,
        topP: 0.9,
      },
    });

    let resultText = response.text || "";

    // Empty or filtered response recovery
    if (!resultText.trim()) {
      const blockReason =
        (response as any).promptFeedback?.blockReason ||
        response.candidates?.[0]?.finishReason;
      console.warn(
        `[Gemini Engine] Empty response or block on ${project.name} (${modelName}, reason: ${
          blockReason || "NONE"
        }). Attempting literary recovery...`
      );

      // Attempt 1: Direct clean prompt
      const textToTranslate = rawSourceText || userPrompt;
      const cleanDirectPrompt = `You are a professional literary translator. Translate the following Chinese novel chapter accurately and completely into English, preserving all paragraphs and dialogues without summarizing:\n\n${textToTranslate}`;

      try {
        const directRes = await project.client.models.generateContent({
          model: modelName,
          contents: cleanDirectPrompt,
          config: { temperature: 0.3 },
        });
        if (directRes.text && directRes.text.trim()) {
          console.log(
            `[Gemini Engine] Direct prompt recovery succeeded (${directRes.text.length} chars) on ${project.name}.`
          );
          quotaScheduler.recordSuccess(project.id);
          modelCooldowns.delete(modelName);
          return { text: directRes.text, modelUsed: modelName, projectUsed: project.name };
        }
      } catch (directErr: any) {
        console.warn(`[Gemini Engine] Direct recovery error:`, directErr.message || directErr);
      }

      // Attempt 2: Split-chunk recovery for large text
      if (textToTranslate.length > 2500) {
        console.log(`[Gemini Engine] Split-chunk recovery for ${textToTranslate.length} chars...`);
        const mid = Math.floor(textToTranslate.length / 2);
        const splitIndex =
          textToTranslate.indexOf("\n", mid) !== -1 ? textToTranslate.indexOf("\n", mid) : mid;
        const part1 = textToTranslate.slice(0, splitIndex).trim();
        const part2 = textToTranslate.slice(splitIndex).trim();

        const [res1, res2] = await Promise.all([
          project.client.models.generateContent({
            model: modelName,
            contents: `Translate the following Chinese passage faithfully into English:\n\n${part1}`,
            config: { temperature: 0.3 },
          }),
          project.client.models.generateContent({
            model: modelName,
            contents: `Translate the following Chinese passage faithfully into English:\n\n${part2}`,
            config: { temperature: 0.3 },
          }),
        ]);

        const combined = `${res1.text || ""}\n\n${res2.text || ""}`.trim();
        if (combined) {
          console.log(`[Gemini Engine] Split-chunk recovery succeeded (${combined.length} chars).`);
          quotaScheduler.recordSuccess(project.id);
          modelCooldowns.delete(modelName);
          return { text: combined, modelUsed: modelName, projectUsed: project.name };
        }
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

    const isAuthOrInvalidKey =
      err.status === 401 ||
      err.status === 403 ||
      err.statusCode === 401 ||
      err.statusCode === 403 ||
      errStr.includes("401") ||
      errStr.includes("403") ||
      errStr.includes("unauthenticated") ||
      errStr.includes("permission_denied") ||
      errStr.includes("invalid authentication credentials") ||
      errStr.includes("access_token_type_unsupported") ||
      errStr.includes("api key not valid") ||
      errStr.includes("api_key_invalid");

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
      console.log(`[Gemini Engine] Safety trigger on ${project.name}. Attempting literary framing...`);
      const textToUse = rawSourceText || userPrompt;
      const cleanPrompt = `Translate the following classical Chinese novel chapter faithfully into English:\n\n${textToUse}`;
      return generateWithQuotaScheduler(
        cleanPrompt,
        "You are an objective translator for historical fiction.",
        currentModelIdx,
        retries - 1,
        2000,
        rawSourceText,
        excludeProjectIds
      );
    }

    // 3. Quota / Rate Limit (429) or Transient (500/503)
    if ((isRateLimit || isTemporary) && retries > 0) {
      quotaScheduler.recordFailure(project.id, err);
      excludeProjectIds.add(project.id);

      // If we have tried all projects in this round, clear exclusion to allow earliest ready project
      const nextExclude = new Set(excludeProjectIds);
      if (nextExclude.size >= quotaScheduler.projectCount) {
        nextExclude.clear();
      }

      console.log(
        `[Quota Scheduler] Project ${project.name} throttled. Failing over immediately to next available project...`
      );

      return generateWithQuotaScheduler(
        userPrompt,
        systemInstruction,
        isRateLimit ? currentModelIdx : currentModelIdx + 1,
        retries - 1,
        currentDelay,
        rawSourceText,
        nextExclude
      );
    }

    throw err;
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
  errorMessage?: string;
  durationMs?: number;
  edited?: boolean;
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
            c.status = "pending";
            c.errorMessage = undefined;
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

// Background Worker Loop on the Server - Parallel Translation with Sequential Export Frontier
const inFlightChunkIds = new Set<string>();

async function startCloudWorkerLoop() {
  if (isCloudWorkerRunning) return;
  isCloudWorkerRunning = true;

  const jobFileName = activeCloudJob?.fileName || "job";
  const numWorkers = Math.max(1, Math.min(activeCloudJob?.concurrency || 4, quotaScheduler.enabledProjectCount || 4, 5));
  console.log(
    `[Cloud Background Worker] Started parallel translation engine (${numWorkers} concurrent workers) for: "${jobFileName}"`
  );

  const runWorkerTask = async (workerId: number) => {
    let workerAttemptStreak = 0;

    while (activeCloudJob && activeCloudJob.status === "running") {
      // Find the next available non-completed chunk not already in-flight
      const pendingChunk = activeCloudJob.chunks.find(
        (c) =>
          (c.status !== "completed" || !c.englishText || !c.englishText.trim()) &&
          !inFlightChunkIds.has(c.id)
      );

      if (!pendingChunk) {
        // If no pending chunks and no other workers running, we are fully done
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
        // Wait a bit before checking for retries or new items
        await new Promise((r) => setTimeout(r, 600));
        continue;
      }

      // Claim chunk exclusively for this worker
      inFlightChunkIds.add(pendingChunk.id);
      pendingChunk.status = "processing";
      activeCloudJob.lastActiveAt = Date.now();
      saveCloudJobToDisk();

      // Find preceding context for narrative continuity
      let prevContext = "";
      const prevChunk = activeCloudJob.chunks[pendingChunk.index - 1];
      if (prevChunk && prevChunk.englishText) {
        prevContext = prevChunk.englishText.slice(-200);
      }

      const startChunkTime = Date.now();
      let success = false;
      let attemptCount = 0;

      while (!success && activeCloudJob && activeCloudJob.status === "running") {
        attemptCount++;
        try {
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

          let contextBlock = "";
          if (prevContext.trim()) {
            contextBlock = `
IMMEDIATELY PRECEDING CONTEXT (For narrative continuity & pronoun resolution only; DO NOT RE-TRANSLATE THIS):
"${prevContext.trim()}"
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
7. Return ONLY the translated English text. Do NOT wrap in conversational intro/outro remarks like "Here is the translation:" or "Certainly!".`;

          const userPrompt = `${contextBlock ? contextBlock + "\n" : ""}${
            activeCloudJob.customInstructions ? `Special Instructions: ${activeCloudJob.customInstructions}\n\n` : ""
          }CHINESE SOURCE TEXT TO TRANSLATE (Chunk ${pendingChunk.index + 1} of ${activeCloudJob.chunks.length}):
"""
${pendingChunk.chineseText}
"""

Translate the above Chinese text directly into English:`;

          const { text: translatedText, modelUsed, projectUsed } = await generateWithQuotaScheduler(
            userPrompt,
            systemInstruction,
            0,
            8,
            4000,
            pendingChunk.chineseText
          );

          pendingChunk.englishText = translatedText;
          pendingChunk.status = "completed";
          pendingChunk.durationMs = Date.now() - startChunkTime;
          pendingChunk.errorMessage = undefined;
          success = true;
          workerAttemptStreak = 0;

          console.log(
            `[Cloud Worker #${workerId}] Successfully completed chunk ${pendingChunk.index + 1}/${activeCloudJob.chunks.length} ("${
              pendingChunk.chapterTitle || "Part " + (pendingChunk.index + 1)
            }") using ${projectUsed} (${modelUsed}) in ${pendingChunk.durationMs}ms`
          );
        } catch (chunkErr: any) {
          const cleanErr = formatCleanErrorMessage(chunkErr);
          console.error(
            `[Cloud Worker #${workerId}] Notice on chunk ${pendingChunk.index + 1} (Attempt #${attemptCount}):`,
            cleanErr
          );
          pendingChunk.status = "error";
          pendingChunk.errorMessage = `Attempt ${attemptCount}: ${cleanErr}. Auto-retrying...`;
          pendingChunk.durationMs = Date.now() - startChunkTime;
          activeCloudJob.lastActiveAt = Date.now();
          saveCloudJobToDisk();

          // Yield if stopped/paused
          if (!activeCloudJob || activeCloudJob.status !== "running") {
            break;
          }

          // Backoff cooldown before retrying
          const waitCooldown = Math.min(attemptCount * 2500, 12000);
          await new Promise((r) => setTimeout(r, waitCooldown));
        }
      }

      inFlightChunkIds.delete(pendingChunk.id);
      if (activeCloudJob) {
        activeCloudJob.lastActiveAt = Date.now();
        saveCloudJobToDisk();
      }

      // Small pacing interval between worker tasks to stay comfortable with RPM
      await new Promise((r) => setTimeout(r, 1200));
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
const validSessions = new Map<string, SessionTokenData>();

// Clean expired sessions periodically
setInterval(() => {
  const now = Date.now();
  for (const [token, data] of validSessions.entries()) {
    if (data.expiresAt <= now) {
      validSessions.delete(token);
    }
  }
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

// Get status & progress of cloud job
app.get("/api/cloud-job/status", (req, res) => {
  if (!activeCloudJob) {
    res.json({ hasJob: false, job: null });
    return;
  }

  const completedChunks = activeCloudJob.chunks.filter((c) => c.status === "completed").length;
  const inProgressChunks = activeCloudJob.chunks.filter((c) => c.status === "processing").length;
  const errorChunks = activeCloudJob.chunks.filter((c) => c.status === "error").length;

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
      chunks: activeCloudJob.chunks,
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
7. Return ONLY the translated English text. Do NOT wrap in conversational intro/outro remarks like "Here is the translation:" or "Certainly!".`;

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
