# Independent review — imported update journey

Date: 2026-09-12. Reviewer: `/root/acceptance_redteam`. Scope: Task 2 frontend and Task 3 browser-fixture isolation, against the approved import-patch spec and Task 1 HTTP contract. This reviewer read code and test evidence, inspected generated screenshots, and exchanged findings with the implementers. No implementation/test edits, main-app writes or Shopee requests were made by this reviewer.

**Spec compliance: PASS for the local import → compare → select → save → reopen journey.**

**Code quality: PASS for that scope; no unresolved blocking finding in the final source reviewed.**

This is not approval of a remote patch executor or the full production application. Parent integration verification and protected-data comparison remain separate checks. The existing full-project gates in `2026-09-12-e2e-acceptance-audit.md` still apply.

## What was checked

- `apps/web/src/ImportUpdates.tsx`: actual file upload/import polling, sparse workbook selection, whole Word paragraph selection, image/SKU assignment, per-role ordering, preview invalidation, selected-operation submission, uncertain-save recovery and saved receipts.
- `ImportWorkbookMapping.tsx`, `ImportPatchTable.tsx`, `import-updates.css`: explicit per-block targets, compact review, field-group selection, source labels and narrow-screen behavior.
- Changes to `Workbench.tsx`, `Workspace.tsx`, `api.ts` and existing Workbench browser tests: reachable entry points, saved receipts, navigation guards and preservation of existing advanced controls.
- `tests/e2e/import-patch-server.mts` and `import-updates.spec.ts`: actual HTTP/import-worker/PostgreSQL path, isolation boundaries, response-loss injection, cleanup and the assertions behind the reported results.
- Final Task 2 brief/report and raw browser output under `.local/import-patch-review/`; final source was reviewed after the frontend owner reported that edits had stopped.

## Cross-review findings resolved

1. **Price profile scope.** The initial UI broadcast each workbook block to all selected targets. The final mapping stores its own WorkOrder subset for each block, permits several blocks from one original file and requires explicit shop scope. `makeSelection()` sends `use.workOrderIds` at `ImportUpdates.tsx:438`. The browser test reads a saved receipt and verifies distinct prices for two shops sharing one SKU.

2. **Reusable image roles and independent ordering.** An exclusive role selector and then one shared order were insufficient. The final assignment supports several roles using one original import ID. `roleOrders` is keyed by `[workOrderId, role]`, and the compiler sends separate ordered arrays. The regression demonstrates gallery A/B and description B/A in the actual saved API receipt; the inspected screenshot shows the same order. No duplicate image bytes are required.

3. **Image assignment must not carry an unintended role to another target.** Adding a role to the same target preserves the confirmed SKU. Bulk reassignment to another target now keeps only the newly requested role and clears the old SKU (`ImportUpdates.tsx:587`). The regression first adds gallery to a variant image, then retargets it and confirms that only gallery remains for the second shop. The UI explains that one file is currently mapped to one WorkOrder.

4. **Description layout cannot be invented.** The placement checkbox is available only for explicitly selected Word description paragraphs with images. An image-only change with unknown saved layout stays blocked; it does not gain a generic “after first paragraph” bypass. The happy-path multi-role case provides a Word mapping and explicit placement. The blocked-path case verifies the absent checkbox, disabled operation and disabled zero-operation save.

5. **Bulk selection must preserve the user's field boundary.** `selectVisible()` uses only changed, nonblocked operations in the visible filter and preserves selections outside it. It is disabled after saving or while save outcome is unknown. The 80-price/80-stock test excludes the stock group and inspects the saved selected-operation set to prove that only prices were retained.

6. **A lost save response must not become a new intent.** Before POST, the exact request ID/body is retained in sessionStorage (`ImportUpdates.tsx:484`). Network/invalid-response/server uncertainty preserves that request and disables scope/operation changes. Reload recovery sends it again. The browser test lets the real server handle the POST and then drops its response; it does not fake a successful receipt. Historical exact replay and alias handling are additionally covered by the separately reviewed Task 1 backend tests.

