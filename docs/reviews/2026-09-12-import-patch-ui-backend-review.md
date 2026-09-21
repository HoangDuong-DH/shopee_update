# Task 2 — independent UI/API contract review

Reviewer: `patch_backend_audit`; 12 September 2026. This is a read-only cross-review of the frontend against the implemented Task 1 contract. No application code was changed, no reported tests were rerun, and no Shopee calls were made during this review.

Status: **PASS for the scoped import → preview → selected local receipt flow**. The two P1 findings and smaller SKU-preservation issue below have been corrected. Filtered group selection, independent image-role ordering and final browser evidence have been checked against the backend contract. No unresolved correctness blocker remains in this review. This is not acceptance of a Shopee patch executor or production deployment.

## Findings raised

### P1 — workbook scope must be selected per block and shop

The initial `makeSelection()` built every selected workbook block with `workOrderIds: selectedTargets`. This silently expressed an instruction to apply one price profile to all selected shops. With the same SKU in Mall and another shop, the backend cannot infer that this broad, explicit selection was unintended. The initial UI also permitted only one block per uploaded file, preventing two price profiles in the same workbook from being assigned independently.

Required correction: each workbook/block keeps its own explicitly selected WorkOrder subset; multiple blocks of one original workbook are allowed. A single preselected target may be the default; multiple targets require an explicit subset or an explicit shop-wide action. Regression evidence must check the real preview/receipt target identity and price for two shops sharing one SKU, not just the visible text.

Source correction reviewed: `apps/web/src/ImportUpdates.tsx:144` persists a list of uses per workbook; `:229` prunes only removed target IDs; `:438` sends `use.workOrderIds` rather than all selected targets. `apps/web/src/ImportWorkbookMapping.tsx:3` exposes multiple blocks, per-target checkboxes and an explicit “Chọn cả shop” action. A block with no selected target is rejected before preview. The reported browser regression checks the real receipt: the same SKU receives 21000 in the first shop and 31000 in the second.

### P1 — one original image can have several listing roles

The initial `Assignment.role` enum was exclusive and assigning a role to a group overwrote the prior role. This prevented the already supplied Lamy material from reusing the same originals in the gallery and extended description. Task 1 already accepts one import ID in both role selections, so duplicate uploading or renaming is unnecessary.

Source correction reviewed: `apps/web/src/ImportUpdates.tsx:28` uses `roles[]`; `:357` independently populates each role using the original import ID. Additive controls and removable role tags are visible in the image selector. The reported browser regression verifies one image upload, two role operations and the same original reference, followed by a real saved receipt.

### P2 — adding an image role must preserve its confirmed SKU

While the multi-role correction was in progress, `applyImageGroup()` still cleared `sku` for every selected image. Adding a gallery/description role to an already mapped variant image in the same WorkOrder therefore lost its confirmed SKU and forced unnecessary remapping. At `apps/web/src/ImportUpdates.tsx:587`, the correction now preserves the old SKU and adds the chosen role when the target is unchanged. On retargeting it clears SKU and carries only the newly selected role, preventing old roles from being transferred unintentionally. The reported browser case covers both behaviours.

### Bulk-selection verification

The initial field filter only changed visibility, leaving a user to uncheck many stock rows individually after importing price and stock together. Root accepted group selection as baseline functionality. At `apps/web/src/ImportUpdates.tsx:620`, `selectableVisibleIds` contains only changed, nonblocked operations. `selectVisible()` unions/removes only those IDs, preserves selections outside the visible group, and rejects use while busy, after saving or while the outcome is unknown. The reported browser case imports 80 price plus 80 stock changes, excludes stock as one group, and verifies that the real receipt selects exactly the 80 price operations.

### Independent ordering and description layout

The final source reviewed stores gallery and description image order separately by `[workOrderId, role]`. At `apps/web/src/ImportUpdates.tsx:558`, `imagesForRole()` retains only currently assigned originals and appends newly selected originals without changing the other role. `makeSelection()` transmits these separate ordered import-ID arrays. The reported browser case verifies the same originals as gallery `[A,B]` and description `[B,A]` in the real saved receipt.

