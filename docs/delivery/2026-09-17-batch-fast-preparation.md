# Batch intake and fast hidden preparation — 17 September

Latest operator direction: do not execute production uploads; finish backend and let the operator use the UI. Hidden listings prioritize exact source images, text, variants, SKU and original price; optional category details are completed by human QC on the same Shopee link.

## Delivered

- Bulk-save intake for manifest-backed ready sources, with canonical keys, revision checks, durable pending recovery and exact-payload readback. Existing drafts are reused, not overwritten or duplicated.
- `POST /v1/production-preparations/autofill`: scoped source/price/own-shop evidence plus live category, brand, warehouse and shipping metadata. Per-request import/metadata deduplication. User edits win over suggestions.
- `attributeMode=minimum_required`: skip optional attribute enrichment; `source_supported` remains available and omission retains compatibility. No arbitrary brand, origin, manufacturer or safety claims are introduced.
- UI selects a whole intake group and fills it in one action. Default is hidden with image QC deferred. Knowledge detail reads mount only in the optional enrichment mode. Concurrent identical metadata and pricebook reads are shared.
- Registration reads each unique imported pricebook once instead of once per SKU, retaining per-proof hashes and scoped locks.
- Filename ranking uses longest contiguous normalized match plus product identity checks. It supplies candidate hints, never silently changes confirmed source membership or prices.
- Batch status exposes the actual earlier work holding the shop lane and distinguishes a zero-step reservation from an uncertain remote write.

## Local data and actual execution boundary

43 current D-drive manifests were imported and read back as saved drafts (1,699 variant positions). Sources 735 and 762 remain held. One preparation `f014536b-1cf8-4932-83a0-8379ddf78dba` registered 26 ready entries and 17 category-blocked entries. Later category recognition improvements are not retroactive edits of that immutable preparation.

Before the user stopped execution, its first run stopped with `PRODUCTION_PILOT_SHOP_BUSY`. New operation `efe0787c-ff62-43a5-a00e-f3744b838731` has no item and zero dispatched steps. No new listing was created by this attempt. Do not auto-resume it.

The prior lane belongs to the Hương Thảo item `45417908562`, operation `cf87c395-4095-4f3e-b3bc-50012b33ec79`, batch `16fdf40c-334a-42e9-8542-4ec1b8ab4e2c`. It has 13 acknowledged steps but lacks the required final reconciliation receipt. Its existing hidden/deferred policy must be honored; never delete the lane manually or recreate the listing.

Connection credentials were refreshed to revision 6 through encrypted receipts. No secrets are included in this report. Local execution journal and import proof are in `.local/bulk-autofill-20260917/`.

## Verification scope

Focused tests cover batch-save recovery, source evidence, attribute modes, price import caching, filename candidates, metadata request sharing, and no-dispatch retry classification. Typecheck/build passed during integration. Browser observation confirmed selection of six saved listings together and the enabled “Điền nhanh cả lô · 6 listing” button; no upload was triggered during that observation. These checks do not constitute a completed production publication test.

See [operator steps](../operator-guides/2026-09-17-dang-an-theo-lo.md). Runtime deployment and any additional no-dispatch authorization renewal are recorded below when completed.

## No-dispatch authorization renewal

Migration 033 adds immutable, append-only preflight renewal receipts. It has been applied locally. A reservation with no item, no steps and no result receipts may be refreshed only after a fresh plan, assets, capability evidence, connection, original source and expected projection agree. The original operation and source fingerprint remain intact. Dispatch pins the exact renewal receipt and its current deadline under the owner lock. A busy foreign lane is now checked before inserting a new reservation.

Seven affected integration cases passed (three renewal/lane cases and four updated earlier expectations), plus typecheck. The first broader run exposed fixture clock and changed prepare-time rejection expectations; those were corrected without relaxing runtime guards. Batch service/runner tests also covered the no-dispatch classification and read-only boundaries. An interrupted request with no result remains held for reconciliation; this change does not authorize replaying an unknown write.

The operator remains responsible for pressing run. The current preparation is paused with zero acknowledged steps and no new item IDs. No execution is automatically resumed by deployment.

Final deployment: API PID 75932, health ready at 17:20 UTC+7. The current reservation now reports `authorized_not_started`; `blockingWork` identifies Hương Thảo and its original batch for operator navigation. Coordinator renewal retry test passed, and the final TypeScript build passed after adding the explicit non-null guard. Frontend build passed. Final read-only runtime proof: `.local/bulk-autofill-20260917/final-local-status.json`. No further production run or reconciliation was triggered after the operator's stop instruction.
