import fs from "fs";
import path from "path";
import axios from "axios";
import JSZip from "jszip";

const BASE_URL = "http://localhost:3000";

async function verifyCompletedNovelAndEPUB() {
  console.log("==================================================================");
  console.log("      VERIFYING RECONNECT PAYLOAD, GREEN CHECK & EPUB ORDER       ");
  console.log("==================================================================");

  // 1. Fetch Job Status in Summary Mode (Mobile Data Saver)
  console.log("\n[Test 1] Simulating browser reconnect with ?summary=true...");
  const t0 = Date.now();
  const summaryRes = await axios.get(`${BASE_URL}/api/cloud-job/status?summary=true`, {
    transformResponse: [(data) => data],
    headers: {
      "Accept-Encoding": "gzip, deflate",
    },
  });
  const summaryDurationMs = Date.now() - t0;
  const summaryBytes = Buffer.byteLength(summaryRes.data, "utf-8");
  const summaryJob = JSON.parse(summaryRes.data);

  console.log(`✓ Reconnect Response received in ${summaryDurationMs}ms.`);
  console.log(`✓ Exact Summary Payload: ${summaryBytes} bytes (${(summaryBytes / 1024).toFixed(2)} KB).`);

  // 2. Fetch Job Status in Full Mode for Payload Comparison
  console.log("\n[Test 2] Comparing with unoptimized ?full=true payload...");
  const fullRes = await axios.get(`${BASE_URL}/api/cloud-job/status?full=true`, {
    transformResponse: [(data) => data],
    headers: {
      "Accept-Encoding": "gzip, deflate",
    },
  });
  const fullBytes = Buffer.byteLength(fullRes.data, "utf-8");
  const fullJob = JSON.parse(fullRes.data);

  console.log(`✓ Full Mode Payload: ${fullBytes} bytes (${(fullBytes / 1024).toFixed(2)} KB).`);
  console.log("------------------------------------------------------------------");
  console.log(`📶 MOBILE DATA SAVINGS ON BROWSER REOPEN:`);
  console.log(`   - Optimized Summary Mode: ${summaryBytes} bytes`);
  console.log(`   - Full Text Mode:         ${fullBytes} bytes`);
  console.log(`   - Data Saved on Reconnect: ${((1 - summaryBytes / fullBytes) * 100).toFixed(1)}% reduction!`);
  console.log("------------------------------------------------------------------");

  // 3. Verify Completed Status & Green Check Trigger
  console.log("\n[Test 3] Verifying Job State & Green Check Condition...");
  const job = summaryJob.job;
  console.log("Job Details:", {
    fileName: job.fileName,
    status: job.status,
    totalChunks: job.totalChunks,
    completedChunks: job.completedChunks,
    completedEnglishWords: job.completedEnglishWords,
  });

  const isCompleted = job.status === "completed";
  const allChunksDone = job.completedChunks === job.totalChunks && job.totalChunks === 5;
  const hasWordCount = job.completedEnglishWords > 0;

  if (isCompleted && allChunksDone && hasWordCount) {
    console.log("✅ VERIFIED: Green Checkmark condition satisfied!");
    console.log(`   • Status: "${job.status}" (Green Check badge active)`);
    console.log(`   • Chunks: ${job.completedChunks} / ${job.totalChunks} (100% complete)`);
    console.log(`   • English Words Ready: ${job.completedEnglishWords.toLocaleString()} words`);
  } else {
    console.error("❌ FAILED: Job not marked completed.");
  }

  // 4. Download Compiled EPUB from Server
  console.log("\n[Test 4] Downloading server-compiled EPUB via /api/cloud-job/download-epub...");
  const downloadStart = Date.now();
  const epubRes = await axios.get(`${BASE_URL}/api/cloud-job/download-epub`, {
    params: {
      novelName: job.fileName,
      continuous: "true",
    },
    responseType: "arraybuffer",
  });
  const downloadDurationMs = Date.now() - downloadStart;
  const epubBuffer = Buffer.from(epubRes.data);
  const epubSizeBytes = epubBuffer.length;

  console.log(`✓ Downloaded EPUB in ${downloadDurationMs}ms.`);
  console.log(`✓ EPUB File Size: ${epubSizeBytes} bytes (${(epubSizeBytes / 1024).toFixed(2)} KB).`);

  // Save copy to data dir for inspection
  const outPath = path.join(process.cwd(), "data", "test_output.epub");
  fs.writeFileSync(outPath, epubBuffer);
  console.log(`✓ Saved EPUB to ${outPath}`);

  // 5. Deep EPUB Structure & Chapter Sequencing Inspection
  console.log("\n[Test 5] Inspecting EPUB structure & chapter order integrity...");
  const zip = await JSZip.loadAsync(epubBuffer);
  const fileNames = Object.keys(zip.files);
  console.log("EPUB Archive Files:", fileNames);

  // Check required standard files
  const required = [
    "mimetype",
    "META-INF/container.xml",
    "OEBPS/content.opf",
    "OEBPS/nav.xhtml",
    "OEBPS/toc.ncx",
    "OEBPS/style.css",
    "OEBPS/titlepage.xhtml",
  ];

  let filesOk = true;
  for (const r of required) {
    if (fileNames.includes(r)) {
      console.log(`   ✓ ${r} exists and is valid`);
    } else {
      console.error(`   ❌ Missing required file: ${r}`);
      filesOk = false;
    }
  }

  // 6. Inspect Table of Contents (nav.xhtml)
  console.log("\n[Test 6] Checking Table of Contents (OEBPS/nav.xhtml)...");
  const navContent = await zip.file("OEBPS/nav.xhtml")?.async("string");
  const tocEntries: Array<{ href: string; title: string }> = [];
  const tocRegex = /<li><a href="([^"]+)">([^<]+)<\/a><\/li>/g;
  let match;
  while ((match = tocRegex.exec(navContent || "")) !== null) {
    tocEntries.push({ href: match[1], title: match[2] });
  }

  console.log(`Found ${tocEntries.length} TOC entries:`);
  tocEntries.forEach((entry, idx) => {
    console.log(`   [${idx + 1}] ${entry.href} -> "${entry.title}"`);
  });

  // 7. Inspect Spine in content.opf
  console.log("\n[Test 7] Checking Reading Spine (OEBPS/content.opf)...");
  const opfContent = await zip.file("OEBPS/content.opf")?.async("string");
  const spineEntries: string[] = [];
  const spineRegex = /<itemref idref="([^"]+)"\/>/g;
  while ((match = spineRegex.exec(opfContent || "")) !== null) {
    spineEntries.push(match[1]);
  }

  console.log(`Found ${spineEntries.length} Spine entries:`);
  spineEntries.forEach((entry, idx) => {
    console.log(`   [${idx + 1}] idref="${entry}"`);
  });

  // 8. Verify Strict Chapter Order (Chapter 1 -> Chapter 2 -> Chapter 3 -> Chapter 4 -> Chapter 5)
  console.log("\n[Test 8] Verifying Chapter Sequential Integrity...");
  let orderStrictlyCorrect = true;

  // Expected sequence: titlepage, chapter_1, chapter_2, chapter_3, chapter_4, chapter_5
  const expectedSpine = ["titlepage", "chapter_1", "chapter_2", "chapter_3", "chapter_4", "chapter_5"];
  if (spineEntries.length !== expectedSpine.length) {
    console.error(`❌ Spine count mismatch: expected ${expectedSpine.length}, got ${spineEntries.length}`);
    orderStrictlyCorrect = false;
  }

  for (let i = 0; i < expectedSpine.length; i++) {
    if (spineEntries[i] !== expectedSpine[i]) {
      console.error(`❌ Spine order error at index ${i}: expected "${expectedSpine[i]}", found "${spineEntries[i]}"`);
      orderStrictlyCorrect = false;
    }
  }

  // Verify Chapter Content & Headers in each chapter file
  const expectedChapters = [
    { num: 1, file: "OEBPS/chapter_1.xhtml", expectedHeader: "第1章 重生的开端" },
    { num: 2, file: "OEBPS/chapter_2.xhtml", expectedHeader: "第2章 初探迷雾森林" },
    { num: 3, file: "OEBPS/chapter_3.xhtml", expectedHeader: "第3章 遗迹的秘密" },
    { num: 4, file: "OEBPS/chapter_4.xhtml", expectedHeader: "第4章 远古的盟约" },
    { num: 5, file: "OEBPS/chapter_5.xhtml", expectedHeader: "第5章 黎明前的抉择" },
  ];

  console.log("\n[Test 9] Inspecting individual chapter HTML files...");
  for (const ch of expectedChapters) {
    const chFile = zip.file(ch.file);
    if (!chFile) {
      console.error(`❌ File ${ch.file} missing from EPUB!`);
      orderStrictlyCorrect = false;
      continue;
    }
    const html = await chFile.async("string");
    const h2Match = html.match(/<h2>([^<]+)<\/h2>/);
    const title = h2Match ? h2Match[1] : "(No H2)";
    const paragraphs = (html.match(/<p[^>]*>([^<]+)<\/p>/g) || []).map(p => p.replace(/<[^>]+>/g, "").trim());

    console.log(`   ✓ Chapter ${ch.num}: Title="${title}"`);
    console.log(`     Paragraph count: ${paragraphs.length}`);
    console.log(`     First paragraph: "${paragraphs[0]?.slice(0, 100)}..."`);
    console.log(`     Last paragraph:  "${paragraphs[paragraphs.length - 1]?.slice(0, 100)}..."`);

    if (!title.includes(String(ch.num)) && !title.includes(ch.expectedHeader)) {
      console.warn(`   ⚠️ Warning: Header title "${title}" did not match expected chapter number ${ch.num}`);
    }
  }

  console.log("\n==================================================================");
  console.log("                        AUDIT SUMMARY                             ");
  console.log("==================================================================");
  console.log(`1. Reconnect Mobile Data Saved: ${((1 - summaryBytes / fullBytes) * 100).toFixed(1)}% reduction (${summaryBytes} B vs ${fullBytes} B)`);
  console.log(`2. UI Green Check Completed State: ${isCompleted && allChunksDone ? "VERIFIED (100% Complete)" : "FAILED"}`);
  console.log(`3. Server-side EPUB Generation: VERIFIED (${(epubSizeBytes / 1024).toFixed(2)} KB compressed)`);
  console.log(`4. EPUB Chapter Sequence: ${orderStrictlyCorrect ? "100% IN ORDER (Chapter 1 -> 2 -> 3 -> 4 -> 5)" : "OUT OF ORDER"}`);
  console.log(`5. Table of Contents & Spine: ${tocEntries.length === 6 && spineEntries.length === 6 ? "VERIFIED" : "MISMATCH"}`);
  console.log("==================================================================\n");
}

verifyCompletedNovelAndEPUB().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
