import { z } from 'zod';
import type {
  DraftField,
  ListingDraft,
  ShopConnection,
  Workbench,
  WorkIssue,
  WorkOrder,
  WorkOrderView,
  WorkbookImport,
} from '@shopee/domain';
import { Repository, WorkOrderRepository, listShopConnections } from '@shopee/persistence';

const field = z.enum([
  'title',
  'description',
  'gallery',
  'category',
  'brand',
  'attributes',
  'variations',
  'price',
  'stock',
  'logistics',
  'video',
  'sizeChart',
  'identifiers',
  'compliance',
  'fulfillment',
  'publication',
]);
const schema = z
  .object({
    id: z.string().uuid(),
    expectedRevision: z.number().int().min(0).max(2147483646),
    config: z
      .object({
        productKey: z.string().min(1).max(200),
        sourceRevision: z.number().int().positive(),
        connectionId: z.string().uuid().nullable(),
        operation: z.enum(['create', 'update']),
        itemId: z
          .string()
          .regex(/^[1-9]\d{0,15}$/)
          .nullable(),
        fieldMask: z.array(field).max(16),
        stocks: z.record(z.string().min(1).max(200), z.number().int().min(0).max(2147483647)),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.config.fieldMask).size !== value.config.fieldMask.length)
      ctx.addIssue({ code: 'custom', path: ['config', 'fieldMask'], message: 'Duplicate fields' });
    if (value.config.operation === 'create' && value.config.itemId !== null)
      ctx.addIssue({
        code: 'custom',
        path: ['config', 'itemId'],
        message: 'Create cannot target existing item',
      });
  });

