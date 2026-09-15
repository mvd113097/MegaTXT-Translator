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

export function initFirestore(): Firestore | null {
  if (dbInstance) return dbInstance;

  try {
    const configPath = path.join(process.cwd(), "firebase-applet-config.json");
    if (!fs.existsSync(configPath)) {
      console.log("[FirestoreStorage] No firebase-applet-config.json found, skipping cloud DB init.");
      return null;
    }

    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const app = getApps().length === 0 ? initializeApp(config) : getApp();
    const db = config.firestoreDatabaseId ? getFirestore(app, config.firestoreDatabaseId) : getFirestore(app);

    dbInstance = db;
    isFirestoreAvailable = true;
    console.log(`[FirestoreStorage] Initialized Firestore client for project ${config.projectId}`);
    return db;
  } catch (err: any) {
    console.warn("[FirestoreStorage] Failed to initialize Firestore client:", err.message);
    isFirestoreAvailable = false;
    return null;
  }
}

export function isCloudStorageConnected(): boolean {
  return isFirestoreAvailable && !!dbInstance;
}

/**
 * Strict monotonic merger:
 * Ensures completed chapters and translated content are never downgraded or lost.
 */
export function mergeMonotonicJob(authoritative: CloudJob, candidate: CloudJob): CloudJob {
  if (!authoritative) return candidate;
  if (!candidate) return authoritative;

  const totalChunks = Math.max(authoritative.chunks.length, candidate.chunks.length);
  const mergedChunks: ServerTextChunk[] = [];

  for (let i = 0; i < totalChunks; i++) {
    const authChunk = authoritative.chunks[i];
    const candChunk = candidate.chunks[i];

    if (!authChunk && candChunk) {
      mergedChunks.push({ ...candChunk });
      continue;
    }
    if (authChunk && !candChunk) {
      mergedChunks.push({ ...authChunk });
      continue;
    }

    // Both exist: check status monotonicity
    const isAuthCompleted = authChunk.status === "completed" && !!authChunk.englishText?.trim();
    const isCandCompleted = candChunk.status === "completed" && !!candChunk.englishText?.trim();

    if (isAuthCompleted && !isCandCompleted) {
      // Retain completed state from authoritative
      mergedChunks.push({ ...authChunk });
    } else if (isCandCompleted && !isAuthCompleted) {
      // Promote to candidate's newly completed state
      mergedChunks.push({ ...candChunk });
    } else if (isAuthCompleted && isCandCompleted) {
      // Pick the longer or edited one if available
      const authLen = (authChunk.englishText || "").length;
      const candLen = (candChunk.englishText || "").length;
      if (candChunk.edited && !authChunk.edited) {
        mergedChunks.push({ ...candChunk });
      } else if (candLen >= authLen) {
        mergedChunks.push({ ...candChunk });
      } else {
        mergedChunks.push({ ...authChunk });
      }
    } else {
      // Neither is completed: keep the one with fewer errors / higher progress or default to candidate
      mergedChunks.push({
        ...candChunk,
        chineseText: candChunk.chineseText || authChunk.chineseText,
        chapterTitle: candChunk.chapterTitle || authChunk.chapterTitle,
        charCount: candChunk.charCount || authChunk.charCount,
      });
    }
  }

  const completedCount = mergedChunks.filter((c) => c.status === "completed" && !!c.englishText?.trim()).length;
  const isFullyDone = completedCount === totalChunks && totalChunks > 0;

  // Monotonic status rules:
  // If either was completed or all chunks are completed, status is permanently "completed"
  let finalStatus: CloudJob["status"] = candidate.status;
  if (isFullyDone || authoritative.status === "completed") {
    finalStatus = "completed";
  } else if (candidate.status === "running" || authoritative.status === "running") {
    finalStatus = "running";
  } else if (candidate.status === "paused" || authoritative.status === "paused") {
    finalStatus = "paused";
  }

  return {
    ...candidate,
    id: authoritative.id || candidate.id,
    sessionId: candidate.sessionId || authoritative.sessionId,
    fileName: candidate.fileName || authoritative.fileName,
    chunks: mergedChunks,
    status: finalStatus,
    startedAt: Math.min(authoritative.startedAt || Date.now(), candidate.startedAt || Date.now()),
    lastActiveAt: Math.max(authoritative.lastActiveAt || 0, candidate.lastActiveAt || 0, Date.now()),
  };
}

/**
 * Persist job metadata to Firestore
 */
