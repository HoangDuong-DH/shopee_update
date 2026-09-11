# B — OpenAPI và listing trực tiếp — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans`; chạy B1–B4 theo từng gate, không ghi production trong phạm vi hiện tại.

**Goal:** Tạo và cập nhật listing bằng backend, lưu tiến độ, đọc lại đúng dữ liệu; không điều khiển API Test Tool cho đường chạy ứng dụng.

**Architecture:** Endpoint registry + token store + typed gateway → worker ghi từng bước → readback comparator. Plan bất biến là đầu vào duy nhất của luồng ghi.

**Tech Stack:** TypeScript/NestJS, Node crypto/HTTP, PostgreSQL, Vitest transport fixture, Playwright cho xác nhận hiển thị.

**Spec:** [Kế hoạch chính](2026-09-10-shopee-execution-plan.md), [contracts](2026-09-10-shopee-execution-contracts.md), [bằng chứng sandbox](../../research/shopee-lamy-listing-2026-09-10/README.md), [resilience](../../research/shopee-production-2026-09-10-performance-resilience.md).

## Global Constraints

Áp dụng Global Constraints chính. Sandbox fixture: app TEST, partner 1232297, shop 227418363, host `https://openplatform.sandbox.test-stable.shopee.sg`; không suy host từ đoạn ví dụ cũ. Scope TEST và LIVE tách tại server, DB, cache và hàng đợi. Không lấy quota/brand ID/logistics thử làm mặc định thật.

## B1 — Kết nối, ký request, token và capability theo shop

**Files tạo:** `packages/shopee/package.json`, `packages/shopee/src/sign.ts`, `packages/shopee/src/gateway.ts`, `packages/shopee/src/endpoint-registry.ts`, `packages/shopee/src/token-store.ts`, `packages/shopee/src/capabilities.ts`, `apps/api/src/connections/connections.controller.ts`, `packages/persistence/migrations/003_connections_capabilities.sql`, `docs/contracts/shopee-endpoints.json`, `tests/unit/shopee-sign.test.ts`, `tests/integration/shopee-gateway.test.ts`, `tests/integration/token-rotation.test.ts`.

**Interfaces:** `signRequest`, gateway read/write trong contracts. Endpoint registry chứa method/path/auth type/request schema/response schema/semantic error extractor/source/rights/retry category. UI không được truyền URL host hoặc tên endpoint không có trong registry.

- [ ] Đọc đầy đủ [Guide 16](../../../knowledge-base/shopee-open-platform/documents/guide/en/16.md), [Guide 20](../../../knowledge-base/shopee-open-platform/documents/guide/en/20.md), API refresh, shop info, category/brand/attributes/item limits/logistics và FAQ/thông báo tương ứng. Guide 20 đã kiểm live 10/09, UI cập nhật 24/07/2026; khi coding kiểm bản mới nếu thay đổi. Không ghi secret/token vào catalog.
- [ ] Tạo test vector public/shop bằng khóa giả và expected HMAC tính độc lập; test sai đường dẫn/thiếu access_token/shop_id. Hàm core theo auth type shop:

```ts
import { createHmac } from 'node:crypto';
export function signRequest(i: {partnerId:string;path:string;timestamp:number;partnerKey:string;accessToken?:string;shopId?:string}) {
  if ((i.accessToken === undefined) !== (i.shopId === undefined)) throw new Error('INCOMPLETE_SHOP_AUTH');
  const base = i.partnerId + i.path + String(i.timestamp) + (i.accessToken ?? '') + (i.shopId ?? '');
  return createHmac('sha256', i.partnerKey).update(base).digest('hex');
}
```

Registry dùng auth public/shop tương ứng; endpoint cấp token đọc chính xác đường dẫn thực trong tài liệu, không dùng tên method để ký. Nếu mở rộng merchant auth tạo type/fixture riêng trước dùng.

- [ ] Gateway parse HTTP và business error; giữ request_id, lỗi từng item/model; timeout sau gửi write thành UNKNOWN. Test phản hồi HTTP 200 nhưng body có lỗi bằng fake transport từ evidence; không đơn giản `response.ok === success`.

```ts
import { expect, it } from 'vitest';
import { classifyEnvelope } from '../../packages/shopee/src/gateway.js';
it('does not report HTTP 200 business rejection as success', () => {
  expect(classifyEnvelope(200,{error:'fixture.invalid_field',message:'bad field',request_id:'r1'}).kind).toBe('rejected');
});
```

