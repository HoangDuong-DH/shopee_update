# C — Chạy lô, phục hồi và QC — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans`; C1–C4 mở rộng trên luồng B đã có checkpoint, không thay state machine bằng vòng lặp agent.

**Goal:** Có lô bền vững, không mất tiến độ khi lỗi, công việc độc lập tiếp tục, UI theo dõi được trạng thái kỹ thuật và QC riêng.

**Architecture:** PostgreSQL là nguồn tiến độ; outbox đánh thức worker, lease/epoch bảo vệ job. Push là tín hiệu để đối soát, không phải bản trạng thái duy nhất.

**Tech Stack:** PostgreSQL, worker TypeScript, SQS adapter, SSE, Vitest fake clock/HTTP, Playwright.

**Spec:** [Kế hoạch chính](2026-09-10-shopee-execution-plan.md), [contracts](2026-09-10-shopee-execution-contracts.md), [resilience](../../research/shopee-production-2026-09-10-performance-resilience.md), [logic/QC và 19 ca](../../research/shopee-production-2026-09-10-listing-logic-qc.md).

## Global Constraints

Áp dụng Global Constraints chính. Không tự tạo lại listing khi chưa rõ kết quả, không tự bù tồn, không rollback giá/tồn cũ sau đơn. Một job bị chặn dữ liệu không làm dừng các shop/job độc lập. Lỗi cùng app/token/endpoint có thể cần dừng đúng nhóm phụ thuộc.

## C1 — Outbox, lease và lịch chạy bền vững

**Files tạo:** `apps/worker/src/jobs.ts`, `apps/worker/src/outbox-dispatcher.ts`, `apps/worker/src/scheduler.ts`, `apps/worker/src/queue/queue.ts`, `apps/worker/src/queue/postgres-wakeup.ts`, `apps/worker/src/queue/sqs-wakeup.ts`, `packages/persistence/migrations/005_job_leases.sql`, `tests/integration/job-leases.test.ts`, `tests/integration/outbox.test.ts`.

**Interfaces:** `claimJob`, `finishStep` trong contracts. Queue chỉ chuyển `{jobId,eventId}`, không chứa token/nguồn lớn. `WakeupQueue.send(jobId: string, eventId: string): Promise<void>`; nhận message cũng phải claim DB.

- [ ] Tạo integration test hai worker tranh cùng job, duplicate message, gửi outbox thành công rồi chết trước đánh dấu; expected chỉ một owner và không lặp external write. Test DB thật, không thay transaction bằng map trong RAM.
- [ ] Migration lease columns và SQL claim, kiểm điều kiện trạng thái lẫn due time:

```sql
UPDATE jobs SET lease_epoch = lease_epoch + 1,
  lease_owner = $2, lease_until = now() + interval '60 seconds', state = 'running'
WHERE id = $1 AND state IN ('queued','waiting_retry') AND next_run_at <= now()
  AND (lease_until IS NULL OR lease_until < now())
RETURNING lease_epoch;
```

60 giây là cấu hình khởi đầu của app để test, không giới hạn Shopee; heartbeat khoảng 15 giây khi đang xử lý. Thời gian HTTP/heartbeat/lease phải đo cùng nhau. Expired `running/in_flight` đi qua recovery scan thành UNKNOWN để đối soát, không vào câu claim này như chưa chạy.

- [ ] Ghi finish có predicate `lease_epoch=$epoch`; receipt của worker cũ vẫn append vào attempt evidence, không cập nhật current job. Test finish epoch cũ trả false. Outbox relay at-least-once; consumer dedupe event + unique step identity.
- [ ] Scheduler lưu `next_run_at` UTC, timezone người dùng riêng (mặc định Asia/Ho_Chi_Minh cho lịch VN); khi restart truy vấn due jobs. Không giữ message in-flight trong queue chờ tới ngày mai; DB due scan tạo wakeup mới. Downtime qua lịch chạy không âm thầm bỏ job.
- [ ] Chạy lease/outbox integration, test interruption ở từng ranh giới DB/queue; commit `feat: dispatch durable jobs with fenced leases and scheduling`.

**Nghiệm thu:** queue lặp và process chết không mất job; late HTTP response vẫn có đường đối soát, không tuyên bố fence ở DB kiểm soát được phía Shopee.

## C2 — Retry có phân loại, quota và UNKNOWN

**Files tạo:** `packages/domain/src/retry.ts`, `apps/worker/src/rate-budget.ts`, `apps/worker/src/recovery.ts`, `apps/worker/src/circuit-breaker.ts`, `tests/unit/recovery.test.ts`, `tests/integration/fault-injection.test.ts`, `tests/fixtures/faults/scenarios.json`.

