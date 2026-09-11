# Hợp đồng triển khai Shopee — dữ liệu và ranh giới

**Trạng thái:** thiết kế để triển khai, 10/09/2026. Tất cả đường dẫn code bên dưới là đường dẫn dự kiến tính từ root. Đọc cùng [kế hoạch thực thi](2026-09-10-shopee-execution-plan.md) và spec, không coi đây là schema OpenAPI của Shopee.

## Dữ liệu dùng chung — A2 tạo `packages/domain/src/contracts.ts`

```ts
export type Id = string; // ID ngoài hệ thống giữ chuỗi; không qua Number để so sánh.
export type IsoTime = string; // RFC3339 UTC; lịch người dùng có timezone riêng.
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Environment = 'sandbox' | 'production';
export type SourceRef = {
  fileSha256: string; locator: string; observedAt: IsoTime;
  kind: 'product_file' | 'user_decision' | 'official_doc' | 'seller_observation';
  url?: string; sourceUpdatedAt?: IsoTime; effectiveAt?: IsoTime;
};
export type Fact<T> = { value: T; sources: SourceRef[]; confirmed: boolean };
export type MoneyVnd = string; // Chuỗi số nguyên không âm; tính bằng bigint.
export type Issue = {
  code: string; severity: 'block' | 'warn'; field: string;
  message: string; sources: SourceRef[];
};
export type Scope = {
  environment: Environment; partnerId: Id; shopId: Id;
  connectionRevision: number; capabilityRevision: number;
};
export type AssetRef = {
  key: string; sha256: string; bytes: number; mime: string;
  width: number; height: number; durationMs?: number; source: SourceRef;
};
export type ContentBlock = { type: 'text'; text: string }
  | { type: 'image'; assetKey: string };
export type Variant = {
  key: string; sku: Fact<string>; optionLabels: string[];
  originalPrice: Fact<MoneyVnd>; promotionTarget?: Fact<MoneyVnd>;
  imageKey?: string; declaredWeightGrams?: Fact<string>;
};
export type DraftField = 'title' | 'description' | 'gallery' | 'category'
  | 'brand' | 'attributes' | 'variations' | 'price' | 'stock' | 'logistics'
  | 'video' | 'sizeChart' | 'identifiers' | 'compliance' | 'fulfillment' | 'publication';
export type ListingDraft = {
  productKey: string; revision: number; title: Fact<string>;
  description: ContentBlock[]; coverKey: string; galleryKeys: string[];
  tierNames: string[]; variants: Variant[]; assets: AssetRef[];
  categoryId?: Fact<Id>; brandId?: Fact<Id>;
  attributes: Record<string, Fact<Json>>;
  logistics: Record<string, Fact<Json>>;
  videoKeys?: string[]; sizeChartKey?: string;
  identifiers?: Record<string, Fact<Json>>;
  compliance?: Record<string, Fact<Json>>;
  fulfillment?: Record<string, Fact<Json>>;
  publication?: Fact<'listed' | 'unlisted'>; issues: Issue[];
};
export type StockInstruction = {
  scope: Scope; sku: string; quantity: number; revision: number;
  commandId: string; decidedAt: IsoTime; source: SourceRef;
};
export type Capability = {
  name: string; state: 'supported' | 'denied' | 'unknown' | 'manual_required';
  scope: Scope; observedAt: IsoTime; expiresAt: IsoTime;
  constraints: Record<string, Json>; sources: SourceRef[];
};
export type ListingSnapshot = {
  itemId: Id; scope: Scope; observedAt: IsoTime; fingerprint: string;
  fields: Partial<Record<DraftField, Json>>;
  models: { modelId: Id; sku: string; tierIndex: number[]; fields: Record<string, Json> }[];
  platformStatus: string; deboosted: boolean | null; qualityGrade: number | null;
};
export type ChangePlan = {
  id: string; revision: number; fingerprint: string; scope: Scope;
  productKey: string; sourceRevision: number;
  operation: 'create' | 'update' | 'promotion';
  itemId?: Id; fieldMask: DraftField[]; desired: ListingDraft;
  stocks: StockInstruction[]; baseline?: ListingSnapshot;
  issues: Issue[]; createdAt: IsoTime;
};
export type JobState = 'queued' | 'running' | 'waiting_retry' | 'waiting_input'
  | 'waiting_external' | 'unknown' | 'verified' | 'failed' | 'cancelled';
export type StepState = 'pending' | 'in_flight' | 'unknown' | 'verified' | 'failed';
export type ApiOutcome =
  | { kind: 'success'; requestId?: string; data: Json }
  | { kind: 'partial'; requestId?: string; data: Json; failures: Json[] }
  | { kind: 'rejected'; code: string; requestId?: string; data: Json }
  | { kind: 'unknown'; reason: 'timeout' | 'disconnected' | 'invalid_response' };
export type ReconcileDecision = 'matched' | 'different' | 'inconclusive';
export type Clock = { now(): Date };
```

