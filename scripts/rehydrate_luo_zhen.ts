import { initFirestore } from "../server/firestoreStorage.js";
import { collection, getDocs, doc, getDoc } from "firebase/firestore";
import fs from "fs";
import path from "path";

async function main() {
  const db = initFirestore();
  if (!db) {
    console.log("No Firestore connection");
    return;
  }

  const jobId = "cloud_job_1791018075811";
  console.log(`Rehydrating full 241 chapters for '${jobId}' from Firestore...`);

  const jobSnap = await getDoc(doc(db, "translation_jobs", jobId));
  const jobData = jobSnap.exists() ? jobSnap.data() : {};

  const chunksRef = collection(db, "translation_jobs", jobId, "chunks");
  const snap = await getDocs(chunksRef);

  console.log(`Loaded ${snap.docs.length} chapter docs from Firestore.`);

  const chunks: any[] = [];
  let totalEnglishWords = 0;
  let totalChars = 0;

  snap.docs.forEach((docSnap) => {
    const c = docSnap.data();
    const idx = typeof c.index === "number" ? c.index : 0;
    const words = c.englishText ? c.englishText.split(/\s+/).filter(Boolean).length : 0;
    totalEnglishWords += words;
    totalChars += c.charCount || 0;

    chunks.push({
      id: c.id || docSnap.id,
      index: idx,
      chapterTitle: c.chapterTitle || `Chapter ${idx + 1}`,
      chineseText: c.chineseText || "",
      englishText: c.englishText || "",
      charCount: c.charCount || 0,
      wordCount: words,
      status: "completed",
      attempts: 0,
    });
  });

  chunks.sort((a, b) => a.index - b.index);

  const fullJob = {
    id: jobId,
    sessionId: "legacy_default",
    fileName: "primitive luo zhen.txt",
    fileSizeBytes: jobData.fileSizeBytes || 2614817,
    totalChineseChars: totalChars || 762223,
    chunks,
    totalChunks: chunks.length,
    completedChunks: chunks.length,
    completedEnglishWords: totalEnglishWords,
    completedChars: totalChars || 762223,
    style: "xianxia",
    customInstructions: "",
    glossary: jobData.glossary || [],
    concurrency: 5,
    status: "completed",
    startedAt: jobData.startedAt || 1791018075811,
    lastActiveAt: Date.now(),
  };

  const jobsDir = path.resolve("./data/jobs");
  if (!fs.existsSync(jobsDir)) {
    fs.mkdirSync(jobsDir, { recursive: true });
  }

  const archivePath = path.join(jobsDir, "archive_primitive_luo_zhen_txt.json");
  const legacyPath = path.join(jobsDir, "job_legacy_default.json");

  fs.writeFileSync(archivePath, JSON.stringify(fullJob, null, 2), "utf-8");
  fs.writeFileSync(legacyPath, JSON.stringify(fullJob, null, 2), "utf-8");

  console.log(`✅ SUCCESS: Rehydrated all ${chunks.length} chapters (${totalEnglishWords.toLocaleString()} English words) to disk archives!`);
}

main().catch(console.error);
