# Batch recovery and source-local holds

This checkpoint describes the isolated `codex/internal-operations` worktree on 2026-09-23. It is not a deployment receipt or proof of live Shopee acceptance.

## Source-local preflight failures

The runner can continue independent sibling sources when a selected attribute or brand is invalid, a mandatory attribute is missing, or an existing item/SKU blocks this particular new source. The narrow error whitelist is `sourcePreflightFailure` in `production-batch-block.ts`.

Continuation requires all of these facts: the failure occurred in read-only collection before `prepare`; this source had no operation; a second scoped journal lookup still finds no operation; and the immutable manifest and execution policy are unchanged. The persisted result carries `failureScope: source_preflight`. Missing metadata, incomplete inventory, authentication, transport errors, and an existing operation do not acquire this classification. A `CATEGORY_UNVERIFIED` error is deliberately excluded because its current collector contract combines a bad source category with malformed/missing category responses.

A source save/archive winning the source lock after the first revision check holds only that unsent source. The runner checks the journal again and never replaces the registered document with the new revision. Existing reservations continue to require explicit review.

The parent may continue later child groups only when their unresolved conditions are positively local. One local failure cannot hide a later shared failure in the same child result. Unknown/sent/rejected journal states and held write lanes remain blockers.

## Verification and recovery boundary

Focused fixtures cover real coordinator invocation, a valid sibling reaching creation after a local preflight error, no creation on shared errors, a source edit/archive during lock acquisition, changed manifests, uncertain writes, and deferred-QC recovery receipts. PostgreSQL integration on the isolated 5443 database verifies two separate coordinators contend on the same advisory lock, refresh observes the running job, and reopening a completed job does not dispatch it again.

Status listing rows now include the registered `sourceRevision`; `currentRevision`, when available, is a separate field. Operators must compare these rather than assume the newest source has replaced the registered version.

A process loss after the durable claim but before reservation can now be recovered by explicit read-only reconciliation using the version 3 proof described below. Requests with a reservation, an unexplained checkpoint or possible dispatch remain blocked until their journal can be reconciled. Never remove claims to bypass this distinction.

No connection/login code was changed, no live database or Shopee writes were performed, and no runtime was restarted for this checkpoint.

## Source comparison and early stale-source feedback

`ProductionPreparationService.sourceChanges(id)` reads the scope-checked preparation and local product revisions only. Its response is `{preparationId, scope, entries}`; each entry has `productKey`, `title`, `sourceRevision`, nullable `currentRevision`, `state` (`current`, `changed`, `missing`, `archived`), `changedFields`, and `changes: [{field,label,before,after}]`. The ready entry's immutable `sourceSnapshot.draft` supplies the old side. A blocked entry without a snapshot uses the exact historical revision when available; a missing historical revision produces no invented field changes.

The value comparison covers content, ordered images, variants/SKU, prices and price-source selection, category/brand, attributes and logistics. Fact observation timestamps, issue messages and server audit receipts are not product differences. A revision change still marks the entry changed even when visible values stayed the same. The operation never rewrites a manifest or reassigns a source.

Before claiming a parent execution, the coordinator reads these local states while holding its existing coordinator lock. If all remaining unreserved sources are stale and no existing unfinished operation needs recovery, it rejects with `PREPARATION_SOURCE_CHANGED`. A current independent sibling remains eligible; already reserved uncertain work continues through journal checks rather than becoming a new create. Per-source locks and revision guards at dispatch remain necessary because this early check is advisory against subsequent source edits.

Focused additions: 2 source-diff tests (ordered images/SKU/price, scope rejection, immutable snapshot, historical fallback, missing and archived source); 19 preparation integration tests on isolated PostgreSQL including stale-only rejection without a persisted claim and partial-stale continuation. Type checking passes. A separate acceptance owner verifies the manual intake workflow and route/UI integration.

## Recovery before reservation: version 3 and its successor

The version 3 recovery event binds the original immutable request hashes, the registered manifest, exact scope and source identity/revision/document SHA, and the successful read-only reconciliation result. It is emitted only while holding the batch coordinator lease plus archive/shared, sorted product locks and the same journal owner transaction lock used by operation authorization. Every source revision is inspected with its step/publication history; any existing operation or unexplained checkpoint excludes that source from the negative proof. Mixed batches still require valid positive/deferred proofs for their other affected sources.

The next explicit execute claim references the recovery event's SHA. Immediately after new operation reservation, before checkpoint creation or any API write, the runner persists a successor binding containing the claim hash, recovery references, source and operation ID/fingerprint. Subsequent reads verify that association rather than incorrectly asking the historical empty-journal observation to remain empty forever. A later unbound operation is separately held for review; it cannot erase the historical recovery or silently grant another create.

Recovery and successor files are written into private temporary files, synced, then atomically published by a same-directory hard link that cannot replace an existing file. The temporary name is removed afterwards. This was exercised on the local Windows filesystem, including concurrent publication with exactly one winner. This is process-crash handling, not a guarantee against hardware/storage loss; keep verified backups of both database and private receipt files.

The remaining narrow limitation is a crash after reservation but before successor binding/checkpoint: it remains blocked rather than inferring that the reservation is safe to send. Sent/unknown outcomes always require their ordinary journal readback. An existing reservation is never accepted as negative evidence merely because it has no item ID.

The coordinator now retains its per-batch lease through final cleanup and status stays busy until release, even if a result file already exists. This closes the premature-enabled-button window where a second click received `IN_PROGRESS`.

Latest focused verification: **100/100 passed** across runner (41), batch service (50), lifecycle (3) and PostgreSQL recovery (6); typecheck passed. This includes pre-reservation recovery, restart before successor, successor completion, crash before binding, sent successor, tampered binding, old-revision journal history, checkpoint contradiction, real owner/source lock contention and atomic file publication. No production/API writes were used.
