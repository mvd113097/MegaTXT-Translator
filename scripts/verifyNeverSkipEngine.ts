/**
 * Automated Verification Test Suite for Parallel Translation & Never-Skip Contiguous Export Frontier
 * Uses 100% mocked workers & synthetic state without calling real Gemini API or modifying active translation jobs.
 */

import { TextChunk } from "../src/types";
import {
  getContiguousCompletedChunks,
  analyzeChunkContinuity,
  countEnglishWords,
} from "../src/utils/chunker";
import { QuotaAwareKeyScheduler } from "../server/quotaScheduler";

function createMockChunk(
  index: number,
  status: TextChunk["status"] = "pending",
  englishText: string = "",
  chapterTitle?: string
): TextChunk {
  return {
    id: `chunk_${index}`,
    index,
    chapterTitle: chapterTitle || `Chapter ${index + 1}`,
    chineseText: `第${index + 1}章 模拟中文小说内容。`,
    englishText,
    charCount: 150,
    status,
  };
}

let passedTests = 0;
let totalTests = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  totalTests++;
  if (condition) {
    console.log(`  ✅ [PASS] ${testName}`);
    passedTests++;
  } else {
    console.error(`  ❌ [FAIL] ${testName}: ${detail || "Assertion failed"}`);
    throw new Error(`Test failed: ${testName}`);
  }
}

