# Independent review — preparation metadata and source authorization

Reviewed on 16/09/2026 after seller-knowledge acceptance. Scope: `production-preparation-metadata.ts`, `production-draft-source.ts`, `production-preparation-service.ts` and their three corresponding unit/integration test files. This review did not run a production preparation, change the main database or call Shopee.

No new blocking defect was found in the reviewed changes:

- Repeated brand IDs are combined only when normalized ID, original name and display label match exactly. Differences in either name still fail. Repeated rows within or across pages retain anomaly entries with the page offset, and raw API receipts remain available. Distinct IDs with the same brand name remain distinct choices. Pagination still uses the returned opaque numeric offset and the existing finite page limit.
- `existingListingAuthorization` is optional, strict and per listing. A valid declaration survives in the input snapshot, source fingerprint, preview and that listing's manifest entry; it is not copied to siblings in the same or another group. Invalid reasons, blank references and extra scope fields are rejected. No declaration is inferred when absent.
- A saved invalid effective category/brand ID fails before producing a ready document, including when the value came from the canonical source rather than a new operating choice.

The authorization reference remains an operator declaration, not a service that resolves and enforces an external receipt allowlist. The concrete ten-listing assembly must therefore bind the user's confirmation to those selected source identities/revisions. The reviewed change preserves the existing trusted-source waiver semantics; it does not establish a general authorization system or authorize replay of prior operations. Existing manifest hashes, source revision checks, capability checks and operation journals remain in place.

Independent verification: **73/73 tests passed** at 10:34 UTC+7: 38 preparation metadata unit tests, 26 draft-source unit tests and 9 preparation PostgreSQL integration tests. The integration tests use isolated schemas. Evidence: `.local/attribute-research-20260916/preparation-independent-review-tests.json` and its `.log` file. The implementation agent separately reported a successful typecheck.

A separate read-through of the private offline assembler/local importer found only local source import/save routes, source-byte hash checks and lost-response recovery through saved receipts and source selection comparison. The importer now also rejects duplicate source keys/product keys before saving. It was not executed by this reviewer; live importing and the ten new listings require their own outcome evidence.
