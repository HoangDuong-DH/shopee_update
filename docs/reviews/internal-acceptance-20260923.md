# Independent internal manual-workflow acceptance — 23 September 2026

This report concerns the isolated `codex/internal-operations` worktree. It does not authorize or evidence Shopee production writes, connection onboarding, multiple employee authentication, LAN deployment or a 24-hour availability claim.

Final QA outcome: **2,438/2,438 unit/integration tests passed across 142 files, zero failures or skipped tests**, in one combined run after the recovery fixes. The continuous manual browser journey also passed **1/1** against the real application and isolated PostgreSQL with only external Shopee responses simulated. Its successful target is a hidden listing with verified core fields and explicitly pending image QC.

## Environment and evidence

- Node 24.20.0; isolated PostgreSQL `127.0.0.1:5443/shopee_internal_test`, account `shopee_internal`, random schema per run. Tests fail before setup against any other database.
- Browser acceptance starts its own API and Vite on random loopback ports. It does not use live API 4310, UI 5173 or PostgreSQL 5442. The shared intercepted-browser test host 5273 is separate.
- New source fixture bytes are genuine ZIP, XLSX and PNG. Product names, SKU values, prices and synthetic metadata are deliberately test data. No imported parse body is fabricated in the new source acceptance.
- Import HTTP routes, import worker, PostgreSQL persistence, content-cell resolver, draft saver, bulk edit and production compiler are actual application modules.
- Runner acceptance uses the actual `ProductionPilotRunner`, journal, codec, signed transport request construction and raw QC. Only external Shopee responses are provided by the independent in-memory `PreparedWirePlatform`; there is no network fallback. A preconnected isolated fixture record supplies test credentials; login/connection implementation is out of scope.
- Initial intake-only browser evidence: `.local/internal-acceptance-20260923/browser-CJQB6A/{ui-evidence.json,database-evidence.json,intake-final.png}`.
- Final continuous browser evidence: `.local/internal-acceptance-20260923/browser-vvko6h/{ui-evidence.json,database-evidence.json,hidden-job-report.png,hidden-qc-report.xlsx}`. The frontend agent completed 1/1 in 47.9 seconds; QA independently inspected the fixture boundary, receipts and final screenshot.
- Machine-readable integration outcome: `.local/internal-acceptance-20260923/integration-final.json` (23/09, 18:36 UTC+7; 6 passed, 0 failed, 0 skipped).
- Final combined outcome: `.local/internal-acceptance-20260923/all-unit-integration-final.json` and `all-unit-integration-final-run.json` (23/09, 19:07:23–19:16:19 UTC+7; 2,438 passed, 0 failed, 0 skipped; 142 files; 536.04 seconds).
- Independent audit of the final browser's saved PG receipts and downloaded workbook: `.local/internal-acceptance-20260923/final-browser-independent-audit.json`. It confirms the completed parent/child, exact SKU/price/stock rows, two core readbacks, hidden state and pending-image-QC report, with the XLSX hash.
- The stale-source case also exercises the real scoped `source-changes` HTTP route and asserts exact title before/after and both revision numbers.
- Runner evidence is the newest `internal-acceptance-20260923-*/compiled-runner-receipt.json` under this worktree's `.local/production-batch-pass1-20260915/`, with adjacent immutable preparation/source/journal evidence. These paths are private local evidence and are not part of the public delivery.

## Concrete use cases

| Case | Surface and expected outcome | Latest result |
|---|---|---|
| ZIP + Excel content + genuine pricebook | Operator imports two source folders, maps explicit STT/content columns, selects original SKU/price rows, chooses description layout and image roles, then saves one draft. | PASS: real browser/API/worker/PG. |
| Invalid sibling | The second folder lacks SKU membership, stays visible after reload and is not silently saved or submitted. | PASS: real browser/API/PG. |
| Reload and bulk remove | Reload saved source, preview removal of 280ml, retain 500ml and 100ml with original SKU/price references, save one new revision. | PASS: real browser/API/PG. |
| Duplicate draft and bulk request | Replay same draft save and submit two concurrent exact bulk applies. One immutable new revision per source; one reply reports recovery. | PASS: real HTTP/PG; two valid drafts. |
| Bulk edit → preparation | Compile source produced by actual bulk edit; valid source stays ready while sibling lacking category is blocked. Frozen manifest keeps hidden mode and source-cell receipts. | PASS after root fix for `localBulkEdit` audit metadata. |
| Source changed after preview | Updating the draft revision blocks registration; frozen preview stays retrievable and no registry call occurs. | PASS: real compiler/PG. |
| Source changed after registration | An unstarted registered job must reject stale source before consulting or dispatching its child. | PASS after backend preclaim fix; no child status or dispatch call. |
| Other-shop job ID | Same stored preparation cannot be read or started under another shop scope. | PASS: real preparation/queue/PG. |
| Hidden job, refresh/recovery | Queue finishes its child, new service instance reads completion, explicit repeat does not start the child again. | PASS: actual queue/PG with deterministic child-status fixture. |
| Lost child POST response | Child accepts then response is lost; parent pauses. Reopened parent reads busy child and never resends mutation. | PASS: actual queue/PG with failure fixture. |
| Bounded busy service | Child remains busy; two configured polls stop with durable `PREPARATION_CHILD_STILL_RUNNING`. | PASS: actual queue/PG with failure fixture. |
| Compiled source → hidden create → external QC conflict | Original source/manifest enters actual runner; one add-item and one initialize-variation occur in raw fixture. External title difference leaves operation acknowledged and QC unresolved. | PASS: actual compiler/runner/journal/PG; external transport fixture. |
| QC recovery without overwrite | Once external read matches source, runner performs two readbacks, verifies, writes no more requests and keeps remote fixture item `UNLIST`. | PASS: actual runner/journal/PG; external transport fixture. |
| Human operational report | Scope-bound JSON/XLSX shows per-product names/status and next action without counting ACK as verified. Nullable unsent item ID works; a leading `=` remains string content; extra raw secrets do not export. | PASS: real HTTP/exporter, deterministic status-service fixture, selected nonlegacy shop. |
| Continuous manual browser journey | ZIP/Excel import → explicit source mapping → save/reload → bulk removal → prepare/register → hidden job → refresh → pending-image-QC status → downloaded XLSX. | PASS: real UI/API/worker/PG/compiler/parent/child/runner/journal; only external Shopee is synthetic. Exactly one new create and one initialization, no publication or refresh resend. |

