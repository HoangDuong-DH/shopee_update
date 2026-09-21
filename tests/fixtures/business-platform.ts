import { randomUUID } from 'node:crypto';
import type {
  PreparedDocument,
  PreparedField,
  PreparedGateway,
  PreparedMetadata,
  PreparedOutcome,
  PreparedRemote,
  Scope,
} from '../../packages/domain/src/index.js';
import { businessShopFixtures, type BusinessShopFixture } from './business-batch-fixtures.js';

export type BusinessPlatformFault = {
  kind: 'create_lost_ack' | 'create_rejected' | 'update_partial' | 'read_wrong_title';
  shopId?: string;
  sourceKey?: string;
};
type PlatformCall = {
  kind: 'metadata' | 'find' | 'read' | 'create' | 'update';
  shopId: string;
  partnerId: string;
  itemId?: string;
  sourceKey?: string;
  fields?: PreparedField[];
  selectedSkus?: string[];
  requestId: string;
};

/** Stateful simulated remote. It has no repository access and never receives fixture expectations. */
export class BusinessPlatform implements PreparedGateway {
  readonly mode = 'simulation' as const;
  readonly calls: PlatformCall[] = [];
  readonly faults: BusinessPlatformFault[] = [];
  private readonly items = new Map<string, { scope: Scope; remote: PreparedRemote }>();
  private nextItemId = 970000000;
  private nextModelId = 9600000000;
  constructor(readonly shops: BusinessShopFixture[] = structuredClone(businessShopFixtures)) {}

