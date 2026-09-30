import assert from "assert";
import { chunkChineseText, splitTextIntoSubChunks } from "../src/utils/chunker";
import { validateChapterIntegrity, extractChapterNumber, parseChineseNumber } from "../src/utils/chapterValidator";
import { generateServerEpubBuffer } from "../server/epubServer";

console.log("=== Testing 1:1 Chapter Mapping & Chapter Integrity Validator ===");

// 1. Test Chinese Chapter Number Parsing
console.log("-> Test 1: Chinese Number Parsing");
assert.strictEqual(parseChineseNumber("一"), 1);
assert.strictEqual(parseChineseNumber("十"), 10);
assert.strictEqual(parseChineseNumber("五十三"), 53);
assert.strictEqual(parseChineseNumber("五十四"), 54);
assert.strictEqual(parseChineseNumber("一百四十"), 140);
assert.strictEqual(parseChineseNumber("53"), 53);
assert.strictEqual(parseChineseNumber("140"), 140);

assert.strictEqual(extractChapterNumber("第53章 盐"), 53);
assert.strictEqual(extractChapterNumber("第54章 郊游"), 54);
assert.strictEqual(extractChapterNumber("Chapter 53: Salt"), 53);
assert.strictEqual(extractChapterNumber("Chapter 54: The Outing"), 54);
assert.strictEqual(extractChapterNumber("第五十三章 盐"), 53);
assert.strictEqual(extractChapterNumber("第五十四章 郊游"), 54);
console.log("✓ Number parsing verified successfully.");

// 2. Test 1:1 Chapter Mapping with Long Chapter (e.g. Chapter 53)
console.log("-> Test 2: 1:1 Chapter Mapping with Long Chapter");
const longChapter53Content = Array(70)
  .fill("广场上点燃了篝火，部落的族人们围坐在一起，兴奋地讨论着运送回来的盐巴。族长看着白花花的粗盐，眼中满是欣慰。")
  .join("\n\n"); // 70 * 53 = ~3,710 chars (exceeds 2500 * 1.25)
const normalChapter54Content = "郊游这天阳光很好，微风拂面，大家带上竹篓准备出发去采集野果。\n\n林间的小道有些泥泞，但大家都很开心。";
const normalChapter55Content = "大家最近都很忙碌，部落里正在制作新的门板与工具。";

const mockNovel = `
第52章 归来
族人们历经数日奔波，终于返回了部落。

第53章 盐
${longChapter53Content}

第54章 郊游
${normalChapter54Content}

第55章 忙碌
${normalChapter55Content}
`.trim();

const chunks = chunkChineseText(mockNovel, { targetChunkChars: 2500, splitByChapters: true });

console.log(`Parsed ${chunks.length} chunks from 4 chapters.`);
assert.strictEqual(chunks.length, 4, `Expected exactly 4 chunks for 4 chapters, but got ${chunks.length}`);
assert.strictEqual(chunks[0].chapterTitle, "第52章 归来");
assert.strictEqual(chunks[0].index, 0);

assert.strictEqual(chunks[1].chapterTitle, "第53章 盐");
assert.strictEqual(chunks[1].index, 1);
assert.ok(chunks[1].subChunks && chunks[1].subChunks.length > 1, "Chapter 53 should have internal subChunks for translation");
console.log(`Chapter 53 decomposed internally into ${chunks[1].subChunks?.length} sub-chunks without creating rogue chapters.`);

assert.strictEqual(chunks[2].chapterTitle, "第54章 郊游");
assert.strictEqual(chunks[2].index, 2);
assert.ok(chunks[2].chineseText.includes("郊游这天阳光很好"), "Chapter 54 content must be preserved intact");

assert.strictEqual(chunks[3].chapterTitle, "第55章 忙碌");
assert.strictEqual(chunks[3].index, 3);
console.log("✓ 1:1 Chapter mapping verified: Chapter 54 is never omitted or displaced by Chapter 53!");

// 3. Test Internal Sub-Chunk Translation and Sequential Merge
console.log("-> Test 3: Sub-chunk Translation and Sequential Merge");
const ch53 = chunks[1];
const sub1En = "Bonfires were lit across the plaza. Tribe members sat around discussing the salt.";
const sub2En = "The Patriarch looked at the white salt with relief in his eyes.";
ch53.subChunks![0].englishText = sub1En;
ch53.subChunks![0].status = "completed";
ch53.subChunks![1].englishText = sub2En;
ch53.subChunks![1].status = "completed";

