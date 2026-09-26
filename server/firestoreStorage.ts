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
    /RESOURCE_EXHAUSTED/i.test(errMsg) ||
    /Quota limit exceeded/i.test(errMsg)
  ) {
    const isDailyQuota = /Free daily read units|Free daily write units|quota metric/i.test(errMsg);
    if (!isFirestoreQuotaExhausted) {
      if (isDailyQuota) {
        console.warn(
          `[FirestoreStorage] Daily Free Quota Limit reached (${context}). Operating seamlessly using local disk cache and client-side IndexedDB storage.`
        );
      } else {
        console.warn(
          `[FirestoreStorage] Transient throttle (${context}): Cloud Firestore burst limit reached. Backing off for 10s.`
        );
      }
    }
    isFirestoreQuotaExhausted = true;
    // For daily quota limit, back off for 15 minutes to prevent spamming Google Cloud; for burst, 10 seconds
    quotaExhaustedUntil = Date.now() + (isDailyQuota ? 15 * 60 * 1000 : 10000);
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

export function getFirestoreQuotaStatus(): { isQuotaExhausted: boolean; isAvailable: boolean; quotaExhaustedUntil: number } {
  const isExhausted = isFirestoreQuotaExhausted && Date.now() < quotaExhaustedUntil;
  return {
    isQuotaExhausted: isExhausted,
    isAvailable: isFirestoreAvailable && !isExhausted,
    quotaExhaustedUntil,
  };
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

  // Always prefer the job with more chunks to prevent accidental truncation on container restart
  const baseJob = (fsJob.chunks?.length || 0) >= (diskJob.chunks?.length || 0) ? fsJob : diskJob;
  const otherJob = baseJob === fsJob ? diskJob : fsJob;

  const baseChunkMap = new Map((baseJob.chunks || []).map((c) => [c.index, c]));
  const otherChunkMap = new Map((otherJob.chunks || []).map((c) => [c.index, c]));

  const allIndices = Array.from(
    new Set([...baseChunkMap.keys(), ...otherChunkMap.keys()])
  ).sort((a, b) => a - b);

  const reconciledChunks: ServerTextChunk[] = allIndices.map((idx) => {
    const bChunk = baseChunkMap.get(idx);
    const oChunk = otherChunkMap.get(idx);
    const primary = bChunk || oChunk!;

    const bCompleted = bChunk?.status === "completed" && !!bChunk.englishText?.trim();
    const oCompleted = oChunk?.status === "completed" && !!oChunk.englishText?.trim();

    let finalStatus: "pending" | "processing" | "completed" | "error" = "pending";
    let finalEnglish = "";

    if (bCompleted && oCompleted) {
      finalStatus = "completed";
      finalEnglish = (bChunk!.englishText!.length >= (oChunk!.englishText?.length || 0))
        ? bChunk!.englishText!
        : oChunk!.englishText!;
    } else if (bCompleted) {
      finalStatus = "completed";
      finalEnglish = bChunk!.englishText!;
    } else if (oCompleted) {
      finalStatus = "completed";
      finalEnglish = oChunk!.englishText!;
    } else if (bChunk?.status === "processing" || oChunk?.status === "processing") {
      finalStatus = "pending";
    } else if (bChunk?.status === "error" || oChunk?.status === "error") {
      finalStatus = "error";
    } else {
      finalStatus = "pending";
    }

    return {
      ...primary,
      status: finalStatus,
      englishText: finalStatus === "completed" ? finalEnglish : "",
      chineseText: primary.chineseText || (oChunk ? oChunk.chineseText : ""),
      chapterTitle: primary.chapterTitle || (oChunk ? oChunk.chapterTitle : ""),
      charCount: primary.charCount || (oChunk ? oChunk.charCount : 0),
      attempts: Math.max(bChunk?.attempts || 0, oChunk?.attempts || 0),
      edited: finalStatus === "completed" ? !!(bChunk?.edited || oChunk?.edited) : false,
      errorMessage: finalStatus === "completed" ? undefined : (bChunk?.errorMessage || oChunk?.errorMessage),
    };
  });

  const completedCount = reconciledChunks.filter((c) => c.status === "completed" && !!c.englishText?.trim()).length;
  const totalCount = Math.max(
    (fsJob as any).totalChunks || 0,
    (diskJob as any).totalChunks || 0,
    reconciledChunks.length
  );
  const effectiveCompleted = Math.max(
    completedCount,
    (fsJob as any).completedChunks || 0,
    (diskJob as any)?.completedChunks || 0
  );
  const effectiveTotal = Math.max(
    totalCount,
    (fsJob as any).totalChunks || 0,
    (diskJob as any)?.totalChunks || 0
  );
  const isAllDone =
    (effectiveTotal > 0 && effectiveCompleted >= effectiveTotal) ||
    fsJob.status === "completed" ||
    diskJob?.status === "completed";

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
    totalChunks: effectiveTotal,
    completedChunks: isAllDone ? (effectiveTotal || effectiveCompleted) : effectiveCompleted,
    style: fsJob.style || diskJob.style || "xianxia",
    customInstructions: fsJob.customInstructions !== undefined ? fsJob.customInstructions : (diskJob.customInstructions || ""),
    glossary: (fsJob.glossary && fsJob.glossary.length > 0) ? fsJob.glossary : (diskJob.glossary || []),
    concurrency: fsJob.concurrency || diskJob.concurrency || 1,
    status: finalStatus,
    startedAt: fsJob.startedAt || diskJob.startedAt || Date.now(),
    lastActiveAt: Math.max(fsJob.lastActiveAt || 0, diskJob.lastActiveAt || 0, Date.now()),
  } as any;
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
    const totalCount = (job.chunks && job.chunks.length > 0)
      ? job.chunks.length
      : ((job as any).totalChunks || 0);
    const completedCount = (job.chunks && job.chunks.length > 0)
      ? job.chunks.filter((c) => c.status === "completed" && !!c.englishText?.trim()).length
      : ((job as any).completedChunks || (job.status === "completed" ? totalCount : 0));
    const isCompleted = (totalCount > 0 && completedCount >= totalCount) || job.status === "completed";

    const payload = {
      id: job.id,
      sessionId: job.sessionId || "legacy_default",
      fileName: job.fileName,
      fileSizeBytes: job.fileSizeBytes || 0,
      totalChineseChars: job.totalChineseChars || 0,
      totalChunks: totalCount,
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
 * Persist novel chunks in compact segment documents (50 chunks per segment) to Firestore.
 * This guarantees all chunk Chinese text, indices, and chapter titles survive container restarts
 * while using minimal Firestore document writes (e.g. 500 chunks = only 10 document writes).
 */
export async function saveJobSegmentsToFirestore(jobId: string, chunks: ServerTextChunk[]): Promise<boolean> {
  if (!isCloudStorageAvailable() || !chunks || chunks.length === 0) return false;
  const db = initFirestore();
  if (!db || !jobId) return false;

  try {
    const CHUNKS_PER_SEGMENT = 50;
    const totalSegments = Math.ceil(chunks.length / CHUNKS_PER_SEGMENT);

    for (let segIdx = 0; segIdx < totalSegments; segIdx++) {
      const slice = chunks.slice(segIdx * CHUNKS_PER_SEGMENT, (segIdx + 1) * CHUNKS_PER_SEGMENT);
      const segRef = doc(db, "translation_jobs", jobId, "segments", `seg_${segIdx}`);
      const segData = {
        segmentIndex: segIdx,
        startChunk: segIdx * CHUNKS_PER_SEGMENT,
        endChunk: segIdx * CHUNKS_PER_SEGMENT + slice.length - 1,
        totalChunksInJob: chunks.length,
        updatedAt: Date.now(),
        chunks: slice.map((c) => ({
          id: c.id,
          index: c.index,
          chapterTitle: c.chapterTitle || "",
          chineseText: c.chineseText || "",
          englishText: c.englishText || "",
          charCount: c.charCount || 0,
          status: c.status,
          attempts: c.attempts || 0,
          edited: !!c.edited,
        })),
      };
      await setDoc(segRef, segData, { merge: true });
    }
    return true;
  } catch (err: any) {
    handleFirestoreError(`saveJobSegmentsToFirestore(${jobId})`, err);
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

// Local disk cache path for deleted novel tombstones
const TOMBSTONES_FILE = path.join(process.cwd(), ".data", "jobs", "deleted_tombstones.json");

function getLocalDiskTombstones(): { ids: Set<string>; fileNames: Set<string> } {
  const ids = new Set<string>();
  const fileNames = new Set<string>();
  try {
    if (fs.existsSync(TOMBSTONES_FILE)) {
      const data = JSON.parse(fs.readFileSync(TOMBSTONES_FILE, "utf-8"));
      if (Array.isArray(data.ids)) {
        for (const id of data.ids) if (id) ids.add(String(id).trim());
      }
      if (Array.isArray(data.fileNames)) {
        for (const fn of data.fileNames) if (fn) fileNames.add(String(fn).trim().toLowerCase());
      }
    }
  } catch {}
  return { ids, fileNames };
}

function saveLocalDiskTombstones(ids: Set<string>, fileNames: Set<string>): void {
  try {
    const dir = path.dirname(TOMBSTONES_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(
      TOMBSTONES_FILE,
      JSON.stringify({
        ids: Array.from(ids),
        fileNames: Array.from(fileNames),
        updatedAt: Date.now(),
      }, null, 2),
      "utf-8"
    );
  } catch {}
}

/**
 * Load authoritative job and all chunks from Firestore
 */
export async function loadJobFromFirestore(jobId: string): Promise<CloudJob | null> {
  if (!isCloudStorageAvailable()) return null;
  const db = initFirestore();
  if (!db || !jobId) return null;

  try {
    // Check tombstones first
    const tombstones = await getDeletedJobTombstonesFromFirestore();
    if (tombstones.ids.has(jobId.trim())) {
      console.log(`[FirestoreStorage] Skipping load for tombstoned job ID: ${jobId}`);
      return null;
    }

    const jobRef = doc(db, "translation_jobs", jobId);
    const jobSnap = await getDoc(jobRef);
    if (!jobSnap.exists()) return null;

    const data = jobSnap.data();
    const docFileName = (data.fileName || "").trim().toLowerCase();
    if (
      tombstones.fileNames.has(docFileName) ||
      Array.from(tombstones.fileNames).some((t) => isSameNovel(t, docFileName))
    ) {
      console.log(`[FirestoreStorage] Skipping load for tombstoned novel filename: ${docFileName}`);
      return null;
    }

    // 1. Try loading full chunk structures from compact segments first (only 1 read per 50 chunks!)
    const segmentsRef = collection(db, "translation_jobs", jobId, "segments");
    const segmentsSnap = await getDocs(segmentsRef);

    let chunks: ServerTextChunk[] = [];
    if (!segmentsSnap.empty) {
      const segmentDocs: any[] = [];
      segmentsSnap.forEach((d) => segmentDocs.push(d.data()));
      segmentDocs.sort((a, b) => (a.segmentIndex || 0) - (b.segmentIndex || 0));

      for (const seg of segmentDocs) {
        if (Array.isArray(seg.chunks)) {
          for (const c of seg.chunks) {
            const hasEnglish = typeof c.englishText === "string" && c.englishText.trim().length > 0;
            chunks.push({
              id: c.id || `chunk_${c.index}`,
              index: typeof c.index === "number" ? c.index : 0,
              chapterTitle: c.chapterTitle || "",
              chineseText: c.chineseText || "",
              englishText: c.englishText || "",
              charCount: typeof c.charCount === "number" ? c.charCount : 0,
              status: hasEnglish ? "completed" : (c.status === "completed" ? "completed" : (c.status || "pending")),
              attempts: typeof c.attempts === "number" ? c.attempts : 0,
              edited: !!c.edited,
            });
          }
        }
      }
    }

    // 2. Query the unbundled 'chunks' subcollection if segments were missing (legacy fallback)
    if (chunks.length === 0) {
      const chunksRef = collection(db, "translation_jobs", jobId, "chunks");
      const chunksSnap = await getDocs(chunksRef);

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
    }

    chunks.sort((a, b) => a.index - b.index);

    const completedCount = chunks.filter((c) => c.status === "completed" && !!c.englishText?.trim()).length;
    const totalCount = data.totalChunks || chunks.length;
    const isCompleted = totalCount > 0 && chunks.length >= totalCount && completedCount === totalCount;

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
      status: isCompleted ? "completed" : (data.status === "completed" && !isCompleted ? "paused" : (data.status || "idle")),
      startedAt: data.startedAt || Date.now(),
      lastActiveAt: data.lastActiveAt || Date.now(),
    };
  } catch (err: any) {
    handleFirestoreError(`loadJobFromFirestore(${jobId})`, err);
    return null;
  }
}

/**
 * On-demand full chunk loader for a job shell
 */
export async function loadFullChunksForJob(job: CloudJob): Promise<CloudJob> {
  if (!job) return job;
  const expectedTotal = (job as any).totalChunks || job.chunks?.length || 0;
  const hasIncompleteText = (job.chunks || []).some(
    (c) => c.status === "completed" && (!c.englishText || !c.englishText.trim())
  );
  if (
    job.chunks &&
    job.chunks.length > 0 &&
    (expectedTotal === 0 || job.chunks.length >= expectedTotal) &&
    !hasIncompleteText
  ) {
    return job;
  }

  // Load authoritative chunks from Firestore
  if (job.id && isCloudStorageAvailable()) {
    const fullFromFs = await loadJobFromFirestore(job.id);
    if (fullFromFs && fullFromFs.chunks && fullFromFs.chunks.length > 0) {
      return {
        ...job,
        chunks: fullFromFs.chunks,
        totalChunks: fullFromFs.chunks.length,
        completedChunks: fullFromFs.chunks.filter((c) => c.status === "completed" && !!c.englishText?.trim()).length,
        status: fullFromFs.status === "completed" ? "completed" : job.status,
        lastActiveAt: Math.max(job.lastActiveAt || 0, fullFromFs.lastActiveAt || 0),
      } as any;
    }
  }

  return job;
}

/**
 * Load authoritative jobs from Firestore.
 * Automatically excludes all tombstones from deleted novels and cleans up orphaned docs.
 */
export async function loadAllJobsFromFirestore(loadFullChunks: boolean = false): Promise<Map<string, CloudJob>> {
  const result = new Map<string, CloudJob>();
  if (!isCloudStorageAvailable()) return result;
  const db = initFirestore();
  if (!db) {
    return result;
  }

  try {
    const tombstones = await getDeletedJobTombstonesFromFirestore();
    const jobsRef = collection(db, "translation_jobs");
    const snapshot = await getDocs(jobsRef);

    for (const docSnap of snapshot.docs) {
      const jId = docSnap.id;
      if (jId.startsWith("_") || jId.startsWith("synthetic_") || jId.startsWith("test_")) continue; // Skip internal health/test docs

      try {
        const data = docSnap.data();
        const docFileName = (data.fileName || "").trim().toLowerCase();

        // 1. Check if this job or novel is tombstoned (deleted by user)
        const isTombstonedId = tombstones.ids.has(jId);
        const isTombstonedFile =
          tombstones.fileNames.has(docFileName) ||
          Array.from(tombstones.fileNames).some((t) => isSameNovel(t, docFileName));

        if (isTombstonedId || isTombstonedFile) {
          console.log(`[FirestoreStorage] Skipping deleted novel "${data.fileName}" (${jId}) found in Firestore.`);
          // Asynchronously purge orphaned tombstoned doc from Firestore
          deleteDoc(docSnap.ref).catch(() => {});
          continue;
        }

        const sKey = data.sessionId || "legacy_default";

        if (loadFullChunks) {
          const job = await loadJobFromFirestore(jId);
          if (job) {
            result.set(sKey, job);
          }
        } else {
          // Low-read summary shell: Consumes only 1 read per novel document!
          const completedCount = typeof data.completedChunks === "number" ? data.completedChunks : 0;
          const totalCount = typeof data.totalChunks === "number" ? data.totalChunks : 0;
          const isCompleted = totalCount > 0 && completedCount >= totalCount;

          result.set(sKey, {
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
            status: isCompleted ? "completed" : (data.status === "completed" ? "completed" : (data.status || "idle")),
            startedAt: data.startedAt || Date.now(),
            lastActiveAt: data.lastActiveAt || Date.now(),
            totalChunks: totalCount,
            completedChunks: completedCount,
          } as any);
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
 * Record a tombstone entry in Firestore AND local disk cache for a deleted job ID or fileName so it is NEVER re-imported
 */
export async function recordDeletedJobInFirestore(jobId?: string, fileName?: string): Promise<boolean> {
  const cleanId = (jobId || "").trim();
  const cleanFileName = (fileName || "").trim().toLowerCase();
  if (!cleanId && !cleanFileName) return false;

  // Always update local disk tombstones first
  const local = getLocalDiskTombstones();
  if (cleanId) local.ids.add(cleanId);
  if (cleanFileName) {
    local.fileNames.add(cleanFileName);
    local.fileNames.add(cleanFileName.replace(/\.(txt|epub|pdf|json)$/i, "").trim().toLowerCase());
  }
  saveLocalDiskTombstones(local.ids, local.fileNames);

  if (!isCloudStorageAvailable()) return true;
  const db = initFirestore();
  if (!db) return true;

  try {
    const docKey = cleanId ? `tombstone_${cleanId}` : `tombstone_file_${cleanFileName.replace(/[^a-z0-9_]/gi, "_")}`;
    const tombstoneRef = doc(db, "deleted_jobs", docKey);
    await setDoc(
      tombstoneRef,
      {
        id: cleanId,
        fileName: cleanFileName,
        deletedAt: Date.now(),
      },
      { merge: true }
    );
    return true;
  } catch (err: any) {
    handleFirestoreError("recordDeletedJobInFirestore", err);
    return false;
  }
}

/**
 * Get all tombstone entries for deleted jobs from local disk cache and Firestore
 */
export async function getDeletedJobTombstonesFromFirestore(): Promise<{ ids: Set<string>; fileNames: Set<string> }> {
  // 1. Read from local disk cache
  const { ids, fileNames } = getLocalDiskTombstones();

  if (!isCloudStorageAvailable()) return { ids, fileNames };
  const db = initFirestore();
  if (!db) return { ids, fileNames };

  try {
    const tombstonesRef = collection(db, "deleted_jobs");
    const snapshot = await getDocs(tombstonesRef);
    for (const docSnap of snapshot.docs) {
      const data = docSnap.data();
      if (data.id) ids.add(String(data.id).trim());
      if (data.fileName) {
        const fn = String(data.fileName).trim().toLowerCase();
        fileNames.add(fn);
        fileNames.add(fn.replace(/\.(txt|epub|pdf|json)$/i, "").trim().toLowerCase());
      }
    }
    // Update local disk cache with any cloud tombstones
    saveLocalDiskTombstones(ids, fileNames);
  } catch (err: any) {
    handleFirestoreError("getDeletedJobTombstonesFromFirestore", err);
  }

  return { ids, fileNames };
}

/**
 * Permanently delete a job and all its chunks from Firestore
 */
export async function deleteJobFromFirestore(jobId: string): Promise<boolean> {
  // Record tombstone first
  await recordDeletedJobInFirestore(jobId);

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

    const segsRef = collection(db, "translation_jobs", jobId, "segments");
    const segsSnap = await getDocs(segsRef);
    if (!segsSnap.empty) {
      const batch = writeBatch(db);
      for (const d of segsSnap.docs) {
        batch.delete(d.ref);
      }
      await batch.commit();
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
  return n1 === n2 || n1.includes(n2) || n2.includes(n1);
}

/**
 * Permanently delete all jobs and their chunks matching a novel filename from Firestore
 */
export async function deleteJobByFileNameFromFirestore(fileName: string): Promise<number> {
  await recordDeletedJobInFirestore(undefined, fileName);

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
      if (docFileName === targetName || isSameNovel(docFileName, targetName)) {
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

