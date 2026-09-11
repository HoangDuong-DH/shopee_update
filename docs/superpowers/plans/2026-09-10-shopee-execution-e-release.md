# E — Triển khai, đo tải và bàn giao — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans`; E1/E2 chỉ báo complete khi có bằng chứng của môi trường thực được kiểm. Không cấp dịch vụ tính phí hoặc ghi production ngoài phạm vi đã được phép.

**Goal:** Bàn giao bản chạy bền vững, quan sát/backup/khôi phục được, có báo cáo năng suất và pilot đúng shop.

**Architecture:** Web/API và worker là process triển khai riêng; PostgreSQL bền vững, asset store, queue và supervisor. Kiến trúc cloud tham chiếu AWS Singapore với ECS/RDS/S3/SQS, truy cập UI qua mạng riêng; OAuth callback/push có cổng nhận riêng khi cần.

**Tech Stack:** Docker build nhiều stage, hạ tầng khai báo, AWS SDK adapters, OpenTelemetry/metrics, PostgreSQL backup, Vitest/Playwright và load harness.

**Spec:** [Kế hoạch chính](2026-09-10-shopee-execution-plan.md), [contracts](2026-09-10-shopee-execution-contracts.md), [kiến trúc](../specs/2026-09-09-shopee-production-architecture-design.md), [mô hình hiệu năng chưa benchmark](../../research/shopee-production-2026-09-10-time-estimates.md).

## Global Constraints

Áp dụng Global Constraints chính. Không nhận laptop mở trình duyệt là hạ tầng 24/7. Không tạo automation coding 24 giờ trong task này. Không thêm auth nhân viên vào baseline; vẫn phải giữ token ở server và không mở toàn bộ UI chung ra Internet để nhận webhook.

## E1 — Bản triển khai, giám sát và khôi phục

**Files tạo:** `infra/docker/api.Dockerfile`, `infra/docker/worker.Dockerfile`, `infra/docker/web.Dockerfile`, `infra/aws/main.tf`, `infra/aws/variables.tf`, `infra/aws/outputs.tf`, `infra/aws/versions.tf`, `packages/persistence/src/asset-store.ts`, `apps/api/src/telemetry.ts`, `apps/worker/src/telemetry.ts`, `scripts/release-check.mts`, `docs/runbooks/deployment.md`, `docs/runbooks/backup-restore.md`, `docs/runbooks/token-recovery.md`, `tests/integration/storage-adapters.test.ts`.

**Interfaces:** `AssetStore.put(key: string, bytes: Uint8Array, sha256: string): Promise<void>`; `get(key:string): Promise<Uint8Array>` cùng nghĩa cho filesystem dev và S3. SQS adapter cùng WakeupQueue C1. Metrics dùng jobId/attemptId để truy vết, tránh shop/SKU làm label vô hạn.

- [ ] Khóa runtime/dependency/image digest; build reproducible. Release image không chứa source workbook/token/assets test lớn. API startup readiness kiểm migration, worker startup recovery scan; graceful shutdown như C4. DB migration có kế hoạch nâng cấp tương thích, không rollback schema phá dữ liệu để quay image cũ.
- [ ] Chọn môi trường triển khai với người dùng khi đã có cấu hình và dự toán cụ thể. Chuẩn bị Terraform plan để review, không apply dịch vụ tính phí khi chưa được chọn ngân sách/môi trường. Baseline AWS là template tham chiếu; nếu chọn máy chủ riêng, điều chỉnh adapter/deployment plan trước thực thi, không tuyên bố hai nền tảng đều đã nghiệm thu.
- [ ] Cloud template: UI/API private access, callback/push chỉ expose route cần thiết với verification theo source; worker outbound, DB private, S3 versioning/lifecycle, SQS DLQ và outbox. Token encrypt/key server, redaction log. App không có tài khoản nhân viên nhưng không để origin khác gọi mutation qua browser của người dùng.
- [ ] Storage contract test byte/hash roundtrip, duplicate key content khác bị conflict; ảnh không đổi sau upload/download. Ví dụ điều kiện kiểm trong test adapter:

```ts
import { createHash } from 'node:crypto';
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
// Chạy cùng assertion cho adapter filesystem và S3 test bucket đã cấu hình.
export async function verifyRoundTrip(store: AssetStore, key: string, bytes: Uint8Array) {
  const expected = sha256(bytes);
  await store.put(key, bytes, expected);
  const actual = await store.get(key);
  if (sha256(actual) !== expected) throw new Error('ASSET_HASH_MISMATCH');
}
```

- [ ] Thiết lập cảnh báo cụ thể: job quá lâu chưa có heartbeat; UNKNOWN chưa giải quyết; token cần reauth; quota cạn; outbox backlog; DB/kho ảnh không dùng được; DLQ; QC gần deadline. Không spam thành công từng API. Log có endpoint/request ID/duration/error category, không access/refresh token/signature URL đầy đủ.
- [ ] Backup DB + object manifest, kiểm restore vào DB/bucket test riêng và read-only reconcile. Restore có thể phục hồi token revision cũ và thiếu job mới; quarantine kết nối/ghi, đối chiếu token/shop/job với Shopee trước resume, không tự phát lại create/stock từ backup. RPO/RTO mục tiêu chỉ chốt sau chọn infra; báo RPO/RTO đo được, không lấy setting backup làm kết quả.
- [ ] Chạy build/release-check/storage tests và restore drill có người theo dõi; lưu resource IDs của môi trường test, thời gian, hash, job states. Commit `ops: package deployment and verify recovery procedures`.

