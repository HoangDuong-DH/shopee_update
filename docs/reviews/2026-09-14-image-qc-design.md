# Image comparison, explicit review, and scoped reconciliation

Implemented 14 September 2026. This design handles Shopee returning a different image ID or encoded file after upload/update. It does not interpret an image ID change as proof of either correctness or failure, and it does not call visual similarity an accuracy probability.

## Source and observed behavior

The full local KB copy of [v2.media_space.upload_image](https://open.shopee.com/documents/v2/v2.media_space.upload_image?module=91&type=1), updated 8 September 2025 and collected 8 September 2026, documents JPEG/PNG files up to 10 MB, `scene=normal` image processing, `scene=desc` without that processing, and `ratio` support limited to whitelisted sellers. These documented transformations do not establish that a particular returned image is correct. The exact `cf.shopee.vn` URL observed in saved API evidence is the basis for the Vietnamese CDN host used here; the two-host allowlist is a deliberately limited implementation, not a claim that it lists every Shopee CDN.

Two already saved sandbox cover pairs were inspected without network requests. The restored grey notebook card appears unchanged in content/layout, but its bytes and decoded pixels differ. The prior gallery fault instead replaced it with a green QA card and white side padding. The new comparator reports the restored pair `review_required` and the wrong card `mismatch`. Full private evidence remains under `.local/acceptance-20260914/patch-matrix/live/{cover-restore,gallery-portrait}/independent-image-qc.json`; it is not committed. Its source is the saved original API-observed cover before the fault, not a newly read original upload file. Agent visual observations were recorded as observations; they do not impersonate an operator or create an approval.

## Pure comparison and fetching

`packages/shopee/src/image-qc.ts` exports `compareImageBytes`, `compareImageRoleSet`, `fetchObservedShopeeImage`, and their types. Every pair is bound to environment, partner, shop, item, operation, role, position, immutable source asset ID, and returned image ID. The role set checks complete count, order, and slot identities before checking pixels; an empty set cannot succeed.

The comparison states are:

| State                       | Meaning                                                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verified`, `exact_bytes`   | Valid decodable image files have the same SHA-256.                                                                                                                  |
| `verified`, `exact_pixels`  | Different encoded files have exactly the same dimensions and canonical decoded sRGB RGBA pixels. Orientation is applied before comparison.                          |
| `review_required`           | Pixels differ but the images are candidates for explicit review. This includes lossy reencoding, same-aspect resizing, and potentially small critical text changes. |
| `mismatch`                  | Aspect ratio changed or the coarse visual difference is too large, or role count/order/binding is wrong.                                                            |
| `unresolved`                | Missing, corrupt, unsupported, excessive, or invalidly bound evidence.                                                                                              |
| `verified`, `manual_review` | A previously pending pair has a valid explicit versioned attestation for these exact bytes and binding.                                                             |

The metrics are actual changed-pixel fraction, mean absolute RGBA channel difference, and 32×32 thumbnail channel difference. The thumbnail mean threshold of 35/255 is only a conservative rejection/candidate-routing heuristic. No threshold or resized comparison can automatically verify an image. Small SKU/quantity text changes can have very low scores, so they remain pending rather than passing. Aspect-changing crop/padding is rejected, even when a review attestation is supplied. Same-aspect cropping may be a review candidate; the algorithm makes no claim to detect every crop. Operator inspection is therefore a real required step for candidates, not an optional decoration on an automatic success.

Decoding accepts single-frame JPEG, PNG, or WebP, at most 10 MiB and 16 million pixels, with a five-second processing timeout. Original buffers are copied before asynchronous work. Comparisons never crop, overwrite, or persist transformed source files. The ordered set decodes pairs sequentially to bound memory.

Fetching is separate from comparison. The caller must supply the exact URL from its trusted API readback. Only HTTPS `cf.shopee.vn` and `cf.shopee.sg` are accepted, with no credentials, nonstandard port, fragment, redirect, or arbitrary host suffix. No credentials are sent. Both declared and streamed byte limits are checked, MIME must be an allowed raster image type, and a bounded deadline covers fetching and stalled body reads. Default limits are 10 MiB and 12 seconds; callers may only lower them. No retries are made. A fetched body is not itself a verified image: it must subsequently pass decoding/comparison.

## Durable ordinary-operator review

`ImageQcService` and migration `017_image_qc_reviews.sql` store immutable cases and immutable decisions; SQL triggers reject updates/deletes. Source and output bytes are retained in the existing content-addressed `BlobStore`, with hashes and comparison metadata in PostgreSQL. The original automated comparison remains separate from the eventual decision/result.

`prepare` is an internal trusted-byte API. It has a strict schema, accepts no attestation, and binds a case fingerprint to scope/role/position/assets, both hashes, and expiry. `get`/`list` expose saved metadata. Public HTTP routes only list/read cases, serve their stored images, and accept an explicit review decision. There is no public prepare/byte-import/accept-proof endpoint.

`review` requires the exact fingerprint and full binding, a request ID, decision, reviewer label, and note. The server creates `image-review/v1` attestations and their timestamp. Only pending review candidates can be accepted; mismatch, unresolved, and exact automatic results cannot be overridden. Before acceptance, the server reloads and hashes the saved blobs and recomputes the original comparison. A changed blob/comparison, stale fingerprint, different scope, expired case, or competing decision blocks acceptance. The same request is idempotent, including later retrieval of an expired historical receipt; altered content under that request ID is rejected. The reviewer field is a recorded operator label in the user's shared workspace model, not a new authentication claim.

`check` is an internal applicability guard: it requires the full binding and newly observed source/output hashes, and rejects expiry or changed evidence. Supplying arbitrary imported JSON as a trusted attestation is never a service input. Test-generated approvals are labelled QA fixture operators and do not represent the user accepting real images.

## Bridge to full raw readback QC

`apps/api/src/prepared-image-qc.ts` exports `checkPreparedWireUpdateWithImageQc(service,input)`. It receives the operation/scope, raw before/after snapshots and steps, and optional cover evidence containing a saved case ID plus fresh trusted byte observations. It derives the expected cover ID from the original snapshot and explicit request payloads. That ID must match the declared source baseline ID and observed source image ID; the output observation must match the current returned cover slot exactly.

The bridge builds the complete binding itself and calls `ImageQcService.check` with freshly calculated hashes. For a verified applicable case only, it clones the after snapshot and projects exactly `item.promotion_image.image_id_list[0]` to the expected source ID, then runs the existing full protected-field QC again. Wrong/reordered gallery images, stock changes, unknown fields, duplicate model identities, unexpected payload fields, and all other differences still fail. It accepts no arbitrary attestation payload and applies no general image aliases. The result distinguishes exact byte/pixel image proof from an explicit manual-review basis.

Historical raw snapshots and journal states are never rewritten. The original run may remain `unknown`; this bridge produces a separate reconciliation receipt containing the original raw QC, the scoped comparison, and the final full QC. A reconciliation receipt is evidence for that bound operation/readback, not a general approval of an image ID in other items or future operations.

## Verification scope

The bounded suites exercise real decoding, actual original image bytes, bounded fake HTTP fetch responses, the real API image/review routes, isolated PostgreSQL, content-addressed blobs, and the unchanged raw wire QC. Adversarial fixtures include tiny SKU/quantity changes, crop/padding, alpha, lossy/lossless reencoding, role/order substitutions, malformed input, stale or cross-scope reviews, timeout/size limits, CAS races, and blob tampering. They use explicit technical QA cards, not generated product artwork. No test invokes live Shopee, modifies the main schema, or claims universal image recognition.
