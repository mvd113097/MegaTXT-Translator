# Implementation Plan: Server-Authoritative Novel Management with 100% Chunker Preservation

## Core Objectives & Guardrails
1. **Preserve Existing Translation Behavior 100%**:
   - **Target chunk size**: Exactly **2500 Chinese characters** (default).
   - **Batch budget**: Exactly **7000 Chinese characters**.
   - **Chapter boundary protection**: Kept strictly intact via `src/utils/chunker.ts`.
   - **Never-Skip contiguous ordering**: Maintained unchanged.
   - **Chunk IDs, indices, metadata, and deduplication**: Identical structure and validation.
   - **Translation Engine & Gemini Config**: No changes to prompts, model selection (`gemini-2.5-flash`), thinking configs, quota rotation, retry logic, or safety-filter handling.
2. **Direct Live Firestore Lookup on Start**:
   - When `/api/cloud-job/start` is called, the server directly queries Firestore (`translation_jobs`) in real time.
   - If a matching novel is completed or in progress, the existing job is returned immediately with zero duplicate cost or accidental restart.
3. **Upload Once & Sub-KB Start Requests**:
   - The original novel text is uploaded once during file selection (`/api/cloud-job/prepare`), where `server.ts` invokes the **exact** `chunkNovelText()` function from `src/utils/chunker.ts`.
   - The `Start Translation` request sends only `{ jobId: "..." }` (under 1 KB) instead of megabytes of chunk data.

---

## Detailed Implementation Steps

### 1. Direct Firestore Live Query on `/api/cloud-job/start`
- In `server.ts`:
  - When a start request is received (with `jobId` or novel metadata), execute a live Firestore query:
    - Check Firestore `translation_jobs` collection for matching `fileName` and `totalChars`.
    - If found with `status: 'completed'` or in-progress chunks:
      - Attach the full Firestore record into server state.
      - Return `{ success: true, alreadyCompleted: true, job: existingJob }`.
      - Refuse to restart or retranslate.
  - Check local disk archive (`data/jobs/archive_*.json`) as a secondary offline safeguard.

### 2. Server-Side Reuse of Exact `chunkNovelText` (`/api/cloud-job/prepare`)
- Create a lightweight preparation endpoint `/api/cloud-job/prepare` in `server.ts`.
- It imports `chunkNovelText` directly from `src/utils/chunker.ts`:
  - Uses `targetChunkChars: 2500` (unchanged).
  - Uses `splitByChapters: true` (unchanged).
  - Passes the resulting chunks through `cleanAndDeduplicateChunks()` (unchanged).
- Persists the prepared job record in Firestore and server memory.
- Returns `{ jobId, totalChunks, totalChars, previewChunks }`.

### 3. Client Frontend Optimization (`UploadSection.tsx` & `App.tsx`)
- When a file is dropped/selected:
  - The client reads the text and calls `/api/cloud-job/prepare`.
  - The client displays the chapter count and chunks for preview immediately.
- When the user clicks **Start Cloud Translation**:
  - The client sends `{ jobId }` to `/api/cloud-job/start` (tiny sub-KB payload).
- All polling, progress bars, and Telegram notifications continue functioning seamlessly.

### 4. Verification & Validation Tests
- **Chunk Size Verification**: Verify that generated chunks for a multi-chapter novel strictly target 2500 characters and do not exceed chapter boundaries.
- **Batch Budget Verification**: Verify that the translation queue in `server.ts` groups chunks strictly within the 7000 character budget.
- **Cold-Start Firestore Lookup Test**: Verify that sending a start request for an existing novel when server memory is empty queries Firestore directly and returns the completed job without generating any Gemini API calls.
- **App Build & Linting**: Run `compile_applet` and `lint_applet` to ensure full TypeScript compilation and zero regressions.
