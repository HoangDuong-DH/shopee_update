# Backend audit: imported changes and durable work — 12/09/2026

## Conclusion

The repository has useful source persistence, immutable revisions, CAS, and two narrowly bounded sandbox execution paths. It does **not** currently implement the user's main update workflow: import a newer Excel/Word/media batch, resolve its targets, calculate a sparse patch, save it, execute each selected field, and recover partial outcomes. Changing the frontend labels alone cannot close this gap.

This is a read-only code/document audit. No API requests, tokens, source edits, jobs, or Shopee writes were made. No tests were run during this audit; test names below identify existing coverage and proposed acceptance cases. The actual sandbox result remains **76 verified / 80 technical sources**, with four rejected creates. That result is not business-source update acceptance.

## Top three findings

### 1. The input model is a full listing, not an imported change

`CatalogRow` has original price and promotion target but no sellable-stock fact (`packages/domain/src/contracts.ts:179`). `readKini` recognizes no stock field (`packages/domain/src/source/kini.ts:20`), detects a block only with SKU and product-name headers (`:82`), and treats missing original price as a blocking issue (`:215`). This is appropriate for the existing catalog lookup but unsuitable for `SKU + TỒN` or `SKU + GIÁ GỐC` updates.

The product assembler requires title, headline, body, gallery, description-image arrays, tiers and variants (`apps/api/src/product-service.ts:13`). It constructs a complete draft, including empty attribute/logistics objects (`:81`). Running a cover-only or price-only import through it would require unrelated source data and could accidentally replace source fields if reused as a merge operation.

`WorkOrderConfig` carries a full source revision plus a field mask and a stock map (`packages/domain/src/workbench.ts:12`); the `DraftField` union does not include a distinct cover or variant-image field (`packages/domain/src/contracts.ts:61`). The source has a distinct cover, but the operation mask does not. This is a concrete contract gap behind the repeated UX mismatch.

**Fix:** introduce a sparse imported-change contract separate from `ListingDraft`. Omitted input emits no operation. Do not regenerate or overwrite the complete source merely to update a subset of fields.

### 2. File deduplication is not command deduplication, especially for stock

`source_files` uniqueness and `createImport` deduplicate `(sha256, kind)` (`packages/persistence/migrations/001_foundation.sql:5`; `packages/persistence/src/repository.ts:60`). This prevents storing the same bytes twice, not repeating a business instruction when Excel is saved under another filename or saved again with different archive metadata.

`InputLibraryRepository` preserves group/product identity within an input batch, but rejects claiming an existing product from a new batch (`packages/persistence/src/input-library.ts:204`). It does not implement “this new folder updates that existing listing.” The corresponding integration test deliberately verifies this rejection (`tests/integration/input-library.test.ts:284`).

`shouldApplyStock` exists and has a unit test (`packages/domain/src/plans.ts:34`; `tests/unit/plans.test.ts:27`), but code search finds no production call site. The `stock_instructions` table has accepted command identity, not an applied per-target execution receipt. `/plans` currently creates `stocks: []` and always adds `EXECUTOR_NOT_RELEASED` (`apps/api/src/app.ts:396`). WorkOrder's stock map has neither imported-cell provenance nor durable applied-command state.

**Risk once execution is added:** stock imported as 100, later reduced to 98 by orders, must not be set back to 100 because the same workbook was reimported or saved again. Comparing only desired value against a fresh shop read would wrongly propose replenishment.

**Fix:** distinguish content identity, semantic instruction identity, and a deliberately renewed command. Recognize identical normalized instructions across different file hashes. Replay defaults to the previous receipt/no new write. A deliberate “set stock again” creates a new instruction generation. Do not permanently prohibit the same numeric value: a later explicit request to set 100 again is valid. Saving a proposal is not proof the stock command was applied.

### 3. Execution and results are not yet a general multi-field job

`WorkbenchService` explicitly supports only title, description and gallery for one previously authorized Lamy item; all other update fields are unsupported, and business create is blocked (`apps/api/src/workbench-service.ts:178`, `:189`, `:208`). Production stays read-only. `SandboxField` likewise contains only these three fields (`packages/domain/src/sandbox-listing.ts:2`).

The worker consumes source imports and synthetic sandbox-create trials only (`apps/worker/src/main.ts:26`); the general `jobs`/outbox store is not connected to a listing update executor. The sandbox update service runs its single `update_item` mutation within the API path (`apps/api/src/sandbox-listing-service.ts:866`). Its durable run has one overall result and two aggregated booleans, not independent price/stock/cover/model outcomes (`packages/domain/src/sandbox-listing.ts:71`, `:102`).

**Fix:** reuse the persisted intent/checkpoint/lease patterns, but add operation-level execution receipts keyed by exact target and field. A cover success plus a blocked model price must remain partial. A successful API response is not a substitute for readback. Do not broaden the synthetic trial allowlist or dispatch these new proposals through it.

## What is already implemented and worth retaining

