# Permanent Novel Deletion & Anti-Resurrection Architecture

Guarantee that when any novel is deleted from History or the workspace, it is permanently and irreversibly eradicated across client storage, server memory, disk archives, and Cloud Firestore—preventing ghost jobs, auto-resurrections, and unexpected translation notifications on server wake-up.

## User Review & Critical Decisions

> [!IMPORTANT]
> Based on your answers:
> - **Confirmed Goal**: If a novel is paused mid-translation, moved to history, and deleted in history, that novel must **never** appear again, **never** resume translating in the background, and **never** send wake-up notifications when you open the published link.
> - **Zero Resurrection Guarantee**: All deletion operations will execute an ironclad 4-layer purge:
>   1. **Client Storage**: Remove immediately from IndexedDB (`current_active_session` and cached chapter chunks) and `localStorage`.
>   2. **Server Memory**: Evict immediately from active background workers, `cloudJobs`, and in-flight translation queues.
>   3. **Disk Cache**: Permanently unlink all matching JSON files in `data/jobs/` and root `data/cloud_job.json`.
>   4. **Cloud Firestore**: Delete parent document and subcollections (`chunks` & `segments`), while permanently persisting a tombstone in Firestore's `deleted_jobs` collection.
>   5. **Startup Disk Protection**: Ensure `loadCloudJobsFromDisk()` filters both Firestore AND disk jobs against tombstones, deleting stale disk files immediately instead of re-saving them to Firestore.

---

## 1. Overview & Root Cause Analysis

### The Root Cause
1. **Unfiltered Disk Jobs on Startup**: During cold starts on Cloud Run, `loadCloudJobsFromDisk()` gathered local disk archives and reconciled them with Firestore. While Firestore jobs were checked against deleted tombstones, **disk jobs were not**. If an archived job existed on disk, the server treated it as missing in Firestore, re-saved it to Cloud Firestore, and marked it eligible for auto-resume.
2. **Server Wake-Up Auto-Resume**: On boot, any job with status `running` triggered a wake-up Telegram notification and re-entered the worker loop.
3. **Client IndexedDB Stale Session**: In `handleTranslateAnother` / `handleTranslateNewNovel`, the active session was cleared from `localStorage` but was **not** removed from client IndexedDB (`clearSessionFromIdb()`). When re-opening the published link, the browser restored the old session from IndexedDB, querying the server for status.
4. **Hardcoded Chen Qi Restoration**: Startup self-healing routines previously re-seeded default jobs if absent, which could conflict with deletion intentions.

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Permanent Deletion Flow                         │
└────────────────────────────────────────────────────────────────────────┘

 [User Taps "Delete Novel" in History]
               │
               ▼
 ┌───────────────────────────┐
 │   Client-Side Purge       │──► 1. Wipe IndexedDB active session & chunks
 │   (Instant & Offline Safe)│──► 2. Wipe localStorage & Reading History
 └─────────────┬─────────────┘──► 3. Write client tombstone to localStorage
               │
               ▼ HTTP POST /api/cloud-job/delete { fileName, jobId }
 ┌───────────────────────────┐
 │   Server-Side Eradication │──► 1. Cancel in-flight chunk requests
 │   (In-Memory & Cache)     │──► 2. Evict from memory cloudJobs Map
 └─────────────┬─────────────┘──► 3. Delete matching JSON files from data/jobs/
               │
               ▼
 ┌───────────────────────────┐
 │   Cloud Firestore Purge   │──► 1. Delete job document, chunks & segments
 │   & Authoritative Tombstone│──► 2. Persist tombstone in deleted_jobs
 └─────────────┬─────────────┘
               │
               ▼
 ┌───────────────────────────┐
 │   Server Cold-Start Guard │──► 1. Tombstone check applied to ALL disk jobs
 │   (Zero Resurrections)    │──► 2. Dormant / deleted jobs unlinked on boot
 └───────────────────────────┘──► 3. Never auto-resume unprompted
```

---

## 2. Proposed Changes & Implementation Scope

### Step 1: Server Startup & Disk Tombstone Enforcement (`server.ts`)
- **Tombstone Disk Filter**: Update `loadCloudJobsFromDisk()` so that all disk jobs (`diskJobs`) are strictly filtered against Firestore and disk tombstones. Any disk job that matches a deleted tombstone by ID or novel filename will be deleted from disk (`fs.unlinkSync`) immediately and never loaded into memory or synced to Firestore.
- **Safe Auto-Resume**: Restrict startup auto-resuming so that only jobs explicitly confirmed active within the last 5 minutes (and strictly not in tombstones) can run. Dormant or paused jobs will remain paused.
- **Remove Hardcoded Re-Hydration**: Remove automatic re-creation of `Primitive Chen Qi` when absent, respecting user deletions.

### Step 2: Robust Server Deletion Handler (`server.ts` & `server/firestoreStorage.ts`)
- **Targeted Deletion**: In `/api/cloud-job/delete`, ensure the server uses the `fileName` and `jobId` explicitly provided in the request body, rather than defaulting to whatever active session happens to be in memory.
- **Complete Eradication**:
  - Evict matching jobs and cancel all in-flight workers.
  - Delete all associated disk cache files in `data/jobs/`.
  - Batch-delete all chunks and segments in Cloud Firestore.
  - Record the novel's canonical and normalized names in the `deleted_jobs` Firestore collection.

### Step 3: Client Workspace & Session Reset (`src/App.tsx` & `src/components/HistoryModal.tsx`)
- **IndexedDB Cleanup on "Translate Another Book"**: Update `handleTranslateAnother` and `handleTranslateNewNovel` to call `clearSessionFromIdb()` so no ghost sessions linger in browser IndexedDB.
- **Startup Deleted Novel Check**: In `App.tsx` startup `useEffect`, verify that any session restored from IndexedDB is checked against `megatext_deleted_novels`. If deleted, immediately wipe IndexedDB and do not load it.
- **Direct History Deletion**: In `HistoryModal.tsx`, ensure deleting a novel cleanly purges both the local database cache and triggers the server-side deletion with exact filename and ID parameters.

---

## 3. Verification & Safety Plan

1. **Compilation & Lint Verification**: Run `compile_applet` and `lint_applet` to ensure type-safety across all endpoints and handlers.
2. **Deletion & Restart Simulation**:
   - Create a test job and verify it exists in memory/disk.
   - Execute deletion via the updated handler.
   - Restart the server process to verify that `loadCloudJobsFromDisk()` respects the tombstone, removes any leftover files, and does NOT resurrect the job or send wake-up notifications.
3. **Browser Reload Verification**: Verify that opening the app after deletion does not restore the deleted book or trigger auto-translation.
