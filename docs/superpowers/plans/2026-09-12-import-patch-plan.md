# Import Patch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Nhập file giá/tồn và bộ ảnh/Word cập nhật, xem patch có nguồn, lưu và phục hồi công việc qua ứng dụng thật.

**Architecture:** Parser cập nhật thưa riêng tránh thay đổi quy tắc nhập KINI cũ. Patch có provenance và target pinned vào công việc; lưu bất biến trong PostgreSQL, không sửa product chung. UI nhận tệp/thư mục, hiển thị diff và ngoại lệ, lưu/mở lại qua HTTP.

**Tech Stack:** Node 24.20.0, TypeScript, ExcelJS, React, Nest/Fastify, PostgreSQL, Vitest, Playwright hiện có.

**Spec:** ../specs/2026-09-12-import-patch-design.md

## Global Constraints

- Không gọi API ghi Shopee; production chỉ đọc. Không sửa Lamy/source revision 1 hoặc phát lại trial cũ.
- Không gõ lại nội dung nguồn, tự chia/gộp SKU, đổi thứ tự phân loại, tạo/crop ảnh.
- Missing = keep; explicit stock 0 is valid. GIÁ BÁN is separate promotion target.
- Before from saved source must not be labeled remote state. Saved patch must not be labeled executed.
- Safe repeated save, immutable source provenance, exact workorder/shop/product/source revision and item identity.
- Report evidence and limitations separately. Do not remove failures to make tests pass.

### Task 1: Sparse import patch backend

**Files:** domain source parser + import-patch types; API import-patch-service and routes; persistence migration 009 + repository; unit/integration tests.

**Consumes:** existing source_files/import byte storage, work_orders and product_revisions. **Produces:** typed context/preview/save/list/get HTTP API documented in the task report, sparse parser and patch receipt. Chosen fields cover/title/description/gallery/variantImage/price/stock; absent is keep, unsupported others explicit.

- [x] Write failing parser tests with SKU+GIÁ GỐC only, SKU+TỒN ĐĂNG BÁN only, blank/zero, duplicate and ambiguous columns, bad/cached formulas.
- [x] Implement sparse parser without changing existing catalog interpretation; preserve exact SKU and raw source locations.
- [x] Write failing service/transaction tests: target references pinned, wrong source kind rejected, duplicates/stale revisions rejected, selected operations derived server-side, no product/source mutation, save idempotency and reload.
- [x] Implement preview composition, persisted receipt/migration and API. Price/stock are per exact SKU; Word selection comes from import paragraphs; assets from blob imports. Preserve ordered media roles.
- [x] Run covering unit/integration and typecheck; record contract and evidence. Independent reviewer checks spec and quality before final UI integration. Parallel disjoint UI implementation and the review sequence are recorded in the execution ledger.

### Task 2: Import-first UI

**Files:** apps/web/src/ImportUpdates.tsx and scoped CSS/client; Workspace/Workbench entry; browser tests.

**Consumes:** Task 1 report's exact HTTP/type contract. **Produces:** user journey uploads files/folders -> target/role exceptions -> before/after diff -> saved receipt -> reopen. No hand-coded JSON forms.

- [x] Write browser tests for price-only, stock-only 0, Word/media-only; navigation/reload and selected operation set.
- [x] Implement actual upload and parse through API; file inputs accept multiple selections and directory flow. Read parser issues as actionable Vietnamese exceptions.
- [x] Show only imported fields and preserve scope; clarify source baseline, not remote. Inputs for role/target selection only where unresolved. No per-SKU numeric entry baseline.
- [x] Save/reopen via backend; double-click guard and selection invalidation when source/target changes. Link visible from main workbench and show saved patch on related work.
- [x] Run covering browser checks desktop and narrow layout, typecheck; report screenshots/evidence. Independent review before final verification.

### Task 3: Cross-review and delivery

**Files:** affected implementation as findings require; docs/reviews, delivery/runbook and execution ledger.

- [x] UX and backend reviewers critique each other's assumptions against requirement and actual diff. Resolve critical/important findings and record decisions.
- [x] Run node scripts/verify.mjs with portable runtime; run UI suite separately to avoid resource conflicts. Local E2E mutation fixtures must use isolated DB/app, never production or source Lamy.
- [x] Read local source/workorder/trial invariants before and after; apply additive migration only after code tests pass, verify local readiness and UI.
- [x] Record changed behavior, test counts, limitations, unresolved full-project release gates. Provide working local screen, do not present prototype as production.

Final evidence: `docs/delivery/2026-09-12-import-patch-workflow.md`; 361 unit/integration, 7 legacy and 56 browser checks passed. This completes the three tasks in this scoped plan, not the full Shopee production execution plan.