**Interfaces:** `decideRecovery` từ contracts. Rate budget keyed environment/app/endpoint/shop theo scope quota thật; `acquire` trả permit hoặc `next_run_at`, không block UI. UNKNOWN create không retry tự động cho đến khi có bằng chứng đủ kết luận.

- [ ] Viết test core rồi chạy fail:

```ts
import { expect, it } from 'vitest';
import { decideRecovery } from '../../packages/domain/src/retry.js';
it('reconciles a write timeout instead of repeating creation', () => {
  expect(decideRecovery({writeSent:true,result:{kind:'unknown',reason:'timeout'},attempts:1})).toBe('reconcile');
  expect(decideRecovery({writeSent:false,result:{kind:'unknown',reason:'timeout'},attempts:1})).toBe('retry_read');
});
```

```ts
export function decideRecovery(i:{writeSent:boolean;result:ApiOutcome;attempts:number}) {
  if (i.result.kind === 'unknown') return i.writeSent ? 'reconcile' : (i.attempts < 5 ? 'retry_read' : 'wait_input');
  if (i.result.kind === 'success') return 'complete'; // bước transport; job vẫn phải readback
  if (i.result.kind === 'partial') return 'reconcile';
  return 'wait_input';
}
```

Hàm trên là default bảo thủ. Endpoint classifier từ B1 mới được đánh dấu lỗi từ chối tạm thời có thể retry; không retry mọi `rejected`. `retry_read` chỉ cho call được xác định là đọc/chưa gửi mutation, không dựa riêng method GET/POST. Test budget 5 là cấu hình nội bộ, không tần suất được Shopee cấp.

- [ ] Backoff khởi đầu 1 giây, exponential full jitter, cap 60 giây cho lỗi transient; tôn trọng server retry timing khi có. Rate limit giảm permit cho đúng nhóm; token invalid chuyển connection recovery; schema/attribute/brand/price/logistics thành cần input/refresh capability. Không sửa payload ngẫu nhiên rồi retry.
- [ ] Trước xử lý UNKNOWN đọc binding/current item/models và ledger; nếu có nhiều ứng viên hoặc readback chưa đủ, giữ `inconclusive`. Không “không thấy ngay” → tạo lại. Cập nhật tồn bị timeout mà observed stock đã giảm không đủ chứng minh lệnh chưa chạy; không gửi lại quantity cũ chỉ để match.
- [ ] Fault scenarios bắt buộc: response lost after apply; transport disconnect before send; HTTP 200 lỗi; 429/rate-limit nghiệp vụ; 5xx; partial models; stale readback; worker kill; duplicate queue; token refresh race/lost response; DB outage; expired image ID; external Seller edit; capability đổi; hết quota/listing capacity. Mỗi scenario có seed, inject point, expected state/call count/readback, thời gian fake riêng.
- [ ] Chạy `recovery.test.ts` và `fault-injection.test.ts`, báo từng case và commit `feat: classify retries and reconcile uncertain mutations`.

**Nghiệm thu:** lỗi chưa hiểu được đưa vào trạng thái cần điều tra có bằng chứng; không giả tự chữa được mọi lỗi. Circuit breaker mở theo lỗi hạ tầng/quyền chung, không vì một sản phẩm sai thuộc tính mà chặn cả shop vô lý.

## C3 — Push, đối soát và QC nhiều chiều

**Files tạo:** `apps/api/src/webhooks/shopee.controller.ts`, `apps/worker/src/qc-reconciler.ts`, `packages/domain/src/qc.ts`, `packages/persistence/migrations/006_qc_inbox.sql`, `tests/unit/qc.test.ts`, `tests/integration/push-qc.test.ts`.

**Interfaces:** `projectQc(snapshot)` giữ các chiều platformStatus/deboosted/qualityGrade. Webhook handler persist event trước ack; validation chữ ký/endpoint theo tài liệu đúng loại push; không dùng raw push body cập nhật item khác shop.

- [ ] Đọc toàn bộ get_item_violation_info, get_item_content_diagnosis_result, push item violation và Uni liên quan; dùng nguồn/ngày trong báo cáo QC. Endpoint POST chẩn đoán vẫn là thao tác đọc; auth policy không phân quyền write chỉ dựa HTTP verb. Hai spelling `deboost_details`/`deboosted_details` trong tài liệu cần fixture có nhãn, giữ raw, chưa nhận thực tế không tự gọi “đã xác nhận schema”.
- [ ] Test NORMAL + deboost không mất cảnh báo:

```ts
import { expect, it } from 'vitest';
import { projectQc } from '../../packages/domain/src/qc.js';
import type { ListingSnapshot } from '../../packages/domain/src/contracts.js';
it('keeps platform status and visibility restriction independent', () => {
  const s: ListingSnapshot = {itemId:'1',scope:{environment:'sandbox',partnerId:'1232297',shopId:'227418363',connectionRevision:1,capabilityRevision:1},
    observedAt:'2026-09-10T00:00:00Z',fingerprint:'x',fields:{},models:[],platformStatus:'NORMAL',deboosted:true,qualityGrade:1};
  expect(projectQc(s)).toEqual({platformStatus:'NORMAL',deboosted:true,qualityGrade:1});
});
```

```ts
export function projectQc(s: ListingSnapshot) {
  return {platformStatus:s.platformStatus,deboosted:s.deboosted,qualityGrade:s.qualityGrade};
}
```

- [ ] Inbox duplicate event xác định bằng event identity nếu được cung cấp, bổ sung raw hash/scope/timestamp để dedupe có cửa sổ; không bỏ vĩnh viễn event hợp lệ chỉ vì nội dung giống. Push thứ tự ngược chỉ lên lịch readback mới, không hồi trạng thái cũ. Poll fallback theo budget, ưu tiên item mới/chưa ổn định; lịch poll không vượt quota.
- [ ] QC case lưu reason, suggestion, deadline, last observed, nguồn và trạng thái xử lý. API không hỗ trợ appeal/chứng từ thì mở hướng dẫn Seller Center đúng item, không tự thao tác web. REVIEWING khóa đúng fields, deleted không tự republish bản sao.
- [ ] Integration: inbox persisted then crash before ack, invalid auth, cross-shop payload, duplicated/out-of-order events, poll recovers missing push, thiếu quyền chẩn đoán, item NORMAL/deboost, brand pending độc lập. Test HTTP callback ack timing khi DB khỏe; DB không lưu được không trả success giả.
- [ ] Chạy tests, cập nhật capability matrix, commit `feat: reconcile Shopee QC without conflating listing states`.

**Nghiệm thu:** QC UI đủ lý do/việc cần làm và trạng thái chưa xác minh; không đặt thời gian duyệt cố định thành SLA.

## C4 — Giao diện vận hành, pause/resume/cancel và chạy liên tục

**Files tạo:** `apps/api/src/jobs/jobs.controller.ts`, `apps/api/src/events/events.controller.ts`, `apps/web/src/features/jobs/JobsPage.tsx`, `apps/web/src/features/jobs/JobDetail.tsx`, `apps/web/src/features/qc/QcPage.tsx`, `tests/e2e/jobs-recovery.spec.ts`, `docs/runbooks/job-recovery.md`.

**Interfaces:** jobs/events/QC routes trong contracts. SSE event ID tăng theo persisted log; reconnect cursor hoặc snapshot refresh. Client không tự tạo lại job khi POST timeout; tìm theo idempotent plan submission.

- [ ] UI hiển thị accepted/đang xử lý/đã đối soát/chờ Shopee/thiếu dữ liệu/lỗi; kết quả per-listing và per-model, số đã xong không cộng item UNKNOWN. Có bộ lọc shop/lô/error, tải báo cáo và liên kết nguồn.
- [ ] Pause/cancel ngăn bước chưa gửi; pending write đang gửi vẫn cần nhận/đối soát. Resume kiểm lại plan/capability/current state; nếu nguồn hoặc giá/tồn đổi cần revision mới. Không rollback/delete tự động.
- [ ] Browser test thực tế với fake server cho app: bắt đầu batch fixture → disconnect SSE → refresh page → pause/resume → kill worker test process → start lại → assert job cũ còn, không thêm create. Ghi screenshot states và call ledger.

```ts
import { test, expect } from '@playwright/test';
test('refresh retains the submitted job identity', async ({page}) => {
  await page.goto('/jobs/fixture-persisted-job');
  const id = await page.getByTestId('job-id').textContent();
  await page.reload();
  await expect(page.getByTestId('job-id')).toHaveText(id!);
  await expect(page.getByTestId('job-scope')).toContainText('TEST');
});
```

Fixture setup tạo job thật trong DB test qua submit service, không chỉ trang HTML tĩnh. UI update test khi mất mạng không lặp submit mù; event backlog lớn có pagination, không render toàn bộ hàng nghìn ảnh cùng lúc.

- [ ] Worker graceful shutdown: dừng claim mới, cố lưu attempt receipt trong thời gian shutdown cấu hình, phần còn lại recovery UNKNOWN. UI đóng không dừng backend; service supervisor restart process. Sleep máy cá nhân không phải triển khai 24/7, ghi rõ cần máy chủ hoạt động liên tục ở E.
- [ ] Chạy e2e, đo accept-job và UI event lag theo kế hoạch chính; commit `feat: operate and resume batches with live progress and QC`.

**Gate G3:** ca lỗi có kết quả tái lập và dashboard phản ánh đúng; lịch/worker sẵn sàng cho soak ở E2.
