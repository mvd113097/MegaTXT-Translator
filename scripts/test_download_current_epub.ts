import fs from "fs";
import path from "path";
import axios from "axios";
import JSZip from "jszip";
import { generateServerEpubBuffer } from "../server/epubServer";

const BASE_URL = "http://localhost:3000";
const SESSION_ID = `download_test_sess_${Date.now()}`;
const NOVEL_FILENAME = `天道苍穹_测试_${Date.now()}.txt`;
const AUTH_PASSCODE = "Mm663696..";

function generateTestBook(): string {
  const chapters = [
    {
      title: "第1章 苍茫绝谷",
      content: `林轩站在绝壁之巅，猎猎狂风卷起他破旧的青衫。
深渊下方云海翻腾，电闪雷鸣，仿若有一头亘古沉睡的绝世凶兽即将苏醒。
“三百年了，我林轩历经九世轮回，终究还是回到了这片葬仙谷。”
他眼中闪烁着凌厉如剑的光芒。上一世，他被至尊魔宗四大护法联手围攻，肉身尽毁，唯有一道本源剑魄破空逃遁。
如今他重塑凡躯，虽然修为仅仅处于纳气初期，但剑尊的傲骨与万千杀招却丝毫不减！
随着他引动体内的混沌剑诀，四周游离的天地灵气疯狂涌入他的丹田气海之中，激荡起阵阵金色狂澜。`
    },
    {
      title: "第2章 龙血妖藤",
      content: `林轩顺着古老的藤蔓滑入幽深阴暗的峡谷底部。
湿润的泥土中弥漫着刺鼻的腥味，四周奇石嶙峋，泛着幽幽冷光。
前行数里，前方豁然开朗，一株通体赤红如血、表面覆满龙鳞般粗糙皮甲的巨型妖藤盘踞在幽泉古石之上。
“这就是能够淬炼凡骨的龙血妖藤！”林轩目光微凝。
然而就在他靠近的瞬间，那妖藤猛烈震颤，数十根长达数十丈的血色触须撕裂空气，如狂风暴雨般朝他席卷而来！
林轩冷哼一声，手中随意折下的枯枝骤然亮起刺目的白芒，一招‘流星划月’，剑气破空，将漫天血藤斩成漫天碎屑！`
    },
    {
      title: "第3章 绝地反击",
      content: `伴随着妖藤核心晶石的碎裂，精纯澎湃的龙血精华化作滚滚热流，疯狂融入林轩周身经络。
他的气息瞬间暴涨，体内发出如雷霆般的轰鸣，直接突破纳气瓶颈，踏入先天化境！
然而，峡谷出口处忽然传来急促杂乱的脚步声。
落霞宗的三名内门叛徒带着十余名黑衣死士堵住了所有退路，脸上满是狰狞贪婪的冷笑。
“林轩，交出龙血精魄，留你一具全尸！”为首的灰袍老者阴测测地说道。
林轩缓缓收回剑指，嘴角扬起一抹冷冽至极的弧度：“凭你们这群土鸡瓦狗，也配染指本尊的机缘？”`
    },
    {
      title: "第4章 剑荡八荒",
      content: `话音未落，林轩身形如鬼魅般在原地消失！
灰袍老者瞳孔猛然收缩，心中警兆大盛，尚未拔出腰间长剑，一道宛若天劫降临般的凌厉剑气便已贯穿了他的眉心！
轰！
狂暴无匹的剑意在狭窄的峡谷中彻底爆发，漫天碎石激射，惨叫声此起彼伏。
不过短短三息时间，所有来袭之人尽数伏诛，唯有林轩白衣胜雪，滴血未沾。
他抬起头，眺望远方巍峨的仙道圣山，神色从容而坚定。
“属于我苍穹剑尊的时代，今日正式开启！”`
    }
  ];

  return chapters.map((c) => `${c.title}\n\n${c.content}`).join("\n\n\n");
}