| Concern | Implemented evidence | Limit |
| --- | --- | --- |
| Original bytes and provenance | SHA-addressed upload, typed import worker, source locators; `apps/api/src/app.ts:283`, `apps/worker/src/imports.ts:3`, `packages/domain/src/contracts.ts:5` | Patch-specific cell presence/errors and media-to-target mappings still needed |
| Source revisions | `Repository.saveProduct`, advisory lock, expected revision, immutable DB rows; `packages/persistence/src/repository.ts:94` | Whole-draft changes; membership is locked, not an explicit SKU-structure change workflow |
| Input batch reload | Versioned batch state, source refs and path/hash validation; `packages/persistence/src/input-library.ts:110`, `:160` | Existing-product update binding across batches is missing |
| WorkOrder concurrency | CAS with identical retry receipts, exact target uniqueness, invalidation of prepared runs; `packages/persistence/src/work-orders.ts:82` | Unique target is reusable work identity, not a new order for every imported file |
| Target protection | Explicit connection/item and exact local-vs-remote SKU/tier checks; `apps/api/src/sandbox-listing-service.ts:106`, `:295` | Bounded Lamy path; no general persisted source/shop/item/model binding registry |
| Drift checks | Baseline check at prepare, before upload and immediately before write; `apps/api/src/sandbox-listing-service.ts:473`, `:728`, `:820` | These are application checks, not an atomic Shopee compare-and-swap |
| Ambiguous write recovery | Immutable intent, active-target lock, read-only reconcile; `packages/persistence/migrations/006_sandbox_listing_runs.sql:15`; `apps/api/src/sandbox-listing-service.ts:916` | Does not settle the still-unknown Lamy cover; no universal retry/rollback guarantee |
| Per-item create recovery | Trial leases and intent-before-send; `packages/persistence/src/sandbox-create-trials.ts:292`, `:379` | Technical fixtures only, separate from business WorkOrders |
| Local atomic submit | Plans, stock-command record, job and outbox commit together; `packages/persistence/src/repository.ts:158` | Local DB transaction does not make multiple remote writes atomic |

## Proposed highest-value implementation slice

Deliver **import additional sources → scoped sparse patch preview → save and reopen prepared work** for Excel price/stock and Word/media. This is a usable preparation workflow that removes repetitive data entry. It must be labeled as preparation against saved source, not actual shop readback or completed publishing.

Keep the current draft/source immutable. Attach a patch overlay and its source references to the existing work target. Do not require a full Word/gallery/SKU package for a price-only or cover-only update. Do not write Shopee while constructing or saving this slice.

### Suggested contract

```ts
type PatchTarget = {
  productKey: string;
  sourceRevision: number;
  workOrderId: string;
  workOrderRevision: number;
  connectionId: string;
  itemId: string | null;
  // modelId/locationId remain unknown until an actual binding/read is verified.
  sku?: string;
};

type ImportedOperation = {
  id: string;
  target: PatchTarget;
  field: 'title' | 'description' | 'cover' | 'gallery'
    | 'variantImage' | 'price' | 'stock';
  action: 'set' | 'replace';
  value: unknown; // Implement with a discriminated field/value union.
  sources: SourceRef[];
  sourceBefore: unknown;
  comparisonBasis: 'saved_source';
  remoteBefore: null;
  status: 'changed' | 'unchanged' | 'needs_mapping' | 'blocked';
  semanticKey: string;
};

type ImportedPatchBatch = {
  id: string;
  revision: number;
  importRefs: { id: string; sha256: string; relativePath?: string }[];
  bindings: PatchTarget[];
  operations: ImportedOperation[];
  issues: Issue[];
  executionState: 'not_submitted';
};
```

This is a proposed interface, not code already implemented. Array fields must have explicit ordered replacement semantics. Removing a missing source file must not generate deletion. The first slice can reject clear/delete operations explicitly rather than pretending to support them. A semantic price operation is `originalPrice`; `GIÁ BÁN` remains a separate promotion target and must never be converted into an original-price patch automatically.

### Service and persistence boundaries

1. Reuse `/imports` and BlobStore for immutable files. Add a separate sparse workbook parser reading the original bytes. Reuse strict money/header helpers, not `readKini`'s full-catalog requirements. Do not overwrite the original catalog parse to fit the patch use case.
2. Resolve each imported row/folder within explicit existing source and shop targets. Use confirmed mappings where available. Duplicate SKU, multiple matching listings, unknown role, formula error, missing formula cache and unrecognized selected columns remain visible exceptions. SKU alone is not a global unique key.
3. Compile operations only from present, valid source values. Blank cell/file absence means keep. Numeric zero stock means set zero. A formula/error cell is not blank. Word parsing must preserve source text, paragraph spacing and established image placement. Description text-only changes must not silently remove existing description images; either merge via the established layout or require explicit complete-description replacement.
4. Compute the preview from pinned `sourceRevision` and WorkOrder configuration. Show “Bản nguồn đã lưu”, never “Trên shop” unless a separately recorded remote observation exists. Stock's prior local instruction may also be unknown; do not substitute zero.
5. Save immutable patch revision and linkage/receipt in one DB transaction, with CAS over referenced source/work configuration. Suggested migration 009 adds patch batches, immutable revisions, operation/source records and save receipts. Existing `work_orders.target_key` is unique, so associate with the existing target rather than insert a new WorkOrder per batch.
6. Return the durable record and reopen it after refresh. Updating the source or WorkOrder after preview invalidates that preview. Network retry returns the same receipt. An earlier receipt must not overwrite a newer choice.
7. Keep `executionState: not_submitted`. The next slice is a separate executor with actual shop baseline, current capability checks, exact item/model identity, per-operation intent and receipts. Do not infer capabilities from the existence of a field in the UI.

