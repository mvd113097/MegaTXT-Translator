import { initializeApp } from "firebase/app";
import { initializeFirestore, collection, getDocs } from "firebase/firestore";
import fs from "fs";

async function main() {
  const config = JSON.parse(fs.readFileSync("./firebase-applet-config.json", "utf-8"));
  const app = initializeApp(config);
  const db = initializeFirestore(app, {
    experimentalForceLongPolling: true,
    ignoreUndefinedProperties: true,
  }, config.firestoreDatabaseId || undefined);

  console.log("Querying Firestore database...");
  try {
    const jobsCol = collection(db, "translation_jobs");
    const snapshot = await getDocs(jobsCol);

    if (snapshot.empty) {
      console.log("No jobs found in Firestore.");
      process.exit(0);
    }

    const jobsList: any[] = [];
    snapshot.forEach((docSnap) => {
      jobsList.push({ id: docSnap.id, ...docSnap.data() });
    });

    // Sort by lastActiveAt descending
    jobsList.sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0));

    console.log("\n==================================================");
    console.log(`ALL JOBS IN FIRESTORE (${jobsList.length} total, sorted by active):`);
    console.log("==================================================");
    jobsList.forEach((job) => {
      console.log(`File:        ${job.fileName}`);
      console.log(`Doc ID:      ${job.id}`);
      console.log(`Session ID:  ${job.sessionId}`);
      console.log(`Status:      ${job.status}`);
      console.log(`Progress:    ${job.completedChunks || 0} / ${job.totalChunks || 0} chunks`);
      console.log(`Last Active: ${job.lastActiveAt ? new Date(job.lastActiveAt).toLocaleString() : 'N/A'}`);
      console.log("--------------------------------------------------");
    });
  } catch (err: any) {
    console.warn("Firestore query note:", err.message || err);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("Error checking Firestore:", err.message || err);
  process.exit(0);
});

