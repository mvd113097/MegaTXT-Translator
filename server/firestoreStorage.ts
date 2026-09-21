import { initializeApp, getApps, getApp } from "firebase/app";
import {
  initializeFirestore,
  getFirestore,
  setLogLevel,
  doc,
  setDoc,
  getDoc,
  deleteDoc,
  collection,
  getDocs,
  writeBatch,
  Firestore,
} from "firebase/firestore";
import fs from "fs";
import path from "path";

// Silence internal Firestore SDK debug/idle stream logs to prevent benign gRPC stream recycling warnings
try {
  setLogLevel("silent");
} catch {
  // ignore if not supported
}

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
let isFirestoreQuotaExhausted = false;
let quotaExhaustedUntil = 0;

function handleFirestoreError(context: string, err: any): void {
  const errMsg = err?.message || String(err);
  const errCode = err?.code;
  if (
    errCode === "resource-exhausted" ||
    errCode === 8 ||
    /RESOURCE_EXHAUSTED/i.test(errMsg)
  ) {
    if (!isFirestoreQuotaExhausted) {
      console.warn(
        `[FirestoreStorage] Transient throttle (${context}): Cloud Firestore burst limit reached. Backing off for 5s.`
      );
    }
    isFirestoreQuotaExhausted = true;
    quotaExhaustedUntil = Date.now() + 5000; // 5 seconds transient backoff, NEVER 1 hour
  } else {
    console.warn(`[FirestoreStorage] Notice (${context}):`, errMsg);
  }
}

export function isCloudStorageAvailable(): boolean {
  if (isFirestoreQuotaExhausted) {
    if (Date.now() > quotaExhaustedUntil) {
      isFirestoreQuotaExhausted = false;
    } else {
      return false;
    }
  }
  if (!dbInstance) {
    initFirestore();
  }
  return isFirestoreAvailable && !!dbInstance;
}

export function initFirestore(): Firestore | null {
  if (isFirestoreQuotaExhausted && Date.now() < quotaExhaustedUntil) {
    return null;
  }
  if (dbInstance) return dbInstance;

  try {
    const configPath = path.join(process.cwd(), "firebase-applet-config.json");
    if (!fs.existsSync(configPath)) {
      return null;
    }

    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const app = getApps().length === 0 ? initializeApp(config) : getApp();
    let db: Firestore;
    try {
      db = initializeFirestore(
        app,
        {
          experimentalForceLongPolling: true,
          ignoreUndefinedProperties: true,
        },
        config.firestoreDatabaseId || undefined
      );
    } catch {
      db = config.firestoreDatabaseId ? getFirestore(app, config.firestoreDatabaseId) : getFirestore(app);
    }

    dbInstance = db;
    isFirestoreAvailable = true;
    console.log(`[FirestoreStorage] Initialized Firestore client for project ${config.projectId} (${config.firestoreDatabaseId})`);
    return db;
  } catch (err: any) {
    handleFirestoreError("initFirestore", err);
    return null;
  }
}

export function isCloudStorageConnected(): boolean {
  return isCloudStorageAvailable();
}

export async function testFirestoreHealth(): Promise<boolean> {
  if (!isCloudStorageAvailable()) return false;
  const db = initFirestore();
  if (!db) return false;
  try {
    const testDoc = doc(db, "_health", "ping");
    await setDoc(testDoc, { ping: Date.now() }, { merge: true });
    isFirestoreAvailable = true;
    return true;
  } catch (err: any) {
    handleFirestoreError("testFirestoreHealth", err);
    return false;
  }
}

/**
 * Monotonic Job & Chunk Reconciliation:
 * Takes the union / maximum progress across Firestore and Local Disk cache.
 * 
 * Rules:
 * 1. Progress is strictly monotonic: A chunk marked 'completed' on either Firestore or local disk MUST NEVER be demoted back to pending.
 * 2. If a chunk is completed on disk (e.g. while cloud quota was exceeded), its English text is retained and protected.
 * 3. In-flight 'processing' chunks are safely reset to 'pending' on restart so they are cleanly translated without stalling.
 */
