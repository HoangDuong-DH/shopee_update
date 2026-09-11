# A — Nền tảng và nguồn — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans`, thực hiện A1–A4 theo checkbox, tự rà soát từng task.

**Goal:** Có ứng dụng chạy tại máy, nhập nguồn và xem trước Lamy đúng nguồn, kế hoạch lưu được trong DB.

**Architecture:** Giữ extension ở root; thêm npm workspaces cho app/package. Logic nguồn thuần tách khỏi API; preview dùng cùng dữ liệu đã kiểm ở server.

**Tech Stack:** Node 24 LTS, TypeScript, NestJS, React/Vite, PostgreSQL 17, Vitest, ExcelJS, bộ đọc OOXML cho Word, thư viện đọc metadata ảnh.

**Spec:** [Kế hoạch chính](2026-09-10-shopee-execution-plan.md), [contracts](2026-09-10-shopee-execution-contracts.md), [Lamy đã đối chiếu](../../research/shopee-lamy-listing-2026-09-10/README.md).

## Global Constraints

Áp dụng đầy đủ Global Constraints của kế hoạch chính. Không sửa `content.js`, `shared.js`, `manifest.json` để thực hiện đường API mới. Không thay CommonJS root vì test extension đang dùng `require`. Node/package versions khóa trong lockfile, không gọi `latest` khi deploy.

## A1 — Workspace, runtime, health và đường chạy test

**Files tạo:** `.gitignore`, `.env.example`, `.node-version`, `tsconfig.base.json`, `vitest.config.ts`, `package-lock.json`, `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/src/main.ts`, `apps/api/src/app.module.ts`, `apps/api/src/health.controller.ts`, `apps/worker/package.json`, `apps/web/package.json`, `apps/web/src/main.tsx`, `packages/domain/package.json`, `infra/local/compose.yaml`, `scripts/doctor.mjs`, `docs/runbooks/local-development.md`, `tests/integration/health.test.ts`.

**Modify:** `package.json` thêm workspaces/scripts; giữ `test:legacy` chạy đúng `tests/shared.test.js`.

**Interfaces:** `GET /health/live` trả `{status:'ok'}` khi process sống; `GET /health/ready` trả 503 nếu DB/migration chưa sẵn sàng. `scripts/doctor.mjs` in runtime, trạng thái dependency, không in env values/credential.

- [ ] Ghi `.gitignore` trước `git init`; loại `.env*` trừ example, `.local/`, node_modules, build, token/raw debug và tài liệu/ảnh nguồn lớn khỏi commit tự động. Giữ nguồn thực tại máy; chỉ commit catalog/fixture đã chọn. Dùng `git add` đường dẫn cụ thể; xem staged diff. Không cấu hình tên/email Git giả nếu máy chưa có danh tính; code tiếp tục được nếu commit cần người dùng cấu hình.
- [ ] Kiểm Node mục tiêu 24.20.0 hoặc patch 24.x mới hơn, dùng bản dự án được xác minh SHA từ nguồn chính thức; không tự thay Node toàn máy. Chọn Nest 12 core/platform/testing cùng major; TypeScript strict; package mới ESM. Cài package và lưu chính xác lockfile. Không chạy CLI Nest hiện hành bằng Node 24.14 ngầm định.
- [ ] Tạo API health với test qua Nest testing app, thêm DB probe riêng để readiness phản ánh đúng. Cấu hình tối thiểu:

```ts
import { Controller, Get } from '@nestjs/common';
@Controller('health')
export class HealthController {
  @Get('live') live() { return { status: 'ok' }; }
}
```

```ts
import { expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { HealthController } from '../../apps/api/src/health.controller.js';
it('serves liveness without claiming DB readiness', async () => {
  const module = await Test.createTestingModule({controllers:[HealthController]}).compile();
  const app = module.createNestApplication();
  await app.init();
  try { expect((await request(app.getHttpServer()).get('/health/live')).body).toEqual({status:'ok'}); }
  finally { await app.close(); }
});
```