export class WorkbenchService {
  readonly orders: WorkOrderRepository;
  constructor(readonly repo: Repository) {
    this.orders = new WorkOrderRepository(repo.pool);
  }
  async shops(): Promise<ShopConnection[]> {
    return listShopConnections(this.repo.pool);
  }
  async view(order: WorkOrder, shops?: ShopConnection[]): Promise<WorkOrderView> {
    const source = await this.repo.getProduct(order.config.productKey, order.config.sourceRevision);
    const latest = await this.repo.getProduct(order.config.productKey);
    if (!source || !latest) throw new Error('SOURCE_NOT_FOUND');
    const shop =
      (shops ?? (await this.shops())).find((s) => s.id === order.config.connectionId) ?? null;
    const issues: WorkIssue[] = [];
    const add = (
      code: string,
      kind: WorkIssue['kind'],
      field: string,
      message: string,
      action: string,
    ) => issues.push({ code, kind, field, message, action });
    const selected = new Set<DraftField>(order.config.fieldMask);
    const sandboxRun = await this.orders.sandboxRun(order.config, order.id);
    const recovery = sandboxRun
      ? (
          await this.repo.pool.query(
            `SELECT q.id,q.created_at FROM sandbox_listing_reconciliations q
       JOIN sandbox_listing_runs r ON r.id=q.run_id WHERE r.id=$1 AND q.verified
         AND q.run_revision=r.revision AND q.run_input_fingerprint=r.input_fingerprint
         AND q.run_snapshot=to_jsonb(r) ORDER BY q.created_at DESC LIMIT 1`,
            [sandboxRun.id],
          )
        ).rows[0]
      : undefined;
    const sandboxReconciliation = recovery
      ? { id: recovery.id, verifiedAt: recovery.created_at.toISOString() }
      : undefined;
    const sandboxRunMatchesConfig =
      !!sandboxRun &&
      sandboxRun.connectionId === order.config.connectionId &&
      sandboxRun.itemId === order.config.itemId &&
      sandboxRun.workOrderId === order.id &&
      sandboxRun.workOrderRevision === order.revision &&
      sandboxRun.productKey === order.config.productKey &&
      sandboxRun.sourceRevision === order.config.sourceRevision &&
      sandboxRun.fieldMask.length === order.config.fieldMask.length &&
      sandboxRun.fieldMask.every((field) => selected.has(field));
    if (sandboxRun && ['in_flight', 'unknown'].includes(sandboxRun.state))
      add(
        'SANDBOX_RUN_NEEDS_RECOVERY',
        'conflict',
        'execution',
        sandboxReconciliation
          ? 'Trạng thái Lamy hiện tại đã được đối chiếu và giải phóng khóa shop. Công việc cũ được giữ làm lịch sử.'
          : sandboxRun.state === 'in_flight'
            ? 'Lần gửi trước của link này đang được xử lý; chưa thể đổi lựa chọn hoặc gửi tiếp.'
            : 'Lần gửi trước của link này chưa xác định kết quả. Cần đọc lại kết quả trước khi đổi lựa chọn hoặc gửi tiếp.',
        sandboxReconciliation
          ? 'Mở Thử sandbox để làm phép thử mới trên listing mẫu.'
          : 'Mở kết quả lần gửi đã lưu và đối chiếu; giữ nguyên phạm vi của lần gửi đó.',
      );
    if (latest.revision !== source.revision)
      add(
        'SOURCE_REVISION_CHANGED',
        'conflict',
        'source',
        'Bộ nguồn đã có phiên bản mới hơn bản công việc đang giữ.',
        'Đối chiếu và chọn rõ phiên bản muốn dùng.',
      );
    if (!shop)
      add(
        'SHOP_REQUIRED',
        'connection',
        'shop',
        'Chưa chọn shop đích cho công việc.',
        'Chọn shop sẽ nhận listing này.',
      );
    else {
      if (shop.state !== 'connected')
        add(
          'SHOP_CONNECTION_REQUIRED',
          'connection',
          'shop',
          'Kết nối shop chưa sẵn sàng.',
          'Mở Kết nối shop để kiểm tra.',
        );
      if (shop.scope.environment === 'production')
        add(
          'PRODUCTION_READ_ONLY',
          'unsupported',
          'shop',
          'Shop thật hiện chỉ được đọc; chưa mở ghi sản phẩm.',
          'Hoàn tất nghiệm thu trước khi mở phạm vi ghi shop thật.',
        );
    }
    if (order.config.operation === 'update') {
      if (!order.config.itemId)
        add(
          'ITEM_BINDING_REQUIRED',
          'mapping_needed',
          'itemId',
          'Chưa xác định link Shopee sẽ cập nhật.',
          'Điền mã sản phẩm của đúng shop; ứng dụng sẽ đọc lại để kiểm tra SKU.',
        );
      if (!selected.size)
        add(
          'FIELD_SELECTION_REQUIRED',
          'mapping_needed',
          'fieldMask',
          'Chưa chọn phần muốn cập nhật.',
          'Chọn đúng những phần cần thay đổi.',
        );
      const unsupported = [...selected].filter(
        (f) => !['title', 'description', 'gallery'].includes(f),
      );
      if (unsupported.length)
        add(
          'UPDATE_FIELDS_UNSUPPORTED',
          'unsupported',
          'fieldMask',
          'Một số phần đã chọn chưa có luồng cập nhật được triển khai.',
          'Chỉ tên, mô tả và ảnh sản phẩm có đường kiểm thử sandbox hiện tại.',
        );
      if (
        shop &&
        shop.scope.environment === 'sandbox' &&
        (shop.scope.partnerId !== '1232297' ||
          shop.scope.shopId !== '227418363' ||
          (order.config.itemId && order.config.itemId !== '803934364'))
      )
        add(
          'SANDBOX_SCOPE_NOT_VERIFIED',
          'unsupported',
          'itemId',
          'Luồng ghi thử hiện chỉ mở cho listing Lamy sandbox đã được cho phép.',
          'Các phạm vi khác cần kiểm chứng riêng trước khi bật.',
        );
    } else {
      add(
        'CREATE_NOT_RELEASED',
        'unsupported',
        'operation',
        'Luồng đăng mới chưa được phát hành. Công việc được giữ để chuẩn bị.',
        'Hoàn tất bộ trường theo ngành và kiểm thử tạo mới trước khi gửi.',
      );
      if (!source.categoryId) {
        const ids = [...new Set(source.sourceSelection?.variants.map((v) => v.importId) ?? [])];
        let categoryKnown = false;
        for (const id of ids) {
          const imp = await this.repo.getImport(id);
          if (imp?.kind === 'xlsx' && imp.body) {
            const rows = (imp.body as WorkbookImport).rows;
            const keys = new Set(
              source.sourceSelection?.variants
                .filter((v) => v.importId === id)
                .map((v) => v.rowKey),
            );
            if (rows.some((r) => keys.has(r.key) && r.category?.value)) categoryKnown = true;
          }
        }
        add(
          'CATEGORY_MAPPING_REQUIRED',
          categoryKnown ? 'mapping_needed' : 'missing_source',
          'category',
          categoryKnown
            ? 'Bảng nguồn có ngành hàng nhưng chưa đối chiếu sang ngành Shopee.'
            : 'Bộ nguồn chưa xác định ngành hàng. ',
          categoryKnown
            ? 'Ứng dụng cần đối chiếu ngành theo shop; không phải nhập lại nội dung nguồn.'
            : 'Bổ sung ngành theo sản phẩm đã chuẩn bị.',
        );
      }
    }
    if (order.config.operation === 'create' || selected.has('stock'))
      for (const variant of source.variants) {
        if (!Object.hasOwn(order.config.stocks, variant.sku.value))
          add(
            'STOCK_DECISION_REQUIRED',
            'missing_source',
            'stock:' + variant.sku.value,
            `Chưa có mức tồn đăng bán cho ${variant.sku.value} tại shop này.`,
            'Nhập mức tồn do bên vận hành quyết định; có thể là tồn ảo.',
          );
      }
    for (const issue of source.issues.filter((i) => i.severity === 'block')) {
      if (order.config.operation === 'update' && !relevant(issue.field, selected)) continue;
      add(
        issue.code,
        /AMBIG|MAPPING|PARSE|FORMULA|UNSUPPORTED/.test(issue.code)
          ? 'mapping_needed'
          : 'missing_source',
        issue.field,
        issue.message,
        'Mở đúng bộ nguồn để đối chiếu vị trí được báo.',
      );
    }
    return {
      ...order,
      source,
      shop,
      latestSourceRevision: latest.revision,
      issues,
      state: issues.length ? 'needs_attention' : 'ready_to_check',
      sandboxRun,
      ...(sandboxReconciliation ? { sandboxReconciliation } : {}),
      sandboxRunMatchesConfig,
    };
  }
  async get(id: string) {
    const order = await this.orders.get(id);
    if (!order) throw new Error('WORK_ORDER_NOT_FOUND');
    return this.view(order);
  }
  async save(raw: unknown) {
    const input = schema.parse(raw);
    await this.orders.save(input.id, input.expectedRevision, input.config);
    // Persistence may return an earlier receipt after a retry. The operational UI must
    // show the latest saved configuration, without replaying a superseded configuration.
    const current = await this.orders.get(input.id);
    if (!current) throw new Error('WORK_ORDER_NOT_FOUND');
    return this.view(current);
  }
  async list(): Promise<Workbench> {
    const [orders, sources, shops] = await Promise.all([
      this.orders.list(),
      this.repo.listProducts(),
      this.shops(),
    ]);
    return {
      orders: await Promise.all(orders.map((order) => this.view(order, shops))),
      sources,
      shops,
      execution: { productionWrites: false, sandboxUpdates: true, createEnabled: false },
    };
  }
}
function relevant(field: string, selected: Set<DraftField>) {
  if (selected.has('title') && field.startsWith('title')) return true;
  if (selected.has('description') && /description|headline|body/.test(field)) return true;
  if (selected.has('gallery') && /gallery|assets/.test(field)) return true;
  return (
    /sku|optionLabels|tierNames|variants|variations/.test(field) &&
    !/price|stock|weight/.test(field)
  );
}