7. **Fixture cleanup failure must fail verification.** The runner uses a random private schema, and its connection now has schema-only `search_path` (`import-patch-server.mts:25`). A failed cleanup or premature helper exit could previously be ignored by the browser test's exit handler. The final lifecycle check rejects nonzero exit, signal, early exit or cleanup timeout. It no longer interprets every helper exit as a successful cleanup.

## Evidence and its limits

The frontend owner's final report and raw output record **24/24 browser tests passed in 1.2 minutes**. These comprise **13 new tests through the actual isolated API/import worker/PostgreSQL** and **11 existing Workbench fixture tests**. This reviewer read the output and test implementations rather than redundantly rerunning the suite. The report also records successful full typecheck after the final changes. The parent will separately run aggregate verification.

The 13 real local browser cases cover:

| Behavior | Concrete assertion |
| --- | --- |
| Price-only workbook | No complete listing requirement or per-SKU number input; unchanged row omitted; selected subset survives save/reload. |
| Uncertain local save | Response lost after the actual server request; controls lock; reload recovers the saved proposal. |
| 80 SKU review | Compact table, deselection and saved receipt retain exactly 79 chosen rows. |
| 80 prices plus 80 stock values | Filter-group selection saves the 80 prices and no stock operations. |
| Stock zero versus blank | Explicit zero becomes an operation; the blank row does not reset stock. |
| Cover only | One cover operation at 390px; no Word/Excel/gallery requirement or page overflow. |
| Word only | Original paragraphs and whitespace retained without a complete listing import. |
| Gallery group | Group assignment and explicit order survive saving. |
| Two shops and price profiles | Same SKU receives the selected profile's price for each explicit target. |
| Image reused across roles | One upload supports gallery and description with explicit Word layout. |
| Unknown description layout | Block remains visible and cannot be selected/saved. |
| Variant image role and retarget | Same-target SKU retained; different target does not inherit old roles/SKU. |
| Independent image order | Same originals are saved as gallery A/B and description B/A. |

Screenshots inspected directly: `cover-preview-mobile.png`, `80-sku-preview-desktop.png`, and `independent-media-orders-saved.png` under `.local/import-patch-review/`. They show source-based labels, compact review and the saved/proposed status. This is inspection of generated evidence, not a manual browser walkthrough by this reviewer.

The fixture validates a local DB host on port 5442, creates separate schema and blob directory, seeds only synthetic connections without credentials, runs only the import worker, and rejects fetch destinations outside localhost. Cleanup validates both generated schema name and resolved blob-directory boundary before removing them. There is no public-schema fallback. No Shopee transport is used by this journey. This is code and normal-test evidence of isolation; it is not fault-injection proof for every process-termination scenario.

## Claims that remain out of scope

- A saved receipt means **prepared locally**, not sent, applied, read back or accepted by Shopee. The UI consistently labels the old side as the saved source, not a current remote snapshot. Production-associated synthetic fixture targets test scope only; they are not real shop connections.
- The 80-SKU browser case is one synthetic listing with 80 SKU rows. It is not 80 published products, a throughput benchmark, or an extension of the earlier real sandbox 76/80 result.
- Directory intake is wired, but these browser cases exercise multi-file upload rather than 80 folders of company material. Many files are received sequentially. No daily capacity claim follows.
- A Word/image currently maps to one WorkOrder. Cross-shop reuse of a single file, reusable mapping of a new day's imports and richer folder identity remain future work. Some mapping controls show only the filename, so repeated basenames in dense folders deserve a later usability check.
- Unsaved mapping work is guarded by navigation warnings but is not fully autosaved. The sessionStorage guarantee applies to an uncertain save request within its browser session; it is not durable remote-job recovery across every device or tab closure.
- The current field contract does not establish category attributes, shipping, taxonomy/variation restructuring, promotion execution or arbitrary Excel column configuration. Unsupported cases must remain exceptions.
- Remote item/model identity, selective remote execution and readback, the applied stock-command ledger, token refresh, policy/QC, Lamy unknown-cover recovery, worker 24h operation, backup/restore and a separately authorized production pilot still block full production acceptance.

No cosmetic or general feature expansion is required to accept this bounded local journey. Complete the parent's aggregate verification and protected-data comparison, then deliver it with the above limits intact.
