import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { SandboxSnapshot, RemoteDescriptionBlock } from '@shopee/domain';
import { API_HOSTS, type ShopCredentials } from './shop-info.js';
import { signRequest } from './sign.js';

export type ProductOutcome<T> =
  | { kind: 'success'; data: T; requestId?: string; warning?: string; httpStatus?: number }
  | { kind: 'rejected'; code: string; requestId?: string; httpStatus?: number }
  | {
      kind: 'unknown';
      reason: 'transport' | 'invalid_response';
      httpStatus?: number;
      requestId?: string;
    };
export type SelectiveItemPatch = {
  item_id: number;
  item_name?: string;
  description?: string;
  description_type?: 'normal' | 'extended';
  description_info?: {
    extended_description: {
      field_list: (
        | { field_type: 'text'; text: string }
        | { field_type: 'image'; image_info: { image_id: string } }
      )[];
    };
  };
  image?: { image_id_list: string[]; image_ratio: '1:1' | '3:4' };
  promotion_images?: { image_id_list: string[] };
};
const id = z
  .union([z.number().int().positive().max(Number.MAX_SAFE_INTEGER), z.string().regex(/^\d+$/)])
  .transform(String);
const money = z
  .union([z.number().finite().nonnegative(), z.string().regex(/^\d+(\.\d+)?$/)])
  .transform(String);
const common = z.object({
  error: z.string(),
  request_id: z.string().optional(),
  warning: z.string().optional(),
  response: z.unknown().optional(),
});
const image = z
  .object({ image_id_list: z.array(z.string().min(1)), image_ratio: z.string().optional() })
  .passthrough();
const block = z.discriminatedUnion('field_type', [
  z.object({ field_type: z.literal('text'), text: z.string() }),
  z.object({
    field_type: z.literal('image'),
    image_info: z.object({ image_id: z.string().min(1) }),
  }),
]);
const itemSchema = z
  .object({
    item_id: id,
    item_name: z.string(),
    item_status: z.string(),
    category_id: id,
    description: z.string().optional(),
    description_type: z.enum(['normal', 'extended']).optional(),
    description_info: z
      .object({ extended_description: z.object({ field_list: z.array(block) }) })
      .optional(),
    image,
    promotion_image: image.optional(),
  })
  .passthrough();