## Reproduced defect and correction

The initial true source chain failed because `BulkProductEditService.apply` adds `localBulkEdit` to a revision while `buildProductionDraftSource` rejected that key as `UNSUPPORTED_SOURCE_FIELD`. The independent test remained red until root added strict audit-receipt validation to the compiler. The later run reached a ready compiled source without changing source bytes or weakening SKU/price checks.

A second real failure allowed `ProductionPreparationExecution.start` to claim a registered job after the source revision changed. The backend owner added a preclaim check. The unchanged independent test now confirms `PREPARATION_SOURCE_CHANGED` before any child call, while the preview remains intact. Partial valid/stale sibling behavior is covered by the implementation owner's separate tests and is not inferred from this single-source case.

Test fixture corrections were limited to using supported manifest storage root, exact visible UI labels, explicitly selecting the mandatory description layout, and asserting the default descending-volume order. The Excel receipt assertion reads the immutable listing snapshot's import receipts, where the product stores it, rather than expecting a separate manifest `sourceFiles` record.

## Scoped completion criteria

The initial intake-only browser case passed 1/1 (10.6 seconds test time, 20.2 seconds including server startup/cleanup). The six focused integration cases passed 6/6 (11.79 seconds including setup/cleanup), and all six also pass inside the final combined run. Both identified integration defects are covered by assertions that originally failed. The final combined result is a single run rather than a sum of focused counts.

The final continuous browser case additionally establishes one uninterrupted UI journey through actual hidden-job dispatch, reload, QC status and report download, on a preconnected synthetic shop. Its final operation is acknowledged with two matching core readbacks and an immutable `image_qc_deferred_by_operator` receipt; image QC remains pending and the item stays `UNLIST`. It retains 500ml/100ml at original prices 13,000/11,000 and stock 100 each, source revision 2 and original content. The report verifies shop name/ID and both variants. This does not establish completed image review, real enterprise workbook acceptance or actual Shopee production readiness. Existing production checkpoints remain separate evidence.

Manual business blockers remain explicit: ambiguous SKU membership, unsupported source fields/layouts, missing category/warehouse/capability evidence and external QC differences require their own source or review action. Login and connection onboarding are deferred by user scope; no code or acceptance claim for them is included.

## Broader regression run

Eleven older integration files now call `tests/helpers/integration-database.ts`. Outside isolated mode it preserves the historical localhost/127.0.0.1 port 5442 rule. With `INTERNAL_ISOLATED_MODE=1`, only `127.0.0.1:5443/shopee_internal_test` as `shopee_internal` is accepted; 5442, another host/database/user all fail before a connection is opened. A separate eight-assertion guard smoke check passed without opening a connection.

The broad regression launch is `.local/run-all-internal-tests.mjs`: `readIsolated` environment, explicitly empty dotenv file, network guard preloaded in launcher and workers, Vitest `--configLoader runner`, existing sequential-file configuration. Output and run metadata go to `.local/internal-acceptance-20260923/all-unit-integration*.json`. Treat the resulting counts separately from the focused acceptance above. This run does not execute the legacy 5442 environment.

The first broad run (18:40:35–18:49:24 UTC+7) finished **2,418 passed / 10 failed / 0 skipped**, across 141 files (135 passed / 6 failed), in 528.76 seconds. Its original results are preserved as `all-unit-integration-initial.json` and `all-unit-integration-initial-run.json`. Recovery implementation was still being edited during this run, so it is a diagnostic run rather than a frozen final acceptance.