`classifyEnvelope(status: number, body: Json): ApiOutcome` là hàm B1 bổ sung; extractor endpoint mới biết partial failure nằm đâu. Error code fixture không phải mã Shopee thật; fixture nguồn thật dùng mã đã quan sát.

- [ ] Cấp quyền qua callback state một lần, read shop xác nhận shop đích trước lưu connection. Token ở server, encrypted at rest với key cấu hình riêng; response/log redaction. Gia hạn một worker theo connection revision; CAS lưu token mới. Test hai job refresh đồng thời chỉ một lần; worker chết sau refresh response trước persist → trạng thái recovery/reauth theo khả năng đã xác minh, không blind-retry refresh token dùng một lần.
- [ ] Capability fetch theo app/shop/ngành/endpoint; lưu `unknown/denied/manual_required` và constraint/raw source. App được duyệt production theo user chưa chứng minh mọi endpoint có quyền. Refresh capability khi expiry, source update, lỗi quyền/schema hoặc đổi connection; không cache vô hạn.
- [ ] Chạy `shopee-sign`, `shopee-gateway`, `token-rotation`, typecheck. Đọc đúng shop sandbox bằng backend khi đã cấu hình; lưu evidence không token. Commit `feat: connect scoped Shopee gateway and rotating tokens`.

**Nghiệm thu:** sai environment/shop không có HTTP ghi ra ngoài; HTTP 200 lỗi không thành success; token rotation test có bằng chứng riêng mock/live.

## B2 — Tải ảnh và tạo item/model có checkpoint

**Files tạo:** `packages/shopee/src/media.ts`, `packages/shopee/src/product.ts`, `apps/worker/src/listing.ts`, `apps/worker/src/steps/create-item.ts`, `apps/worker/src/steps/initialize-models.ts`, `packages/persistence/migrations/004_assets_bindings.sql`, `tests/integration/create-listing.test.ts`, `tests/unit/media-cache.test.ts`.

**Interfaces:** `executeListing(planId: string): Promise<JobState>`; media `mediaCacheKey(scope: Scope, asset: AssetRef, scene: string, ratio: string): string`; `uploadAsset(scope: Scope, asset: AssetRef, scene: string, ratio: string): Promise<{imageId: Id}>`. Worker gọi adapter qua plan và claim đã lưu, không để browser giữ token.

- [ ] Đọc đầy đủ `v2.media_space.upload_image`, `v2.product.add_item`, `v2.product.init_tier_variation`, `v2.product.add_model`, `v2.product.get_item_base_info`, `v2.product.get_model_list`, guides 209/211 và thông báo liên quan. Chốt whitelist/ratio/description theo capability, không làm ảnh khác để lách check.
- [ ] Viết cache test; sha giống nhưng TEST/LIVE hoặc scene/ratio khác không dùng cùng key:

```ts
import { expect, it } from 'vitest';
import { mediaCacheKey } from '../../packages/shopee/src/media.js';
import type { AssetRef, Scope } from '../../packages/domain/src/contracts.js';
it('separates uploads by scope and scene', () => {
  const s: Scope = {environment:'sandbox',partnerId:'1232297',shopId:'227418363',connectionRevision:1,capabilityRevision:1};
  const a: AssetRef = {key:'g1',sha256:'fixture-sha',bytes:1,mime:'image/png',width:900,height:1200,
    source:{kind:'product_file',fileSha256:'fixture-sha',locator:'g1',observedAt:'2026-09-10T00:00:00Z'}};
  expect(mediaCacheKey(s,a,'gallery','3:4')).not.toBe(mediaCacheKey({...s,environment:'production'},a,'gallery','3:4'));
  expect(mediaCacheKey(s,a,'gallery','3:4')).not.toBe(mediaCacheKey(s,a,'description','3:4'));
});
```

```ts
export function mediaCacheKey(s: Scope, a: AssetRef, scene: string, ratio: string): string {
  return JSON.stringify([s.environment,s.partnerId,s.shopId,scene,ratio,a.sha256]);
}
```

Connection revision/expiry không nhất thiết làm image ID hết hiệu lực; kiểm lỗi remote/cache policy để invalidate riêng. Giữ phạm vi shop trong key đến khi có bằng chứng cho phép reuse rộng hơn.

