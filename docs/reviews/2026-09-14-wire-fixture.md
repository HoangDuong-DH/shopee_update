# Local OpenAPI wire fixture — 14 September 2026

`tests/fixtures/prepared-wire-platform.ts` implements a stateful `fetch` replacement at the HTTP boundary. It does not implement `PreparedGateway`, import the prepared document codec, inspect a runner's desired outcome, contact Shopee, or open a database. The three default owners/shops and four category families are explicitly synthetic. Their rights and numeric limits are fixture choices, not evidence of any live shop's rights or limits.

## Interface

```ts
const platform = new PreparedWirePlatform({ shops?, now?: () => milliseconds });
const credentials = platform.credentials(shopId); // Synthetic fixture secrets only
const transport = platform.fetch;                // Bound function, never falls through to fetch
platform.advance(5000);
platform.faults.push({ path, shopId?, itemId?, kind: 'drop_response' });
const evidence = platform.snapshot();            // Deep-cloned raw items, models, tiers, images, calls
```

An injected clock controls signature expiry and the five-second add/init delay. If the real transport obtains timestamps through `Date.now`, tests must inject/mock that same logical clock there. Uploads are public API calls: the signature excludes shop/token and the image store is scoped to the partner. Shop API calls validate partner/shop/token and independently calculate HMAC-SHA256. Only the sandbox origin is accepted. A request to an unknown endpoint, the production host, the wrong HTTP method, a malformed body, or invalid signature returns a failure; there is no network fallback.

The HTTP body is JSON for product writes and real multipart `image` files for media. PNG/JPEG bytes are decoded by `sharp` and recorded by byte count, dimensions and SHA-256. The fixture does not crop, generate replacements, or represent Shopee's image processing. Image IDs are synthetic server identities, with inert `fixture.invalid` URLs. They are never fetched.

Item/model state is persisted solely from accepted wire fields. `add_item` creates a zero-tier item. `init_tier_variation` must wait at least five seconds and supplies one/two standard tiers plus an exact set of model indices. Option images are only accepted on the first tier and must cover all first-tier options if any are used. Item/model responses use documented snake_case fields, model arrays are reversed, and callers must resolve identities. A tiered item's base response omits price/stock, while its models carry price/stock. A zero-tier item carries base price/stock and uses `model_id=0` for price/stock writes. `update_model` and `update_tier_variation` return envelope-only acknowledgements.

Updates copy only explicit fields and requested model identities. Faults can return a business error under HTTP 200, commit only selected model rows, lose a response after committing, change an unselected base field, or return an arbitrary malformed/status response. Promotion setup is a test control, not a write endpoint: ongoing/upcoming entries, absent lists and contradictory base flags remain separate evidence. The fixture never treats a successful acknowledgement as readback verification.

Calls redact tokens, partner keys and signatures, including configured secrets echoed in text. Binary call evidence records hashes, not bytes. `snapshot().items` retains exact synthetic product text; it is source/readback evidence, not a general-purpose secret scrubber.

## Official source contract

Starting point: [Open Platform agent guide](../../knowledge-base/shopee-open-platform/AGENT_GUIDE.md), snapshot retrieved 8 September 2026. Request/response parameter tables, examples, errors and update notes informed this fixture. Repeated language examples do not supersede the parameter table or newer guide.