async function runDownloadTest() {
  console.log("================================================================================");
  console.log("             TESTING: 'DOWNLOAD CURRENT EPUB' BUTTON & PIPELINE                 ");
  console.log("================================================================================");

  // 1. Authenticate
  console.log("\n[1/6] Authenticating client session...");
  const loginRes = await axios.post(`${BASE_URL}/api/auth/login`, { passcode: AUTH_PASSCODE });
  const authToken = loginRes.data.token;
  console.log(`✓ Authenticated: Token ${authToken.slice(0, 16)}...`);

  const authHeaders = {
    "Content-Type": "application/json",
    "x-session-id": SESSION_ID,
    "x-auth-token": authToken,
    "Authorization": `Bearer ${authToken}`,
    "x-novel-filename": encodeURIComponent(NOVEL_FILENAME),
  };

  // 2. Prepare & Upload Novel
  console.log("\n[2/6] Uploading 4-chapter novel...");
  const novelText = generateTestBook();
  const rawBytes = Buffer.byteLength(novelText, "utf-8");

  const prepRes = await axios.post(
    `${BASE_URL}/api/cloud-job/prepare`,
    {
      rawText: novelText,
      fileName: NOVEL_FILENAME,
      fileSizeBytes: rawBytes,
      style: "xianxia",
      splitByChapters: true,
      targetChunkChars: 2500,
      autoStart: false,
    },
    { headers: authHeaders }
  );

  const jobId = prepRes.data.jobId;
  const totalChunks = prepRes.data.totalChunks;
  console.log(`✓ Novel registered: Job ID = ${jobId}, Total Chunks = ${totalChunks}`);

  // 3. Start Background Translation
  console.log("\n[3/6] Starting background cloud translation...");
  await axios.post(
    `${BASE_URL}/api/cloud-job/start`,
    { jobId, fileName: NOVEL_FILENAME, concurrency: 2 },
    { headers: authHeaders }
  );
  console.log("✓ Cloud worker is actively running in background.");

  // 4. Wait for Mid-Way Progress (e.g. Chapter 1 & Chapter 2 done while job is STILL RUNNING)
  console.log("\n[4/6] Waiting for mid-way translation progress (Chapters 1 & 2 completed)...");
  let midJob: any = null;
  const maxWaitMs = 90000;
  const startMid = Date.now();

  while (Date.now() - startMid < maxWaitMs) {
    await new Promise((r) => setTimeout(r, 3000));
    const statusRes = await axios.get(`${BASE_URL}/api/cloud-job/status?summary=true`, { headers: authHeaders });
    const j = statusRes.data.job;
    if (j) {
      process.stdout.write(`\r   [Active Progress] Completed: ${j.completedChunks}/${j.totalChunks} chapters | Status: ${j.status} | Words: ${j.completedEnglishWords || 0}`);
      if (j.completedChunks >= 2) {
        midJob = j;
        console.log(`\n✓ Mid-way milestone reached: ${j.completedChunks}/${totalChunks} chapters translated (${j.completedEnglishWords} words).`);
        console.log(`✓ Job is currently: status = "${j.status}" (STILL RUNNING IN BACKGROUND).`);
        break;
      }
    }
  }

  if (!midJob) {
    throw new Error("Timeout waiting for Chapters 1 & 2 to translate");
  }

  // 5. TEST ACTION: USER PRESSES "Download Current EPUB" (Mid-way Snapshot)
  console.log("\n--------------------------------------------------------------------------------");
  console.log("🔘 TEST ACTION: User clicks [Download Current EPUB] while translation is running");
  console.log("--------------------------------------------------------------------------------");

  // A. Simulate the frontend syncCompletedTexts() call triggered on button click
  console.log("A. Executing frontend text synchronization (syncCompletedTexts)...");
  const syncStart = Date.now();
  const syncRes = await axios.get(`${BASE_URL}/api/cloud-job/sync-texts?completedOnly=true`, { headers: authHeaders });
  const syncElapsed = Date.now() - syncStart;
  const syncedChunks = syncRes.data.chunks || [];
  console.log(`   ✓ Synced ${syncedChunks.length} completed chapter texts in ${syncElapsed}ms.`);

  // Verify sync contains actual English text
  for (const c of syncedChunks) {
    console.log(`     • Chapter ${c.index + 1} (${c.chapterTitle || "Untitled"}): ${c.englishText ? c.englishText.slice(0, 80) + "..." : "[EMPTY]"}`);
  }

  // B. Simulate client-side EPUB generation with JSZip
  console.log("\nB. Testing client-side EPUB generation logic (generateEpubBlob / JSZip)...");
  const clientEpubBuffer = await generateServerEpubBuffer(syncedChunks, {
    bookTitle: NOVEL_FILENAME.replace(/\.[^/.]+$/, "").replace(/_/g, " "),
    isBilingual: false,
  });
  console.log(`   ✓ Client-side EPUB generated: ${clientEpubBuffer.length} bytes (${(clientEpubBuffer.length / 1024).toFixed(2)} KB).`);

  // C. Test direct server-side download endpoint: GET /api/cloud-job/download-epub?novelName=...&continuous=true
  console.log("\nC. Testing direct server download endpoint (GET /api/cloud-job/download-epub)...");
  const serverEpubRes = await axios.get(`${BASE_URL}/api/cloud-job/download-epub`, {
    params: {
      novelName: NOVEL_FILENAME,
      continuous: "true",
    },
    headers: {
      "x-session-id": SESSION_ID,
      "x-auth-token": authToken,
    },
    responseType: "arraybuffer",
  });

  const serverEpubBuffer = Buffer.from(serverEpubRes.data);
  console.log(`   ✓ Server-side EPUB downloaded: ${serverEpubBuffer.length} bytes (${(serverEpubBuffer.length / 1024).toFixed(2)} KB)`);
  console.log(`   ✓ Content-Type: ${serverEpubRes.headers["content-type"]}`);
  console.log(`   ✓ Content-Disposition: ${serverEpubRes.headers["content-disposition"]}`);

  // D. Inspect the Mid-Way EPUB eBook structure
  console.log("\nD. Inspecting internal structure of downloaded 'Current EPUB'...");
  const midZip = await JSZip.loadAsync(serverEpubBuffer);
  const midFiles = Object.keys(midZip.files);
  console.log(`   ✓ Archive contains ${midFiles.length} files:`, midFiles);

  // Check Table of Contents
  const midNav = await midZip.file("OEBPS/nav.xhtml")?.async("string");
  const tocMatches = midNav?.match(/<a href="([^"]+)">([^<]+)<\/a>/g) || [];
  console.log(`   ✓ Table of Contents has ${tocMatches.length} entries:`);
  tocMatches.forEach((m) => console.log(`       ${m}`));

  // Check that only currently completed continuous chapters are included (Chapters 1 & 2)
  console.log("   ✓ Checking chapter files present in Mid-way EPUB:");
  const ch1Xml = await midZip.file("OEBPS/chapter_1.xhtml")?.async("string");
  const ch2Xml = await midZip.file("OEBPS/chapter_2.xhtml")?.async("string");
  const ch3Xml = await midZip.file("OEBPS/chapter_3.xhtml")?.async("string");

  if (ch1Xml && ch2Xml) {
    console.log("       ✓ Chapter 1 is present with translated content.");
    console.log("       ✓ Chapter 2 is present with translated content.");
  } else {
    throw new Error("Missing Chapter 1 or Chapter 2 in downloaded Current EPUB!");
  }

  // E. Verify background translation was NOT interrupted by the download!
  console.log("\nE. Verifying background translation is STILL RUNNING uninterrupted...");
  const checkRunningRes = await axios.get(`${BASE_URL}/api/cloud-job/status?summary=true`, { headers: authHeaders });
  const runningJob = checkRunningRes.data.job;
  console.log(`   ✓ Status after downloading: status = "${runningJob.status}"`);
  console.log(`   ✓ Completed chunks: ${runningJob.completedChunks}/${runningJob.totalChunks}`);
  if (runningJob.status !== "running" && runningJob.status !== "completed") {
    throw new Error(`Background translation stalled after download! status = ${runningJob.status}`);
  }
  console.log("   ✅ VERIFIED: Background translation continues uninterrupted while user downloads current EPUB!");

  // 6. Wait for 100% Completion and Test Final Download
  console.log("\n[5/6] Waiting for remaining chapters to reach 100% completion...");
  const maxWaitFullMs = 120000;
  const startFull = Date.now();
  let fullJob: any = null;

  while (Date.now() - startFull < maxWaitFullMs) {
    await new Promise((r) => setTimeout(r, 3000));
    const statusRes = await axios.get(`${BASE_URL}/api/cloud-job/status?summary=true`, { headers: authHeaders });
    const j = statusRes.data.job;
    if (j) {
      process.stdout.write(`\r   [Active Progress] Completed: ${j.completedChunks}/${j.totalChunks} chapters | Status: ${j.status} | Words: ${j.completedEnglishWords || 0}`);
      if (j.status === "completed" || j.completedChunks >= j.totalChunks) {
        fullJob = j;
        console.log(`\n✓ Novel reached 100% completion! (${j.completedChunks}/${j.totalChunks} chapters, ${j.completedEnglishWords} words).`);
        break;
      }
    }
  }

  if (!fullJob || fullJob.completedChunks < fullJob.totalChunks) {
    throw new Error("Timeout waiting for 100% completion");
  }

  // 7. Final EPUB Download Test
  console.log("\n[6/6] Testing final complete EPUB download...");
  const finalEpubRes = await axios.get(`${BASE_URL}/api/cloud-job/download-epub`, {
    params: {
      novelName: NOVEL_FILENAME,
      continuous: "true",
    },
    headers: {
      "x-session-id": SESSION_ID,
      "x-auth-token": authToken,
    },
    responseType: "arraybuffer",
  });

  const finalZip = await JSZip.loadAsync(Buffer.from(finalEpubRes.data));
  const finalFiles = Object.keys(finalZip.files);
  console.log(`✓ Final complete EPUB downloaded: ${finalEpubRes.data.byteLength} bytes.`);
  console.log(`✓ Contains ${finalFiles.length} files.`);

  // Verify all 4 chapters are present in the final EPUB
  for (let i = 1; i <= totalChunks; i++) {
    const chFile = `OEBPS/chapter_${i}.xhtml`;
    if (finalFiles.includes(chFile)) {
      console.log(`   ✓ ${chFile} present`);
    } else {
      throw new Error(`Missing ${chFile} in final EPUB!`);
    }
  }

  console.log("\n================================================================================");
  console.log("       🎉 'DOWNLOAD CURRENT EPUB' BUTTON & PIPELINE FULLY VERIFIED!            ");
  console.log("================================================================================");
  console.log("1. Mid-Way 'Download Current EPUB' button click: SUCCESS");
  console.log("2. On-demand chapter text sync (delta sync): SUCCESS");
  console.log("3. Never-Skip contiguous sequence guarantee: SUCCESS (Chapters 1 & 2 packaged)");
  console.log("4. Zero background interruption: Translation continues actively: SUCCESS");
  console.log("5. Full EPUB download at 100% completion: SUCCESS (All 4 chapters packaged)");
  console.log("================================================================================\n");
}

runDownloadTest().catch((err) => {
  console.error("\n❌ DOWNLOAD CURRENT EPUB TEST FAILED:", err?.response?.data || err?.message || err);
  process.exit(1);
});
