# Production authorization pilot — 15 September 2026

## Scope and actual state

The user saved the VestaPro app after rotating its Live key. Console now reports that a new key took effect at **15/09/26 11:01 UTC+07** and a three-day transition period. The same page still displayed an expired-key warning with the older expiry field. Treat this as mixed Console presentation until an API call with the user's new key succeeds. Do not copy the visibly selected old key or claim production authentication succeeded from the banner alone.

Target remains **Live partner 2010476 / shop 1423724897 (vuatinhdau.vn)**. User authorized connection and one provided essential-oil listing pilot. No product request was sent in this checkpoint. Other shops and historical sandbox runs remain out of scope.

## Added flow

In **Công cụ → Kết nối shop**, the main path is now:

1. User pastes the new Live Partner Key locally.
2. **Chuẩn bị kết nối Shopee** creates a pending local authorization attempt.
3. User clicks **Mở Shopee để cấp quyền** and selects only the target shop, without Auth Merchant.
4. Browser returns to the backend; backend exchanges the single-use code and verifies the target with `get_shop_info` before saving the encrypted connection.

Manual access-token entry remains collapsed under an advanced section. No automatic refresh or production product writer is claimed. The user has been asked to enter the key; the last public status read still shows disconnected, revision 0, no saved production key.

## Boundaries implemented

- Migration **021_production_authorization.sql** applied locally. Separate temporary attempt records keep encrypted keys and hashes of state/browser session. Terminal or expired attempts clear staged key ciphertext on access/cleanup; no background cleanup scheduler is claimed.
- Authorization target and URLs are fixed for this local pilot. Callback: `http://127.0.0.1:4310/v1/connections/production-pilot/callback`. This requires the initiating browser on the same machine and the API running. Shopee Console domain has not been configured or its acceptance demonstrated. No public tunnel or deployment was created.
- Prepare is a protected POST. State plus HttpOnly SameSite=Lax cookie binds the callback to the initiating browser; no user-controlled callback host.
- One conditional claim before token HTTP prevents repeated or concurrent code consumption. TTL is checked again using DB clock at claim, including time waiting for the shared connection lock.
- Wrong shop, duplicate/invalid parameters, extra main-account shops, merchant/supplier/user/principal grants are rejected. Unknown token exchange is never retried automatically.
- Token receipt expiry is retained. Connection and verified attempt finalize atomically under CAS. Only `shop.read` capability is recorded; jobs/outbox are untouched.
- Callback redirects to a status URL without the code. Responses are no-store/no-referrer, HTML uses a restrictive CSP and no external assets. Credentials and raw callback query are not included in application logs or public responses.

## Verification

- **93/93 targeted tests passed**: 49 gateway unit, 20 authorization integration/HTTP, 18 production connection, 6 existing renewal tests. Real local PostgreSQL in isolated schemas; Shopee responses were simulated and no real credentials were used by tests.
- Independent agent review found a TTL-after-lock issue; a failing regression reproduced it and the conditional claim fixed it. Final targeted suite has no skipped tests.
- Typecheck/build passed (existing large-bundle build warning remains).
- Local migration and API restart completed; worker not restarted. Browser confirmed the main key-only entry, disabled empty submit, and collapsed manual token form. The complete browser → Shopee authorization → callback flow still requires user action and live verification.

## Sources

- [Authorization and Authentication](https://open.shopee.com/developer-guide/20), official snapshot 8 September, source updated 23 July 2026.
- `v2.public.get_access_token`, official snapshot, source updated 13 July 2026. Path `/api/v2/auth/token/get`; code exchange is single-use. The duration definition is used for `expire_in`; the inconsistent epoch-shaped example is not treated as a valid duration.

Read `.local/production-pilot-1423724897/preflight.md` for listing source, price, stock and media gaps. Connection success will not by itself complete publishing or production acceptance.
