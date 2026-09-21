# Scoped production connection — 15 September 2026

The user explicitly authorized connecting VestaPro to shop `1423724897 / vuatinhdau.vn` and testing one complete essential-oil listing from supplied materials. This does not authorize other shops, arbitrary source changes, or replaying historical sandbox jobs.

## Implemented and verified locally

- Added GET/POST `/v1/connections/production-pilot` and a production panel in **Công cụ → Kết nối shop**.
- Enrollment is explicitly scoped to Live partner `2010476`, shop `1423724897`, production host. This pilot configuration is not a general multi-shop writer.
- POST calls signed `v2.shop.get_shop_info` only. Credentials are encrypted server-side after a successful VN/NORMAL shop read. CAS plus a transaction lock prevents concurrent enrollment overwrites. No product request or job enqueue occurs.
- Only `shop.read` capability is recorded. Product writes remain disabled; token expiry is unknown and automatic refresh is not implemented.
- Targeted integration run: **24/24 passed** across production-connection and connection-renewal tests. Shopee responses were fixtures; PostgreSQL schemas were isolated. Typecheck and build passed. Build retains the existing large-bundle warning.
- API was restarted separately; worker was not restarted. Readiness and GET target returned correctly. Browser confirmed the target form and disabled submit with empty credentials.

## Actual external state and blocker

Live Console `https://open.shopee.com/console/app/218272` shows VestaPro Online, Seller In House System, Live partner `2010476`. Its explicit warning says the Live Partner Key has expired and OpenAPI calls are restricted until rotation. No key was revealed or rotated. The user must complete credential rotation directly in Console.

`No access` belongs to **Access to Sensitive Data**, not to general product API permissions. Official snapshot guides 14 and 718 distinguish app category permissions from access to unmasked buyer data. Snapshot date: 8 September 2026; guide 14 updated 24 April 2025, guide 718 updated 4 August 2026. Current Console labels were read directly. Public web fetching these guides returned 403, so no claim of a freshly fetched full guide is made.

The real local connection remains `disconnected`, revision 0, no saved production credentials. No production API call or product mutation was made. A successful future shop-info read alone will not prove create/update/variation/media permissions or business publishing readiness.

Candidate source and outstanding source/price/stock/media checks remain in private `.local/production-pilot-1423724897/preflight.md`. Do not copy Mall prices to an ordinary shop or invent production stock.