| First-run failure | Diagnosis and follow-up |
|---|---|
| Two prepared-execution cases exceeded 1,500ms | Both pass unchanged when selected independently (223ms / 194ms); full-file retry showed variable whole-test elapsed time. Root authorized a 5,000ms outer test budget for the three real-PG deadline cases, retaining the 20ms product request deadline and every unknown-state/no-resend assertion. The full file then passed 29/29. |
| Two price-issue context requests returned 400 | Historical test called the now scoped preparation context without a selected shop. Root added the explicit shop query; both cases pass. |
| Eighty-source preparation description differed | The older test expected a text-only draft while existing publish compilation applies opening → original gallery → body. Root corrected the expectation to exact text and exact source image metadata; title/SKU/price/source hash assertions remain. All three compiler cases pass. |
| Network-guard self-test | Inherited preload cached the guard before the child installed its fake fetch. Test child now clears only inherited `NODE_OPTIONS`, installs the fake and explicitly imports the guard. All seven isolation/backup tests pass afterward; runtime guard is unchanged. |
| Three lifecycle tests missing scope | Fixture registration passed no selected scope. Backend owner corrected the fixture; all three pass in independent final retry. |
| Recovered orphan second start returned `PRODUCTION_BATCH_IN_PROGRESS` | Status could advertise readiness after a durable result but before coordinator cleanup. Backend now keeps busy until the batch lease is released last, after the shop lease; a cleanup-gate regression checks this directly. Expanded recovery cases pass independently. |

The subsequent full prepared-execution plus isolation-test rerun produced 34 passed / 2 whole-test timeouts. This is retained separately as `focused-2026-09-23T115041299Z.json`; it is not represented as a successful full regression. The two selected-case retry is `focused-2026-09-23T115015269Z.json` (2 selected passed / 27 excluded by name filter).

After the isolated self-test correction and outer test-budget adjustment, a four-file run finished **77 passed / 0 failed / 0 skipped** in 22.72 seconds: prepared execution (29), isolation/backup (7), independent workflow acceptance (6), and scoped production route contracts (35). It includes the latest source-changes HTTP route and operational JSON/XLSX report. Evidence: `focused-2026-09-23T115246602Z.json`. This focused result does not overwrite or aggregate away the first broad run's failures.

Root's subsequent four-file run finished **46 passed / 0 failed / 0 skipped** in 42.29 seconds: eighty-source compiler/preparation (3), price issue context projection (2), independent workflow acceptance (6), and scoped routes (35). Evidence: `focused-2026-09-23T115318638Z.json`. QA independently reviewed both expectation corrections; neither relaxes source identity, raw bytes, price or scope rules.

## Independent recovery v3 review

The code review covered `production-batch-recovery.ts`, service status/admission/receipt persistence and the runner's first dispatch. Negative proof takes archive/shared, sorted product identity and journal owner locks in the same order used by the writer, checks every source revision and its joined step/publication history, checks checkpoints, and persists the immutable receipt before releasing the transaction. Successor evidence binds the original recovery and new request fingerprints, selected scope, source/revision and exact operation before the runner writes remotely. Status validates that binding rather than treating the historical absence observation as perpetual permission to create.

No unsafe automatic replay path was found in this review. A crash after operation reservation but before successor binding or checkpoint is deliberately held for review; this is a remaining manual recovery boundary, not a successful automatic recovery claim.

Independent execution on the final stable recovery code finished **100 passed / 0 failed / 0 skipped** in 14.12 seconds: batch service (50), lifecycle (3), batch runner (41), real-PG recovery (6). Evidence: `focused-2026-09-23T115852917Z.json`. This covers older authorized/sent/unknown revisions, actual advisory-lock contention, unexplained checkpoints, concurrent immutable receipt publication, reservation/binding/send crash points, tampered successor provenance, and the coordinator cleanup interval.

## Outcome gate at QA handoff

All failure classes in the first broad run pass in the final combined run, with original failing evidence preserved. **Final: 2,438 passed / 0 failed / 0 skipped; 142/142 files; 536.04 seconds; exit code 0.** Results of 77, 46 and 100 remain overlapping diagnostic/focused runs and are not added to this total. Backend code was frozen for the final run; no safety assertion was relaxed. The three timing-sensitive PG tests retain their original 20ms product request deadlines and state/no-resend checks within a 5,000ms whole-test runtime budget.

The continuous browser source → hidden dispatch → refresh → QC status/report case has final evidence from the frontend agent, independently reviewed by QA; its explicit pending image QC state is part of the expected result. This completes the declared isolated acceptance gate. Root's final type/build/legacy checks are separate release evidence. Actual Shopee readiness, real enterprise workbook acceptance and the listed manual business/recovery blockers remain outside these fixture results.

Root final verification at 2026-09-23T12:38:12Z: typecheck, TypeScript project build, web build, 7 legacy checks and repository skill validation all passed. Receipt: `.local/internal-acceptance-20260923/final-build.json`. The web build still reports its existing large single-chunk advisory (about262KB gzip); no general page-load or sustained-load claim follows from a successful build. The new reproducible verifier has7 separately passing guard checks; these are not silently added to the combined regression total. No live merge/restart/deployment was performed.
