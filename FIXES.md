# Approved fixes and medicine history

Implemented locally on 1 October 2026. Nothing has been published to GitHub or deployed.

## What was wrong, and what changed

- Uploads could discard edits made while another upload was running. Each queued edit now has its own identifier; successful uploads remove only the edits actually sent.
- Older device records could overwrite newer Sheet records. Uploads now check timestamps, preserve newer remote records, and respect deletion markers. Upload operations are serialized within the page and, where supported, across same-browser tabs.
- Restore and several save actions could appear successful when device storage failed. Restore now fails explicitly, and primary editing actions check whether saving succeeded.
- Imported medicine times could accept impossible minutes, and schedules could have no weekdays. Those cases are rejected.
- Invalid Sheet dates could silently become today's readings. Unparseable dates are rejected. Record identifiers are validated and HTML attribute values are escaped.
- The dashboard had a hardcoded Sheet and used public-sharing access. It now requires a supplied Sheet link plus Google authorization, uses authenticated reads, and keeps its token only in memory. This does not change an existing Sheet's sharing permissions.
- Dashboard duplicates/deletion markers and stale custom definitions could display misleading results. It now selects the newest row before filtering and refreshes definitions even when empty. Number rounding matches the app.
- Google identity credentials were decoded without checking their signature. The app now verifies the signature against Google's public keys, client, issuer, expiry, and request nonce. This strengthens the local account gate but is not a trusted server session.
- Drive access tokens were retained in long-lived browser storage. They now use session storage; legacy tokens are migrated and removed from long-lived storage.
- Repeated wrong PIN attempts had no cooldown. Five failed attempts now impose a one-minute local cooldown.
- Offline requests could receive HTML where an asset was expected. HTML fallback is now limited to main-page navigation; missing assets fail normally. Cache versions and versioned icons are aligned.
- Closed detail panels could appear at the side on wider screens. They are now hidden until opened.

## Approved medicine history

Inside Medicines, a date picker opens two lists: Taken with a green square, and Skipped with a red square. Counts, medicine name, dose, and scheduled time make each record easy to read. Text labels accompany colors for accessibility. A day without records shows an empty-state message.

Only explicitly recorded taken/skipped doses appear. An unmarked dose is not automatically called skipped. New marks save the medicine name and dose alongside the record, so later schedule edits/deletion do not erase that context. These fields also sync through the DoseLog Sheet tab. Older records use the current medicine definition when available; names of already-deleted older medicines cannot be reconstructed.

## Verification

Run `node tests/regressions.cjs` from the repository. Tests cover concurrent queue additions, stale writes and deletion conflicts, failed Restore storage, medicine imports, malformed records, dashboard reconciliation, date-selected history, Google signature/claim validation, offline fallbacks, and markup targets. JavaScript syntax and whitespace checks also passed. A local browser preview with synthetic data verified taken/skipped history and the empty state after choosing another date. No real health data was used in preview.

Live Google consent, real Sheet migration/restore, deployed caching, and multi-device races have not been exercised end-to-end.

## Remaining limitations

- Device health records are still unencrypted. The PIN is a local screen lock, not protection against someone who can inspect/modify browser storage. Its cooldown is also locally bypassable. Strong confidentiality and trusted access enforcement need a separate encrypted-storage/server design.
- Closed or suspended browsers cannot guarantee reminder delivery. The help text now says this; use a phone alarm for essential reminders.
- Timestamp checks are not atomic across separate devices. A trusted backend would be needed for stronger conflict guarantees. Restore does not perform deletion-aware two-way reconciliation.
- Existing public Sheet sharing was not changed. Making the dashboard private does not make a previously public Sheet private.
- No audit can promise that every possible loophole has been found. This work is source review and targeted testing, not a penetration test.

The static GitHub Pages architecture is retained as approved. These limits are not described as solved.
