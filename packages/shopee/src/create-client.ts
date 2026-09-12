import { z } from 'zod';
import { signRequest } from './sign.js';
import { API_HOSTS, type ShopCredentials } from './shop-info.js';
import type { ProductOutcome } from './product-client.js';

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveId = integer.min(1);
const imageId = z.string().regex(/^[A-Za-z0-9_-]{1,512}$/);
const trialSku = z.string().regex(/^SBX-BULK-[A-Za-z0-9_-]{1,90}$/);
const stock = z.array(z.object({ stock: integer }).strict()).length(1);
const dimension = z
  .object({
    package_height: positiveId,
    package_length: positiveId,
    package_width: positiveId,
  })
  .strict();
const createSchema = z
  .object({
    original_price: positiveId,
    description: z.string().min(1).max(100000),
    description_type: z.literal('normal'),
    weight: z.number().finite().positive(),
    item_name: z
      .string()
      .regex(/^SANDBOX QA(?:\s|$)/)
      .max(200),
    item_sku: trialSku,
    item_status: z.literal('UNLIST'),
    // This pilot is explicitly limited to the previously observed synthetic stationery leaf.
    // The service must still verify that leaf and its current requirements before creating.
    category_id: z.literal(301378),
    dimension,
    logistic_info: z
      .array(
        z
          .object({
            enabled: z.boolean(),
            logistic_id: positiveId,
            is_free: z.literal(false).optional(),
            size_id: integer.optional(),
            shipping_fee: z.number().finite().nonnegative().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(10),
    attribute_list: z.array(
      z
        .object({
          attribute_id: positiveId,
          attribute_value_list: z
            .array(
              z
                .object({
                  value_id: integer,
                  original_value_name: z.string().optional(),
                  value_unit: z.string().optional(),
                })
                .strict()
                .refine(
                  (value) => value.value_id !== 0 || !!value.original_value_name,
                  'Custom values need their source name',
                ),
            )
            .min(1),
        })
        .strict(),
    ),
    image: z
      .object({ image_ratio: z.literal('1:1'), image_id_list: z.array(imageId).min(1).max(8) })
      .strict(),
    brand: z
      .object({ brand_id: z.literal(0), original_brand_name: z.literal('No Brand') })
      .strict(),
    condition: z.literal('NEW'),
    pre_order: z
      .object({ is_pre_order: z.literal(false), days_to_ship: positiveId.optional() })
      .strict(),
    seller_stock: stock,
    gtin_code: z.literal('00').optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.logistic_info.some((channel) => channel.enabled))
      ctx.addIssue({ code: 'custom', message: 'An eligible logistics channel must be enabled' });
    for (const values of [
      value.logistic_info.map((c) => c.logistic_id),
      value.attribute_list.map((a) => a.attribute_id),
      value.image.image_id_list,
    ])
      if (new Set<string | number>(values).size !== values.length)
        ctx.addIssue({ code: 'custom', message: 'Duplicate source identity' });
  });
const option = z
  .object({
    variation_option_id: z.literal(0),
    variation_option_name: z.string().min(1).max(100),
    image_id: imageId.optional(),
  })
  .strict();
const initSchema = z
  .object({
    item_id: positiveId,
    standardise_tier_variation: z
      .array(
        z
          .object({
            variation_id: z.literal(0),
            variation_name: z.string().min(1).max(100),
            variation_group_id: z.literal(0).optional(),
            variation_option_list: z.array(option).min(1).max(4),
          })
          .strict(),
      )
      .max(2),
    model: z
      .array(
        z
          .object({
            tier_index: z.array(integer).max(2),
            model_sku: trialSku,
            original_price: positiveId,
            seller_stock: stock,
            gtin_code: z.literal('00').optional(),
          })
          .strict(),
      )
      .min(1)
      .max(4),
  })
  .strict()
  .superRefine((value, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (isProtected(String(value.item_id))) fail('Existing trial listings are protected');
    const tiers = value.standardise_tier_variation;
    if (new Set(tiers.map((tier) => tier.variation_name)).size !== tiers.length)
      fail('Duplicate tier name');
    tiers.forEach((tier, index) => {
      const options = tier.variation_option_list;
      if (new Set(options.map((entry) => entry.variation_option_name)).size !== options.length)
        fail('Duplicate option name');
      const images = options.filter((entry) => entry.image_id !== undefined).length;
      if ((index > 0 && images > 0) || (images > 0 && images !== options.length))
        fail('Only the complete first tier may have option images');
    });
    if (new Set(value.model.map((model) => model.model_sku)).size !== value.model.length)
      fail('Duplicate model SKU');
    if (
      new Set(value.model.map((model) => JSON.stringify(model.tier_index))).size !==
      value.model.length
    )
      fail('Duplicate tier index');
    if (
      value.model.length !==
      tiers.reduce((total, tier) => total * tier.variation_option_list.length, 1)
    )
      fail('Incomplete trial model combinations');
    for (const model of value.model)
      if (
        model.tier_index.length !== tiers.length ||
        model.tier_index.some((index, tier) => !tiers[tier]?.variation_option_list[index])
      )
        fail('Invalid tier index');
  });

export type CreateUnlistedPayload = z.infer<typeof createSchema>;
export type InitTiersPayload = z.infer<typeof initSchema>;
export { createSchema as createUnlistedSchema, initSchema as initTiersSchema };
export type ItemStatus =
  'NORMAL' | 'BANNED' | 'UNLIST' | 'REVIEWING' | 'SELLER_DELETE' | 'SHOPEE_DELETE';
const statuses = z.enum([
  'NORMAL',
  'BANNED',
  'UNLIST',
  'REVIEWING',
  'SELLER_DELETE',
  'SHOPEE_DELETE',
]);
const record = z.record(z.string(), z.unknown());
const common = z.object({
  error: z.string(),
  request_id: z.string().optional(),
  warning: z.string().optional(),
  response: z.unknown().optional(),
});
const responseId = z
  .union([
    positiveId,
    z
      .string()
      .regex(/^[1-9]\d*$/)
      .refine((value) => Number.isSafeInteger(Number(value))),
  ])
  .transform(String);
function isProtected(itemId: string) {
  return ['803934364', '846056124'].includes(itemId);
}
function validId(raw: string) {
  return responseId.parse(raw);
}
function invalid<T>(result: ProductOutcome<unknown>): ProductOutcome<T> {
  return {
    kind: 'unknown',
    reason: 'invalid_response',
    ...(result.requestId ? { requestId: result.requestId } : {}),
    ...('httpStatus' in result && result.httpStatus ? { httpStatus: result.httpStatus } : {}),
  };
}

/** No retries. The caller owns durable intents, source/QC checks, and newly-created item bindings. */
export class SandboxCreateClient {
  private readonly credentials: ShopCredentials;
  constructor(
    credentials: ShopCredentials,
    private readonly transport: typeof fetch = fetch,
  ) {
    if (
      credentials.environment !== 'sandbox' ||
      credentials.partnerId !== '1232297' ||
      credentials.shopId !== '227418363' ||
      !credentials.partnerKey ||
      !credentials.accessToken
    )
      throw new Error('SANDBOX_CREATE_SCOPE_INVALID');
    this.credentials = { ...credentials };
  }
  private async call(
    path: string,
    query: [string, string][] = [],
    body?: CreateUnlistedPayload | InitTiersPayload,
  ): Promise<ProductOutcome<unknown>> {
    const c = this.credentials,
      timestamp = Math.floor(Date.now() / 1000),
      url = new URL(path, API_HOSTS.sandbox);
    const sign = signRequest({ ...c, path, timestamp });
    for (const [key, value] of Object.entries({
      partner_id: c.partnerId,
      shop_id: c.shopId,
      access_token: c.accessToken,
      timestamp: String(timestamp),
      sign,
    }))
      url.searchParams.set(key, value);
    for (const [key, value] of query) url.searchParams.append(key, value);
    try {
      const response = await this.transport(url, {
        method: body ? 'POST' : 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
        headers: {
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const text = await response.text();
      if (text.length > 8 * 1024 * 1024)
        return { kind: 'unknown', reason: 'invalid_response', httpStatus: response.status };
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        return {
          kind: 'unknown',
          reason: response.ok ? 'invalid_response' : 'transport',
          httpStatus: response.status,
        };
      }
      const parsed = common.safeParse(raw);
      if (!parsed.success)
        return { kind: 'unknown', reason: 'invalid_response', httpStatus: response.status };
      const requestId = parsed.data.request_id?.match(/^[A-Za-z0-9_-]{1,128}$/)?.[0];
      const info = { httpStatus: response.status, ...(requestId ? { requestId } : {}) };
      if (parsed.data.error) {
        const code = /^[A-Za-z0-9_.-]{1,100}$/.test(parsed.data.error)
          ? parsed.data.error
          : 'unrecognized_error';
        // A server-side failure may occur after a mutation. Do not advertise a safe retry.
        if (
          body &&
          (response.status >= 500 ||
            /(?:^|\.)(error_network|error_server|error_inner|error_unknown|error_system_busy|error_busi_add_item_failed)$/.test(
              code,
            ))
        )
          return { kind: 'unknown', reason: 'transport', ...info };
        return { kind: 'rejected', code, ...info };
      }
      if (!response.ok) return { kind: 'unknown', reason: 'transport', ...info };
      return {
        kind: 'success',
        data: parsed.data.response,
        ...info,
        ...(parsed.data.warning ? { warning: 'SHOPEE_WARNING_PRESENT' } : {}),
      };
    } catch {
      return { kind: 'unknown', reason: 'transport' };
    }
  }
  private async metadata(
    path: string,
    query: [string, string][] = [],
    collection?: string,
  ): Promise<ProductOutcome<Record<string, unknown>>> {
    const result = await this.call(path, query);
    if (result.kind !== 'success') return result;
    const parsed = record.safeParse(result.data);
    if (!parsed.success || (collection && !Array.isArray(parsed.data[collection])))
      return invalid(result);
    return { ...result, data: parsed.data };
  }
  categories() {
    return this.metadata('/api/v2/product/get_category', [['language', 'en']], 'category_list');
  }
  attributes(categoryId: string) {
    return this.metadata(
      '/api/v2/product/get_attribute_tree',
      [
        ['category_id_list', validId(categoryId)],
        ['language', 'en'],
      ],
      'list',
    );
  }
  brands(categoryId: string, offset = 0) {
    integer.parse(offset);
    return this.metadata(
      '/api/v2/product/get_brand_list',
      [
        ['category_id', validId(categoryId)],
        ['offset', String(offset)],
        ['page_size', '100'],
        ['status', '1'],
        ['language', 'en'],
      ],
      'brand_list',
    );
  }
  creationLimits(categoryId: string) {
    return this.metadata('/api/v2/product/get_item_limit', [['category_id', validId(categoryId)]]);
  }
  channels() {
    return this.metadata('/api/v2/logistics/get_channel_list', [], 'logistics_channel_list');
  }
  async listItemsPage(input: {
    offset: number;
    statuses: ItemStatus[];
  }): Promise<ProductOutcome<Record<string, unknown>>> {
    const parsed = z
      .object({ offset: integer, statuses: z.array(statuses).min(1).max(6) })
      .strict()
      .parse(input);
    const result = await this.metadata(
      '/api/v2/product/get_item_list',
      [
        ['offset', String(parsed.offset)],
        ['page_size', '100'],
        ...parsed.statuses.map((status): [string, string] => ['item_status', status]),
      ],
      'item',
    );
    if (result.kind !== 'success') return result;
    const page = z
      .object({
        item: z.array(z.object({ item_id: responseId, item_status: statuses }).passthrough()),
        has_next_page: z.boolean(),
        next_offset: integer.optional(),
        total_count: integer,
      })
      .safeParse(result.data);
    if (
      !page.success ||
      (page.data.has_next_page &&
        (page.data.next_offset === undefined || page.data.next_offset <= parsed.offset)) ||
      new Set(page.data.item.map((item) => item.item_id)).size !== page.data.item.length
    )
      return invalid(result);
    return result;
  }
  async readBaseItems(itemIds: string[]): Promise<ProductOutcome<Record<string, unknown>[]>> {
    const ids = z.array(responseId).min(1).max(50).parse(itemIds);
    if (new Set(ids).size !== ids.length) throw new Error('SANDBOX_CREATE_ITEM_IDS_DUPLICATE');
    const result = await this.metadata(
      '/api/v2/product/get_item_base_info',
      [['item_id_list', ids.join(',')]],
      'item_list',
    );
    if (result.kind !== 'success') return result;
    const list = z.array(record).safeParse(result.data.item_list);
    if (!list.success || list.data.length !== ids.length) return invalid(result);
    const actual = list.data.map((item) => responseId.safeParse(item.item_id));
    if (
      actual.some((entry) => !entry.success || !ids.includes(entry.data)) ||
      new Set(actual.filter((entry) => entry.success).map((entry) => entry.data)).size !==
        ids.length
    )
      return invalid(result);
    return { ...result, data: list.data };
  }
  async readModels(itemId: string): Promise<ProductOutcome<Record<string, unknown>>> {
    const result = await this.metadata(
      '/api/v2/product/get_model_list',
      [['item_id', validId(itemId)]],
      'model',
    );
    if (result.kind !== 'success') return result;
    const parsed = z
      .object({
        model: z.array(z.object({ model_id: responseId }).passthrough()),
        tier_variation: z.array(record),
      })
      .safeParse(result.data);
    if (
      !parsed.success ||
      new Set(parsed.data.model.map((model) => model.model_id)).size !== parsed.data.model.length
    )
      return invalid(result);
    return result;
  }
  private acknowledgement(
    result: ProductOutcome<unknown>,
    expectedId?: string,
  ): ProductOutcome<{ itemId: string }> {
    if (result.kind !== 'success') return result;
    const parsed = z.object({ item_id: responseId }).safeParse(result.data);
    if (
      !parsed.success ||
      isProtected(parsed.data.item_id) ||
      (expectedId !== undefined && parsed.data.item_id !== expectedId)
    )
      return invalid(result);
    return { ...result, data: { itemId: parsed.data.item_id } };
  }
  async createUnlisted(
    payload: CreateUnlistedPayload,
  ): Promise<ProductOutcome<{ itemId: string }>> {
    const parsed = createSchema.parse(payload);
    return this.acknowledgement(await this.call('/api/v2/product/add_item', [], parsed));
  }
  async initializeTiers(payload: InitTiersPayload): Promise<ProductOutcome<{ itemId: string }>> {
    const parsed = initSchema.parse(payload);
    return this.acknowledgement(
      await this.call('/api/v2/product/init_tier_variation', [], parsed),
      String(parsed.item_id),
    );
  }
}