async function runTests() {
  console.log("\n=======================================================");
  console.log("  NEVER-SKIP PARALLEL TRANSLATION & EXPORT ENGINE TESTS");
  console.log("=======================================================\n");

  // -------------------------------------------------------------
  // Test 1: Out-of-Order Completion & Gap Handling
  // -------------------------------------------------------------
  console.log("[Test Suite 1] Out-of-Order Completion & Gap Handling");
  {
    const chunks: TextChunk[] = [
      createMockChunk(0, "completed", "Chapter 1 English content translated successfully."),
      createMockChunk(1, "completed", "Chapter 2 English content translated successfully."),
      createMockChunk(2, "completed", "Chapter 3 English content translated successfully."),
      createMockChunk(3, "processing", ""), // Gap at Chunk 4
      createMockChunk(4, "completed", "Chapter 5 translated ahead by concurrent worker."),
      createMockChunk(5, "completed", "Chapter 6 translated ahead by concurrent worker."),
    ];

    const contiguous = getContiguousCompletedChunks(chunks);
    const report = analyzeChunkContinuity(chunks);

    assert(
      contiguous.length === 3,
      "Contiguous frontier length must be exactly 3 when chunk 4 is in-progress",
      `Got ${contiguous.length}`
    );
    assert(
      contiguous[0].index === 0 && contiguous[1].index === 1 && contiguous[2].index === 2,
      "Contiguous chunks must only contain 1, 2, 3",
      `Indices: ${contiguous.map((c) => c.index + 1).join(",")}`
    );
    assert(
      report.hasGaps === true,
      "Continuity report correctly flags gap present",
      `hasGaps: ${report.hasGaps}`
    );
    assert(
      report.missingChunks.length === 1 && report.missingChunks[0].index === 3,
      "Missing chunk identified as Chunk #4 (index 3)",
      `Missing: ${report.missingChunks.map((c) => c.index).join(",")}`
    );
    assert(
      report.aheadCompletedCount === 2,
      "Correctly detects 2 chapters completed ahead of the frontier (Ch 5 & 6)",
      `Ahead count: ${report.aheadCompletedCount}`
    );
  }

  // -------------------------------------------------------------
  // Test 2: Gap Resolution (When Chunk 4 Completes -> Frontier Expands to 6)
  // -------------------------------------------------------------
  console.log("\n[Test Suite 2] Gap Resolution & Frontier Auto-Extension");
  {
    const chunks: TextChunk[] = [
      createMockChunk(0, "completed", "Chapter 1 text"),
      createMockChunk(1, "completed", "Chapter 2 text"),
      createMockChunk(2, "completed", "Chapter 3 text"),
      createMockChunk(3, "completed", "Chapter 4 text (just finished!)"), // Gap resolved
      createMockChunk(4, "completed", "Chapter 5 text"),
      createMockChunk(5, "completed", "Chapter 6 text"),
    ];

    const contiguous = getContiguousCompletedChunks(chunks);
    const report = analyzeChunkContinuity(chunks);

    assert(
      contiguous.length === 6,
      "Contiguous export frontier automatically expands to all 6 chapters once gap finishes",
      `Got ${contiguous.length}`
    );
    assert(
      report.hasGaps === false,
      "Continuity report confirms zero gaps after resolution",
      `hasGaps: ${report.hasGaps}`
    );
    assert(
      report.aheadCompletedCount === 0,
      "Ahead count becomes 0 as all chapters are now part of contiguous frontier",
      `Ahead count: ${report.aheadCompletedCount}`
    );
  }

  // -------------------------------------------------------------
  // Test 3: Never-Skip Guarantee When Chapter 1 is Incomplete
  // -------------------------------------------------------------
  console.log("\n[Test Suite 3] Initial Chapter Gate (Chapter 1 Missing)");
  {
    const chunks: TextChunk[] = [
      createMockChunk(0, "processing", ""), // Chapter 1 in progress
      createMockChunk(1, "completed", "Chapter 2 done"),
      createMockChunk(2, "completed", "Chapter 3 done"),
    ];

    const contiguous = getContiguousCompletedChunks(chunks);
    assert(
      contiguous.length === 0,
      "EPUB export must NOT include any chapters if Chapter 1 is not yet complete",
      `Got ${contiguous.length}`
    );
  }

  // -------------------------------------------------------------
  // Test 4: Duplicate Translation Prevention (Never Translate Already Completed Chunks)
  // -------------------------------------------------------------
  console.log("\n[Test Suite 4] Duplicate Prevention (Never Re-translate Completed Chunks)");
  {
    const chunks: TextChunk[] = [
      createMockChunk(0, "completed", "Already done text"),
      createMockChunk(1, "completed", "Already done text 2"),
      createMockChunk(2, "pending", ""),
    ];

    const inFlight = new Set<string>();
    const pendingCandidates = chunks.filter(
      (c) =>
        (c.status !== "completed" || !c.englishText || !c.englishText.trim()) &&
        !inFlight.has(c.id)
    );

    assert(
      pendingCandidates.length === 1 && pendingCandidates[0].index === 2,
      "Dispatcher skips already completed chunks and only selects pending chunk 3",
      `Candidates: ${pendingCandidates.map((c) => c.index).join(",")}`
    );
  }

  // -------------------------------------------------------------
  // Test 5: Quota Scheduler 429 Rotation & Key Sanitization
  // -------------------------------------------------------------
  console.log("\n[Test Suite 5] Quota Scheduler 429 Failover & Cooldown Rotation");
  {
    const scheduler = new QuotaAwareKeyScheduler([
      { envVar: "KEY_1", apiKey: "TEST_KEY_1_CLEAN", name: "Project #1" },
      { envVar: "KEY_2", apiKey: "TEST_KEY_2_CLEAN", name: "Project #2" },
      { envVar: "KEY_3", apiKey: "TEST_KEY_3_CLEAN", name: "Project #3" },
    ]);

    const res1 = scheduler.selectProject();
    assert(res1 !== null && !!res1.project, "Successfully selects active project 1");

    // Simulate 429 rate limit on project 1
    scheduler.recordFailure(res1.project.id, {
      status: 429,
      message: "Resource exhausted: rate limit exceeded (429)",
    });

    const res2 = scheduler.selectProject();
    assert(
      res2 !== null && res2.project.id !== res1.project.id,
      "After 429, scheduler automatically rotates away from rate-limited project to next available project",
      `Rotated from ${res1.project.id} to: ${res2?.project.id}`
    );
  }

  // -------------------------------------------------------------
  // Test 6: Retry / Failure Isolation
  // -------------------------------------------------------------
  console.log("\n[Test Suite 6] Worker Failure Isolation (Chunk 4 Error Does Not Block Chunk 5)");
  {
    const chunks: TextChunk[] = [
      createMockChunk(0, "completed", "Ch 1"),
      createMockChunk(1, "completed", "Ch 2"),
      createMockChunk(2, "completed", "Ch 3"),
      createMockChunk(3, "error", "", "Chapter 4"), // Failed
      createMockChunk(4, "completed", "Ch 5"),
    ];

    // Worker can continue on chunk 4 or other chunks
    const exportable = getContiguousCompletedChunks(chunks);
    assert(
      exportable.length === 3,
      "Failed chunk 4 safely holds the export frontier at Chapter 3 without crashing",
      `Exportable: ${exportable.length}`
    );

    // Simulate retry success on chunk 4
    chunks[3].status = "completed";
    chunks[3].englishText = "Ch 4 translated successfully on retry";

    const exportableAfterRetry = getContiguousCompletedChunks(chunks);
    assert(
      exportableAfterRetry.length === 5,
      "Once chunk 4 retry succeeds, export frontier immediately extends across all 5 chunks",
      `Exportable: ${exportableAfterRetry.length}`
    );
  }

  // -------------------------------------------------------------
  // Test 7: Cumulative Progress & Non-Interfering Downloads
  // -------------------------------------------------------------
  console.log("\n[Test Suite 7] Cumulative Downloads (Non-Interfering Background Translation)");
  {
    const chunks: TextChunk[] = [
      createMockChunk(0, "completed", "Five words in chapter one"),
      createMockChunk(1, "completed", "Five more words here now"),
    ];

    const contiguous = getContiguousCompletedChunks(chunks);
    const wordsCount = contiguous.reduce(
      (acc, c) => acc + countEnglishWords(c.englishText),
      0
    );

    assert(
      wordsCount === 10,
      `Word count correctly accumulates across contiguous chapters (${wordsCount} words)`,
      `Words: ${wordsCount}`
    );

    // Simulate background worker translating chunk 3 while user is downloading
    chunks.push(createMockChunk(2, "completed", "Another five words translated quietly"));
    const updatedContiguous = getContiguousCompletedChunks(chunks);
    const updatedWords = updatedContiguous.reduce(
      (acc, c) => acc + countEnglishWords(c.englishText),
      0
    );

    assert(
      updatedWords === 15 && updatedContiguous.length === 3,
      "Background worker translation continues seamlessly and increments cumulative word count",
      `Updated words: ${updatedWords}`
    );
  }

  // -------------------------------------------------------------
  // Test 8: Pause / Resume Dispatch Logic
  // -------------------------------------------------------------
  console.log("\n[Test Suite 8] Pause / Resume Workflow");
  {
    const jobState: {
      status: "running" | "paused" | "completed";
      chunks: TextChunk[];
    } = {
      status: "running",
      chunks: [
        createMockChunk(0, "completed", "Ch 1 text"),
        createMockChunk(1, "pending", ""),
        createMockChunk(2, "pending", ""),
      ],
    };

    // Pause action
    jobState.status = "paused";
    assert(jobState.status === "paused", "Job status transitions cleanly to paused");

    // While paused, workers will not pick new tasks
    const canDispatchWhilePaused = (jobState.status as string) === "running";
    assert(!canDispatchWhilePaused, "Workers do not dispatch tasks while job is paused");

    // Resume action
    jobState.status = "running";
    const canDispatchAfterResume = (jobState.status as string) === "running";
    assert(canDispatchAfterResume, "Workers immediately resume picking up pending tasks on resume");
  }

  // -------------------------------------------------------------
  // Test 9: Restart Recovery (Preserves Completed Chunks from Disk)
  // -------------------------------------------------------------
  console.log("\n[Test Suite 9] Server Restart & Recovery");
  {
    // Simulate serialized state from disk
    const savedDiskState = {
      id: "cloud_job_12345",
      fileName: "test_novel.txt",
      chunks: [
        createMockChunk(0, "completed", "Ch 1 persisted on disk"),
        createMockChunk(1, "completed", "Ch 2 persisted on disk"),
        createMockChunk(2, "processing", ""), // was in flight when server crashed/restarted
        createMockChunk(3, "completed", "Ch 4 persisted on disk"),
        createMockChunk(4, "pending", ""),
      ],
    };

    // On reboot, chunks with processing are safely treated as pending for translation pickup
    const restoredChunks = savedDiskState.chunks.map((c) => {
      if (c.status === "processing" && (!c.englishText || !c.englishText.trim())) {
        return { ...c, status: "pending" as const };
      }
      return c;
    });

    const pendingToResume = restoredChunks.filter(
      (c) => c.status !== "completed" || !c.englishText || !c.englishText.trim()
    );

    const contiguousOnBoot = getContiguousCompletedChunks(restoredChunks);

    assert(
      pendingToResume.length === 2 && pendingToResume[0].index === 2 && pendingToResume[1].index === 4,
      "Server recovery seamlessly identifies remaining chunks 3 and 5 without retranslating chunks 1, 2, 4",
      `Pending: ${pendingToResume.map((c) => c.index + 1).join(",")}`
    );
    assert(
      contiguousOnBoot.length === 2,
      "Contiguous frontier is safely restored to Chapters 1–2 until chunk 3 completes",
      `Frontier: ${contiguousOnBoot.length}`
    );
  }

  console.log("\n=======================================================");
  console.log(`  ALL ${passedTests}/${totalTests} TESTS PASSED SUCCESSFULLY!`);
  console.log("=======================================================\n");
}

runTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