`Id` dùng chuỗi là hợp đồng **nội bộ**. Adapter chuyển đúng kiểu wire Shopee; nếu schema yêu cầu số và vượt miền nguyên an toàn của JavaScript, không ép kiểu mất dữ liệu, dùng serializer có hỗ trợ số nguyên chính xác được kiểm bằng fixture. Không thay hết trường ID wire thành chuỗi một cách máy móc.

`promotionTarget`, `brandId`, chứng từ, cân nặng chưa có không tự thành 0/No Brand. Các thuộc tính API cụ thể có schema riêng trong catalog; `Json` ở biên lưu trữ không có nghĩa chấp nhận payload tùy ý từ UI.

## Các hàm nghiệp vụ và adapter

| Task và file tạo | Hợp đồng | Ý nghĩa |
| --- | --- | --- |
| A2 `source/normalize.ts` | `parseVnd(value: string): MoneyVnd`; `compileDescription(headline: string, body: string, imageKeys: string[]): ContentBlock[]` | Giá không làm tròn ngầm; cấu trúc ảnh mô tả theo yêu cầu |
| A2 `source/kini.ts` | `readKini(bytes: Uint8Array, filename?: string): Promise<WorkbookImport>` | Trả catalog rows và nguồn từng ô; người vận hành nhóm listing. Hợp đồng được cập nhật khi triển khai để giữ hai bộ giá và các khối độc lập |
| A2 `source/word.ts` | `readWord(bytes: Uint8Array): Promise<{paragraphs: string[]; source: SourceRef}>` | Giữ đoạn, khoảng trắng và provenance; ghép theo mapping người dùng |
| A2 `source/assets.ts` | `inspectAssets(files: {key: string; bytes: Uint8Array}[]): Promise<AssetRef[]>` | Hash và đọc metadata, không sinh lại ảnh |
| A3 `plans.ts` | `makePlan(input: Omit<ChangePlan,'id'|'fingerprint'|'createdAt'>, clock: Clock): ChangePlan` | Bản bất biến; canonical hash không đảo thứ tự ảnh/variation |
| A3 `stock.ts` | `shouldApplyStock(command: StockInstruction, appliedRevision: number): boolean` | Chỉ áp lệnh mới, không bù tồn sau đơn |
| B1 `gateway.ts` | `read(scope: Scope, endpoint: string, params: Json): Promise<ApiOutcome>`; `write(scope: Scope, endpoint: string, payload: Json, attemptId: string): Promise<ApiOutcome>` | Endpoint phải có trong registry có schema; server chọn host, credentials |
| B1 `sign.ts` | `signRequest(input: {partnerId: Id; path: string; timestamp: number; partnerKey: string; accessToken?: string; shopId?: Id}): string` | Chữ ký theo loại request, test vector riêng public/shop |
| B2 `listing.ts` | `executeListing(planId: string): Promise<JobState>` | Dùng DB để claim, lưu từng bước; không nhận raw payload từ agent |
| B3 `compare.ts` | `compareReadback(plan: ChangePlan, snapshot: ListingSnapshot): {decision: ReconcileDecision; issues: Issue[]}` | So sánh theo field mask/SKU/tier mapping, normalize có nguồn |
| B3 `models.ts` | `mapModels(expected: {key: string; sku: string; tierIndex: number[]}[], actual: ListingSnapshot['models']): Map<string, Id>` | Reject duplicate/missing/ambiguous; không nối theo thứ tự mảng |
| C1 `jobs.ts` | `claimJob(jobId: string, workerId: string): Promise<{epoch: number} | null>`; `finishStep(attemptId: string, epoch: number, result: ApiOutcome): Promise<boolean>` | Lease có epoch, kết quả cũ lưu bằng chứng nhưng không ghi đè hiện trạng |
| C2 `retry.ts` | `decideRecovery(input: {writeSent: boolean; result: ApiOutcome; attempts: number}): 'retry_read' | 'reconcile' | 'wait_input' | 'complete'` | Kết quả ghi không rõ phải đối soát; retry có ngân sách riêng |
| C3 `qc.ts` | `projectQc(snapshot: ListingSnapshot): {platformStatus: string; deboosted: boolean | null; qualityGrade: number | null}` | Không ép ba chiều trạng thái thành một success boolean |
| D1 `pricing.ts` | `checkVariantRatio(prices: MoneyVnd[], maximumRatio: number): boolean` | Quy tắc có phạm vi từ rule catalog; không lấy 5 làm hằng số toàn thị trường |
| D2 `harness.ts` | `resolveAgentScope(sessionId: string, requestedPlanId: string): Promise<Scope>`; `runAssistant(sessionId: string, question: string): Promise<{text: string; sourceIds: string[]; proposedPlanId?: string}>` | Scope từ server; tool call luôn kiểm plan/permission mới nhất |

Các file `source/*`, `plans.ts`, `stock.ts`, `compare.ts`, `models.ts`, `retry.ts`, `qc.ts`, `pricing.ts` nằm trong `packages/domain/src/`; gateway/sign trong `packages/shopee/src/`; listing/jobs trong worker; harness trong agent-runtime. Mỗi file có `index.ts` package export tường minh, không export secret store ra web.