const modelSchema = z
  .object({
    model_id: id,
    model_sku: z.string().optional(),
    tier_index: z.array(z.number().int().nonnegative()),
    price_info: z.array(
      z
        .object({
          currency: z.string().optional(),
          original_price: money.optional(),
          current_price: money.optional(),
        })
        .passthrough(),
    ),
    stock_info_v2: z
      .object({
        summary_info: z
          .object({
            total_available_stock: z.number().int().nonnegative().optional(),
            total_reserved_stock: z.number().int().nonnegative().optional(),
          })
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
const modelsSchema = z.object({
  model: z.array(modelSchema),
  tier_variation: z.array(
    z
      .object({
        name: z.string(),
        option_list: z.array(z.object({ option: z.string() }).passthrough()),
      })
      .passthrough(),
  ),
});
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ':' + stableJson(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value) ?? 'null';
}
export function productFingerprint(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}
function withoutUrls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUrls);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !/url/i.test(key))
        .map(([key, child]) => [key, withoutUrls(child)]),
    );
  return value;
}
export function snapshotContent(snapshot: SandboxSnapshot) {
  const { fingerprint: _, observedAt: __, requestIds: ___, ...content } = snapshot;
  return content;
}
export function normalizeProductSnapshot(
  itemRaw: unknown,
  modelsRaw: unknown,
  expectedId: string,
  requestIds: string[] = [],
): SandboxSnapshot {
  const item = itemSchema.parse(itemRaw),
    models = modelsSchema.parse(modelsRaw);
  if (item.item_id !== expectedId) throw new Error('SANDBOX_REMOTE_ITEM_MISMATCH');
  if (new Set(models.model.map((m) => m.model_id)).size !== models.model.length)
    throw new Error('SANDBOX_REMOTE_MODEL_DUPLICATE');
  const descriptionType = item.description_type ?? 'normal';
  let description: RemoteDescriptionBlock[];
  if (descriptionType === 'extended') {
    if (!item.description_info) throw new Error('SANDBOX_REMOTE_DESCRIPTION_MISSING');
    description = item.description_info.extended_description.field_list.map((b) =>
      b.field_type === 'text'
        ? { type: 'text', text: b.text }
        : { type: 'image', imageId: b.image_info.image_id },
    );
  } else {
    if (item.description === undefined) throw new Error('SANDBOX_REMOTE_DESCRIPTION_MISSING');
    description = [{ type: 'text', text: item.description }];
  }
  const excluded = new Set([
    'item_id',
    'item_name',
    'description',
    'description_type',
    'description_info',
    'image',
    'update_time',
    'create_time',
  ]);
  const protectedItem = Object.fromEntries(Object.entries(item).filter(([k]) => !excluded.has(k)));
  if (Object.hasOwn(protectedItem, 'logistic_info')) {
    const logistics = z
      .array(z.object({ logistic_id: id }).passthrough())
      .safeParse(protectedItem.logistic_info);
    if (!logistics.success) throw new Error('SANDBOX_REMOTE_LOGISTICS_INVALID');
    if (
      new Set(logistics.data.map((channel) => channel.logistic_id)).size !== logistics.data.length
    )
      throw new Error('SANDBOX_REMOTE_LOGISTICS_DUPLICATE');
    // Channels are identified by ID, and Shopee may rotate their response order between reads.
    // Preserve every channel field and its original representation; only canonicalize this known set.
    protectedItem.logistic_info = [
      ...(protectedItem.logistic_info as Record<string, unknown>[]),
    ].sort((one, two) => String(one.logistic_id).localeCompare(String(two.logistic_id)));
  }
  if (Object.hasOwn(protectedItem, 'attribute_list')) {
    const attributes = z
      .array(z.object({ attribute_id: id }).passthrough())
      .safeParse(protectedItem.attribute_list);
    if (!attributes.success) throw new Error('SANDBOX_REMOTE_ATTRIBUTES_INVALID');
    if (
      new Set(attributes.data.map((attribute) => attribute.attribute_id)).size !==
      attributes.data.length
    )
      throw new Error('SANDBOX_REMOTE_ATTRIBUTES_DUPLICATE');
    // The outer collection is keyed by attribute ID; inner value order stays untouched.
    protectedItem.attribute_list = [
      ...(protectedItem.attribute_list as Record<string, unknown>[]),
    ].sort((one, two) => String(one.attribute_id).localeCompare(String(two.attribute_id)));
  }
  const content = {
    itemId: item.item_id,
    title: item.item_name,
    descriptionType,
    description,
    gallery: { imageIds: item.image.image_id_list, ratio: item.image.image_ratio ?? null },
    coverImageIds: item.promotion_image?.image_id_list ?? [],
    categoryId: item.category_id,
    status: item.item_status,
    tierNames: models.tier_variation.map((t) => t.name),
    models: models.model
      .map((m) => {
        if (
          m.tier_index.length !== models.tier_variation.length ||
          m.tier_index.some((v, i) => !models.tier_variation[i]?.option_list[v])
        )
          throw new Error('SANDBOX_REMOTE_TIER_INVALID');
        const prices = m.price_info;
        if (prices.length !== 1) throw new Error('SANDBOX_REMOTE_PRICE_AMBIGUOUS');
        return {
          modelId: m.model_id,
          sku: m.model_sku ?? '',
          tierIndex: m.tier_index,
          optionLabels: m.tier_index.map(
            (v, i) => models.tier_variation[i]!.option_list[v]!.option,
          ),
          originalPrice: prices[0]?.original_price ?? null,
          currentPrice: prices[0]?.current_price ?? null,
          currency: prices[0]?.currency ?? null,
          availableStock: m.stock_info_v2?.summary_info?.total_available_stock ?? null,
          reservedStock: m.stock_info_v2?.summary_info?.total_reserved_stock ?? null,
        };
      })
      .sort((a, b) => a.modelId.localeCompare(b.modelId)),
    protectedFields: withoutUrls({
      item: protectedItem,
      models: [...models.model].sort((a, b) => a.model_id.localeCompare(b.model_id)),
      tiers: models.tier_variation,
    }) as Record<string, unknown>,
  };
  return {
    ...content,
    observedAt: new Date().toISOString(),
    requestIds,
    fingerprint: productFingerprint(content),
  };
}