- [ ] Khởi tạo PostgreSQL dev bằng compose khi Docker hoạt động; bind localhost, named volume, credential dev từ cấu hình riêng. Nếu daemon chưa chạy, doctor báo rõ và domain/unit vẫn chạy; integration phải báo chưa chạy chứ không tự PASS/đổi DB in-memory.
- [ ] Định nghĩa scripts: `test:legacy`=`node --test tests/shared.test.js`; `test:unit`/`test:integration`=`vitest run` với config project tương ứng; `typecheck`=`tsc -b`; `build` build packages trước apps; `db:migrate`, `dev` có dừng sạch process con. Kiểm `npm ci`, legacy 7/7, health, typecheck, build; lưu báo cáo G0 thiếu DB nếu chưa có.
- [ ] Commit có phạm vi: `chore: scaffold internal app and development checks`.

**Nghiệm thu độc lập:** clean checkout + runtime phù hợp cài được; server health chạy; lỗi DB hiển thị đúng; extension vẫn nguyên trạng.

## A2 — Hợp đồng dữ liệu và nhập nguồn có provenance

**Files tạo:** `packages/domain/src/contracts.ts`, `packages/domain/src/source/normalize.ts`, `packages/domain/src/source/kini.ts`, `packages/domain/src/source/word.ts`, `packages/domain/src/source/assets.ts`, `packages/domain/src/index.ts`, `tests/fixtures/lamy/manifest.json`, `tests/fixtures/lamy/expected.json`, `tests/unit/source.test.ts`, `tests/unit/kini.test.ts`, `tests/unit/word-assets.test.ts`.

**Interfaces:** toàn bộ types và năm hàm source đã định nghĩa trong contracts. `readKini` chưa ghép chắc chắn các hàng vào một listing phải trả issue `LISTING_GROUP_REQUIRED`; SKU trùng trong khối khác không tự bị gộp. Mapping bảng giá/shop do người vận hành chọn.

- [ ] Tạo fixture có nguồn bằng bản chụp Lamy đã xác nhận; ghi SHA/path tương đối/vị trí ô. Đọc lại file KINI gốc nếu dùng làm dữ liệu mới; không sửa snapshot cũ khi workbook thay đổi. Fixture giá lịch sử sáu SKU lấy từ `prepared-source-bundle.json`; mô tả cuối lấy `content-update-payload.json`, không dùng payload cũ thiếu ảnh.
- [ ] Viết phép thử thật cho giữ tên/nội dung, toàn bộ ảnh mô tả và giá. Chạy `npm run test:unit -- tests/unit/source.test.ts`, xác nhận thất bại vì chưa có hàm:

```ts
import { expect, it } from 'vitest';
import { compileDescription, parseVnd } from '../../packages/domain/src/source/normalize.js';
it('keeps every supplied description image and paragraph spacing', () => {
  expect(compileDescription('Tiêu đề', 'Nội dung\n\nDòng sau', ['g1','g2'])).toEqual([
    {type:'text',text:'Tiêu đề\n\n'},
    {type:'image',assetKey:'g1'}, {type:'image',assetKey:'g2'},
    {type:'text',text:'\n\nNội dung\n\nDòng sau'}
  ]);
});
it('preserves VND exactly and rejects ambiguous separators', () => {
  expect(parseVnd('137998')).toBe('137998');
  expect(() => parseVnd('137.998')).toThrow('MONEY_FORMAT_REQUIRED');
});
```

- [ ] Implement core tối thiểu dưới đây. Chuỗi hiển thị tiền định dạng địa phương phải đi qua parser có format của cột được xác nhận; giá số Excel nguyên chuyển chuỗi chính xác; `parseVnd` không đoán dấu phân cách:

```ts
export function parseVnd(value: string): string {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('MONEY_FORMAT_REQUIRED');
  return BigInt(value).toString();
}
export function compileDescription(headline: string, body: string, imageKeys: string[]) {
  return [
    {type:'text' as const,text:headline+'\n\n'},
    ...imageKeys.map(assetKey => ({type:'image' as const,assetKey})),
    {type:'text' as const,text:'\n\n'+body}
  ];
}
```