export function reconcileAuthoritativeJob(fsJob: CloudJob, diskJob?: CloudJob | null): CloudJob {
  if (!diskJob) return fsJob;
  if (!fsJob) return diskJob;

  const baseJob = fsJob.chunks && fsJob.chunks.length > 0 ? fsJob : diskJob;
  const otherJob = baseJob === fsJob ? diskJob : fsJob;

  const otherChunkMap = new Map((otherJob.chunks || []).map((c) => [c.index, c]));

  const reconciledChunks: ServerTextChunk[] = (baseJob.chunks || []).map((bChunk) => {
    const oChunk = otherChunkMap.get(bChunk.index);
    const bCompleted = bChunk.status === "completed" && !!bChunk.englishText?.trim();
    const oCompleted = oChunk?.status === "completed" && !!oChunk?.englishText?.trim();

    let finalStatus: "pending" | "processing" | "completed" | "error" = "pending";
    let finalEnglish = "";

    if (bCompleted && oCompleted) {
      finalStatus = "completed";
      finalEnglish = (bChunk.englishText!.length >= (oChunk?.englishText?.length || 0))
        ? bChunk.englishText!
        : oChunk!.englishText!;
    } else if (bCompleted) {
      finalStatus = "completed";
      finalEnglish = bChunk.englishText!;
    } else if (oCompleted) {
      finalStatus = "completed";
      finalEnglish = oChunk!.englishText!;
    } else if (bChunk.status === "processing" || oChunk?.status === "processing") {
      finalStatus = "pending";
    } else if (bChunk.status === "error" || oChunk?.status === "error") {
      finalStatus = "error";
    } else {
      finalStatus = "pending";
    }

    return {
      ...bChunk,
      status: finalStatus,
      englishText: finalStatus === "completed" ? finalEnglish : "",
      chineseText: bChunk.chineseText || (oChunk ? oChunk.chineseText : ""),
      chapterTitle: bChunk.chapterTitle || (oChunk ? oChunk.chapterTitle : ""),
      charCount: bChunk.charCount || (oChunk ? oChunk.charCount : 0),
      attempts: Math.max(bChunk.attempts || 0, oChunk?.attempts || 0),
      edited: finalStatus === "completed" ? !!(bChunk.edited || oChunk?.edited) : false,
      errorMessage: finalStatus === "completed" ? undefined : (bChunk.errorMessage || oChunk?.errorMessage),
    };
  });

  const completedCount = reconciledChunks.filter((c) => c.status === "completed" && !!c.englishText?.trim()).length;
  const totalCount = reconciledChunks.length;
  const isAllDone = completedCount === totalCount && totalCount > 0;

  let finalStatus: CloudJob["status"] = "idle";
  if (isAllDone) {
    finalStatus = "completed";
  } else if (fsJob.status === "running" || diskJob?.status === "running") {
    finalStatus = "running";
  } else if (fsJob.status === "paused" || diskJob?.status === "paused") {
    finalStatus = "paused";
  } else {
    finalStatus = fsJob.status || diskJob?.status || "idle";
  }

  return {
    ...baseJob,
    sessionId: fsJob.sessionId || diskJob.sessionId || "legacy_default",
    fileName: fsJob.fileName || diskJob.fileName,
    fileSizeBytes: Math.max(fsJob.fileSizeBytes || 0, diskJob.fileSizeBytes || 0),
    totalChineseChars: Math.max(fsJob.totalChineseChars || 0, diskJob.totalChineseChars || 0),
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
  if (!isCloudStorageAvailable()) return false;
  const db = initFirestore();
  if (!db || !job.id) {
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
    handleFirestoreError(`saveJobToFirestore(${job.id})`, err);
    return false;
  }
}

/**
 * Persist translated chunk to Firestore
 */
export async function saveChunkToFirestore(jobId: string, chunk: ServerTextChunk): Promise<boolean> {
  if (!isCloudStorageAvailable()) return false;
  const db = initFirestore();
  if (!db || !jobId) {
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
    handleFirestoreError(`saveChunkToFirestore(${jobId}, chunk_${chunk.index})`, err);
    return false;
  }
}

/**
 * Batch save chunks to Firestore
 */
export async function saveChunksBatchToFirestore(jobId: string, chunks: ServerTextChunk[]): Promise<boolean> {
  if (!isCloudStorageAvailable()) return false;
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
    handleFirestoreError(`saveChunksBatchToFirestore(${jobId})`, err);
    return false;
  }
}

/**
 * Load authoritative job and all chunks from Firestore
 */
export async function loadJobFromFirestore(jobId: string): Promise<CloudJob | null> {
  if (!isCloudStorageAvailable()) return null;
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
    handleFirestoreError(`loadJobFromFirestore(${jobId})`, err);
    return null;
  }
}

/**
 * Load all authoritative jobs from Firestore
 */
