# Prepared wire patch boundary review — 14 September 2026

**Final state: planning a gallery 1:1→3:4 transition is blocked again.** The live technical trial changed the actual cover content despite retaining its original ID in the request; it did not merely produce an equivalent ID alias. The failed evidence remains unresolved, and no image-ID equivalence exception was added.

The independent patch matrix initially reproduced three defects: 39 passes and 3 failures across 42 cases. After those fixes, the live failure regression and rollback guard, it has **46/46 passes**. Combined codec, raw QC, independent adversarial and patch-boundary suites have **123/123 passes**. The full TypeScript check passed after correcting the portable saved-fixture path at 13:58 local time. These local passes do not turn the failed live transition into an accepted workflow.

## Reproduced defects and repairs

| Finding | Concrete reproduction | Final behavior |
| --- | --- | --- |
| P1 — incomplete remote model coverage before a variation-image request | The source/bindings contain red-S, red-L and blue-S, while the valid raw 2-tier listing also contains blue-L. The previous planner returned a complete `model_list` omitting the fourth remote SKU. | Image updates require the exact set of all raw model IDs before returning a plan. Duplicate binding SKUs also fail. `PREPARED_WIRE_MODEL_COVERAGE_INCOMPLETE` prevents dispatch; readback QC is not used as a substitute for this pre-write guard. |
| P2 — price preflight ignored existing wholesale constraints | An untiered listing has wholesale `unit_price: 8000`; a selected original-price change to `50000` gives 16%, below the supplied wholesale threshold minimum of 30%. The previous planner returned ready. | Nonempty or malformed wholesale configuration blocks price planning with `PREPARED_WIRE_WHOLESALE_PRICE_UNSUPPORTED`. This is deliberately an explicit unsupported contract, not an implementation of every wholesale rule. Missing threshold metadata cannot bypass it. Empty wholesale remains eligible for the other checks. |
| P2 — planner/QC disagreement on standard variation group IDs | The planner retained the observed `variation_group_id: 42`, but raw QC rejected that documented request field even when readback retained it. | QC accepts and preserves the exact observed group ID. Altered or omitted group IDs do not verify. |

The model-coverage consequence is grounded in the variant-management guide: updating options uses `model_list` to retain existing model identities, and deletion examples omit removed model IDs. An image-only patch cannot safely discover an unbound model after sending that request.

## Matrix coverage

| Area | Cases | Checks |
| --- | ---: | --- |
| Cover and gallery | 12 | Both cover/gallery execution orders on a 3:4 baseline; exact retained intermediate cover; separate media roles; source ratios; changed cover ID rejection; blocked 1:1→3:4 planning; saved live cover-replacement regression. |
| Variation images and structure | 13 | Shared first-tier option consistency; selecting all affected red SKUs while preserving blue; standard group ID; unbound raw model; attempted tier/option/SKU rename, reorder, add and remove. |
| Original price and preservation | 21 | VN integer format, zero/negative/decimal/exponent/unsafe integer, actual minimum and maximum boundaries, ongoing/upcoming/missing/partial/wrong-item promotion evidence, wholesale ambiguity, partial model failure and unknown-field drift in an unselected model. |

The first-tier image is shared by every SKU with that first option. Selecting only red-S and giving it a different image from unselected red-L is rejected; no unselected SKU is silently included. Rename/reorder/add/remove changes remain unsupported by this image-patch pipeline, although Shopee has separate documented operations for some of those actions. The tests distinguish this application boundary from API availability.

`wholesale_price_threshold_percentage` is not treated as an inter-SKU maximum/minimum price ratio. The snapshot documents it as a wholesale percentage of original price. The tests do not invent a universal 3×/5× price rule or reuse example limits as shop policy.

## Live transition failure and final rollback

At 06:49–06:50 UTC on 14 September, the root task dispatched the explicit technical gallery trial for sandbox shop `227418363`, listing `803935036`. It sent the newly authored 3:4 gallery plus `promotion_images.image_id_list` containing the exact old square-cover ID. Shopee acknowledged the request. Repeated raw readback found a different promotion cover and remained unresolved.

Independent visual inspection of the saved images confirmed that the old grey synthetic notebook cover became the green first-gallery QA card. Recorded decoded pixel hashes also differ. This is an actual content replacement; accepting the new image ID as an alias would conceal the failure. The root task subsequently sent a new standalone cover-restoration intent against the now-3:4 listing. Its visual restoration was reported separately, while exact-ID QC still remained unresolved; that repair does not retroactively verify the gallery trial.

