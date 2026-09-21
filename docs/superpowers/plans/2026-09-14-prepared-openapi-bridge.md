# Prepared listing → OpenAPI bridge — 14/09/2026

The 80-folder acceptance is application/business simulation evidence. This increment moves the replacement boundary to HTTP so actual signing, endpoints, request shapes, image bytes, partial acknowledgements and multi-call recovery can be exercised. Production writes remain disabled. The old Lamy and technical trial bindings are not adopted or replayed.

## Deliverables and order

1. Strict sandbox HTTP transport, with fixed host, explicit owner allowlist, Public vs Shop signing, no retries, cancellation and redacted diagnostics.
2. Source-backed metadata assessment and pure wire planner. Missing GTIN/condition/preorder, unsupported option-image structure and unknown whitelist evidence become explicit source/capability issues. No silent default, crop or SKU restructuring.
3. Durable per-request journal. Save full intent before calling Shopee; save acknowledged item identity before initialization; enforce the documented five-second add→init delay. Restart may continue only steps known never sent. Ambiguous writes never replay.
4. Stateful fake HTTP server that speaks OpenAPI envelopes. Verify request payloads, scope, image bytes, partial errors and unselected field retention against raw readback independently from the planner.
5. Fresh read-only sandbox connection/metadata probe. Only then use distinct authorized synthetic sandbox source for a bounded create/readback test if the source and capability gates pass. Do not send the 80 fake-category corpus to Shopee.
6. Enable the application worker only after the full prepared-source/operational-context integration and raw readback verification are complete. An acknowledged request is not a verified listing.

## Explicit acceptance limits

Existing `PreparedGateway` is normalized simulation; changing its mode string would not implement a real adapter. New wire modules and journal must earn separate evidence before they are wired to the public batch page. Raw fields outside selected groups, stock command identity, source identity distinct from zero-tier `item_sku`, owner isolation and in-flight cancellation must remain observable.

The official documents returned HTTP403 to the web reader on 14/09. Implementation consults the full 08/09 snapshot with source dates, records fresh API observations separately and does not claim policies were freshly reverified from that 403.
