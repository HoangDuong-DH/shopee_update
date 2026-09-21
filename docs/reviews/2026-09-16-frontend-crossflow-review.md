# Frontend operator flow review — 2026-09-16

Scope: current folder/pending-SKU intake → saved draft/editor → production preparation → registration → hidden execution → explicit per-listing publication. This was a local code review and browser fixture run. No main database changes, Shopee calls, migrations, restarts, or live publication were performed.

## Fixed finding

**P1: an old preparation response could restore a preview after the operator changed its inputs.** While `POST /production-preparations/preview` was waiting, condition, dimensions, per-SKU stock and other choices remained editable. `changed()` removed the displayed preview, but the old response subsequently restored it without checking which choices it represented. The restored snapshot could then be registered. Dimensions and condition were not repeated in the preview table, so the form could show new values while registration used the earlier snapshot.

The regression changed length from 12 to 25 during a held preview response. Before the fix, a stale preview remained visible (expected zero preview panels; observed one). Evidence: `.local/e2e-artifacts/preparation-race-red-20260916/`.

`ProductionPreparation.tsx` now binds preview, recovery and registration responses to a monotonic input generation and a specific request object. Changing a snapshot input cancels the obsolete request, clears its recovery marker and preview, preserves the new form, and tells the operator to check the listings again. Metadata reads also invalidate the snapshot because their results may populate warehouse or brand choices. A late response, error or finalizer cannot overwrite or unlock a later request. Unmount cancels display work while retaining the exact pending request for recovery; loading historical previews deliberately establishes a new displayed snapshot. No server manifest or execution behavior changed.

## Other review results

- Pending rows retain the prepared labels/order and all missing-SKU rows. Continuing requires complete source mapping and saved current batch revision; it leads to content completion, not immediate sending. Server claim/CAS remains the authority for exact source identity and reimport.
- The editor keeps the source binding and listing-ID intent. Existing IDs route to update work; invalid IDs do not offer a new-create CTA.
- Hidden and automatic-publication modes are distinct in preparation and saved jobs. Converted historical work displays the effective policy, while missing legacy mode remains explicitly labelled as automatic.
- Per-listing publication requires `canPublish`, verified non-deferred state, a confirmation bound to the current status fingerprint, and an explicit publish button. Refresh invalidates stale confirmation. No publication request is triggered by hidden execution in the reviewed path.
- Deferred image instructions distinguish continuing hidden execution after accepted weight review from strict read-only comparison → image review → comparison again before publication.

No additional P0/P1 finding was identified in this bounded frontend review. Nonblocking wording issue: `Workspace.tsx`'s collapsed import guide still says “Bước gửi lên Shopee hiện chưa mở”; production sending is now available in its dedicated workflow. That wording was reported to the parent and not edited in this review.

## Verification

- `tests/e2e/production-preparation.spec.ts`: **15/15 passed**, including four new cases: obsolete response after edit, uninterruptible late success, uninterruptible late error, and unmount/recovery while an old component response arrives. All API calls were intercepted fixtures; only local frontend modules were loaded.
- Typecheck and scoped diff whitespace check passed.
- Browser evidence: `.local/e2e-artifacts/preparation-race-final-20260916/`.

These results do not replace the parent's full verification or prove live Shopee publication.

## Delivery follow-up: pending file count

The intake header in `FolderIntake.tsx` counts parsed import records and complete manifests but omits `pendingMapping`. A successfully read folder containing Word, an image and a pending worksheet can therefore show 2/3 files in the header. The per-folder counter already includes the worksheet; its table, saving, restoration and completion gates still work. This is a nonblocking display defect, not a lost worksheet or a claim that missing SKUs are ready.

Reported to the parent during the final bundle review. The parent explicitly deferred this cosmetic correction to preserve the frozen runtime/full verification. No code was changed for it. Separately, the existing-source saved-draft counter was corrected and reviewed in [the portable intake counter report](2026-09-16-portable-intake-counter.md).