- [ ] Implement KINI đọc từng sheet, merged headers/khối; xác định SKU, GIÁ GỐC, GIÁ BÁN theo label, không hardcode J/K/L cho cả workbook. Số công thức dùng cached result với nhãn nguồn; kết quả thiếu thành issue, không tự đánh giá công thức hoặc mở link ngoài. Tách màu/số lượng bằng mapping đã chọn, không xóa khoảng trắng trong nhãn phân loại.
- [ ] Implement Word đọc paragraph/run và giữ nguyên văn bản gốc, line breaks; lưu mapping title/headline/body riêng. Metadata ảnh chỉ đọc SHA/bytes/MIME/kích thước; nhập đường dẫn ảnh tương đối manifest, kiểm tệp thật. Numeric-sort g1…g10; cover/gallery/description/variant là role riêng, một ảnh có thể ở nhiều role. Không crop/transcode.
- [ ] Kiểm thêm: hàng thiếu giá; cùng SKU hai bộ giá; khối header đổi vị trí; mã số có 0 đầu; Word có emoji/dòng trống; g2/g10; ảnh phân loại bị ghép nhầm; file bị thay hash. Chạy ba test file, typecheck và legacy; commit `feat: import source revisions without rewriting content`.

**Nghiệm thu độc lập:** Lamy sáu SKU/giá nguồn/ảnh đúng; bản preview có thể giải thích mỗi giá trị từ ô/tệp/xác nhận nào. Bổ sung ít nhất một khối bảng khác KINI để tránh overfit fixture Lamy.

## A3 — DB, kế hoạch bất biến và tồn thủ công

**Files tạo:** `packages/domain/src/plans.ts`, `packages/domain/src/stock.ts`, `packages/persistence/package.json`, `packages/persistence/src/db.ts`, `packages/persistence/src/plans.repository.ts`, `packages/persistence/migrations/001_sources_plans.sql`, `packages/persistence/migrations/002_jobs_outbox.sql`, `tests/unit/stock.test.ts`, `tests/integration/plans.test.ts`.

**Interfaces:** `makePlan`, `shouldApplyStock` từ contracts; repository `submitPlan(planId: string, revision: number, fingerprint: string): Promise<{jobId:string}>`. Sau A3 đã có transactional submission/idempotency; C1 bổ sung lease/dispatch nhiều worker.

- [ ] Viết test tồn; chạy file unit thấy fail rồi implement:

```ts
import { expect, it } from 'vitest';
import { shouldApplyStock } from '../../packages/domain/src/stock.js';
import type { StockInstruction } from '../../packages/domain/src/contracts.js';
it('does not reapply a stock instruction after an order lowered observed stock', () => {
  const c: StockInstruction = {
    scope:{environment:'sandbox',partnerId:'1232297',shopId:'227418363',connectionRevision:1,capabilityRevision:1},
    sku:'LMKT5DT100',quantity:100,revision:7,commandId:'stock-7',decidedAt:'2026-09-10T00:00:00Z',
    source:{kind:'user_decision',fileSha256:'fixture',locator:'sandbox instruction',observedAt:'2026-09-10T00:00:00Z'}
  };
  expect(shouldApplyStock(c,7)).toBe(false);
  expect(shouldApplyStock(c,6)).toBe(true);
});
```

```ts
export function shouldApplyStock(command: StockInstruction, appliedRevision: number): boolean {
  if (!Number.isSafeInteger(command.quantity) || command.quantity < 0) throw new Error('INVALID_STOCK');
  return command.revision > appliedRevision;
}
```

- [ ] Tạo schema theo contracts. Plan hash bao gồm scope, input revision, stock command revisions, field mask và nội dung canonical; object keys ổn định nhưng giữ thứ tự arrays. Plan đã submit không sửa trực tiếp; nguồn đổi khiến revalidate/create revision mới.
- [ ] Implement `submitPlan` bằng transaction: khóa plan revision → so fingerprint/issue blocking/scope → tìm job unique `(plan_id,plan_revision)` → insert job và outbox → commit → trả job ID. SQL unique là chốt cuối chống đua, không chỉ kiểm trước ở code.

