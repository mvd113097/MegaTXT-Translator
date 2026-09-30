# Implementation Plan: 1:1 Chapter Preservation with Internal Sub-Chunk Translation & Chapter Integrity Validator

## 1. Problem Diagnosis & Root Cause
In Chinese web novel translations (such as the uploaded novel with 140 chapters), Chapter 53 was unusually long (>3,500 characters). 
Under the previous chunker logic (`splitTextIntoParagraphChunks`), when a chapter exceeded `targetSize * 1.3`, it was split into two top-level `TextChunk` objects (`Chapter 53 (Part 1)` and `Chapter 53 (Part 2)`).
Because these sub-chunks were pushed directly into the novel's main chunk sequence:
1. `Chapter 53 (Part 1)` was assigned chunk index 52, which mapped to `chapter_53.xhtml` in the EPUB.
2. `Chapter 53 (Part 2)` was assigned chunk index 53, which mapped to `chapter_54.xhtml` in the EPUB.
3. The true Chinese Chapter 54 was pushed out, misaligned, or omitted during batching/deduplication, resulting in a corrupted novel sequence where `chapter_54.xhtml` contained the second half of Chapter 53, and the true Chapter 54 ("郊游这天阳光很好...") vanished while the file count remained 140.

---

## 2. Proposed Architecture & Solution

### A. Strict 1:1 Chapter-to-Chunk Mapping (No Rogue Chapters)
- **Top-Level 1:1 Identity**: In `src/utils/chunker.ts` and `server.ts`, every detected novel chapter in the original text (e.g., Chapter 1 to Chapter 140) will always represent **exactly one** top-level `TextChunk` with its authentic `chapterTitle` (e.g. `第53章 盐`) and sequential index.
- **Internal Sub-Chunk Decomposition & Safe Merge**:
  - If a chapter's Chinese text exceeds the batch/target budget (e.g. >2,500–3,500 characters), it is decomposed **internally** into sub-chunks for translation execution only.
  - The translation engine translates each sub-chunk in strict sequence and merges the resulting English text back into the **single parent chapter** in exact chronological order.
  - The parent chapter retains its singular identity, ensuring `chapter_53.xhtml` in the EPUB contains all of Chapter 53, and `chapter_54.xhtml` contains Chapter 54.

### B. Automatic Chapter Integrity Validator
Add a dedicated, lightweight validator (`src/utils/chapterValidator.ts` and server-side support) that verifies:
1. **Chapter Titles & Chinese Numbering**: Parses and checks sequence (e.g., 第1章 through 第N章), identifying missing numbers or duplicate headers.
2. **Sequential IDs & Indexes**: Ensures an unbroken `0..N-1` index sequence with zero missing indices or out-of-order entries.
3. **Source Text Continuity & Boundary Alignment**: Verifies that the concatenated Chinese text matches the novel's source text without dropped paragraphs or unintended cross-chapter overlap.
4. **Sub-Chunk Merging Verification**: For any chapters translated via internal sub-chunks, confirms all sub-segments merged back into the chapter in correct order without missing fragments.
5. **Pre-Export Enforcement**:
   - Before EPUB or TXT export in `ExportModal.tsx`, `epubGenerator.ts`, and `server/epubServer.ts`, the validator automatically runs.
   - If validation fails, it **flags and blocks export** with detailed diagnostics (e.g., "Integrity Error: Chapter 54 missing or displaced by Chapter 53 sub-chunk") rather than silently deleting, reordering, or retranslating content.
6. **No Extra API Calls**: The validator operates deterministically on the stored source and translated text without consuming Gemini API quota.

### C. UI Integrity Feedback
- In `ExportModal.tsx`, display an **Integrity Validation Badge**:
  - Green: "Integrity Verified: All 140 Chapters sequentially verified against source."
  - Red / Warning: Clearly lists flagged chapters and reason for blocking export.
- In `ActiveTranslationView.tsx` and `LibraryView.tsx`, surface sub-chunk merge progress smoothly for long chapters.

---

## 3. Preserved Engine Constraints
- Keep the **2,500-character target** and **7,000–9,000-character batch budget** unchanged.
- Keep the **Never-Skip ordering** guarantee strictly active.
- Keep the **Gemini model and project/key rotation** (`quotaScheduler.ts`) untouched.
- Zero mock translations.

---

## 4. Verification Plan
1. **Unit & Regression Test**:
   - Create an automated test (`tests/test-chapter-integrity.ts`) simulating a multi-chapter novel where Chapter 53 exceeds 4,000 characters and Chapter 54 is normal length.
   - Verify that Chapter 53 decomposes internally, translates, and merges into exactly one chapter entry.
   - Verify that Chapter 54 is preserved immediately following Chapter 53 with its correct Chinese source and translated text.
2. **Validator Test**:
   - Test validator against intentionally corrupted sequences (missing chapter, duplicate chapter number, overlapping text).
   - Ensure the validator detects and flags each issue and blocks invalid export.
3. **EPUB Output Test**:
   - Verify that the resulting EPUB has `chapter_53.xhtml` (full Chapter 53), `chapter_54.xhtml` (full Chapter 54), and `chapter_55.xhtml` (full Chapter 55) in exact 1:1 alignment with the original Chinese novel.
4. **Applet Compilation**: Run `compile_applet` to confirm zero TypeScript, lint, or build errors.