The planner now requires an already observed 3:4 baseline for gallery and standalone cover changes. An explicit old-cover ID, an authored portrait source and correct old first-image matching do not bypass the transition block. A dedicated staged transition/recovery workflow requires its own acceptance before this boundary can be reopened.

QC retains the historical transition expectation solely to evaluate recorded requests: the complete raw before/after/steps fixture fails with `item.promotion_image.image_id_list.0`. It does not authorize planning or dispatch. Missing `promotion_images`, changed or aliased cover IDs and reverse 3:4→1:1 also do not verify. No source was cropped or rewritten by this review, and no mismatching image ID was normalized away.

## Source basis and limits

The KB is the official-document snapshot collected on **8 September 2026**. The relevant full API documents and guides were read in this codec/QC work; this review does not certify their present availability or current shop permissions. Official-page access in the earlier 14 September codec research returned 403. Actual app/shop capability and fresh promotion/limit evidence remain caller responsibilities.

| Official source | Source update date recorded in KB | Relevant contract |
| --- | --- | --- |
| [Variant management](https://open.shopee.com/developer-guide/219) | 28 May 2024 | Separate operations for structure changes; retaining model identity through `model_list`; first/second tier behavior. |
| [update_tier_variation](https://open.shopee.com/documents/v2/v2.product.update_tier_variation?module=89&type=1) | 12 September 2025 | Standard variation/option IDs, optional group ID, full model bindings and image updates; legacy upload structure deprecated in the update log. |
| [update_item](https://open.shopee.com/documents/v2/v2.product.update_item?module=89&type=1) | 24 June 2026 | Gallery `image_ratio`, separate `promotion_images` available with 3:4 product images, description fields. |
| [update_price](https://open.shopee.com/documents/v2/v2.product.update_price?module=89&type=1) | No update date supplied; collected 8 September 2026 | Original price, VN integer requirement, per-model success/failure, promotion and wholesale errors. |
| [get_item_limit](https://open.shopee.com/documents/v2/v2.product.get_item_limit?module=89&type=1) | 8 January 2025 | Actual price range, wholesale threshold percentage and image limits. The price min/max prose is inverted in the stored table; example values are not shop policy. |
| [get_item_promotion](https://open.shopee.com/documents/v2/v2.product.get_item_promotion?module=89&type=1) | 31 July 2026 | Per-item promotion entries including ongoing/upcoming staging and partial query failure. |
| [upload_image](https://open.shopee.com/documents/v2/v2.media_space.upload_image?module=91&type=1) | 8 September 2025 | Distinct upload scenes and image role/ratio requirements used by the media transport. |

Raw QC still fails closed for unsupported description-type fallback transitions, unresolved new attribute/value metadata, new logistics-channel metadata, promotional/reserved/advance allocation arithmetic and unpredictable derived shipping fees. A changed image ID is not accepted as the same image without independent identity evidence. Tests here do not exercise network permissions, claim successful live patch publication, or relax production read-only scope.

## Evidence and code

- Test matrix: `tests/unit/prepared-wire-patch-boundaries.test.ts`.
- Scoped fixes: `packages/shopee/src/prepared-wire.ts` and `packages/shopee/src/prepared-wire-qc.ts`.
- `.local/acceptance-20260914/patch-matrix/reproduced-boundaries.json`: 39/42, three failures using the valid sparse-source model-coverage reproduction.
- `green-boundaries.json`: original 42/42 after fixes.
- `transition-red.json`, `transition-green.json`, and `final-regression.json`: historical pre-live checks. Their 45/45 and 122/122 passes did not predict actual cover preservation and are superseded by the live failure and rollback.
- `live/gallery-portrait/{intent,result,cover-identity}.json` and `cover-before.png`/`cover-after.png`: exact request, repeated failed readback and image evidence.
- `tests/fixtures/prepared-wire-portrait-cover-live.json`: portable raw before/after/steps copied from that live evidence, retaining unknown product fields and excluding connection/auth context. Tests do not depend on `.local` files.
- `live-rollback-red.json`: the new block assertion failed against the temporary transition-enabled planner; the saved live QC regression already detected the cover replacement.
- `live-rollback-green.json`: four test files, **123/123**, including the restored planner guard and saved live regression.

No live API mutation, credential read, or main application database write was performed by this review.