- [ ] Implement trình tự: validate plan/capability mới → upload các ảnh đã chọn → lưu image IDs/receipt → add item ở trạng thái chưa công khai nếu API/quyền hỗ trợ → lưu item binding ngay → init models → readback mapping → kiểm nguồn/giá/tồn/ảnh → publish theo ý định đã chọn → readback trạng thái. Nếu API không hỗ trợ bước trạng thái dự kiến, báo capability gap, không âm thầm đổi luồng.
- [ ] Mỗi HTTP write có step attempt `in_flight` commit trước gửi, kết quả lưu sau nhận; timeout thành `unknown`; bước sau không chạy nếu bước trước chưa xác minh. Không áp ngủ cố định 5 giây; readiness readback có backoff/time budget, hết budget thành chờ đối soát.
- [ ] Integration fake server lưu item rồi ngắt kết nối: assert worker không gửi add_item lần hai, job UNKNOWN có receipt/attempt; ngắt sau add_item trước init model: tiếp tục đúng item ID; lỗi một ảnh: ảnh thành công có cache, không tải lại hết; catalog thiếu stock: không gọi add_item.
- [ ] Chạy integration/unit tương ứng, typecheck; commit `feat: execute checkpointed listing creation with original assets`.

**Nghiệm thu:** có plan/ảnh/attempt/binding; retry đúng bước; chưa đủ dữ kiện không sinh payload bằng default.

## B3 — Cập nhật trường chọn và đọc lại theo model identity

**Files tạo:** `packages/domain/src/models.ts`, `packages/domain/src/compare.ts`, `apps/worker/src/steps/update-listing.ts`, `apps/worker/src/reconcile-listing.ts`, `tests/unit/model-mapping.test.ts`, `tests/integration/update-listing.test.ts`.

**Interfaces:** `mapModels`/`compareReadback` trong contracts. Update tách field mask và operation dependency; đổi cấu trúc variation là luồng riêng với binding snapshot, không giả là update giá đơn giản.

- [ ] Đọc toàn bộ API update_item/update_price/update_stock/update_tier_variation/update_model liên quan và giới hạn trạng thái/quyền. Lập matrix trường → endpoint → constraint → có ảnh hưởng promotion/QC không → readback API. Trường không có API hỗ trợ thành manual_required.
- [ ] Matrix bao phủ cả video nguồn có sẵn, bảng kích cỡ, GTIN/định danh, thông tin tổ chức chịu trách nhiệm, chứng từ/ngày hết hạn, bảo hành, cân nặng/kích thước đóng gói, preorder/chuẩn bị hàng, kênh vận chuyển và ẩn/hiện. Những trường không áp dụng ngành có nhãn not_applicable. Không đưa NULL/giá trị đoán vào payload để đạt “đủ trường”. Giới hạn số model/tầng và nhánh nhiều model phải lấy capability; trước bật nhánh phải có fixture riêng.
- [ ] Nếu nguồn có video, tạo `packages/shopee/src/video.ts`, `apps/worker/src/steps/upload-video.ts`, `tests/integration/video-upload.test.ts`: đọc đầy đủ init/upload_part/complete/get_result đúng phiên bản còn hỗ trợ; lưu upload ID/part checksum/checkpoint; test mất phản hồi part, complete rồi chưa xử lý xong, expiry/cancel và readback binding. Không transcode video tự động. Khi người dùng chỉ có ảnh Lamy, nhánh video vẫn ghi chưa nghiệm thu thực, không nhận PASS từ test ảnh. Bảng kích cỡ/chứng từ thêm adapter/test theo endpoint matrix đã xác minh; nếu không có API/quyền, giữ bước Seller Center rõ ràng.
- [ ] Viết test model đảo thứ tự; chạy fail rồi implement lookup theo SKU+tier identity, reject duplicates:

```ts
import { expect, it } from 'vitest';
import { mapModels } from '../../packages/domain/src/models.js';
it('maps by identity rather than returned array order', () => {
  const expected = [{key:'white',sku:'W',tierIndex:[0]},{key:'black',sku:'B',tierIndex:[1]}];
  const actual = [
    {modelId:'9002',sku:'B',tierIndex:[1],fields:{}},
    {modelId:'9001',sku:'W',tierIndex:[0],fields:{}}
  ];
  expect([...mapModels(expected,actual)]).toEqual([['white','9001'],['black','9002']]);
});
```

```ts
export function mapModels(expected: {key:string;sku:string;tierIndex:number[]}[], actual: ListingSnapshot['models']): Map<string,string> {
  const result = new Map<string,string>();
  for (const e of expected) {
    const matches = actual.filter(a => a.sku === e.sku && JSON.stringify(a.tierIndex) === JSON.stringify(e.tierIndex));
    if (matches.length !== 1 || [...result.values()].includes(matches[0].modelId)) throw new Error('MODEL_MAPPING_AMBIGUOUS');
    result.set(e.key,matches[0].modelId);
  }
  return result;
}
```

