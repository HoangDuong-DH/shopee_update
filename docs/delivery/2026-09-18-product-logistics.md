# Product shipping choices and batch autofill — 18 September 2026

User clarified that the excessive shipping checkboxes were manual options, not the result of autofill. Their Seller Centre screenshot shows seven checkout groups. They requested a batch option to enable all applicable shipping groups.

## Evidence

- Official local snapshot: `knowledge-base/shopee-open-platform/documents/guide/en/209.md`, section 7, source https://open.shopee.com/developer-guide/209 (updated 2025-09-19; captured 2026-09-08): product selection requires `enabled=true` and `mask_channel_id=0`.
- Official channel contract: https://open.shopee.com/documents/v2/v2.logistics.get_channel_list?module=95&type=1. Live documentation fetch returned 403; no third-party carrier directory used.
- Fresh read at 2026-09-18T03:45:47.132Z, request `e3e3e7f35bb9bc5b69bea1327f91f300:010002c829e96911:000000f324463162`: shop **1423724897**, 31 channels, seven checkout groups. Private metadata `.local/logistics-review-live.json`; classification `.local/logistics-verification-20260918.json`.
- These observations are for vuatinhdau.vn, NOT shop 1126307464. Production preparation remains scoped to the existing pilot shop; generic connection support is not general multi-shop publishing support.

## Changes

- UI offers checkout groups only; shows source shop, observation time and package eligibility reasons. Existing saved child/unknown IDs are flagged and can be removed explicitly.
- Batch autofill exposes `all_eligible` versus existing `source_supported` mode. UI defaults to the user-requested all-eligible policy; API omission preserves prior mode.
- All-eligible mode no longer needs a prior successful listing's shipping settings. It checks current shop channels, each listing's source weight and existing or supplied package dimensions. Explicit all-eligible selection replaces shipping choices only; other manual fields remain preserved. If existing editor weight differs from the source-based proposal, shipping is not overwritten.
- Shared eligibility uses only checkout groups; validates enabled state, supported fee type, weight/dimensions, known relations and volume-unit evidence. Compulsory means at least one compulsory group, while force-enable requires each forced group. Dependent-block relations apply when disabling, not a conflict between enabled groups.
- Wire codec independently rejects fulfillment IDs in enabled product shipping choices. Existing production preflight also enforces checkout-only selection.
- No carrier names/IDs hardcoded as platform policy. For the example package 503.8g and 12×12×28cm, five groups qualify. Viettel Smartbox's height limit is 8cm; same-day metadata reports UNKNOWN dimension unit and positive limits, so its constraints are not guessed.

## Verification and deployment

- 149/149 focused tests across six files pass; typecheck and TypeScript/Vite build pass. Tests include fulfillment-ID rejection, dependency semantics, no-history batch fill, and per-listing package precedence.
- UI bundle uses the narrow domain module import to avoid bringing server-only dependencies into the browser.
- API restarted through the existing launcher after confirming zero active preparations, exchanges and sent operations. No listing write, publication, source-folder rewrite or bulk execution performed.
- Browser interaction was not inspected due the previously reported browser-tool quota rejection. Build/API verification is not a claim of visual E2E acceptance.

Operator: refresh the app, open batch preparation, choose **Vận chuyển cho cả lô → Bật tất cả kênh vận chuyển phù hợp**, then **Điền nhanh cả lô**. Review exclusions and run preparation checks again before submitting. Existing immutable batch manifests are not rewritten automatically.
