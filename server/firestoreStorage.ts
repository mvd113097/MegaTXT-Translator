import { initializeApp, getApps, getApp } from "firebase/app";
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  collection,
  getDocs,
  writeBatch,
  Firestore,
} from "firebase/firestore";
import fs from "fs";
import path from "path";

export interface ServerTextChunk {
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

export interface CloudJob {
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

let dbInstance: Firestore | null = null;
let isFirestoreAvailable = false;
let lastFirestoreCheckTime = 0;

export function initFirestore(): Firestore | null {
  if (dbInstance) return dbInstance;

  try {
    const configPath = path.join(process.cwd(), "firebase-applet-config.json");
    if (!fs.existsSync(configPath)) {
      console.warn("[FirestoreStorage] No firebase-applet-config.json found, skipping cloud DB init.");
      return null;
    }

    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const app = getApps().length === 0 ? initializeApp(config) : getApp();
    const db = config.firestoreDatabaseId ? getFirestore(app, config.firestoreDatabaseId) : getFirestore(app);

    dbInstance = db;
    isFirestoreAvailable = true;
    console.log(`[FirestoreStorage] Initialized Firestore client for project ${config.projectId} (${config.firestoreDatabaseId})`);
    return db;
  } catch (err: any) {
    console.error("[FirestoreStorage] Failed to initialize Firestore client:", err.message);
    isFirestoreAvailable = false;
    return null;
  }
}

export function isCloudStorageConnected(): boolean {
  return isFirestoreAvailable && !!dbInstance;
}

export async function testFirestoreHealth(): Promise<boolean> {
  const db = initFirestore();
  if (!db) return false;
  try {
    const testDoc = doc(db, "_health", "ping");
    await setDoc(testDoc, { ping: Date.now() }, { merge: true });
    isFirestoreAvailable = true;
    return true;
  } catch (err: any) {
    console.error("[FirestoreStorage] Health check failed:", err.message);
    isFirestoreAvailable = false;
    return false;
  }
}

/**
 * Authoritative Firestore Reconciliation:
 * Firestore is the sole authoritative source of truth for job progress and completed translations.
 * Local disk (/data/jobs) is treated strictly as an unauthoritative read/cache layer.
 * 
 * Rules:
 * 1. For an existing job in Firestore, Firestore state is 100% authoritative.
 * 2. Local disk CANNOT promote any chunk or progress above what Firestore has durably recorded.
 * 3. If Firestore = 165/283 and Local disk = 283/283, the recovered job MUST be exactly 165/283.
 * 4. If Firestore = 165/283 and Local disk = 150/283, the recovered job MUST be exactly 165/283.
 * 5. For completed chunks, the actual English text MUST come directly from Firestore.
 * 6. Local disk only supplies non-contradictory auxiliary info (like source chineseText if missing in Firestore).
 */
export function reconcileAuthoritativeJob(fsJob: CloudJob, diskJob?: CloudJob | null): CloudJob {
  if (!diskJob) return fsJob;
  if (!fsJob) return diskJob;

  const fsChunks = fsJob.chunks || [];
  const diskChunks = diskJob.chunks || [];
  const diskChunkMap = new Map(diskChunks.map((c) => [c.index, c]));

  const reconciledChunks: ServerTextChunk[] = fsChunks.map((fsChunk) => {
    const dChunk = diskChunkMap.get(fsChunk.index);
    const isFsCompleted = fsChunk.status === "completed" && !!fsChunk.englishText?.trim();

    return {
      ...fsChunk,
      // Status & English text are STRICTLY authoritative from Firestore
      status: isFsCompleted ? "completed" : (fsChunk.status === "processing" ? "pending" : (fsChunk.status || "pending")),
      englishText: isFsCompleted ? fsChunk.englishText : "",
      // Non-contradictory auxiliary fields fallback to disk cache only if missing in Firestore
      chineseText: fsChunk.chineseText || (dChunk ? dChunk.chineseText : ""),
      chapterTitle: fsChunk.chapterTitle || (dChunk ? dChunk.chapterTitle : ""),
      charCount: fsChunk.charCount || (dChunk ? dChunk.charCount : 0),
      attempts: fsChunk.attempts || (dChunk ? dChunk.attempts : 0),
      edited: isFsCompleted ? !!fsChunk.edited : false,
      errorMessage: isFsCompleted ? undefined : fsChunk.errorMessage,
    };
  });

  const completedCount = reconciledChunks.filter((c) => c.status === "completed" && !!c.englishText?.trim()).length;
  const totalCount = reconciledChunks.length;
  const isAllDone = completedCount === totalCount && totalCount > 0;

  let finalStatus: CloudJob["status"] = fsJob.status;
  if (isAllDone || fsJob.status === "completed") {
    finalStatus = "completed";
  } else if (fsJob.status === "running") {
    finalStatus = "running";
  } else {
    finalStatus = "paused";
  }

  return {
    ...fsJob,
    sessionId: fsJob.sessionId || diskJob.sessionId || "legacy_default",
    fileName: fsJob.fileName || diskJob.fileName,
    fileSizeBytes: fsJob.fileSizeBytes || diskJob.fileSizeBytes || 0,
    totalChineseChars: fsJob.totalChineseChars || diskJob.totalChineseChars || 0,
    chunks: reconciledChunks,
    style: fsJob.style || diskJob.style || "xianxia",
    customInstructions: fsJob.customInstructions !== undefined ? fsJob.customInstructions : (diskJob.customInstructions || ""),
    glossary: (fsJob.glossary && fsJob.glossary.length > 0) ? fsJob.glossary : (diskJob.glossary || []),
    concurrency: fsJob.concurrency || diskJob.concurrency || 1,
    status: finalStatus,
    startedAt: fsJob.startedAt || diskJob.startedAt || Date.now(),
    lastActiveAt: Math.max(fsJob.lastActiveAt || 0, diskJob.lastActiveAt || 0, Date.now()),
  };
}

export function mergeMonotonicJob(authoritative: CloudJob, candidate: CloudJob): CloudJob {
  return reconcileAuthoritativeJob(authoritative, candidate);
}

/**
 * Persist job metadata to Firestore
 */
export async function saveJobToFirestore(job: CloudJob): Promise<boolean> {
  const db = initFirestore();
  if (!db || !job.id) {
    console.warn(`[FirestoreStorage] Cannot save job: DB not initialized or missing ID (job: ${job?.id})`);
    return false;
  }

  try {
    const jobRef = doc(db, "translation_jobs", job.id);
    const completedCount = (job.chunks || []).filter((c) => c.status === "completed" && !!c.englishText?.trim()).length;
    const isCompleted = completedCount === (job.chunks?.length || 0) && (job.chunks?.length || 0) > 0;

    const payload = {
      id: job.id,
      sessionId: job.sessionId || "legacy_default",
      fileName: job.fileName,
      fileSizeBytes: job.fileSizeBytes || 0,
      totalChineseChars: job.totalChineseChars || 0,
      totalChunks: job.chunks ? job.chunks.length : 0,
      completedChunks: completedCount,
      style: job.style || "xianxia",
      customInstructions: job.customInstructions || "",
      concurrency: job.concurrency || 1,
      status: isCompleted ? "completed" : job.status,
      startedAt: job.startedAt || Date.now(),
      lastActiveAt: Date.now(),
      glossary: (job.glossary || []).slice(0, 100),
    };

    await setDoc(jobRef, payload, { merge: true });
    return true;
  } catch (err: any) {
    console.error(`[FirestoreStorage] CRITICAL: Failed to save job ${job.id} metadata to Firestore:`, err.message);
    return false;
  }
}

/**
 * Persist translated chunk to Firestore
 * MUST be called and succeed before chunk is marked permanently completed.
 */
export async function saveChunkToFirestore(jobId: string, chunk: ServerTextChunk): Promise<boolean> {
  const db = initFirestore();
  if (!db || !jobId) {
    console.error(`[FirestoreStorage] Cannot save chunk: DB not initialized or missing jobId (jobId: ${jobId})`);
    return false;
  }

  try {
    const chunkRef = doc(db, "translation_jobs", jobId, "chunks", `chunk_${chunk.index}`);
    const chunkPayload: any = {
      id: chunk.id || `chunk_${chunk.index}`,
      jobId: jobId,
      index: chunk.index,
      chapterTitle: chunk.chapterTitle || "",
      chineseText: chunk.chineseText || "",
      englishText: chunk.englishText || "",
      charCount: chunk.charCount || 0,
      status: chunk.status,
      attempts: chunk.attempts || 0,
      edited: !!chunk.edited,
      durationMs: chunk.durationMs || 0,
      updatedAt: Date.now(),
    };

    if (chunk.errorMessage) {
      chunkPayload.errorMessage = chunk.errorMessage;
    }

    await setDoc(chunkRef, chunkPayload, { merge: true });
    return true;
  } catch (err: any) {
    console.error(`[FirestoreStorage] CRITICAL: Failed to save chunk ${chunk.index} for job ${jobId} to Firestore:`, err.message);
    return false;
  }
}

/**
 * Batch save chunks to Firestore
 */
export async function saveChunksBatchToFirestore(jobId: string, chunks: ServerTextChunk[]): Promise<boolean> {
  const db = initFirestore();
  if (!db || !jobId || chunks.length === 0) return false;

  try {
    const BATCH_SIZE = 100;
    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const slice = chunks.slice(i, i + BATCH_SIZE);
      const batch = writeBatch(db);
      for (const chunk of slice) {
        const chunkRef = doc(db, "translation_jobs", jobId, "chunks", `chunk_${chunk.index}`);
        batch.set(
          chunkRef,
          {
            id: chunk.id || `chunk_${chunk.index}`,
            jobId: jobId,
            index: chunk.index,
            chapterTitle: chunk.chapterTitle || "",
            chineseText: chunk.chineseText || "",
            englishText: chunk.englishText || "",
            charCount: chunk.charCount || 0,
            status: chunk.status,
            attempts: chunk.attempts || 0,
            edited: !!chunk.edited,
            durationMs: chunk.durationMs || 0,
            updatedAt: Date.now(),
          },
          { merge: true }
        );
      }
      await batch.commit();
    }
    return true;
  } catch (err: any) {
    console.error(`[FirestoreStorage] Failed to batch save chunks for job ${jobId}:`, err.message);
    return false;
  }
}

/**
 * Load authoritative job and all chunks from Firestore
 */
export async function loadJobFromFirestore(jobId: string): Promise<CloudJob | null> {
  const db = initFirestore();
  if (!db || !jobId) return null;

  try {
    const jobRef = doc(db, "translation_jobs", jobId);
    const jobSnap = await getDoc(jobRef);
    if (!jobSnap.exists()) return null;

    const data = jobSnap.data();
    const chunksRef = collection(db, "translation_jobs", jobId, "chunks");
    const chunksSnap = await getDocs(chunksRef);

    const chunks: ServerTextChunk[] = [];
    chunksSnap.forEach((docSnap) => {
      const c = docSnap.data();
      const hasEnglish = typeof c.englishText === "string" && c.englishText.trim().length > 0;
      const isCompleted = c.status === "completed" && hasEnglish;

      chunks.push({
        id: c.id || docSnap.id,
        index: typeof c.index === "number" ? c.index : 0,
        chapterTitle: c.chapterTitle || "",
        chineseText: c.chineseText || "",
        englishText: c.englishText || "",
        charCount: typeof c.charCount === "number" ? c.charCount : 0,
        status: isCompleted ? "completed" : (c.status === "processing" ? "pending" : (c.status || "pending")),
        attempts: typeof c.attempts === "number" ? c.attempts : 0,
        edited: !!c.edited,
        durationMs: typeof c.durationMs === "number" ? c.durationMs : 0,
        errorMessage: isCompleted ? undefined : c.errorMessage,
      });
    });

    chunks.sort((a, b) => a.index - b.index);

    const completedCount = chunks.filter((c) => c.status === "completed" && !!c.englishText?.trim()).length;
    const totalCount = data.totalChunks || chunks.length;
    const isCompleted = completedCount === totalCount && totalCount > 0;

    return {
      id: data.id || jobId,
      sessionId: data.sessionId || "legacy_default",
      fileName: data.fileName || "novel.txt",
      fileSizeBytes: data.fileSizeBytes || 0,
      totalChineseChars: data.totalChineseChars || 0,
      chunks,
      style: data.style || "xianxia",
      customInstructions: data.customInstructions || "",
      glossary: data.glossary || [],
      concurrency: data.concurrency || 1,
      status: isCompleted ? "completed" : (data.status || "idle"),
      startedAt: data.startedAt || Date.now(),
      lastActiveAt: data.lastActiveAt || Date.now(),
    };
  } catch (err: any) {
    console.error(`[FirestoreStorage] Failed to load job ${jobId} from Firestore:`, err.message);
    throw err;
  }
}

/**
 * Load all authoritative jobs from Firestore
 */
export async function loadAllJobsFromFirestore(): Promise<Map<string, CloudJob>> {
  const result = new Map<string, CloudJob>();
  const db = initFirestore();
  if (!db) {
    throw new Error("Firestore client not initialized.");
  }

  const jobsRef = collection(db, "translation_jobs");
  const snapshot = await getDocs(jobsRef);

  for (const docSnap of snapshot.docs) {
    const jId = docSnap.id;
    if (jId.startsWith("_")) continue; // Skip internal health docs
    try {
      const job = await loadJobFromFirestore(jId);
      if (job) {
        const sKey = job.sessionId || "legacy_default";
        result.set(sKey, job);
      }
    } catch (jobErr: any) {
      console.error(`[FirestoreStorage] Failed to load job details for ${jId}:`, jobErr.message);
    }
  }

  console.log(`[FirestoreStorage] Authoritative load complete: ${result.size} job(s) from Firestore.`);
  return result;
}