export async function saveJobToFirestore(job: CloudJob): Promise<void> {
  const db = initFirestore();
  if (!db || !job.id) return;

  try {
    const jobRef = doc(db, "translation_jobs", job.id);
    const completedCount = job.chunks.filter((c) => c.status === "completed" && !!c.englishText?.trim()).length;
    const isCompleted = completedCount === job.chunks.length && job.chunks.length > 0;

    const payload = {
      id: job.id,
      sessionId: job.sessionId || "legacy_default",
      fileName: job.fileName,
      fileSizeBytes: job.fileSizeBytes || 0,
      totalChineseChars: job.totalChineseChars || 0,
      totalChunks: job.chunks.length,
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
  } catch (err: any) {
    console.warn(`[FirestoreStorage] Failed to save job ${job.id} metadata:`, err.message);
  }
}

/**
 * Persist translated chunk to Firestore
 */
export async function saveChunkToFirestore(jobId: string, chunk: ServerTextChunk): Promise<void> {
  const db = initFirestore();
  if (!db || !jobId) return;

  try {
    const chunkRef = doc(db, "translation_jobs", jobId, "chunks", `chunk_${chunk.index}`);
    await setDoc(
      chunkRef,
      {
        id: chunk.id,
        index: chunk.index,
        chapterTitle: chunk.chapterTitle || "",
        chineseText: chunk.chineseText || "",
        englishText: chunk.englishText || "",
        charCount: chunk.charCount || 0,
        status: chunk.status,
        attempts: chunk.attempts || 0,
        edited: !!chunk.edited,
        updatedAt: Date.now(),
      },
      { merge: true }
    );
  } catch (err: any) {
    console.warn(`[FirestoreStorage] Failed to save chunk ${chunk.index} of job ${jobId}:`, err.message);
  }
}

/**
 * Batch save chunks to Firestore
 */
export async function saveChunksBatchToFirestore(jobId: string, chunks: ServerTextChunk[]): Promise<void> {
  const db = initFirestore();
  if (!db || !jobId || chunks.length === 0) return;

  try {
    // Firestore batch limit is 500 operations
    const BATCH_SIZE = 100;
    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const slice = chunks.slice(i, i + BATCH_SIZE);
      const batch = writeBatch(db);
      for (const chunk of slice) {
        const chunkRef = doc(db, "translation_jobs", jobId, "chunks", `chunk_${chunk.index}`);
        batch.set(
          chunkRef,
          {
            id: chunk.id,
            index: chunk.index,
            chapterTitle: chunk.chapterTitle || "",
            chineseText: chunk.chineseText || "",
            englishText: chunk.englishText || "",
            charCount: chunk.charCount || 0,
            status: chunk.status,
            attempts: chunk.attempts || 0,
            edited: !!chunk.edited,
            updatedAt: Date.now(),
          },
          { merge: true }
        );
      }
      await batch.commit();
    }
  } catch (err: any) {
    console.warn(`[FirestoreStorage] Failed to batch save chunks for job ${jobId}:`, err.message);
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
      const c = docSnap.data() as ServerTextChunk;
      chunks.push({
        id: c.id,
        index: c.index,
        chapterTitle: c.chapterTitle,
        chineseText: c.chineseText,
        englishText: c.englishText || "",
        charCount: c.charCount || 0,
        status: c.status,
        attempts: c.attempts || 0,
        edited: c.edited,
      });
    });

    chunks.sort((a, b) => a.index - b.index);

    const completedCount = chunks.filter((c) => c.status === "completed" && !!c.englishText?.trim()).length;
    const isCompleted = completedCount === (data.totalChunks || chunks.length) && chunks.length > 0;

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
      status: isCompleted ? "completed" : data.status || "idle",
      startedAt: data.startedAt || Date.now(),
      lastActiveAt: data.lastActiveAt || Date.now(),
    };
  } catch (err: any) {
    console.warn(`[FirestoreStorage] Failed to load job ${jobId} from Firestore:`, err.message);
    return null;
  }
}

/**
 * Load all authoritative jobs from Firestore
 */
export async function loadAllJobsFromFirestore(): Promise<Map<string, CloudJob>> {
  const result = new Map<string, CloudJob>();
  const db = initFirestore();
  if (!db) return result;

  try {
    const jobsRef = collection(db, "translation_jobs");
    const snapshot = await getDocs(jobsRef);

    for (const docSnap of snapshot.docs) {
      const jId = docSnap.id;
      const job = await loadJobFromFirestore(jId);
      if (job) {
        const sKey = job.sessionId || "legacy_default";
        result.set(sKey, job);
      }
    }
    console.log(`[FirestoreStorage] Loaded ${result.size} authoritative jobs from Firestore.`);
  } catch (err: any) {
    console.warn("[FirestoreStorage] Failed to load jobs collection from Firestore:", err.message);
  }

  return result;
}