export class SandboxProductClient {
  constructor(
    private readonly credentials: ShopCredentials,
    private readonly transport: typeof fetch = fetch,
  ) {
    if (
      credentials.environment !== 'sandbox' ||
      !/^\d+$/.test(credentials.partnerId) ||
      !/^\d+$/.test(credentials.shopId)
    )
      throw new Error('SANDBOX_SCOPE_REQUIRED');
  }
  private async call(
    path: string,
    query: Record<string, string> = {},
    body?: SelectiveItemPatch | FormData,
    publicApi = false,
  ): Promise<ProductOutcome<unknown>> {
    const c = this.credentials,
      timestamp = Math.floor(Date.now() / 1000);
    const url = new URL(path, API_HOSTS.sandbox);
    const commonQuery = {
      partner_id: c.partnerId,
      timestamp: String(timestamp),
      sign: signRequest({
        partnerId: c.partnerId,
        partnerKey: c.partnerKey,
        path,
        timestamp,
        ...(publicApi ? {} : { accessToken: c.accessToken, shopId: c.shopId }),
      }),
    };
    for (const [key, value] of Object.entries({
      ...commonQuery,
      ...(publicApi ? {} : { shop_id: c.shopId, access_token: c.accessToken }),
      ...query,
    }))
      url.searchParams.set(key, value);
    try {
      const response = await this.transport(url, {
        method: body ? 'POST' : 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
        headers: {
          Accept: 'application/json',
          ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
      });
      const text = await response.text();
      if (text.length > 3 * 1024 * 1024) return { kind: 'unknown', reason: 'invalid_response' };
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        return {
          kind: 'unknown',
          reason: response.ok ? 'invalid_response' : 'transport',
          ...(!response.ok ? { httpStatus: response.status } : {}),
        };
      }
      const result = common.safeParse(raw);
      if (!result.success)
        return {
          kind: 'unknown',
          reason: response.ok ? 'invalid_response' : 'transport',
          ...(!response.ok ? { httpStatus: response.status } : {}),
        };
      // Never retain arbitrary message/warning values, which can echo sensitive request data.
      const requestId = result.data.request_id?.match(/^[A-Za-z0-9_-]{1,128}$/)?.[0];
      if (result.data.error)
        return {
          kind: 'rejected',
          code: /^[a-zA-Z0-9_.-]{1,100}$/.test(result.data.error)
            ? result.data.error
            : 'unrecognized_error',
          requestId,
          ...(!response.ok ? { httpStatus: response.status } : {}),
        };
      if (!response.ok)
        return { kind: 'unknown', reason: 'transport', httpStatus: response.status };
      return {
        kind: 'success',
        data: result.data.response,
        requestId,
        httpStatus: response.status,
        warning: result.data.warning ? 'SHOPEE_WARNING_PRESENT' : undefined,
      };
    } catch {
      return { kind: 'unknown', reason: 'transport' };
    }
  }
  async read(itemId: string): Promise<ProductOutcome<SandboxSnapshot>> {
    if (!/^\d+$/.test(itemId) || !Number.isSafeInteger(Number(itemId)))
      throw new Error('SANDBOX_ITEM_INVALID');
    const base = await this.call('/api/v2/product/get_item_base_info', { item_id_list: itemId });
    if (base.kind !== 'success') return base;
    const items = z.object({ item_list: z.array(z.unknown()).length(1) }).safeParse(base.data);
    if (!items.success) return { kind: 'unknown', reason: 'invalid_response' };
    const models = await this.call('/api/v2/product/get_model_list', { item_id: itemId });
    if (models.kind !== 'success') return models;
    try {
      return {
        kind: 'success',
        data: normalizeProductSnapshot(
          items.data.item_list[0],
          models.data,
          itemId,
          [base.requestId, models.requestId].filter((s): s is string => !!s),
        ),
        requestId: models.requestId,
      };
    } catch {
      return { kind: 'unknown', reason: 'invalid_response' };
    }
  }
  async limits(categoryId: string): Promise<ProductOutcome<Record<string, unknown>>> {
    const result = await this.call('/api/v2/product/get_item_limit', { category_id: categoryId });
    if (result.kind !== 'success') return result;
    if (!result.data || typeof result.data !== 'object' || Array.isArray(result.data))
      return { kind: 'unknown', reason: 'invalid_response' };
    const allowed = [
      'item_name_length_limit',
      'item_image_count_limit',
      'item_description_length_limit',
      'extended_description_limit',
    ];
    return {
      ...result,
      data: Object.fromEntries(Object.entries(result.data).filter(([k]) => allowed.includes(k))),
    };
  }
  async update(patch: SelectiveItemPatch): Promise<ProductOutcome<{ itemId: string }>> {
    // Fixed allowlist prevents unrelated properties entering the write even at runtime.
    const parsed = z
      .object({
        item_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        item_name: z.string().optional(),
        description: z.string().optional(),
        description_type: z.enum(['normal', 'extended']).optional(),
        description_info: z
          .object({ extended_description: z.object({ field_list: z.array(block) }).strict() })
          .strict()
          .optional(),
        image: z
          .object({
            image_id_list: z.array(z.string().min(1)).min(1),
            image_ratio: z.enum(['1:1', '3:4']),
          })
          .strict()
          .optional(),
        promotion_images: z
          .object({ image_id_list: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,512}$/)).length(1) })
          .strict()
          .optional(),
      })
      .strict()
      .parse(patch);
    const result = await this.call('/api/v2/product/update_item', {}, parsed);
    if (result.kind !== 'success') return result;
    const response = z.object({ item_id: id }).safeParse(result.data);
    if (!response.success || response.data.item_id !== String(patch.item_id))
      return { kind: 'unknown', reason: 'invalid_response' };
    return { ...result, data: { itemId: response.data.item_id } };
  }
  async upload(
    bytes: Uint8Array,
    mime: string,
    scene: 'normal' | 'desc',
    ratio?: '1:1' | '3:4',
  ): Promise<ProductOutcome<{ imageId: string }>> {
    if (!['image/png', 'image/jpeg'].includes(mime) || !bytes.length || bytes.length > 10_000_000)
      throw new Error('SANDBOX_MEDIA_UNSUPPORTED');
    const form = new FormData();
    form.set(
      'image',
      new Blob([Uint8Array.from(bytes)], { type: mime }),
      mime === 'image/png' ? 'source.png' : 'source.jpg',
    );
    form.set('scene', scene);
    if (ratio) form.set('ratio', ratio);
    const result = await this.call('/api/v2/media_space/upload_image', {}, form, true);
    if (result.kind !== 'success') return result;
    const parsed = z
      .object({
        image_info: z.object({ image_id: z.string().min(1) }).optional(),
        image_info_list: z
          .array(
            z.object({
              error: z.string().nullable(),
              image_info: z.object({ image_id: z.string().min(1) }).optional(),
            }),
          )
          .optional(),
      })
      .safeParse(result.data);
    if (!parsed.success)
      return {
        kind: 'unknown',
        reason: 'invalid_response',
        httpStatus: result.httpStatus,
        requestId: result.requestId,
      };
    if (parsed.data.image_info_list?.some((i) => i.error))
      return {
        kind: 'rejected',
        code: 'image_upload_rejected',
        requestId: result.requestId,
        httpStatus: result.httpStatus,
      };
    const imageIds = [
      ...new Set(
        [
          parsed.data.image_info?.image_id,
          ...(parsed.data.image_info_list?.map((i) => i.image_info?.image_id) ?? []),
        ].filter((v): v is string => !!v),
      ),
    ];
    return imageIds.length === 1
      ? { ...result, data: { imageId: imageIds[0]! } }
      : {
          kind: 'unknown',
          reason: 'invalid_response',
          httpStatus: result.httpStatus,
          requestId: result.requestId,
        };
  }
}
