# RenVitals code audit

This is the historical audit before the approved fixes. See [FIXES.md](FIXES.md) for the current resolution status and remaining limitations; the findings below are not a claim that they are all still present.

Reviewed 1 October 2026. This is a source-code audit of the local checkout plus the previously requested header change. It covers the main app, Drive module, dashboard, HTML, styles, manifest, and service worker. It is not a live penetration test or a guarantee that every possible bug has been found. No real health Sheet was read, no sharing permissions were changed, and no live Google login/restore was performed.

## What changed during this review

Only maintenance changes were made:

- Replaced repeated queue-building bodies with enqueueChange, while keeping all eight public functions and the same queue records, ordering, timestamp defaults, deduplication, storage writes, and flush calls.
- Replaced three duplicate collapse-control bodies with one shared helper. Each existing wrapper keeps its old behavior.
- Removed the unused lockAppNow function after the requested header lock-button removal.
- Removed optional event wiring for a Sync-now button that does not exist in the current markup.
- Removed the unused CSS rule for the old Drive collapsible panel.
- Corrected misleading comments about two-way syncing, Google identity, and the location of Connect.
- Added the workflow/code guide and audit report; linked them from README.
- Aligned runtime asset versions with the service-worker cache and dashboard stylesheet.

No bug fixes that change application behavior were applied. The earlier requested header UI changes remain separate from this audit cleanup: Connect/Disconnect is in the header popup; Open Sheet, Restore, sheet linking, and CSV export remain in Settings.

## Findings that need separate fixes

The findings below remain present. Priorities reflect data integrity and privacy impact, not a claim of successful remote exploitation.

### 1. An edit can disappear from the upload queue — high priority

**Where:** drive.js, flushQueue and enqueueChange.

**Plain English:** If an upload is already happening and you save another reading, the older upload can overwrite the queue with its old copy. The new reading still exists on the device, but its pending upload can disappear. A normal full sync may eventually upload a live record again. A lost deletion marker is more serious because the deleted record is no longer present in the local list for a later full sync to recover.

**Evidence:** A controlled test paused the first upload, appended a second queue operation, then completed the upload. The saved queue became empty, including removal of the second operation.

**Possible fix:** Remove only the successfully uploaded operation from the latest stored queue; serialize queue updates and coordinate tabs. This needs behavior-changing tests and was not implemented.

### 2. An older device copy can overwrite newer Sheet data — high priority

**Where:** drive.js, syncEntries, syncMetrics, syncMedicines, syncDoseLog, and the upsert functions.

**Plain English:** Two devices connected to one Sheet do not currently merge changes automatically. If device A holds an older reading and device B has updated its Sheet copy, device A can push the older reading back over B's newer one. It can also replace a remote deletion marker with its live local record.

**Evidence:** A controlled test used a local record with updatedAt 10 and a remote record with updatedAt 20. syncEntries uploaded the older local record. The code treats different timestamps as needing an upload, rather than comparing which is newer.

**Possible fix:** Agree on conflict resolution and deletion handling before implementing true multi-device synchronization. The review preserves the existing push-only behavior.

### 3. The PIN does not encrypt or secure browser storage — high priority privacy limitation

**Where:** app.js DB, shouldShowLockOnOpen, handlePinComplete, unlockApp; drive.js token storage.

**Plain English:** The lock screen prevents ordinary viewing through the page. Health records and the Drive access token are still stored in readable browser storage. Someone with access to that browser profile, developer tools, or a compromised same-origin script can read them without entering the PIN.

The four-digit PIN has only 10,000 possibilities, and the code has no durable failed-attempt limit. Its fast salted hash can also be checked offline if storage is copied.

This is a local privacy limitation, not proof that someone on the internet can access another person's device.

**Possible fix:** Define the intended threat model. Encryption and stronger authentication would require a separate design and recovery plan.

### 4. Imported IDs are placed into HTML without consistent escaping — high priority hardening issue

**Where:** app.js, detailEntryRow, doseRowHtml, renderMedicinesList, and custom-metric settings rows.

**Plain English:** Some Sheet fields are trusted as identifiers and inserted directly into generated HTML. A deliberately malformed identifier containing a quote or markup can alter the page structure after Restore imports it.

**Evidence:** A harmless test identifier caused detailEntryRow to generate an extra span element in its HTML string. No script was executed. The Content Security Policy blocks several script paths, so this audit does not claim a fully demonstrated script-execution exploit.

**Possible fix:** Validate identifiers and imported record shapes, and escape all attribute values or create elements with DOM APIs. Ordinary locally generated IDs are well formed; the concern is imported or altered data.

### 5. Restore and some saves can report success after storage failure — medium/high priority

**Where:** drive.js restoreFromSheet; app.js saveMedicineFromSheet, saveMetricFromSheet, dose-state saves, medicine import, and settings persistence.

**Plain English:** Some parts of the app check whether storage succeeded; others ignore the result. If browser storage is full or unavailable, a success message can appear even though the new data was not saved. Medicine import also queues uploads before its final local save.

**Evidence:** A controlled Restore test made DB.saveEntries return false. Restore still returned an imported-record count of one. saveEntry already checks the write result, but several other save paths do not.

**Possible fix:** Treat failed persistence consistently and show success only after the local write succeeds.

### 6. The dashboard has no app login or PIN — conditional privacy exposure

**Where:** dashboard.js SHEET_ID, csvUrl, fetchTab; dashboard.html.

**Plain English:** The separate dashboard uses a Sheet ID built into the source and requests its shared CSV data without logging into Vitals. Whether a viewer can actually read the Sheet depends on Google sharing and the viewer's access. If it is available to anyone with the link, the app's PIN will not protect the shared health records.