// Merge sub-chunks
ch53.englishText = [sub1En, sub2En].join("\n\n");
ch53.status = "completed";

chunks[0].englishText = "The tribe members returned to the settlement after days of traveling.";
chunks[0].status = "completed";
chunks[2].englishText = "The day of the outing was very sunny with a gentle breeze.";
chunks[2].status = "completed";
chunks[3].englishText = "Everyone in the tribe had been very busy lately.";
chunks[3].status = "completed";

const validResult = validateChapterIntegrity(chunks, mockNovel);
assert.strictEqual(validResult.isValid, true, "Validation should pass for complete 1:1 sequence");
assert.strictEqual(validResult.canExport, true, "Should allow export for valid sequence");
console.log("✓ Validator passed valid sequence:", validResult.summary);

// 4. Test Validator Catches Missing Chapter (e.g. missing Chapter 54)
console.log("-> Test 4: Validator Catches Missing Chapter");
const corruptedMissing54 = [
  { ...chunks[0] },
  { ...chunks[1], index: 1 },
  { ...chunks[3], index: 2, chapterTitle: "第55章 忙碌" }, // 54 skipped!
];
const missingResult = validateChapterIntegrity(corruptedMissing54 as any);
assert.strictEqual(missingResult.isValid, false, "Should fail when Chapter 54 is missing");
assert.strictEqual(missingResult.canExport, false, "Export must be blocked when chapter missing");
assert.ok(
  missingResult.issues.some((i) => i.type === "missing_chapter" && i.message.includes("Chapter 54")),
  "Should flag missing Chapter 54"
);
console.log("✓ Missing chapter correctly detected and blocked:", missingResult.issues[0].message);

// 5. Test Validator Catches Duplicate Chapter (e.g. Chapter 53 split into two Chapter 53s)
console.log("-> Test 5: Validator Catches Duplicate Chapter");
const corruptedDuplicate53 = [
  { ...chunks[0], index: 0 },
  { ...chunks[1], index: 1, chapterTitle: "第53章 盐 (Part 1)" },
  { ...chunks[1], index: 2, chapterTitle: "第53章 盐 (Part 2)" },
  { ...chunks[2], index: 3 },
];
const duplicateResult = validateChapterIntegrity(corruptedDuplicate53 as any);
assert.strictEqual(duplicateResult.isValid, false, "Should fail when Chapter 53 is duplicated");
assert.ok(
  duplicateResult.issues.some((i) => i.type === "duplicate_chapter"),
  "Should flag duplicate chapter"
);
console.log("✓ Duplicate chapter correctly detected and blocked:", duplicateResult.issues[0].message);

// 6. Test Validator Catches Unmerged Sub-Chunks
console.log("-> Test 6: Validator Catches Unmerged Sub-Chunks");
const corruptedUnmergedSubChunk = [
  {
    ...chunks[1],
    index: 0,
    englishText: "Only part 1 was merged here...",
    status: "completed" as const,
  },
];
const subChunkResult = validateChapterIntegrity(corruptedUnmergedSubChunk as any);
assert.strictEqual(subChunkResult.isValid, false, "Should fail when sub-chunks are not merged in full");
assert.ok(
  subChunkResult.issues.some((i) => i.type === "subchunk_mismatch"),
  "Should flag subchunk_mismatch"
);
console.log("✓ Sub-chunk mismatch correctly detected and blocked:", subChunkResult.issues[0].message);

// 7. Test Server EPUB Generation with Valid vs Corrupted Chunks
console.log("-> Test 7: EPUB Export Enforcement");
(async () => {
  const epubBuffer = await generateServerEpubBuffer(chunks as any, {
    bookTitle: "Primitive Era",
    originalSourceText: mockNovel,
  });
  assert.ok(epubBuffer && epubBuffer.length > 500, "Valid EPUB should build successfully");
  console.log(`✓ Valid EPUB built successfully (${epubBuffer.length} bytes).`);

  let blocked = false;
  try {
    await generateServerEpubBuffer(corruptedMissing54 as any, {
      bookTitle: "Corrupted Novel",
    });
  } catch (err: any) {
    blocked = true;
    assert.ok(err.message.includes("Chapter Integrity Validator"), "Must be blocked by validator");
  }
  assert.strictEqual(blocked, true, "Corrupted EPUB export must be strictly blocked");
  console.log("✓ Corrupted EPUB export was strictly blocked by Chapter Integrity Validator.");

  console.log("\nALL CHAPTER INTEGRITY & NEVER-SKIP TESTS PASSED SUCCESSFULLY! 🎉\n");
})();