**Nghiệm thu độc lập:** có bản cài chạy được, cấu hình/hướng dẫn và phục hồi được dữ liệu vào môi trường tách biệt; chưa nhận 24/7 chỉ vì service auto-restart đã bật.

## E2 — Fault/load/soak, pilot và đóng dự án

**Files tạo:** `tests/load/run.mts`, `tests/load/workloads.json`, `tests/load/report.mts`, `tests/soak/run.mts`, `tests/fixtures/acceptance/requirements.json`, `docs/test-reports/release-candidate/README.md`, `docs/test-reports/release-candidate/results.json`, `docs/runbooks/pilot-production.md`, `docs/runbooks/operator-guide.md`.

**Interfaces:** `Workload={name:string;mode:'simulated'|'sandbox';listingCount:number;concurrency:number;seed:number;assetBytes:number[];modelCounts:number[]}`. Production test không được bật bằng flag chung của load harness. Report ghi source commit, env, workload, real/virtual clock, start/end, successfulReadbacks, UNKNOWN/failed/waiting, API count, bandwidth, latency và quota observations.

- [ ] Tạo requirement-to-test matrix từ 16 task và 19 ca logic/QC trong spec. Mỗi requirement có test ID, môi trường và trạng thái PASS/FAIL/NOT_RUN/MANUAL_REQUIRED, source evidence. Không đánh PASS cho test skip vì thiếu credential.
- [ ] Đo mô phỏng đầy đủ 10/30/80, concurrency 1/2/4/8 theo kế hoạch chính; dùng sản phẩm/model/ảnh khác nhau để phản ánh upload mới và nguồn đa dạng. Tách warm cache/cold cache, failure injection và baseline; không gom lại rồi quảng cáo một số đẹp.
- [ ] Chạy sandbox representative trong đúng scope: ưu tiên nguồn đã đủ thông tin, fixture identity rõ; không tạo hàng trăm bản trùng Lamy chỉ để đo. Đọc quota/limit thực từ app/API nếu cung cấp; nếu chỉ có lỗi throttling quan sát được thì ghi “chưa xác định quota”, không reverse-engineer ngưỡng bằng cách cố bắn quá tải.
- [ ] Report kiểm số liệu tối thiểu bằng code:

```ts
export function verifiedThroughput(verified: number, elapsedSeconds: number): number {
  if (!Number.isSafeInteger(verified) || verified < 0 || !Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) {
    throw new Error('INVALID_MEASUREMENT');
  }
  return verified / elapsedSeconds;
}
```

Unit: 80 verified/3600s = 80/3600 link/s; pending/UNKNOWN không được cộng vào verified; elapsed=0 bị reject. Extrapolate 24h phải trừ quota, thời gian gián đoạn đã đo và capacity shop, không nhân throughput API burst thành cam kết đăng công khai.

- [ ] Soak 24 giờ thực trên môi trường test hoạt động liên tục: hỗn hợp nhập/xem trước/read/ghi giả lập, job scheduling, token fixture rollover, restarts có chủ đích, SSE reconnect, backup. Sandbox token/push thật chỉ đánh PASS nếu thực sự quan sát được. Báo phần soak là simulator, sandbox hay hỗn hợp; không nhận chạy clock giả 24h là soak thật.
- [ ] Không chuyển pilot nếu còn critical sai shop/SKU/giá/tồn, tạo trùng do retry, mất job đã ack hoặc restore không phục hồi được. Lỗi quyền/tính năng chưa hỗ trợ có đường thao tác rõ và nhãn chưa nghiệm thu, không bỏ khỏi báo cáo.
- [ ] Chuẩn bị pilot manifest: shop/environment, app connection, listing mới/cũ, product source revision, giá gốc, stock command theo từng SKU/shop, ảnh/nội dung, ngành/brand/hồ sơ, field mask, lịch và người vận hành. Làm đủ preview/evidence trước bước xin phép ghi thật nếu chưa được cấp. Không bắt người dùng xác nhận lại phần sandbox/code đã cho phép.
- [ ] Pilot sau khi được phép: một lô nhỏ đủ dữ liệu trên shop thường; Mall có gate brand/hồ sơ riêng; tăng dần trên nguồn sản phẩm khác nhau. Không tự chọn 46 shop hoặc clone cùng sản phẩm hàng loạt. Báo từng listing kỹ thuật/readback/QC, ngoại lệ, thời gian và chi phí hạ tầng đo được.
- [ ] Handover bản phát hành + operator guide: nhập nguồn, chọn shop, stock thủ công, preview/submit, xử lý UNKNOWN/QC, resume và truy nguồn. Cập nhật final matrix, known limitations và backlog còn thiếu. Commit `release: record acceptance evidence and operator handover`.

**Gate G5:** release candidate có test/load/soak/restore; production readiness có phạm vi và pilot đã được phép. Tính năng chưa được API cấp quyền không thể nghiệm thu thành tự động end-to-end; hệ thống cần giữ bước thủ công đó hiển thị rõ và tiếp tục được sau khi người dùng hoàn tất.

## Hoàn thành có bằng chứng

Không dùng số dòng code, số agent hoặc tên framework làm tiêu chí. Người dùng phải thao tác được từ nguồn đến kết quả đọc lại; job có thể phục hồi; dữ liệu không bị tự đổi; báo cáo ghi chính xác phần đã test thật và phần còn phụ thuộc Shopee.