| API / guide | Source update | Contract used |
|---|---|---|
| [Call API, guide 16](https://open.shopee.com/developer-guide/16) | 2025-11-21 | Current sandbox origin, shop/public signing, five-minute timestamp validity, JSON/form distinction |
| [Shop info](https://open.shopee.com/documents/v2/v2.shop.get_shop_info?module=92&type=1) | 2026-05-19 | Shop metadata is at envelope top level |
| [Upload image](https://open.shopee.com/documents/v2/v2.media_space.upload_image?module=91&type=1) | 2025-09-08 | Public multipart API; `image`, scene, ratio; single and per-file image acknowledgement |
| [Category](https://open.shopee.com/documents/v2/v2.product.get_category?module=89&type=1) | 2021-10-29 | `response.category_list` |
| [Attribute tree](https://open.shopee.com/documents/v2/v2.product.get_attribute_tree?module=89&type=1) | 2025-01-13 | Category list, mandatory attributes, attribute values and input metadata |
| [Brand list](https://open.shopee.com/documents/v2/v2.product.get_brand_list?module=89&type=1) | 2021-10-29 | Category/status/offset/page-size, brand ID and original name |
| [Item limits](https://open.shopee.com/documents/v2/v2.product.get_item_limit?module=89&type=1) | 2025-01-08 | Price, stock, text/image, shipping/size-chart and GTIN metadata |
| [Channels](https://open.shopee.com/documents/v2/v2.logistics.get_channel_list?module=95&type=1) | 2026-05-22 | Shop-enabled channels, fee type, weight/dimension limits |
| [Add item](https://open.shopee.com/documents/v2/v2.product.add_item?module=89&type=1) | 2026-09-01 | Source text/media/brand/attributes/logistics, item price and seller stock |
| [Init tiers](https://open.shopee.com/documents/v2/v2.product.init_tier_variation?module=89&type=1) | 2025-09-12 | Five-second delay; `standardise_tier_variation`; model indices/SKUs/price/stock |
| [Base info](https://open.shopee.com/documents/v2/v2.product.get_item_base_info?module=89&type=1) | 2026-04-03 | Separate `promotion_image` read field, zero-tier price/stock, weight string |
| [Model list](https://open.shopee.com/documents/v2/v2.product.get_model_list?module=89&type=1) | 2026-07-31 | Model identities, tier indices, standard tiers, price and stock summaries |
| [Update item](https://open.shopee.com/documents/v2/v2.product.update_item?module=89&type=1) | 2026-06-24 | Explicit partial item fields |
| [Update model](https://open.shopee.com/documents/v2/v2.product.update_model?module=89&type=1) | 2025-01-08 | SKU/GTIN/preorder/model shipping; envelope-only acknowledgement |
| [Update tiers](https://open.shopee.com/documents/v2/v2.product.update_tier_variation?module=89&type=1) | 2025-09-12 | Standard options and model identity mapping; envelope-only acknowledgement |
| [Update price](https://open.shopee.com/documents/v2/v2.product.update_price?module=89&type=1) | Not supplied in snapshot | Model-scoped original price; partial success/failure lists |
| [Update stock](https://open.shopee.com/documents/v2/v2.product.update_stock?module=89&type=1) | 2022-10-31 | Seller stock only, zero model ID, reserved-stock check, partial acknowledgement |
| [Item promotions](https://open.shopee.com/documents/v2/v2.product.get_item_promotion?module=89&type=1) | 2026-07-31 | Item success/failure coverage and ongoing/upcoming promotion metadata |

There is no `v2.product.get_model_limit` document in this snapshot. The fixture rejects that route rather than fabricating an API. It uses `get_attribute_tree`; the deprecated `get_attributes` route is not implemented. `get_item_limit` has no model-count response field; a 50-model fixture safeguard is not presented as a queried shop limit. Announcements [1280](https://open.shopee.com/announcement/1280) and [1377](https://open.shopee.com/announcement/1377) explain why promotion detail and base flags are separate reads; no guard is relaxed for a contradictory flag.

## Coverage and limits

Initial meaningful unit execution: **26/26 passed**, including the existing real signed shop reader and real multipart product client. Tests cover three shops, same SKU in different shops, shared-partner image ownership, zero/one/two tiers, exact text/media role readback, timing, reversed models, partial patches, malformed/auth failures, lost create/update acknowledgements, promotion evidence and redacted receipts. No external requests or main schema mutation occur.

The added `tests/integration/prepared-wire-acceptance.test.ts` subsequently passed **14/14** through the actual `SandboxPreparedTransport`, source-to-wire codec and `PreparedWireRunner` using a private PostgreSQL schema. It generated a new 80-folder DOCX/PNG/XLSX fixture and explicit additional square option images for this protocol suite. These new images are synthetic source assets, not cropped replacements. Original portrait variation sources and conflicting first-option images are retained as negative source cases. This test begins at authored `PreparedDocument` inputs; ordinary browser intake and saved business drafts are covered by the separate prepared-business browser suite, not counted again here.

- 80 `add_item` and 48 delayed `init_tier_variation` calls produced 80 independently matched raw readbacks: 200 source SKU rows, 32 zero-tier / 24 one-tier / 24 two-tier listings, four category IDs and shop counts 27/27/26.
- Nine changed field-group updates and a combined price/stock update on 12 folders across all three shops matched the complete expected raw snapshot. The combined update retained 36 unselected models and 68 other listings.
- One intentional partial stock write remained `unknown`, stopped before the next price request and did not resend after runner reconstruction. The journal held 101 acknowledged operations plus this one unknown operation; acknowledgements alone do not represent QC.
- 602 actual multipart uploads preserved input-byte hashes. All 521 original source files were rehashed unchanged. An independent Node assertion audit checked 648 media references against upload hashes and repeated the 80 source-to-readback/model/shop checks without importing the codec or runner.
- 1,456 HTTP-boundary calls, zero outbound requests, zero main-schema writes; the private schema was dropped after evidence capture. The local create/readback loop took 13.903 seconds; the complete integration command took 34.02 seconds including fixture setup. These are local simulation measurements.

Evidence is in `.local/acceptance-20260914/prepared-wire/run-mY5s0W/`: `wire-acceptance.json` contains raw create/update/readback receipts and redacted calls; `wire-audit.json` records the independent assertions and exact counts. The original source manifest SHA-256 is `3a323454fe03db4a771343517a5f998d1e2204921cfd0845be0ebb7253decad3`. Separate machine-readable test outputs are `.local/acceptance-20260914/prepared-wire-vitest-results.json` and `prepared-wire-fixture-unit-results.json`. Both report zero failures in their final runs.

This is a bounded protocol fixture, not a complete Shopee emulator. It rejects unsupported fields and routes. It does not simulate auth refresh, tax regimes, warehouse discovery, QC, carrier side effects, media CDN transforms, model structural conversion, or adding/removing options through update tiers. Synthetic metadata has one required single-choice attribute and one size-input channel per shop. GTIN validation checks the documented shape/rule, not a full GS1 checksum. Source permissions and whitelists must still be established from an actual allowed connection before any real execution. No current live Shopee availability was inferred from these local results.