## Database — A3 và C1 hoàn thiện

| Bảng | Nội dung và ràng buộc cần có |
| --- | --- |
| `shop_connections` | environment/partner/shop unique; token ciphertext, token revision, trạng thái refresh, expires_at; không trả token qua API UI |
| `source_files`, `source_mappings`, `products`, `product_revisions` | SHA, bản gốc, vị trí nguồn, mapping từng khối; revision bất biến |
| `assets`, `asset_uploads` | SHA/key/metadata; cache upload theo environment/partner/phạm vi shop nếu cần/scene/ratio/SHA; không mặc định image ID dùng được mọi shop |
| `capability_snapshots`, `rule_versions` | Nguồn, ngày, scope, trạng thái xác minh; rule đã dùng bởi plan được giữ lại |
| `listing_bindings`, `model_bindings`, `listing_snapshots` | product↔shop↔item; variant↔model; ID giữ chuỗi; unique theo đúng scope và variant key |
| `stock_instructions` | unique scope/SKU/revision, command ID chống lặp; tách observed stock và last applied command |
| `change_plans`, `plan_revisions` | desired/field mask/baseline/hash/scope; plan đã chạy không chỉnh tại chỗ |
| `jobs`, `job_steps`, `step_attempts` | state, next_run_at, lease_until, lease_epoch, attempt IDs, request IDs, readback evidence, timestamps |
| `outbox`, `inbox_events` | Ghi job+outbox một transaction; event dedupe, raw đã che secret, processed_at; không suy thứ tự từ lúc nhận push |
| `qc_cases`, `promotion_plans`, `agent_runs` | Vi phạm/deadline; ý định chương trình; tool/trace/source/budget; không lưu dữ liệu người mua |

Thêm constraint/index trong task dùng bảng; migration có checksum và script tiến/lùi được kiểm trên DB dùng thử. Không giữ transaction DB trong khi chờ HTTP. Unique plan submission `(plan_id, revision)` chặn double-click; người dùng cố ý chạy lại tạo revision/command mới sau kiểm lại. Điều này khác trùng sản phẩm chính sách và không bảo đảm exactly-once ở Shopee.

## API nội bộ — A4/B/C/D dùng chung

- `POST /v1/imports`: upload nguồn, trả 202 và import ID sau khi tệp được lưu. Không đọc path tùy ý trên server từ request client.
- `GET /v1/imports/:id`, `GET /v1/products`, `PUT /v1/products/:key/mapping`: nguồn, lỗi và revision mapping; sửa mapping tạo revision mới.
- `GET /v1/shops`, `POST /v1/connections/authorize`, `GET /v1/connections/callback`: kết nối Shopee; callback kiểm state một lần và shop thực tế.
- `POST /v1/plans`: nhập productRevision/scope/fieldMask/stockCommands/operation, trả plan, issues và preview. Server tự dựng payload.
- `POST /v1/plans/:id/submit`: body `{revision, fingerprint}`; 202 `{jobId}` nếu đã lưu; double-click trả cùng job, hash/revision cũ trả 409.
- `GET /v1/jobs`, `GET /v1/jobs/:id`, `GET /v1/events`: danh sách, chi tiết và SSE có cursor. Cursor hết hạn trả chỉ dẫn tải snapshot, không mất trạng thái vĩnh viễn.
- `POST /v1/jobs/:id/pause`, `/resume`, `/cancel`: pause/cancel chỉ ngăn các bước chưa gửi; resume preflight lại; không xóa sản phẩm tự động.
- `GET /v1/qc`, `POST /v1/promotion-plans`, `POST /v1/assistant/messages`: dùng cùng domain/service và ranh giới scope.

Các mutation API UI dùng cùng origin và kiểm origin hợp lệ trong mạng nội bộ; đây là bảo vệ tránh website khác kích hoạt lệnh qua trình duyệt, không thêm hệ thống tài khoản. Shop mục tiêu và môi trường luôn hiện rõ ở preview/submit/job.

## Bất biến trạng thái để nghiệm thu

1. Chỉ báo `verified` sau readback các trường bắt buộc; không dùng HTTP 200 hoặc item_id đơn lẻ.
2. Ghi bị timeout/worker chết sau gửi → `unknown` → đối soát. Tạm thời chưa tìm thấy item không chứng minh chưa tạo; không retry create mù.
3. Lease epoch chặn worker cũ sửa DB hiện hành, **không chặn Shopee nhận HTTP muộn**. Khi takeover phải đối soát bước đã gửi; kiểm scope/epoch ngay trước dispatch chỉ giảm cửa sổ đua, không biến API thành transaction.
4. External edit không có compare-and-swap Shopee được xác minh: đọc trước/đọc sau, bảo toàn field mask, hiển thị conflict; không hứa loại bỏ tuyệt đối cuộc đua với Seller Center.
5. Poll/push cập nhật platform/QC độc lập job. API không trả field không được suy là field trống hoặc QC sạch.
6. `REVIEWING`, brand pending, deboost, quality grade và điều kiện Flash không thể gộp thành một nhãn “được Shopee duyệt”.
