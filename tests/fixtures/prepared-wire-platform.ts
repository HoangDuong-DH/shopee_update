import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import sharp from 'sharp';
import type { ShopCredentials } from '../../packages/shopee/src/shop-info.js';
import { businessShopFixtures, type BusinessShopFixture } from './business-batch-fixtures.js';

/** Raw OpenAPI-shaped data only. Deliberately independent of PreparedGateway and its codec. */
export type WireObject = Record<string, any>;
export type PreparedWireShop = {
  credentials: ShopCredentials;
  profile: BusinessShopFixture;
  allowPortrait?: boolean;
  allowExtendedDescription?: boolean;
  gtinRule?: 'Optional' | 'Flexible' | 'Mandatory';
};
export type PreparedWireFault = {
  path: string;
  shopId?: string;
  itemId?: string;
} & (
  | { kind: 'business_error'; code?: string }
  | { kind: 'partial'; successCount?: number }
  | { kind: 'drop_response' }
  | { kind: 'alter_unselected'; field?: string; value?: unknown }
  | { kind: 'response'; status?: number; body: unknown }
);
export type PreparedWireCall = {
  sequence: number;
  at: number;
  method: string;
  path: string;
  query: Record<string, string | string[]>;
  body?: unknown;
  status?: number;
  error?: string;
  dropped?: boolean;
  committed?: boolean;
};
type StoredItem = {
  partnerId: string;
  shopId: string;
  createdAt: number;
  base: WireObject;
  models: WireObject[];
  tiers: WireObject[];
  promotions: WireObject[] | undefined;
};
type StoredImage = {
  partnerId: string;
  imageId: string;
  sha256: string;
  bytes: number;
  mime: string;
  width: number;
  height: number;
  scene: string;
  ratio: string;
};
class WireFailure extends Error {
  constructor(
    readonly code: string,
    message = 'Synthetic OpenAPI fixture rejection',
  ) {
    super(message);
  }
}
const sandboxOrigin = 'https://openplatform.sandbox.test-stable.shopee.sg';
const clone = <T>(value: T): T => structuredClone(value);
const requireWire = (condition: unknown, code = 'product.error_param'): void => {
  if (!condition) throw new WireFailure(code);
};
const object = (value: unknown): WireObject => {
  requireWire(value && typeof value === 'object' && !Array.isArray(value));
  return value as WireObject;
};
const list = (value: unknown, min = 0, max = 50): any[] => {
  requireWire(Array.isArray(value) && value.length >= min && value.length <= max);
  return value as any[];
};
const int = (value: unknown, min = 0): number => {
  requireWire(typeof value === 'number' && Number.isSafeInteger(value) && value >= min);
  return value as number;
};
const fields = (value: WireObject, allowed: string[]) => {
  requireWire(Object.keys(value).every((key) => allowed.includes(key)));
};
const priceInfo = (price: number) => [
  { currency: 'VND', original_price: price, current_price: price },
];
function stockInfo(raw: unknown, reserved = 0) {
  const rows = list(raw, 1).map((entry) => {
    const row = object(entry);
    fields(row, ['location_id', 'stock']);
    int(row.stock);
    requireWire(row.location_id === undefined || typeof row.location_id === 'string');
    return clone(row);
  });
  requireWire(new Set(rows.map((row) => row.location_id ?? '')).size === rows.length);
  const total = rows.reduce((sum, row) => sum + row.stock, 0);
  requireWire(total >= reserved, 'product.error_auth');
  return {
    summary_info: { total_reserved_stock: reserved, total_available_stock: total - reserved },
    seller_stock: rows.map((row) => ({ ...row, if_saleable: true })),
    shopee_stock: [],
  };
}

