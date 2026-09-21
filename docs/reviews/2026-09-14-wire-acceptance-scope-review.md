# Independent review: wire acceptance and delayed readback

Date: 14 September 2026. Reviewer inspected source and saved evidence. No live API call or main database change was made by this reviewer.

## Evidence that can be claimed

| Evidence                                                                   | What it proves                                                                                                                                                                                                                      | What it does not prove                                                                                                                 |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Existing 80-folder intake acceptance                                       | The separate browser/import journey can ingest its prepared fixture folders and shared workbook.                                                                                                                                    | It is not the input path used by the new wire test.                                                                                    |
| `.local/acceptance-20260914/prepared-wire/run-mY5s0W/wire-acceptance.json` | Real request codecs, signing/multipart logic and a real isolated PostgreSQL journal were exercised against an injected local Shopee-shaped platform. Eighty derived documents were created and compared with independent raw reads. | No requests reached Shopee; no production permissions, dynamic live category support, moderation or throughput acceptance.             |
| `.local/acceptance-20260914/wire-bridge/title-canary/result.json`          | One new title intent targeted the existing technical UNLIST sandbox listing 803935036 in shop 227418363. Two later consecutive reads matched its expected title and preserved other normalized business fields.                     | No business-source create, no 80-listing real batch, no price/stock/image mutation by this particular canary, no production execution. |

The 80-document wire corpus is explicitly derived by `tests/integration/prepared-wire-acceptance.test.ts` from generator objects. It does not parse the saved Word/XLSX through the main intake APIs. It adds separately generated square option images and explicit fixture context: condition NEW, non-preorder, GTIN `00`, confirmed no warehouse location, and allowed image capabilities. The original 521 fixture files retain their hashes. That is valid isolated codec testing, but the derived corpus must not be described as unchanged original listing content accepted directly by Shopee.

## Saved wire report reconciliation

- `kind: local-http-wire-simulation`, `externalRequests: 0`, `schemaRemoved: true`.
- 80 creates, 200 SKU/model records including zero-tier products; 32 zero-tier, 24 one-tier and 24 two-tier listings. Three fixture shops have 27/27/26 listings; four fixture categories have 21/21/20/18.
- All 80 source-based raw comparisons passed; 80 add-item calls and 48 model-initialization calls were asserted by the test. Reopening the persisted creates did not resend.
- Nine separate update groups were compared against complete before/after raw snapshots: title, description, cover, gallery, variation images, price, stock, attributes and logistics.
- A further 12-listing price/stock batch changes one model per selected listing across three shops; 36 other models in those listings and 68 other listings remain unchanged.
- An intentional partial stock response remains unknown, applies only the first model, never sends the following price step and does not resend after runner reload. Final journal counts are 101 acknowledged and one expected unknown operation.
- Original portrait variation media and conflicting images on models sharing one first-tier option are explicitly blocked. The test does not “fix” those original sources to claim support.

The approximately 13.9-second create test duration is **not a speed estimate**. The fixture advances a logical clock by 240,000 ms for 48 required add/init delays rather than waiting four minutes in real time. It supplies no evidence for a maximum listings-per-day claim.

The raw comparison is independent of the request plan: expected field values come from authored fixture documents, and the local platform applies endpoint-specific mutations before separate reads. However, it remains a modeled platform with selected behavior. Live reservations, pagination and permission changes, transformed image IDs, category-specific conditional fields and actual propagation delays require their own evidence. The new pure metadata assessor is not called by this acceptance suite; its raw metadata checks are covered separately.

## Readback helper finding

The first `pollPreparedReadback` bounded only the sum of delay intervals. An unresolved read callback could hang forever, and abort during a delay/read did not settle immediately. Its four initial tests used promptly resolved callbacks and did not exercise this failure.

The reviewer added `tests/unit/prepared-readback-timeouts.test.ts`: total elapsed deadline, per-read deadline with an adapter ignoring abort, external abort during a read, external abort during delay, rejection of a late second match, and successful timer cleanup. Five cases were observed failing against the original implementation; the ordinary in-budget case passed. The revised helper now enforces an overall deadline and separate read deadline, races uncooperative callbacks against cancellation, interrupts pauses, cleans timers/listeners and rejects late evidence. The reviewer reran all ten tests (four original + six new): **10/10 passed**, and the whole-repository typecheck passed. Evidence: `.local/prepared-verification/prepared-readback-review-tests.json`. The reported P1 is closed for this helper's bounded read-only scope.

The helper has no mutation callback. Two matching reads improve confidence in propagation, but verification still depends on the supplied checker proving the selected fields and preserved remainder. Acknowledgement alone is never sufficient. The owner then used the helper for read-only reconciliation of the same already acknowledged canary operation, without resending. The refreshed saved result records two verified observations at `2026-09-14T06:15:42.716Z` and `2026-09-14T06:15:44.398Z`, with distinct request IDs and empty mismatched paths; `readback.state` and `verified` both indicate a match. The operation ID remains `8bb19101-220b-4693-af7b-4fcf85aca6c3`. The journal execution remains labelled acknowledged; the separate readback provides the comparison evidence. This demonstrates the helper against this one live sandbox title case, not every live field or listing type.

## Delivery wording

“The application has separate evidence for 80-folder intake and for 80 derived listing documents through the local API simulator, including bulk updates and partial-failure handling. A new durable backend journal was also used for one title-only update on an existing sandbox listing, with a matching final readback. Linking the normal input journey to the complete live executor, live create metadata exceptions, automatic QC/recovery and production release remain unfinished.”
