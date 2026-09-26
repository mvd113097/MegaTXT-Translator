# Safety & History Restoration Plan: "Translate Another Book" Action

## Executive Summary
Pressing **"Translate Another Book" is completely safe and did not harm your 455k-word translation of *Primitive Chen Qi***. 

When "Translate Another Book" is pressed:
1. The entire completed translation (all 404 chapters, 455,147 words) is **safely archived** in Cloud Firestore and local server storage (`data/jobs/archive_primitive_chen_qi_txt.json`).
2. The active workspace is cleared to allow you to upload or translate a new book cleanly without clobbering existing novel data.
3. Your completed *Primitive Chen Qi* translation is permanently preserved and can be reopened at any time via the **History** drawer or by re-selecting/uploading the file.

---

## Proposed Safeguards & UI Enhancements

### 1. Reassurance & Quick-Restore Banner
- Add a prominent **"Recently Completed: Primitive Chen Qi (404/404 Chp • 455k words)"** quick-restore bar at the top of the novel upload/home screen.
- Clicking **"Open in Reader"** immediately loads all 404 chapters back into the active reader without any delay.

### 2. Enhanced History Drawer
- Show complete translation statistics (**100% Complete • 404 Chunks • 455,147 Words**) for *Primitive Chen Qi* inside the Translation History list.
- Provide direct 1-click actions: **"Open in Reader"**, **"Export EPUB"**, and **"Export TXT"** directly from the history item so you never have to worry about losing access.

### 3. Non-Destructive Novel Switching Safeguards
- Verify that starting a new novel never deletes, overwrites, or truncates any completed novel in Firestore or disk cache.
- Display a clear confirmation dialog whenever "Translate Another Book" is clicked explaining: *"Your current novel is safely archived in History and Cloud Storage. You can return to it anytime."*

---

## Verification Plan
1. **Archive Integrity**: Verify that `primitive chen qi.txt` with 404 chapters and 455k words remains accessible in `/api/cloud-job/history`.
2. **Quick Restore**: Test switching between a new blank workspace and reopening *Primitive Chen Qi* to confirm 100% data preservation.
3. **Export Verification**: Confirm TXT and EPUB downloads work directly from both the active session and the history list.
