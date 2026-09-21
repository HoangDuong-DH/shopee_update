# Production API pilot — 15 September 2026

This is a real API pilot on shop **1423724897 / vuatinhdau.vn**, official name **Vuatinhdau - Đại Lý Chính Hãng**, partner2010476. It does not establish general 80-listing, multi-shop or 24-hour production acceptance.

## Latest checkpoint — both authorized listings published and verified

At **15:41:56 UTC+7 (08:41:56Z)** the two-source pilot completed: can 5L **51467852283 / 12 SKUs** and Ngọc Lan Tây **51267858328 / 3 SKUs** are both `NORMAL`, create and publication verified. Read [bulk continuation delivery](2026-09-15-bulk-continuation.md) for the final evidence, narrowly accepted weight rounding, cover proof, revision2 refresh, intake changes and remaining limits. Full final verification at **08:47:19Z** passed **1529 unit/integration + 7 legacy**, typecheck and both builds. Do not replay either completed source. The one-listing and row65-unsent statements below are historical checkpoints, superseded by this result.

## Earlier checkpoint — one listing published and verified

At **14:37:17 UTC+7 (07:37:17Z)** the final pair of fresh API reads confirmed item **51467852283 NORMAL**. Create operation `ec195c1c-b2e1-44d9-a866-e14a39988a9b` is verified; publication `5995935b-a336-4efb-8a30-1ed26d447ee7` is verified. The single unlist_item write succeeded, request `e3e3e7f35b8090f198e7db9e89347100`. First post-write read was still UNLIST and the next NORMAL; the final reconciliation performed only reads, never resent publication. Final result: `finish-one-31a4c7b7-6771-49fd-ba9e-3e84f0d939c1/publication-read-only.json` under the private pilot directory.

All12 source SKUs, original prices2179998đ, stock100 atVNZ,9gallery images, variation names/order/images, title/plain description, category/brand/attributes,5logistics channels and per-model5.225kg/25×20×35cm were checked. Full normalized protected raw state matches across publication except the intended UNLIST→NORMAL. Cover image case **e6e9dd41-0529-45a5-8ec6-f78be1f6d585** is verified with **manual_review by Codex QA(agent)**, not a user attestation: original PNG converted to JPEG, both1024², same content/layout, source/output hashes and exactoperation/item/slot bound. Every proof-bearing reconciliation fetches the actual image again. Original Shopee imageID and absentratio remain in raw evidence; a separate proof sidecar supports the semantic match.

**Exactly one source is complete. Row-65 remains unsent**, following the user's latest priority. Running app status is partial_complete, inactive, with replay disabled, no stale QC-error banner. A transient post-write propagation mismatch must not cause automatic stock writes, recreated items or repeated unlist calls. Final runtime API26132/UI5173. Root final typecheck/TypeScript/webbuild passed after the bridge/status changes;64runner tests and42service tests passed for those later changes. The1412 full-suite checkpoint below predates these additions; do not inflate it into a later full-suite count.

Employee materials now exist: `docs/operator-guides/chuan-bi-bo-listing.md` and `.local/operator-intake-template/outputs/production-pilot-readiness/Phieu-ban-giao-listing.xlsx`. The two-sheet Excel is an intake handoff template, **not yet an automatic-import contract**. The guide includes current UI steps and distinguishes missing automation.

## Earlier checkpoint — first production item created

**Actual production item `51467852283` was created through backend OpenAPI**, operation `ec195c1c-b2e1-44d9-a866-e14a39988a9b`, source row-2 revision4. The journal has22 media acknowledgements, one add_item acknowledgement and one init_tier_variation acknowledgement for12 models. Item is **UNLIST**, not yet published or fully QC-verified. Row-65 remains unsent. The user now prioritizes completing this one listing first. No UI form was used to create it.

The first raw read at07:10:17Z returned zero stock with an empty location, approximately0.6seconds after variation initialization. Two independent fresh API reads at07:15:15Z/07:15:18Z returned all12 models at **VNZ stock100**, available100, reserved0, FBS0 and advance0. **No stock write was needed**; retain both the early and settled responses as propagation evidence. Files: `.local/production-pilot-1423724897/created-read-92fecf18-0a95-49e3-9e1f-f81099b54ddf/`.

The remaining create-QC issue is the promotion cover: Shopee returned `vn-11134201-81ztc-mt4ye0fzurydbd` and omitted promotion_image.image_ratio. Do not waive that difference by assumption. Content/decoded dimensions must be independently checked and bound to the source/output/operation through image-QC evidence before publication. Raw first response remains in `wire-evidence/ec195c1c-b2e1-44d9-a866-e14a39988a9b/78f9d1ff-7144-4b91-b28a-56221715027b.json`.

Revision3 had first failed with a definitive logistics validation (`product.error_busi`, request `e3e3e7f35b80096eb039638106725500`, rule `logistics.channel.force_enable_forbid_disable`, code1326). All31 channel metadata records said force_enable=false/compulsory_channel=false; do not claim metadata identified the forced channel. Revision4 derives five enabled checkout channels from same-shop UNLIST item42476682098 and verifies each source parcel fits:50052/5000/50053/5001/5004. Old enabled channel50039 was excluded because its height limit8cm cannot fit either unchanged source package. No shop-level setting was changed. Every other document field is identical between revision3 and4.