  private key(scope: Scope, itemId: string) {
    return `${scope.environment}:${scope.partnerId}:${scope.shopId}:${itemId}`;
  }
  private shop(scope: Scope) {
    return scope.environment === 'sandbox'
      ? this.shops.find((shop) => shop.shopId === scope.shopId && shop.ownerId === scope.partnerId)
      : undefined;
  }
  private receipt(kind: PlatformCall['kind'], scope: Scope, extras: Partial<PlatformCall> = {}) {
    const call: PlatformCall = {
      kind,
      shopId: scope.shopId,
      partnerId: scope.partnerId,
      requestId: randomUUID(),
      ...extras,
    };
    this.calls.push(structuredClone(call));
    return call.requestId;
  }
  private ok<T>(data: T, requestId: string): PreparedOutcome<T> {
    return { kind: 'success', data: structuredClone(data), requestId };
  }
  private takeFault(kind: BusinessPlatformFault['kind'], scope: Scope, sourceKey: string) {
    const index = this.faults.findIndex(
      (fault) =>
        fault.kind === kind &&
        (!fault.shopId || fault.shopId === scope.shopId) &&
        (!fault.sourceKey || fault.sourceKey === sourceKey),
    );
    return index >= 0 ? this.faults.splice(index, 1)[0] : undefined;
  }
  async metadata(scope: Scope, categoryId: string): Promise<PreparedOutcome<PreparedMetadata>> {
    const requestId = this.receipt('metadata', scope);
    const shop = this.shop(scope),
      category = shop?.categories.find((category) => category.categoryId === categoryId);
    if (!shop || !category) return { kind: 'rejected', code: 'QA_SHOP_CATEGORY_NOT_AVAILABLE' };
    return this.ok(
      {
        categoryId,
        supported: true,
        requiredAttributes: [category.requiredAttribute.attributeId],
        allowedAttributeValues: {
          [category.requiredAttribute.attributeId]: category.requiredAttribute.values.map(
            (value) => value.valueId,
          ),
        },
        brandIds: [category.brandId],
        channelIds: [shop.logisticsChannelId],
        maxGallery: 8,
        maxModels: 50,
        minPrice: 1000,
        maxPrice: 1000000,
        maxStock: 10000,
      },
      requestId,
    );
  }
  private exposed(remote: PreparedRemote) {
    const result = structuredClone(remote);
    // Wire response identity order differs, while authored tier/model presentation stays intact.
    result.modelBindings.reverse();
    return result;
  }
  async find(scope: Scope, sourceKey: string): Promise<PreparedOutcome<PreparedRemote[]>> {
    const requestId = this.receipt('find', scope, { sourceKey });
    if (!this.shop(scope)) return { kind: 'rejected', code: 'QA_SHOP_NOT_AVAILABLE' };
    return this.ok(
      [...this.items.values()]
        .filter(
          (row) =>
            this.key(row.scope, row.remote.itemId) === this.key(scope, row.remote.itemId) &&
            row.remote.document.sourceKey === sourceKey,
        )
        .map((row) => this.exposed(row.remote)),
      requestId,
    );
  }
  async read(scope: Scope, itemId: string): Promise<PreparedOutcome<PreparedRemote>> {
    const requestId = this.receipt('read', scope, { itemId });
    const row = this.items.get(this.key(scope, itemId));
    if (!this.shop(scope) || !row) return { kind: 'rejected', code: 'QA_SHOP_ITEM_NOT_FOUND' };
    const result = this.exposed(row.remote);
    if (this.takeFault('read_wrong_title', scope, result.document.sourceKey))
      result.document.title = 'QA injected read mismatch';
    return this.ok(result, requestId);
  }
  async create(
    scope: Scope,
    document: PreparedDocument,
  ): Promise<PreparedOutcome<{ itemId: string }>> {
    const requestId = this.receipt('create', scope, { sourceKey: document.sourceKey });
    if (!this.shop(scope)) return { kind: 'rejected', code: 'QA_SHOP_NOT_AVAILABLE' };
    if (this.takeFault('create_rejected', scope, document.sourceKey))
      return { kind: 'rejected', code: 'QA_INJECTED_BUSINESS_ERROR' };
    if (
      [...this.items.values()].some(
        (row) =>
          this.key(row.scope, row.remote.itemId) === this.key(scope, row.remote.itemId) &&
          row.remote.document.sourceKey === document.sourceKey,
      )
    )
      return { kind: 'rejected', code: 'QA_DUPLICATE_SOURCE' };
    const itemId = String(++this.nextItemId);
    const remote: PreparedRemote = {
      itemId,
      document: structuredClone(document),
      modelBindings: document.models.map((model) => ({
        sku: model.sku,
        modelId: String(++this.nextModelId),
        tierIndex: [...model.tierIndex],
      })),
      extra: {
        protected: `Existing remote metadata ${scope.shopId}`,
        currency: 'VND',
        untouched: { array: [], object: {}, flags: [true, false] },
      },
    };
    this.items.set(this.key(scope, itemId), { scope: structuredClone(scope), remote });
    if (this.takeFault('create_lost_ack', scope, document.sourceKey))
      return { kind: 'unknown', code: 'QA_ACK_LOST_AFTER_COMMIT' };
    return this.ok({ itemId }, requestId);
  }
  async update(
    scope: Scope,
    itemId: string,
    expected: PreparedRemote,
    fields: PreparedField[],
    selectedSkus: string[],
  ): Promise<PreparedOutcome<null>> {
    const requestId = this.receipt('update', scope, {
      itemId,
      sourceKey: expected.document.sourceKey,
      fields: [...fields],
      selectedSkus: [...selectedSkus],
    });
    const row = this.items.get(this.key(scope, itemId));
    if (!this.shop(scope) || !row || expected.itemId !== itemId)
      return { kind: 'rejected', code: 'QA_SHOP_ITEM_NOT_FOUND' };
    const allowed: PreparedField[] = [
      'title',
      'description',
      'cover',
      'gallery',
      'variationImages',
      'price',
      'stock',
      'attributes',
      'logistics',
    ];
    if (
      fields.some((field) => !allowed.includes(field)) ||
      new Set(fields).size !== fields.length ||
      new Set(selectedSkus).size !== selectedSkus.length ||
      selectedSkus.some((sku) => !row.remote.document.models.some((model) => model.sku === sku))
    )
      return { kind: 'rejected', code: 'QA_UPDATE_SCOPE_INVALID' };
    const partial = this.takeFault('update_partial', scope, row.remote.document.sourceKey);
    const selected = partial ? selectedSkus.slice(0, 1) : selectedSkus;
    for (const field of fields) {
      if (field === 'price' || field === 'stock' || field === 'variationImages') {
        for (const sku of selected) {
          const model = row.remote.document.models.find((model) => model.sku === sku)!;
          const desired = expected.document.models.find((model) => model.sku === sku);
          if (!desired) return { kind: 'rejected', code: 'QA_MODEL_NOT_FOUND' };
          if (field === 'price') model.originalPrice = desired.originalPrice;
          if (field === 'stock') model.stock = desired.stock;
          if (field === 'variationImages') {
            if (desired.image) model.image = structuredClone(desired.image);
            else delete model.image;
          }
        }
      } else if (field === 'logistics') {
        row.remote.document.logistics = structuredClone(expected.document.logistics);
        row.remote.document.weightGrams = expected.document.weightGrams;
        row.remote.document.dimensionCm = structuredClone(expected.document.dimensionCm);
      } else if (field === 'title') row.remote.document.title = expected.document.title;
      else if (field === 'description')
        row.remote.document.description = structuredClone(expected.document.description);
      else if (field === 'cover')
        row.remote.document.cover = structuredClone(expected.document.cover);
      else if (field === 'gallery')
        row.remote.document.gallery = structuredClone(expected.document.gallery);
      else if (field === 'attributes')
        row.remote.document.attributes = structuredClone(expected.document.attributes);
    }
    return partial
      ? { kind: 'rejected', code: 'QA_PARTIAL_MODEL_WRITE' }
      : this.ok(null, requestId);
  }
  snapshot() {
    return structuredClone({
      mode: this.mode,
      items: [...this.items.values()],
      calls: this.calls,
      pendingFaults: this.faults,
    });
  }
}