Nếu shop cho phép SKU trống/trùng thì cần binding model_id từ lần trước và explicit mapping; không nới matcher bằng cách chọn bản đầu.

- [ ] Update đọc snapshot ngay trước ghi, kiểm lại trạng thái/khóa promotion và source version; fields ngoài mask không đưa vào body. So dữ liệu cần bảo vệ với baseline, conflict thành `waiting_input`, cho người dùng xem khác biệt và dựng plan mới.
- [ ] Comparator giữ riêng desired raw và normalization có nguồn: currency/weight precision, image IDs/role order, text block line breaks; không so response write cũ như snapshot cuối. Chỉ poll các field API trả được; nếu cần hiển thị web mới kiểm được, ghi một bước xác nhận UI có evidence riêng.
- [ ] Test HTTP 200 partial model, response cũ rồi readback mới, external edit trước và sau write, chỉ đổi title không đưa stock/price, SKU mapping ambiguous, REVIEWING chặn trường; stock retry không ghi đè giảm tồn sau đơn. Chạy tests/commit `feat: reconcile selective updates by stable listing identity`.

**Nghiệm thu:** payload update review được, readback có diff theo trường; không báo thành công khi chưa xác định đúng model.

## B4 — Một luồng Lamy trực tiếp và bằng chứng sandbox

**Files tạo:** `tests/sandbox/lamy-direct.test.ts`, `tests/sandbox/new-product-direct.test.ts`, `tests/sandbox/scope.ts`, `scripts/sandbox-lamy.mts`, `docs/runbooks/sandbox-test.md`, `docs/test-reports/sandbox-direct/README.md`.

**Interfaces:** CLI Lamy nhận plan ID đã lưu và chế độ `read` hoặc `execute`; scope cố định từ cấu hình TEST đã xác nhận, item Lamy là **803934364**. Theo AGENTS không tạo thêm bản Lamy trùng để tiếp tục công việc: CLI này chỉ read/update item đã có. Test create thật tách sang `new-product-direct.test.ts`, cần một sản phẩm khác đủ nguồn và thuộc phạm vi sandbox được cho phép; fixture có binding riêng để không tạo lại khi rerun.

- [ ] Chuẩn bị plan Lamy sáu SKU bằng nguồn/mapping A; xem lại brand pending, ngành, logistics và fields thiếu. Các ngoại lệ sandbox phải gắn TEST rõ. Giữ GIÁ GỐC, mô tả đủ g1–g9 sau headline và dòng trống; không tự tạo promo để có giá gạch.
- [ ] Gate scope có test unit trước kết nối:

```ts
export function requireLamySandbox(environment:string, partnerId:string, shopId:string): void {
  if (environment !== 'sandbox' || partnerId !== '1232297' || shopId !== '227418363') throw new Error('SANDBOX_SCOPE_MISMATCH');
}
```

Test đưa production, partner khác, shop khác đều throw; sau đó chạy read-only trực tiếp xác nhận shop. Chỉ dùng credential cấu hình server, không chép token từ file evidence.

- [ ] Chạy Lamy read/update field đã chọn trên 803934364, giữ item/attempt IDs để resume. Create được kiểm bằng fake server trước; chỉ chạy create sandbox bằng sản phẩm khác đủ nguồn/phạm vi, không nhân bản Lamy. Khi chưa có mẫu create phù hợp ghi NOT_RUN và tiếp tục các phép thử độc lập. Không đưa bước delete/unlist cleanup vào mặc định nếu không thuộc ý định test. Test runner không tự ghi production khi thiếu biến môi trường sandbox.
- [ ] Đọc lại item/models/ảnh/mô tả/giá/tồn và quan sát hiển thị; dùng expected từ nguồn **độc lập** với code build payload để tránh lỗi giống nhau ở implementation và test. Lưu thời điểm, endpoint, request ID, field diff, status, dữ liệu đã che secret.
- [ ] Báo cáo riêng PASS/FAIL/NOT_RUN/MANUAL_REQUIRED cho tạo, variation, ảnh/description, update, readback và QC. Brand pending không thành approved. Commit `test: verify direct sandbox listing flow and evidence`.

**Gate G2:** read/update Lamy có bằng chứng backend thật; create thật có gate riêng với sản phẩm không trùng. Chỉ đạt đầy đủ G2 khi cả hai được kiểm; chưa tuyên bố create backend đã nghiệm thu từ việc đọc item tạo bằng Console, hoặc tốc độ lô/QC production đã đạt.