The description-placement checkbox is shown only when a new Word description is selected and images exist. Only that explicit selection sends `images_after_first_paragraph`. An image-only update does not reinterpret an arbitrary existing description using that option; the backend canonical-layout requirement remains authoritative.

## Contract checks with no blocker found

- The normal flow imports bytes through the application API. Excel uses the dedicated sparse workbook endpoint, so a price-only workbook does not depend on the legacy full-catalog parser accepting it. Word and images wait for their import record to become ready.
- User controls choose targets, source blocks, whole Word paragraphs, separators, image roles and ordering. There is no baseline form for fabricating price, stock or description text. Stock `0` is displayed as a concrete value; null and absent values remain distinct.
- Imported fields are compiled by the server; the UI sends the server preview fingerprint and selected operation IDs when saving. A change to input, target or mapping invalidates the preview. The name is taken from the preview selection at save time; it is no longer an editable stale value beside the save button.
- Before sending a local save, the UI stores the exact save ID, selection, preview fingerprint and selected operation IDs in `sessionStorage`. Network, invalid-response and server failures preserve that request. A reload restores it, and the recovery button reuses the same request instead of creating a new ID. The backend resolves exact replays and semantic-save aliases. Scope controls cannot mutate the request while this outcome is unknown.
- Source-file references preserve original relative paths. Duplicate paths are not silently merged by the UI; backend manifest checks reject them. Content selections must refer to imported originals, and the backend verifies their bytes and hashes. A shared original may retain separate legitimate path aliases.
- The table labels its baseline as “Bản nguồn đã lưu” and the new values as “Theo tệp mới”. Saved work is described as local preparation, with explicit text that it has not been sent, read back or accepted by Shopee. There is no patch execution route or execution button in this slice.
- Opening a historical receipt uses its own saved preview and selected operation IDs. It does not rewrite the current Product or WorkOrder. Existing unresolved sandbox runs remain execution blockers rather than being released by saving a proposal.

## Scope that must remain explicit

This review is not production acceptance. The new flow does not execute these patches on Shopee, supply remote before-values, maintain an applied inventory-command ledger, or complete token refresh/QC/recovery for all API fields.

The frontend currently maps each Word/image file to one WorkOrder; reuse of that file across several shops is not yet established by this slice. Relative paths are retained in the manifest and shown in the received-file list, while some later mapping controls display only the filename; dense folders with repeated names could benefit from showing their path there too. This is a nonblocking usability follow-up, not a request to extend this slice. File intake remains sequential; there is no measured throughput claim for a full day of company materials.

The browser fixture was also checked: it runs the real application API/import parser against a private PostgreSQL schema with schema-only `search_path`, a separate blob directory, synthetic connections without credentials, and an outbound network guard. Cleanup checks its generated schema and resolved blob-directory boundary. These fixtures must not be described as Shopee execution tests.

## Final verification

The frontend owner supplied `.local/import-patch-review/task-2-report.md` and `.local/import-patch-review/task-2-browser-test-output.txt`. This reviewer read both, inspected the final relevant source, and viewed the 80-SKU desktop screenshot. No browser suite was rerun by this reviewer.

The final log reports **24/24 passed in 1.2 minutes**: **13 new tests using the real local API/import worker/BlobStore/PostgreSQL** plus **11 existing Workbench compatibility fixtures**. These evidence classes remain separate; fixture tests are not real Shopee calls. Covered regressions include scope by price block/shop, price-only and stock-zero imports, selected subsets, a lost response after real local commit and reload, cover-only on narrow viewports, exact Word text, multiple image roles, separate role orders, unknown description-layout blocking and group selection. The owner's report also records a passing full TypeScript check and successful child-process/schema cleanup.

Root will run fresh aggregate verification separately. This scoped PASS does not replace that verification, production acceptance, or the documented unresolved Shopee execution work.