Both rejected attempts remain rejected, with their original rows/receipts unchanged. Migration024 and immutable full-census proofs closed only their lanes; explicit supersession links lead v2→v3→v4. Rejected v3 operation is `dfa64457-dd7d-4ca2-9354-c89482b4fd38` (22 media acknowledgements/no item). Neither old create was replayed. The current acknowledged create must never be recreated.

The application now exposes the fixed two-source pilot through GET status/assets and POST start; the UI distinguishes current source versions and historical attempts and uses the server canStart gate. The standard general worker remains separate. Root's full verification at07:12:20Z: **1412/1412 unit/integration,7/7 legacy,typecheck and both builds passed**. Dedicated UI fixture suite8/8 passed separately, without Shopee calls. The earlier concurrent verification failed while a new regression preceded its fix; the later complete run above is the completed checkpoint. The image-proof bridge is subsequent work and needs separate final checks.

## Authorized source and scope

The user authorized production publication, then stock100 per SKU, DORIS SHOP MALL **GIÁ GỐC** for original prices, and estimated package dimensions. Active batch is **row-2 can5L (12SKUs)** and **row-65 Ngọc Lan Tây (300/100/500ml, 3SKUs)**. Row-11 Tràm Huế is explicitly excluded. The seller confirmed **Nguyên chất 100%** for the two active sources; only corresponding contradictory composition text was revised, with original text retained in the source history. General fire/eye/child/fabric precautions remain.

Catalog `fd983d71-dbe4-4980-a3d6-d2f90d9f117c`, DORIS pricebook `6bea45ed-8211-41c2-9f6f-4d8416f9af12`. Private originals, hashes, visual mappings and source revisions are in `.local/production-pilot-1423724897/`. Do not commit that directory or print credentials.

Source revision2 contains original cover1:1, g1–g9 gallery3:4, the same g1–g9 after the opening description heading, and original variation artwork. Can5L image filename numbers differ from source variant order: use the visual manifest. Ngọc Lan Tây uses its supplied shared square variation image for all three sizes, without cropping/generation.

## Current real API evidence

Connection revision1 was validated on the actual production shop. Fresh scans found53 UNLIST products, no matching new source titles/SKUs, and no NORMAL/BANNED/REVIEWING products. Category101128 and brand1252097 VINA TƯƠI were confirmed through current APIs. Channel5001 was checked against declared DORIS weights and user-authorized estimated dimensions. API warehouse access returned not-in-whitelist; stock requests omit location_id, while separately proven readback location is VNZ.

At **13:24:18–13:24:47 UTC+7**, backend operation `85c09451-42b1-4927-b819-7a30dd21a602` sent31 original-image uploads followed by one `v2.product.add_item` for row-2, requesting **UNLIST**. All31 uploads were acknowledged. The create was **rejected**, code `product.error_param`, request `e3e3e7f35b7f9b7fb0e758f0addb4f00`, with the explicit message that the shop is not whitelisted for images in descriptions and may only upload plain text.

No item ID was returned. No variation initialization, publication or row-65 creation was sent in that attempt. Original products were not edited. Media uploads are real side effects; do not call the entire attempt read-only or report it as a successful product creation. The rejected operation and all receipts remain intact in the database; safe export is `operation-85c09451.json` in the private directory. Main migrations022 and023 were applied after tests.

The user then explicitly chose: **“Đăng mô tả chữ; giữ đủ g1–g9 ở bộ ảnh sản phẩm, bìa và ảnh phân loại giữ nguyên.”** Source revision3 removes only description-image blocks, preserving text blocks and every gallery/cover/variation file. It is a new source revision, not permission to replay/overwrite the rejected operation.

Two fresh complete read-only scans after rejection again found53 products and no source matches. Their raw pages/base/model responses are stored at `rejected-scans-5b23621f-4141-4cc0-af2f-223873e731e5.json`. Append-only no-create reconciliation and an explicit successor link are being implemented before the revision3 attempt. Until its own receipt is added here, **revision3 has not been sent**.

## Verified implementation scope

Root's dedicated run:263/263 tests passed across transport, source decoder, metadata, per-model shipping, create journal, publication journal and runner; full typecheck passed. An additional final-page completeness regression raised the source decoder suite to8/8. These are local fixtures/database tests, not successful production publication. New source-revision recovery and UI changes require their own fresh verification.

The production transport is restricted to the one authorized shop. Create must be UNLIST. Mutation intents are committed before network I/O; TTL is rechecked after lock waits. Publication is a separate source-bound journal requiring two full pre-reads and two NORMAL post-reads. Lost or uncertain mutation responses are not automatically resent. Model weights/dimensions and custom attribute text/units are compared, not merely attribute IDs.

The remaining work is revision3 recovery/execution/readback, application wiring and browser verification, then broader batch acceptance. Do not describe this pilot as a general production worker release.

## Knowledge learned

- Actual `get_item_list` zero-result pages may omit `item` while returning `total_count:0, has_next_page:false`; this is accepted only for an explicitly empty result. Missing nonempty inventory fails closed.
- `get_item_limit.extended_description_limit` is a limit description, not permission. Real add_item rejection proves this shop lacks the feature at the observed time. FAQ51 in the local KB explains the distinction; source URL https://open.shopee.com/faq/51, updated13May2026.
- Uploading a description image successfully does not prove a shop can attach it to a product description.
- DORIS model weights are kept exactly:5.225kg for can5L;0.3223/0.1309/0.5038kg in source order for Ngọc Lan Tây. No documented three-decimal rounding permission was found; a different readback must be reported rather than silently accepted.