### Mandatory distinction for dedupe

- **Content hash:** identical bytes; safe to reuse local file storage/media upload where scope permits.
- **Semantic match:** same normalized target/field/value regardless of filename, row order or Excel Save As metadata; show the previously prepared/applied instruction instead of silently creating a new one.
- **New intent:** explicit operator choice to perform the same value again, with a new command generation and source/version audit.
- **Applied receipt:** only recorded after execution evidence; a prepared-patch receipt cannot prove no future stock replenishment bug.

Do not include volatile timestamps or source-file hashes in a semantic identity that is meant to survive harmless reimports. Do include shop/item/source binding, SKU and stock location if applicable. Do not deduplicate across different shops. Do not treat a gallery reordered deliberately as the same operation.

## Acceptance cases for this slice

| Case | Expected outcome | Existing test area to extend |
| --- | --- | --- |
| Excel has SKU + price only, no name/Word/media | Price operations only; other fields untouched | New sparse-parser unit tests; `tests/integration/input-library.test.ts` |
| Excel has SKU + stock; blank, zero and malformed formula | Blank keeps; zero is set; formula error blocks affected cell with locator | New sparse-parser tests |
| Same SKU across two shops | Exact chosen scope only; ambiguous target not guessed | `tests/integration/workbench.test.ts` |
| Same SKU appears twice with conflicting values | Conflict, not last-row-wins | New patch compiler tests |
| Reimport same bytes / renamed file / Save As same values | Reuse or flag same instruction, no extra work intent | Patch persistence integration |
| Same value requested intentionally again | New explicit command generation, separate receipt | Patch persistence integration, future stock executor |
| Cover-only folder | One cover operation; no Word/gallery requirement | New patch compiler and browser flow |
| Only new description Word | Source spacing preserved; existing description-image handling explicit | `tests/unit/source.test.ts`, browser patch preview |
| Two galleries, one explicitly reordered | Correct per-listing order retained; no cross-folder merge | Patch compiler tests |
| Unknown image role / duplicate filename in different folders | Persist exception or correct explicit mapping; no blind role assignment | `tests/unit/folder-source.test.ts`, patch compiler |
| Source/work changed after preview | Save rejected as stale; no partial linked records | `tests/integration/workbench.test.ts` |
| Two identical save requests / timeout after commit | One receipt; latest work remains latest | Patch persistence integration |
| Restart and reopen prepared batch | Same source references, operations, target and chosen scope | Browser E2E with Postgres-backed reload |
| UI attempts submit/write | No write endpoint dispatched; status prepared, not succeeded | HTTP/browser assertions with zero Shopee calls |

Future executor acceptance must add: mixed model success/failure, lost write response, readback mismatch, stock consumed between write and readback, stale worker lease, cancellation after intent, partial image reuse, and a blocked field while independent fields succeeded. A row or batch cannot turn green if required operations are blocked or unknown.

## Shopee evidence boundary

Read the local Open Platform and Seller University agent guides and complete `update_price` / `update_stock` API documents from the 08/09/2026 snapshot. This audit does not claim those snapshots establish current app/shop capability.

- [update_price](https://open.shopee.com/documents/v2/v2.product.update_price?module=89&type=1): the snapshot has a single item target, model-level price entries and success/failure lists. Source update date absent. This supports field/model receipts rather than one batch-success flag.
- [update_stock](https://open.shopee.com/documents/v2/v2.product.update_stock?module=89&type=1): snapshot source update 31/10/2022, collected 08/09/2026; seller-stock/location payload and model success/failure outcomes differ from a generic stock number. Reserved stock, location structure and promotion conditions must be checked before execution. Some listed `error_auth` meanings are business constraints, so do not classify every such code as an expired token.

The preparation slice does not need a new live Shopee request. Opening price/stock execution requires fresh official documentation/capability evidence for the intended environment, endpoint-specific interpretation and sandbox acceptance. Preserve existing production read-only controls and the unresolved Lamy run.

## Cross-agent challenge incorporated

The UX reviewer challenged full-listing requirements on sparse updates and required import-first screens with only exceptions handled manually. The acceptance reviewer challenged file-hash-only dedupe, partial model outcomes and stock `error_auth` classification. These points agree with the source evidence above and are reflected in the proposed contract and tests. The parent agent was informed that a saved-source preview must not be labeled remote readback and that current WorkOrders do not execute stock.
