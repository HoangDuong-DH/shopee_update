# Final independent review — import-patch preparation

Date: 2026-09-12. Reviewer: `/root/acceptance_redteam`. Reviewed Task 1 and Task 2 briefs, the approved spec, final diff packages, actual implementation and final implementer reports. No implementation/test edits or Shopee requests by this reviewer.

**Spec compliance: PASS for the local imported update journey.**

**Code quality: PASS for that scope. No unresolved blocking finding remains in the reviewed changes.**

Accepted scope: upload original Excel/Word/images → select explicit listing/shop/source scope → server-derived sparse patch → compare against the saved local source → select operations → save an immutable prepared receipt → reopen/recover that receipt. This verdict does not accept a remote executor, production release or the entire application.

## Findings closed through independent cross-review

| Risk found | Final behavior and evidence |
| --- | --- |
| Price/stock parser silently lost rows or broadcast stock across profiles | Missing SKU, ambiguous profile/range, unsupported columns and malformed values remain explicit issues; stock 0 is preserved and blanks keep existing values. Final backend parser/integration regressions cover these cases. |
| Imported source was not fully pinned to the supplied manifest/bytes | Manifest membership and duplicate-path validation; hash/size checks on original bytes; fresh compilation and revision checks at save; no Product/WorkOrder mutation. |
| One Excel block accidentally applied to every selected shop | Each block has an explicit WorkOrder subset. Browser receipt proves distinct profile prices for two shops sharing one SKU. |
| An image had one exclusive role or one shared order | Same original supports several roles; order is independent per target and role. Browser receipt and screenshot demonstrate gallery A/B with description B/A. |
| Bulk image reassignment carried unwanted fields to the next shop | Same-target role addition preserves SKU; different-target reassignment takes only the new role and clears old SKU. Regression inspects the resulting target and sole remaining gallery operation. |
| Existing description was implicitly restructured | New Word placement needs explicit selection; image-only unknown layout remains blocked and cannot be saved. |
| Field filtering still required per-SKU clicking or changed other selections | Group controls act only on valid visible operations and preserve selections outside the filter. The 80-price/80-stock receipt contains only the 80 selected prices. |
| Lost save response could lead to a new local intent | Exact request is retained before POST, protected while uncertain, and reused after reload. Backend alias/semantic replay and browser response-loss recovery are covered separately. |
| Browser fixture could use public-schema fallback or ignore cleanup errors | Schema-only search path, separate blob root, no seeded credentials, outbound guard, validated cleanup boundaries; premature/abnormal helper exit and cleanup timeout now fail the suite. |

## Verification provenance

- Task 1: this reviewer independently ran the then-current parser + PostgreSQL/service/HTTP suite: 25/25. The final implementer report records 28/28 plus typecheck after the last regressions; those final cases and code were read rather than redundantly rerun. These overlapping counts are not added.
- Task 2 final report and raw output: **24/24 browser tests passed**, consisting of **13 actual local API/import-worker/BlobStore/PostgreSQL tests** and **11 Workbench compatibility fixtures**. This reviewer read the raw output, assertions and final diff, and inspected mobile-cover, 80-SKU and independent-image-order screenshots. These are not Shopee API execution tests.
- Parent aggregate `verify.mjs`, full browser suite and protected-data comparisons are separate, still in progress at the time of this review. This document does not claim their result.

Detailed review records: [backend review](2026-09-12-import-patch-backend-review.md), [UI and fixture review](2026-09-12-import-patch-ui-review.md), [full-project acceptance audit](2026-09-12-e2e-acceptance-audit.md).

## Limits that must remain visible at delivery

1. Receipts are **prepared locally**. Before-values are the saved source; no current Shopee snapshot is claimed. There is no patch send/readback/QC in this slice, and prior unknown sandbox states are not cleared by saving a proposal.
2. The 80-SKU UI case is not 80 products published or a throughput benchmark. The earlier sandbox create result remains 76 successful readbacks out of 80 technical sources, with four unresolved business errors; this work does not change that result.
3. Each Word/image currently maps to one WorkOrder. Reusing mappings on a new day's inputs, direct file reuse across shops, arbitrary column mapping, whole-draft autosave and representative 80-folder intake are not established. These are follow-up scope, not reasons to redesign this verified slice again.
4. Remote item/model binding, the selective executor and durable stock applied ledger, live token refresh, dynamic category/policy/QC, Lamy unknown-cover recovery, 24-hour worker operation, backup/restore and an authorized production pilot still block full production acceptance.

The scoped change can proceed to parent integration verification. It must not be presented as completion of every bulk listing operation or as production-ready E2E Shopee automation.

## Parent integration addendum

Recorded by `/root` after the independent review: fresh `verify.mjs` passed typecheck, both builds, 7 legacy and 361 unit/integration tests. The separate full browser run passed 56/56 in 2.6 minutes. At 10:20:27 UTC, complete products/workbench responses still matched the pre-change baseline, Lamy remained revision 1, the main app had zero test patch receipts, production writes stayed disabled, worker was online and UI returned HTTP 200. Evidence is consolidated in [delivery](../delivery/2026-09-12-import-patch-workflow.md). No implementation changes followed these runs; documentation updates do not widen the scoped verdict.