/** Every invocation stays in memory: there is no fallback transport or network access. */
export class PreparedWirePlatform {
  readonly faults: PreparedWireFault[] = [];
  readonly calls: PreparedWireCall[] = [];
  readonly shops: PreparedWireShop[];
  private readonly items = new Map<string, StoredItem>();
  private readonly images = new Map<string, StoredImage>();
  private readonly nowProvider: () => number;
  private offsetMs = 0;
  private nextItemId = 970100000;
  private nextModelId = 9601000000;
  private nextImageId = 0;
  constructor(options: { shops?: PreparedWireShop[]; now?: () => number } = {}) {
    this.nowProvider = options.now ?? Date.now;
    this.shops = clone(
      options.shops ??
        businessShopFixtures.map((profile) => ({
          profile,
          credentials: {
            environment: 'sandbox' as const,
            partnerId: profile.ownerId,
            shopId: profile.shopId,
            partnerKey: 'QA-ONLY-PARTNER-KEY-' + profile.ownerId,
            accessToken: 'QA-ONLY-TOKEN-' + profile.shopId,
          },
          allowPortrait: true,
          allowExtendedDescription: true,
          gtinRule: 'Optional' as const,
        })),
    );
    requireWire(this.shops.length > 0);
    requireWire(
      new Set(this.shops.map((shop) => shop.credentials.shopId)).size === this.shops.length,
    );
    for (const shop of this.shops) {
      requireWire(shop.credentials.environment === 'sandbox');
      requireWire(shop.credentials.shopId === shop.profile.shopId);
      requireWire(
        this.shops.every(
          (other) =>
            other.credentials.partnerId !== shop.credentials.partnerId ||
            other.credentials.partnerKey === shop.credentials.partnerKey,
        ),
      );
    }
  }
  now = (): number => this.nowProvider() + this.offsetMs;
  advance(ms: number): void {
    requireWire(Number.isFinite(ms) && ms >= 0);
    this.offsetMs += ms;
  }
  credentials(shopId: string): ShopCredentials {
    const shop = this.shops.find((candidate) => candidate.credentials.shopId === shopId);
    if (!shop) throw new Error('WIRE_FIXTURE_SHOP_UNKNOWN');
    return clone(shop.credentials);
  }
  snapshot() {
    return clone({
      items: [...this.items.values()],
      images: [...this.images.values()],
      calls: this.calls,
    });
  }
  /** Explicit fault setup, never a promotion write endpoint. Undefined tests missing evidence. */
  setPromotions(
    shopId: string,
    itemId: string,
    promotions: WireObject[] | undefined,
    baseFlag?: boolean,
  ) {
    const item = this.ownedItem(shopId, itemId);
    item.promotions = clone(promotions);
    item.base.has_promotion =
      baseFlag ?? !!promotions?.some((promotion) => promotion.promotion_staging === 'ongoing');
  }
  private redact(value: any): any {
    if (typeof value === 'string') {
      for (const shop of this.shops)
        for (const secret of [shop.credentials.partnerKey, shop.credentials.accessToken]) {
          if (secret) value = value.split(secret).join('[REDACTED]');
        }
      return value;
    }
    if (Array.isArray(value)) return value.map((entry) => this.redact(entry));
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          key,
          /^(sign|access_token|partner_key|authorization|cookie)$/i.test(key)
            ? '[REDACTED]'
            : this.redact(entry),
        ]),
      );
    return value;
  }
  private ownedItem(shopId: string, itemId: string): StoredItem {
    const item = this.items.get(itemId);
    requireWire(item, 'product.error_item_not_found');
    requireWire(item!.shopId === shopId, 'product.error_item_not_belong_shop');
    return item!;
  }
  private queryIds(url: URL, key: string, max = 50): string[] {
    const result = url.searchParams.getAll(key).flatMap((entry) => entry.split(','));
    requireWire(
      result.length > 0 && result.length <= max && result.every((id) => /^\d+$/.test(id)),
    );
    requireWire(new Set(result).size === result.length);
    return result;
  }
  private image(partnerId: string, imageId: unknown): StoredImage {
    requireWire(typeof imageId === 'string');
    const image = this.images.get(String(imageId));
    requireWire(image && image.partnerId === partnerId, 'product.error_param');
    return image!;
  }
  private authenticate(url: URL, publicApi: boolean): PreparedWireShop {
    for (const key of [
      'partner_id',
      'timestamp',
      'sign',
      ...(publicApi ? [] : ['shop_id', 'access_token']),
    ])
      requireWire(url.searchParams.getAll(key).length === 1, 'error_param');
    const q = Object.fromEntries(url.searchParams),
      timestamp = Number(q.timestamp);
    requireWire(
      /^\d+$/.test(q.timestamp!) &&
        Number.isSafeInteger(timestamp) &&
        Math.abs(this.now() / 1000 - timestamp) <= 300,
      'error_param',
    );
    const shop = this.shops.find(
      (candidate) =>
        candidate.credentials.partnerId === q.partner_id &&
        (publicApi || candidate.credentials.shopId === q.shop_id),
    );
    requireWire(shop, 'error_auth');
    const c = shop!.credentials;
    requireWire(
      publicApi
        ? !url.searchParams.has('access_token') && !url.searchParams.has('shop_id')
        : q.access_token === c.accessToken,
      'error_auth',
    );
    // Independent HMAC implementation: do not import the adapter's signature helper.
    const base =
      c.partnerId + url.pathname + q.timestamp + (publicApi ? '' : c.accessToken + c.shopId);
    const expected = createHmac('sha256', c.partnerKey).update(base).digest('hex');
    requireWire(
      /^[a-f0-9]{64}$/.test(q.sign!) &&
        timingSafeEqual(Buffer.from(q.sign!), Buffer.from(expected)),
      'error_sign',
    );
    return shop!;
  }
  readonly fetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init),
      url = new URL(request.url);
    const call: PreparedWireCall = {
      sequence: this.calls.length + 1,
      at: this.now(),
      method: request.method,
      path: url.pathname,
      query: this.redact(
        Object.fromEntries(
          [...new Set(url.searchParams.keys())].map((key) => [
            key,
            url.searchParams.getAll(key).length === 1
              ? url.searchParams.get(key)
              : url.searchParams.getAll(key),
          ]),
        ),
      ),
    };
    this.calls.push(call);
    const envelope = (data?: unknown) => ({
      error: '',
      message: '',
      warning: '',
      request_id: 'wire-qa-' + call.sequence,
      ...(data === undefined ? {} : { response: data }),
    });
    const respond = (body: any, status = 200) => {
      call.status = status;
      call.error = typeof body?.error === 'string' ? body.error : undefined;
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    try {
      requireWire(
        url.origin === sandboxOrigin && !url.username && !url.password && !url.hash,
        'error_param',
      );
      const publicApi = url.pathname === '/api/v2/media_space/upload_image';
      const shop = this.authenticate(url, publicApi);
      const endpoint = url.pathname.replace('/api/v2/', '');
      const isWrite =
        /^(product\/(add_item|init_tier_variation|update_item|update_model|update_price|update_stock|update_tier_variation|unlist_item)|media_space\/upload_image)$/.test(
          endpoint,
        );
      requireWire(request.method === (isWrite ? 'POST' : 'GET'), 'error_param');
      let body: WireObject = {};
      if (isWrite && !publicApi) {
        requireWire(
          request.headers.get('content-type')?.split(';')[0] === 'application/json',
          'error_param',
        );
        body = object(await request.json());
        call.body = this.redact(clone(body));
      }
      const itemId = String(
        body.item_id ??
          url.searchParams.get('item_id') ??
          url.searchParams.get('item_id_list') ??
          '',
      );
      const faultIndex = this.faults.findIndex(
        (fault) =>
          fault.path === url.pathname &&
          (!fault.shopId || fault.shopId === shop.credentials.shopId) &&
          (!fault.itemId || fault.itemId === itemId),
      );
      const fault = faultIndex >= 0 ? this.faults.splice(faultIndex, 1)[0] : undefined;
      if (fault?.kind === 'business_error')
        throw new WireFailure(fault.code ?? 'product.error_busi');
      if (fault?.kind === 'response') return respond(clone(fault.body), fault.status ?? 200);
      let raw: unknown;
      if (publicApi) raw = envelope(await this.upload(request, shop, call));
      else if (endpoint === 'shop/get_shop_info')
        raw = {
          ...envelope(),
          shop_name: shop.profile.name,
          region: 'VN',
          status: 'NORMAL',
          shop_fulfillment_flag: 'Others',
          is_cb: false,
          is_sip: false,
          is_upgraded_cbsc: false,
          auth_time: Math.floor(this.now() / 1000) - 60,
          expire_time: Math.floor(this.now() / 1000) + 86400,
        };
      else raw = envelope(this.dispatch(endpoint, url, body, shop, fault));
      call.committed = isWrite;
      if (fault?.kind === 'alter_unselected') {
        requireWire(isWrite && !!itemId);
        this.ownedItem(shop.credentials.shopId, itemId).base[fault.field ?? 'weight'] = clone(
          fault.value ?? '9.999',
        );
      }
      if (fault?.kind === 'drop_response') {
        call.dropped = true;
        throw new TypeError('Synthetic response lost after server commit');
      }
      return respond(raw);
    } catch (error) {
      if (error instanceof WireFailure)
        return respond({ ...envelope(), error: error.code, message: error.message });
      if (call.dropped) throw error;
      return respond({ ...envelope(), error: 'error_param', message: 'Malformed fixture request' });
    }
  };
  private async upload(request: Request, shop: PreparedWireShop, call: PreparedWireCall) {
    requireWire(
      request.headers.get('content-type')?.startsWith('multipart/form-data;'),
      'error_param',
    );
    const form = await request.formData();
    requireWire([...form.keys()].every((key) => ['image', 'scene', 'ratio'].includes(key)));
    requireWire(form.getAll('scene').length <= 1 && form.getAll('ratio').length <= 1);
    const scene = form.get('scene') ?? 'normal',
      ratio = form.get('ratio') ?? '1:1';
    requireWire(
      ['normal', 'desc'].includes(String(scene)) && ['1:1', '3:4'].includes(String(ratio)),
    );
    requireWire(ratio !== '3:4' || shop.allowPortrait, 'error_auth');
    const files = list(form.getAll('image'), 1, 8),
      uploaded: StoredImage[] = [];
    for (const file of files) {
      requireWire(
        file instanceof Blob &&
          ['image/png', 'image/jpeg'].includes(file.type) &&
          file.size > 0 &&
          file.size <= 10 * 1024 * 1024,
      );
      const bytes = Buffer.from(await file.arrayBuffer()),
        info = await sharp(bytes).metadata();
      requireWire(info.width && info.height && ['png', 'jpeg'].includes(info.format ?? ''));
      const image: StoredImage = {
        partnerId: shop.credentials.partnerId,
        imageId: 'qa-wire-img-' + ++this.nextImageId,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes.length,
        mime: file.type,
        width: info.width!,
        height: info.height!,
        scene: String(scene),
        ratio: String(ratio),
      };
      uploaded.push(image);
    }
    for (const image of uploaded) this.images.set(image.imageId, image);
    call.body = { scene, ratio, image: uploaded.map(({ partnerId: _, ...image }) => image) };
    const infos = uploaded.map((image, index) => ({
      id: index,
      error: '',
      message: '',
      image_info: {
        image_id: image.imageId,
        image_url_list: [
          { image_url_region: 'VN', image_url: 'https://fixture.invalid/file/' + image.imageId },
        ],
      },
    }));
    return {
      ...(infos.length === 1 ? { image_info: infos[0]!.image_info } : {}),
      image_info_list: infos,
    };
  }
  private dispatch(
    endpoint: string,
    url: URL,
    body: WireObject,
    shop: PreparedWireShop,
    fault?: PreparedWireFault,
  ): unknown {
    const profile = shop.profile,
      shopId = shop.credentials.shopId,
      partnerId = shop.credentials.partnerId;
    const category = (id: unknown) => {
      const entry = profile.categories.find((candidate) => candidate.categoryId === String(id));
      requireWire(entry, 'product.error_invalid_category');
      return entry!;
    };
    if (endpoint === 'product/get_category')
      return {
        category_list: profile.categories.map((entry) => ({
          category_id: Number(entry.categoryId),
          parent_category_id: 0,
          original_category_name: entry.name,
          display_category_name: entry.name,
          has_children: false,
        })),
      };
    if (endpoint === 'product/get_attribute_tree')
      return {
        list: this.queryIds(url, 'category_id_list', 20).map((id) => {
          const entry = category(id),
            attribute = entry.requiredAttribute;
          return {
            category_id: Number(id),
            warning: '',
            attribute_tree: [
              {
                attribute_id: Number(attribute.attributeId),
                mandatory: true,
                name: attribute.name,
                attribute_info: {
                  input_type: 1,
                  input_validation_type: 0,
                  format_type: 1,
                  max_value_count: 1,
                  support_search_value: false,
                },
                attribute_value_list: attribute.values.map((value) => ({
                  value_id: Number(value.valueId),
                  name: value.name,
                  value_unit: '',
                  child_attribute_list: [],
                })),
              },
            ],
          };
        }),
      };
    if (endpoint === 'product/get_brand_list') {
      const entry = category(url.searchParams.get('category_id')),
        offset = Number(url.searchParams.get('offset')),
        size = Number(url.searchParams.get('page_size'));
      requireWire(
        url.searchParams.has('offset') &&
          Number.isSafeInteger(offset) &&
          offset >= 0 &&
          size >= 1 &&
          size <= 100 &&
          ['1', '2'].includes(url.searchParams.get('status') ?? ''),
      );
      return {
        brand_list:
          offset === 0 && url.searchParams.get('status') === '1'
            ? [
                {
                  brand_id: Number(entry.brandId),
                  original_brand_name: entry.brandName,
                  display_brand_name: entry.brandName,
                },
              ]
            : [],
        has_next_page: false,
        next_offset: offset === 0 ? 1 : offset,
      };
    }
    if (endpoint === 'product/get_item_limit') {
      if (url.searchParams.has('category_id')) category(url.searchParams.get('category_id'));
      return {
        price_limit: { min_limit: 1000, max_limit: 1000000 },
        stock_limit: { min_limit: 0, max_limit: 10000 },
        item_name_length_limit: { min_limit: 1, max_limit: 120 },
        item_image_count_limit: { min_limit: 1, max_limit: 9 },
        item_description_length_limit: { min_limit: 1, max_limit: 3000 },
        tier_variation_name_length_limit: { min_limit: 1, max_limit: 30 },
        tier_variation_option_length_limit: { min_limit: 1, max_limit: 30 },
        item_count_limit: { max_limit: 1000 },
        extended_description_limit: {
          description_text_length_min: 1,
          description_text_length_max: 5000,
          description_image_num_min: 0,
          description_image_num_max: 10,
          description_image_width_min: 1,
          description_image_height_min: 1,
          description_image_aspect_ratio_min: 0.1,
          description_image_aspect_ratio_max: 10,
        },
        dts_limit: {
          days_to_ship_limit: { min_limit: 3, max_limit: 15 },
          non_pre_order_days_to_ship: 2,
        },
        weight_limit: { weight_mandatory: true },
        dimension_limit: { dimension_mandatory: true },
        size_chart_limit: {
          size_chart_mandatory: false,
          support_image_size_chart: false,
          support_template_size_chart: false,
        },
        gtin_limit: { gtin_validation_rule: shop.gtinRule ?? 'Optional' },
      };
    }
    if (endpoint === 'logistics/get_channel_list')
      return {
        logistics_channel_list: [
          {
            logistics_channel_id: Number(profile.logisticsChannelId),
            logistics_channel_name: 'QA vận chuyển ' + profile.name,
            enabled: true,
            cod_enabled: true,
            fee_type: 'SIZE_INPUT',
            weight_limit: { item_min_weight: 0, item_max_weight: 50 },
            item_max_dimension: {
              height: 100,
              width: 100,
              length: 100,
              unit: 'cm',
              dimension_sum: 300,
            },
            force_enable: false,
            mask_channel_id: 0,
            compulsory_channel: false,
          },
        ],
      };
    if (endpoint === 'product/get_item_list') {
      const offset = Number(url.searchParams.get('offset') ?? 0),
        size = Number(url.searchParams.get('page_size'));
      requireWire(
        Number.isInteger(offset) &&
          offset >= 0 &&
          Number.isInteger(size) &&
          size >= 1 &&
          size <= 100,
      );
      const statuses = url.searchParams.getAll('item_status').flatMap((entry) => entry.split(','));
      const all = [...this.items.values()].filter(
        (item) =>
          item.shopId === shopId && (!statuses.length || statuses.includes(item.base.item_status)),
      );
      return {
        item: all.slice(offset, offset + size).map((item) => ({
          item_id: item.base.item_id,
          item_status: item.base.item_status,
          update_time: item.base.update_time,
        })),
        total_count: all.length,
        has_next_page: offset + size < all.length,
        next_offset: Math.min(offset + size, all.length),
      };
    }
    if (endpoint === 'product/get_item_base_info')
      return {
        item_list: this.queryIds(url, 'item_id_list')
          .map((id) => clone(this.ownedItem(shopId, id).base))
          .reverse(),
      };
    if (endpoint === 'product/get_model_list')
      return this.modelResponse(this.ownedItem(shopId, this.queryIds(url, 'item_id', 1)[0]!));
    if (endpoint === 'product/get_item_promotion') {
      const success_list: WireObject[] = [],
        failure_list: WireObject[] = [];
      for (const id of this.queryIds(url, 'item_id_list')) {
        const item = this.items.get(id);
        if (!item || item.shopId !== shopId)
          failure_list.push({ item_id: Number(id), failed_reason: 'Item not found in shop' });
        else
          success_list.push({
            item_id: Number(id),
            ...(item.promotions === undefined ? {} : { promotion: clone(item.promotions) }),
          });
      }
      return { success_list: success_list.reverse(), failure_list };
    }
    if (endpoint === 'product/add_item') {
      fields(body, [
        'original_price',
        'description',
        'weight',
        'item_name',
        'item_status',
        'dimension',
        'logistic_info',
        'attribute_list',
        'category_id',
        'image',
        'pre_order',
        'item_sku',
        'condition',
        'brand',
        'description_info',
        'description_type',
        'seller_stock',
        'gtin_code',
        'promotion_images',
      ]);
      category(body.category_id);
      this.validateItem(body, shop, true);
      const itemId = ++this.nextItemId,
        base: WireObject = {
          ...clone(body),
          item_id: itemId,
          item_status: body.item_status ?? 'NORMAL',
          description_type: body.description_type ?? 'normal',
          weight: String(body.weight),
          has_model: false,
          has_promotion: false,
          create_time: Math.floor(this.now() / 1000),
          update_time: Math.floor(this.now() / 1000),
          price_info: priceInfo(body.original_price),
          stock_info_v2: stockInfo(body.seller_stock ?? [{ stock: 0 }]),
        };
      delete base.original_price;
      delete base.seller_stock;
      if (body.promotion_images)
        base.promotion_image = { ...clone(body.promotion_images), image_ratio: '1:1' };
      delete base.promotion_images;
      this.items.set(String(itemId), {
        partnerId,
        shopId,
        createdAt: this.now(),
        base,
        models: [],
        tiers: [],
        promotions: [],
      });
      return { item_id: itemId };
    }
    if (endpoint === 'product/unlist_item') {
      fields(body, ['item_list']);
      const entries = list(body.item_list, 1, 50);
      const success_list = entries.map((entry) => {
        fields(object(entry), ['item_id', 'unlist']);
        int(entry.item_id, 1);
        requireWire(typeof entry.unlist === 'boolean');
        const owned = this.ownedItem(shopId, String(entry.item_id));
        requireWire(owned.base.has_promotion === false, 'product.error_busi');
        owned.base.item_status = entry.unlist ? 'UNLIST' : 'NORMAL';
        return { item_id: entry.item_id, unlist: entry.unlist };
      });
      return { success_list, failure_list: [] };
    }
    const knownMutations = [
      'product/init_tier_variation',
      'product/update_item',
      'product/update_model',
      'product/update_price',
      'product/update_stock',
      'product/update_tier_variation',
    ];
    requireWire(knownMutations.includes(endpoint), 'error_param');
    int(body.item_id, 1);
    const item = this.ownedItem(shopId, String(body.item_id));
    if (endpoint === 'product/init_tier_variation') {
      fields(body, ['item_id', 'standardise_tier_variation', 'model']);
      requireWire(this.now() - item.createdAt >= 5000, 'product.error_busi');
      // This fixture implements initial tier setup, not destructive structure conversion.
      requireWire(!item.models.length, 'product.error_param');
      const tiers = this.validateTiers(body.standardise_tier_variation, partnerId),
        models = list(body.model, 1, 50);
      requireWire(tiers.length > 0);
      requireWire(
        models.length ===
          tiers.reduce((count, tier) => count * tier.variation_option_list.length, 1),
      );
      const indices = new Set<string>();
      const parsed: WireObject[] = models.map((raw) => {
        const model = object(raw);
        fields(model, [
          'tier_index',
          'original_price',
          'model_sku',
          'seller_stock',
          'gtin_code',
          'weight',
          'dimension',
          'pre_order',
        ]);
        this.validateIndex(model.tier_index, tiers);
        const key = JSON.stringify(model.tier_index);
        requireWire(!indices.has(key));
        indices.add(key);
        this.validatePrice(model.original_price);
        requireWire(typeof model.model_sku === 'string' && model.model_sku.length <= 100);
        this.validateGtin(model.gtin_code, shop);
        const { original_price, seller_stock, ...rest } = model;
        return {
          ...clone(rest),
          model_id: ++this.nextModelId,
          model_status: 'MODEL_NORMAL',
          has_promotion: false,
          promotion_id: 0,
          price_info: priceInfo(original_price),
          stock_info_v2: stockInfo(seller_stock),
          ...(model.weight === undefined ? {} : { weight: String(model.weight) }),
        };
      });
      item.tiers = clone(tiers);
      if (models.some((model) => model.weight !== undefined)) {
        for (const model of parsed) if (model.weight === undefined) model.weight = item.base.weight;
        item.base.weight = String(Math.max(...parsed.map((model) => Number(model.weight))));
      }
      if (models.some((model) => model.dimension !== undefined)) {
        for (const model of parsed)
          if (model.dimension === undefined) model.dimension = clone(item.base.dimension);
        const volume = (model: WireObject) =>
          model.dimension.package_length *
          model.dimension.package_width *
          model.dimension.package_height;
        item.base.dimension = clone(
          [...parsed].sort((a, b) => volume(b) - volume(a))[0]!.dimension,
        );
      }
      item.models = parsed;
      item.base.has_model = true;
      delete item.base.price_info;
      delete item.base.stock_info_v2;
      return { item_id: body.item_id, ...this.modelResponse(item) };
    }
    if (endpoint === 'product/update_item') {
      fields(body, [
        'item_id',
        'item_name',
        'description',
        'description_type',
        'description_info',
        'image',
        'promotion_images',
        'category_id',
        'brand',
        'attribute_list',
        'logistic_info',
        'weight',
        'dimension',
        'condition',
        'pre_order',
        'gtin_code',
        'item_sku',
      ]);
      this.validateItem(body, shop, false, item.base);
      for (const [key, value] of Object.entries(body)) {
        if (key === 'item_id') continue;
        if (key === 'promotion_images')
          item.base.promotion_image = { ...clone(value), image_ratio: '1:1' };
        else item.base[key] = key === 'weight' ? String(value) : clone(value);
      }
      item.base.update_time = Math.floor(this.now() / 1000);
      return { item_id: body.item_id };
    }
    if (endpoint === 'product/update_tier_variation') {
      fields(body, ['item_id', 'standardise_tier_variation', 'model_list']);
      const tiers = this.validateTiers(body.standardise_tier_variation, partnerId);
      requireWire(tiers.length === item.tiers.length && tiers.length > 0);
      // Image/name update coverage only; addition/deletion needs a separate fixture implementation.
      requireWire(
        tiers.every(
          (tier, index) =>
            tier.variation_option_list.length === item.tiers[index]!.variation_option_list.length,
        ),
      );
      const updates =
        body.model_list === undefined
          ? item.models.map((model) => ({ model_id: model.model_id, tier_index: model.tier_index }))
          : list(body.model_list, 1);
      requireWire(
        updates.length === item.models.length &&
          new Set(updates.map((entry) => entry.model_id)).size === updates.length &&
          new Set(updates.map((entry) => JSON.stringify(entry.tier_index))).size === updates.length,
      );
      for (const update of updates) {
        fields(object(update), ['model_id', 'tier_index']);
        requireWire(item.models.some((model) => model.model_id === update.model_id));
        this.validateIndex(update.tier_index, tiers);
      }
      for (const update of updates)
        item.models.find((model) => model.model_id === update.model_id)!.tier_index = clone(
          update.tier_index,
        );
      item.tiers = clone(tiers);
      return undefined;
    }
    if (endpoint === 'product/update_model') {
      fields(body, ['item_id', 'model']);
      const rows = list(body.model, 1);
      requireWire(new Set(rows.map((row) => row.model_id)).size === rows.length);
      for (const row of rows) {
        fields(object(row), [
          'model_id',
          'model_sku',
          'pre_order',
          'gtin_code',
          'model_status',
          'weight',
          'dimension',
        ]);
        requireWire(item.models.some((model) => model.model_id === row.model_id));
        requireWire(typeof row.model_sku === 'string' && row.model_sku.length <= 100);
        if (row.gtin_code !== undefined) this.validateGtin(row.gtin_code, shop);
        requireWire(row.model_status === undefined, 'error_auth'); // local VN fixture has no CNSC rights
      }
      for (const row of rows)
        Object.assign(
          item.models.find((model) => model.model_id === row.model_id)!,
          clone(row),
          row.weight === undefined ? {} : { weight: String(row.weight) },
        );
      return undefined;
    }
    const isPrice = endpoint === 'product/update_price',
      key = isPrice ? 'price_list' : 'stock_list';
    fields(body, ['item_id', key]);
    const rows = list(body[key], 1),
      successes: WireObject[] = [],
      failures: WireObject[] = [];
    requireWire(new Set(rows.map((row) => row.model_id ?? 0)).size === rows.length);
    for (const row of rows) {
      fields(object(row), isPrice ? ['model_id', 'original_price'] : ['model_id', 'seller_stock']);
      int(row.model_id ?? 0);
      requireWire(
        item.models.length
          ? item.models.some((model) => model.model_id === row.model_id)
          : (row.model_id ?? 0) === 0,
      );
      if (isPrice) this.validatePrice(row.original_price);
      else stockInfo(row.seller_stock);
    }
    for (const [index, row] of rows.entries()) {
      const target = item.models.length
          ? item.models.find((model) => model.model_id === row.model_id)!
          : item.base,
        modelId = row.model_id ?? 0;
      if (fault?.kind === 'partial' && index >= (fault.successCount ?? 1)) {
        failures.push({ model_id: modelId, failed_reason: 'Synthetic model write rejected' });
        continue;
      }
      if (isPrice && (item.base.has_promotion || target.has_promotion || item.promotions?.length)) {
        failures.push({
          model_id: modelId,
          failed_reason: 'Price cannot change in ongoing or upcoming promotion',
        });
        continue;
      }
      if (isPrice) {
        target.price_info = priceInfo(row.original_price);
        successes.push({ model_id: modelId, original_price: row.original_price });
      } else {
        try {
          target.stock_info_v2 = stockInfo(
            row.seller_stock,
            target.stock_info_v2?.summary_info?.total_reserved_stock ?? 0,
          );
          successes.push(
            ...row.seller_stock.map((stock: WireObject) => ({ model_id: modelId, ...stock })),
          );
        } catch {
          failures.push({ model_id: modelId, failed_reason: 'Stock below reserved stock' });
        }
      }
    }
    return { success_list: successes.reverse(), failure_list: failures.reverse() };
  }
  private validatePrice(value: unknown) {
    int(value, 1000);
    requireWire((value as number) <= 1000000);
  }
  private validateGtin(value: unknown, shop: PreparedWireShop) {
    if (value === undefined) {
      requireWire((shop.gtinRule ?? 'Optional') === 'Optional');
      return;
    }
    requireWire(
      typeof value === 'string' &&
        ((value === '00' && shop.gtinRule !== 'Mandatory') || /^\d{8,14}$/.test(value as string)),
    );
  }
  private validateItem(
    body: WireObject,
    shop: PreparedWireShop,
    creating: boolean,
    before: WireObject = {},
  ) {
    const effective = { ...before, ...body },
      partnerId = shop.credentials.partnerId;
    if (creating || body.item_name !== undefined)
      requireWire(
        typeof body.item_name === 'string' &&
          body.item_name.length >= 1 &&
          body.item_name.length <= 120,
      );
    if (creating) this.validatePrice(body.original_price);
    if (creating || body.weight !== undefined)
      requireWire(
        typeof body.weight === 'number' &&
          Number.isFinite(body.weight) &&
          body.weight > 0 &&
          body.weight <= 50,
      );
    if (creating || body.dimension !== undefined) {
      const dimension = object(body.dimension);
      fields(dimension, ['package_height', 'package_length', 'package_width']);
      for (const key of ['package_height', 'package_length', 'package_width']) {
        int(dimension[key], 1);
        requireWire(dimension[key] <= 100);
      }
    }
    if (body.item_status !== undefined)
      requireWire(['NORMAL', 'UNLIST'].includes(body.item_status));
    if (body.condition !== undefined)
      requireWire(['new', 'used'].includes(String(body.condition).toLowerCase()));
    if (body.pre_order !== undefined) {
      const preOrder = object(body.pre_order);
      fields(preOrder, ['is_pre_order', 'days_to_ship']);
      requireWire(typeof preOrder.is_pre_order === 'boolean');
      if (preOrder.is_pre_order) {
        int(preOrder.days_to_ship, 3);
        requireWire(preOrder.days_to_ship <= 15);
      }
    }
    if (creating || body.gtin_code !== undefined) this.validateGtin(body.gtin_code, shop);
    if (
      creating ||
      body.description !== undefined ||
      body.description_info !== undefined ||
      body.description_type !== undefined
    ) {
      if ((effective.description_type ?? 'normal') === 'extended') {
        requireWire(shop.allowExtendedDescription, 'error_auth');
        const blocks = list(
          object(object(effective.description_info).extended_description).field_list,
          1,
          100,
        );
        for (const block of blocks) {
          if (block.field_type === 'image')
            this.image(partnerId, object(block.image_info).image_id);
          else requireWire(block.field_type === 'text' && typeof block.text === 'string');
        }
      } else
        requireWire(
          (effective.description_type ?? 'normal') === 'normal' &&
            typeof effective.description === 'string' &&
            !body.description_info,
        );
    }
    if (creating || body.image !== undefined) {
      const image = object(body.image);
      fields(image, ['image_id_list', 'image_ratio']);
      requireWire(['1:1', '3:4'].includes(image.image_ratio ?? '1:1'));
      requireWire(image.image_ratio !== '3:4' || shop.allowPortrait, 'error_auth');
      for (const id of list(image.image_id_list, 1, 9)) this.image(partnerId, id);
    }
    if (body.promotion_images !== undefined) {
      requireWire(effective.image?.image_ratio === '3:4');
      fields(object(body.promotion_images), ['image_id_list']);
      for (const id of list(body.promotion_images.image_id_list, 1, 1)) {
        const image = this.image(partnerId, id);
        requireWire(image.width === image.height);
      }
    }
    const category = shop.profile.categories.find(
      (entry) => entry.categoryId === String(effective.category_id),
    );
    requireWire(category, 'product.error_invalid_category');
    if (creating || body.brand !== undefined) {
      requireWire(
        body.brand &&
          body.brand.brand_id === Number(category!.brandId) &&
          body.brand.original_brand_name === category!.brandName,
      );
    }
    if (creating || body.attribute_list !== undefined) {
      const attributes = list(body.attribute_list, 1);
      requireWire(
        new Set(attributes.map((entry) => entry.attribute_id)).size === attributes.length,
      );
      const required = category!.requiredAttribute;
      requireWire(attributes.some((entry) => entry.attribute_id === Number(required.attributeId)));
      for (const attribute of attributes) {
        fields(object(attribute), ['attribute_id', 'attribute_value_list']);
        requireWire(attribute.attribute_id === Number(required.attributeId));
        const values = list(attribute.attribute_value_list, 1, 1);
        requireWire(
          values.every((value) =>
            required.values.some((entry) => Number(entry.valueId) === value.value_id),
          ),
        );
      }
    }
    if (creating || body.logistic_info !== undefined) {
      const channels = list(body.logistic_info, 1);
      requireWire(new Set(channels.map((entry) => entry.logistic_id)).size === channels.length);
      requireWire(channels.some((entry) => entry.enabled));
      for (const channel of channels) {
        fields(object(channel), ['logistic_id', 'enabled', 'is_free', 'size_id', 'shipping_fee']);
        requireWire(
          channel.logistic_id === Number(shop.profile.logisticsChannelId) &&
            typeof channel.enabled === 'boolean',
        );
      }
    }
  }
  private validateTiers(raw: unknown, partnerId: string): WireObject[] {
    const tiers = list(raw, 0, 2).map((entry) => object(entry));
    for (const [index, tier] of tiers.entries()) {
      fields(tier, [
        'variation_id',
        'variation_name',
        'variation_group_id',
        'variation_option_list',
      ]);
      int(tier.variation_id);
      requireWire(typeof tier.variation_name === 'string' && tier.variation_name.length > 0);
      const options = list(tier.variation_option_list, 1, 50);
      requireWire(
        new Set(options.map((entry) => entry.variation_option_name)).size === options.length,
      );
      for (const option of options) {
        fields(object(option), ['variation_option_id', 'variation_option_name', 'image_id']);
        int(option.variation_option_id ?? 0);
        requireWire(
          typeof option.variation_option_name === 'string' &&
            option.variation_option_name.length > 0,
        );
        if (option.image_id !== undefined) {
          requireWire(index === 0, 'product.error_tier_img_not_allower');
          this.image(partnerId, option.image_id);
        }
      }
      requireWire(
        !options.some((option) => option.image_id !== undefined) ||
          options.every((option) => option.image_id !== undefined),
        'product.error_tier_img_partial',
      );
    }
    requireWire(new Set(tiers.map((tier) => tier.variation_name)).size === tiers.length);
    return tiers;
  }
  private validateIndex(raw: unknown, tiers: WireObject[]) {
    const index = list(raw, tiers.length, tiers.length);
    index.forEach((value, tier) => {
      int(value);
      requireWire(value < tiers[tier]!.variation_option_list.length);
    });
  }
  private modelResponse(item: StoredItem) {
    return clone({
      tier_variation: item.tiers.map((tier) => ({
        name: tier.variation_name,
        option_list: tier.variation_option_list.map((option: WireObject) => ({
          option: option.variation_option_name,
          ...(option.image_id
            ? {
                image: {
                  image_id: option.image_id,
                  image_url: 'https://fixture.invalid/file/' + option.image_id,
                },
              }
            : {}),
        })),
      })),
      standardise_tier_variation: item.tiers,
      model: [...item.models].reverse(),
    });
  }
}