export async function loadAllJobsFromFirestore(): Promise<Map<string, CloudJob>> {
  const result = new Map<string, CloudJob>();
  if (!isCloudStorageAvailable()) return result;
  const db = initFirestore();
  if (!db) {
    return result;
  }

  try {
    const jobsRef = collection(db, "translation_jobs");
    const snapshot = await getDocs(jobsRef);

    for (const docSnap of snapshot.docs) {
      const jId = docSnap.id;
      if (jId.startsWith("_") || jId.startsWith("synthetic_") || jId.startsWith("test_")) continue; // Skip internal health/test docs
      try {
        const data = docSnap.data();
        const sKey = data.sessionId || "legacy_default";

        // Only do the deep chunk query if the job is actively running
        if (data.status === "running") {
          const job = await loadJobFromFirestore(jId);
          if (job) {
            result.set(sKey, job);
          }
        } else {
          // For completed or idle jobs, load metadata directly in O(1) time without querying hundreds of chunk documents
          const lightweightJob: CloudJob = {
            id: data.id || jId,
            sessionId: sKey,
            fileName: data.fileName || "novel.txt",
            fileSizeBytes: data.fileSizeBytes || 0,
            totalChineseChars: data.totalChineseChars || 0,
            chunks: [],
            style: data.style || "xianxia",
            customInstructions: data.customInstructions || "",
            glossary: data.glossary || [],
            concurrency: data.concurrency || 1,
            status: data.status || "idle",
            startedAt: data.startedAt || Date.now(),
            lastActiveAt: data.lastActiveAt || Date.now(),
          };
          result.set(sKey, lightweightJob);
        }
      } catch (jobErr: any) {
        handleFirestoreError(`loadAllJobsFromFirestore(${jId})`, jobErr);
      }
    }
  } catch (err: any) {
    handleFirestoreError("loadAllJobsFromFirestore", err);
  }

  return result;
}

/**
 * Permanently delete a job and all its chunks from Firestore
 */
export async function deleteJobFromFirestore(jobId: string): Promise<boolean> {
  if (!isCloudStorageAvailable()) return false;
  const db = initFirestore();
  if (!db || !jobId) return false;

  try {
    const chunksRef = collection(db, "translation_jobs", jobId, "chunks");
    const chunksSnap = await getDocs(chunksRef);
    if (!chunksSnap.empty) {
      const BATCH_SIZE = 100;
      const docs = chunksSnap.docs;
      for (let i = 0; i < docs.length; i += BATCH_SIZE) {
        const slice = docs.slice(i, i + BATCH_SIZE);
        const batch = writeBatch(db);
        for (const d of slice) {
          batch.delete(d.ref);
        }
        await batch.commit();
      }
    }

    const jobRef = doc(db, "translation_jobs", jobId);
    await deleteDoc(jobRef);
    console.log(`[FirestoreStorage] Deleted job ${jobId} and its chunk subcollection from Firestore`);
    return true;
  } catch (err: any) {
    handleFirestoreError(`deleteJobFromFirestore(${jobId})`, err);
    return false;
  }
}

/**
 * Permanently delete all jobs and their chunks matching a novel filename from Firestore
 */
export async function deleteJobByFileNameFromFirestore(fileName: string): Promise<number> {
  if (!isCloudStorageAvailable()) return 0;
  const db = initFirestore();
  if (!db || !fileName) return 0;

  const targetName = fileName.trim().toLowerCase();
  let deletedCount = 0;

  try {
    const jobsRef = collection(db, "translation_jobs");
    const snapshot = await getDocs(jobsRef);
    for (const docSnap of snapshot.docs) {
      const data = docSnap.data();
      const docFileName = (data.fileName || "").trim().toLowerCase();
      if (docFileName === targetName) {
        await deleteJobFromFirestore(docSnap.id);
        deletedCount++;
      }
    }
  } catch (err: any) {
    handleFirestoreError(`deleteJobByFileNameFromFirestore(${fileName})`, err);
  }

  return deletedCount;
}

/**
 * Permanently delete ALL jobs from Firestore
 */
export async function deleteAllJobsFromFirestore(): Promise<number> {
  if (!isCloudStorageAvailable()) return 0;
  const db = initFirestore();
  if (!db) return 0;

  let deletedCount = 0;
  try {
    const jobsRef = collection(db, "translation_jobs");
    const snapshot = await getDocs(jobsRef);
    for (const docSnap of snapshot.docs) {
      if (docSnap.id.startsWith("_")) continue; // preserve health ping
      await deleteJobFromFirestore(docSnap.id);
      deletedCount++;
    }
  } catch (err: any) {
    handleFirestoreError("deleteAllJobsFromFirestore", err);
  }

  return deletedCount;
}