**Evidence:** Confirmed from the request path and the lack of an authentication gate in the dashboard. The actual Sheet sharing setting and live accessibility were not checked.

**Possible fix:** Decide explicitly whether this dashboard is meant to be shareable or authenticated. A private sharing model would need a different access flow. No sharing changes were made.

### 7. Medicine import accepts impossible minutes — medium priority

**Where:** app.js parseImportTime.

**Plain English:** An imported time such as 8:99 AM is accepted. JavaScript date handling may roll it into a later hour, causing a schedule different from the entered text.

**Evidence:** A controlled test confirmed parseImportTime('8:99 AM') returns '08:99'.

**Possible fix:** Validate minutes from 00 through 59. Separately, an empty weekday selection is labeled Once, but matchesTodayMed does not schedule an empty days array.

### 8. Dashboard data can remain stale or disagree with the app — medium priority

**Where:** dashboard.js loadData, rowToMetric, rowToMedicine, rowToDoseLog, roundSmart.

**Plain English:** When the Metrics tab becomes empty, loadData can retain old metric definitions. Deleted rows are filtered out before resolving duplicate medicines/doses, so an older surviving row can still be shown if a newer deletion marker exists. Dashboard rounding also discards decimal places for values of 100 or more, while the main app keeps up to two decimals.

**Evidence:** Source inspection. These scenarios were not tested against a live shared Sheet.

**Possible fix:** Resolve duplicate IDs and deletion markers before filtering records, deliberately replace an empty successful Metrics response, and align the shared numeric rules.

### 9. Bad Sheet dates become today's readings during Restore — medium priority

**Where:** drive.js rowToEntry, compared with dashboard.js rowToEntry.

**Plain English:** The Drive parser substitutes the current time when a Sheet date cannot be parsed. A malformed old record can therefore be restored as if it happened now. The dashboard instead discards an invalid-date row.

**Evidence:** Source inspection of the two parsers.

**Possible fix:** Reject invalid records or report them explicitly rather than silently assigning the current time.

### 10. Offline caching can return the wrong file type — medium priority

**Where:** service-worker.js fetch handler and manifest.json icon paths.

**Plain English:** When a requested file is not cached, the service worker falls back to the main HTML page even when the request was for a script, image, or another page. That can produce broken resources or the wrong screen offline. Manifest icon URLs contain query versions that do not match the unversioned icon URLs in APP_SHELL.

**Evidence:** Source inspection. Browser/device-specific installation behavior was not tested.

**Possible fix:** Restrict HTML fallbacks to appropriate navigation requests and align icon cache keys. This would change offline behavior and was left for a separate fix.

### 11. Reminder delivery depends on the browser continuing to run — existing limitation

**Where:** app.js scheduleAllMedicines/checkMedicinesTick/fireMedicineDose; service-worker.js.

**Plain English:** The app schedules checks with a page timer. The service worker responds to notification clicks but does not independently schedule reminders. Closing or suspending the browser can prevent on-time reminders, regardless of installation on the home screen.

**Evidence:** Source inspection. No real notification was sent.

**Possible fix:** Reliable closed-app reminders need a supported background delivery approach; that is beyond a cleanup.

### 12. Google identity is decoded, not verified locally — trust-boundary limitation

**Where:** app.js decodeGoogleIdToken and handleGoogleCredentialResponse.

**Plain English:** The app reads the identity fields supplied by Google's sign-in flow, but its own code does not verify the token's signature or establish a server session. The normal Google widget is expected to provide a real credential. Someone already able to run code in the same browser page can forge local profile/account selection; this does not grant them Google Drive permission by itself.

**Evidence:** Source inspection. Drive uses a separate OAuth authorization flow.

**Possible fix:** If the product needs security beyond a local app profile, validate identity through an appropriate trusted authentication design.

## Redundancy and readability

The biggest safe repetition was the eight queue-building functions and three collapsible-section functions; those have been consolidated.

The main app and dashboard duplicate dates, chart drawing, metric definitions, and row parsing. Their rules already differ in meaningful ways. Combining them during a no-functional-change review could change display or imported-data handling, so that duplication remains documented for a separately tested refactor.

app.js still contains several responsibilities in one large file: accounts, storage, charts, medicines, locks, and event wiring. drive.js also has inconsistent spacing and extensive historical comments. WORKFLOW.md provides a navigation map. Breaking these into modules or broadly reformatting them was not necessary for the targeted cleanup and would increase review scope.

The app and Drive module both react to network recovery. Existing guards reduce repeated work, but removing a trigger would change ordering/timing; it remains unchanged.

## Verification

Completed locally:

- JavaScript syntax checks for app.js, drive.js, dashboard.js, and service-worker.js.
- Old/new comparison across 270 queue operations, including legacy queue records, replacements, mixed record types, deletes, timestamp defaults, ordering, and flush call counts.
- Old/new comparison of all three collapse controls, with open/closed states and missing-element cases.
- Controlled reproductions of queue loss, older-local overwrite, false Restore success, invalid imported minutes, and unescaped identifier markup.
- Fixed event-target checks against both HTML pages.
- Whitespace/diff checks and cache/version consistency checks.

Limits: no end-to-end real Google OAuth, Sheet writes, mobile biometric ceremonies, visual browser regression, offline installation, or push-notification delivery was tested. All bug reproductions used synthetic records. No production changes have been published.

## Suggested next fix order

1. Preserve queued edits/deletions and make local save failures visible.
2. Agree on multi-device conflict/deletion rules.
3. Validate imported records and consistently escape rendered fields.
4. Decide the privacy model for device storage and the dashboard.
5. Address import validation, dashboard inconsistencies, and offline fallbacks.

These are proposed follow-up fixes, not changes included in this review.