```sql
CREATE UNIQUE INDEX jobs_one_submission ON jobs(plan_id, plan_revision);
CREATE UNIQUE INDEX stock_command_identity ON stock_instructions(command_id);
CREATE INDEX jobs_due ON jobs(next_run_at) WHERE state IN ('queued','waiting_retry');
```

- [ ] Integration DB thật: hai request submit đồng thời trả cùng job; sai fingerprint trả conflict; lỗi insert outbox rollback job; đổi source revision không sửa plan đang chạy; mất DB không trả 202. Test restart API rồi đọc lại job còn nguyên. Script test tạo database/schema riêng và cleanup chỉ đúng tài nguyên test.
- [ ] Chạy unit/integration tương ứng, migration từ DB trống và nâng phiên bản; commit `feat: persist immutable plans and manual stock commands`.

**Nghiệm thu độc lập:** double-click không tạo hai job; job được xác nhận lưu tồn tại sau restart; tồn quan sát thay đổi không phát sinh lệnh tự bù.

## A4 — UI nhập nguồn, sửa mapping, chọn shop và preview

**Files tạo:** `apps/api/src/imports/imports.controller.ts`, `apps/api/src/imports/imports.service.ts`, `apps/api/src/plans/plans.controller.ts`, `apps/web/src/features/imports/ImportPage.tsx`, `apps/web/src/features/catalog/MappingEditor.tsx`, `apps/web/src/features/plans/PlanPreview.tsx`, `apps/web/src/lib/api.ts`, `tests/e2e/source-preview.spec.ts`.

**Interfaces:** imports/products/plans routes trong contracts. UI lưu selection/mapping revision; request khởi chạy chỉ plan ID/revision/hash, không gửi raw Shopee body. API import chạy ngoài request nếu cần lâu.

- [ ] Tạo form chọn bộ nguồn, map sản phẩm/listing/SKU, chọn shop, bảng nguồn/lỗi; không thêm bước đăng nhập. Mỗi shop hiển thị TEST/LIVE và tên/ID, loại shop khi đã đọc được. Chọn production ở giai đoạn này vẫn read-only.
- [ ] Render preview từ `ContentBlock[]` và AssetRef gốc; bìa/ảnh gallery/ảnh mô tả/ảnh từng phân loại xem riêng. Bảng giá hiển thị GIÁ GỐC và mục tiêu khuyến mại có nhãn khác nhau; tồn thiếu là thiếu, không gợi số mặc định.
- [ ] Kiểm browser bằng fixture server; ví dụ assertion với các test ID do UI cung cấp:

```ts
import { test, expect } from '@playwright/test';
test('shows original Lamy variant labels and complete description sequence', async ({page}) => {
  await page.goto('/plans/fixture-lamy'); // webServer test seed fixture, không gọi Shopee
  await expect(page.getByTestId('variant-row')).toHaveCount(6);
  await expect(page.getByTestId('variant-row').first()).toContainText('CB 100 Cái Trắng');
  await expect(page.getByTestId('description-image')).toHaveCount(9);
  await expect(page.getByTestId('shop-scope')).toContainText('227418363');
});
```

- [ ] Test thêm thay mapping/giá/stock input làm preview revision cũ invalid; lỗi thiếu nguồn dẫn tới dòng/ô; nhập/refresh browser không mất draft đã lưu. Test fixture route chỉ trong webServer test, không ship dữ liệu seed vào production.
- [ ] Chạy `npm run test:e2e -- tests/e2e/source-preview.spec.ts`, typecheck/build. Lưu ảnh chụp preview và báo cáo sáu SKU; commit `feat: review imported listings before execution`.

**Gate G1:** Demo nhập nguồn → chỉnh mapping → preview → lưu plan. Backend Shopee chưa được coi là đã hoạt động sau gói A.
