import { z } from 'zod';
import { SandboxCreateClient } from './create-client.js';
import { signRequest } from './sign.js';
import { API_HOSTS, type ShopCredentials } from './shop-info.js';
import type { ProductOutcome } from './product-client.js';

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positive = integer.min(1);
const imageId = z.string().regex(/^[A-Za-z0-9_-]{1,512}$/);
const responseId = z
  .union([
    integer,
    z
      .string()
      .regex(/^(?:0|[1-9]\d*)$/)
      .refine((value) => Number.isSafeInteger(Number(value))),
  ])
  .transform(String);
const itemIdSchema = responseId.refine((value) => Number(value) > 0);
const description = z.discriminatedUnion('description_type', [
  z
    .object({ description_type: z.literal('normal'), description: z.string().min(1).max(100000) })
    .strict(),
  z
    .object({
      description_type: z.literal('extended'),
      description_info: z
        .object({
          extended_description: z
            .object({
              field_list: z
                .array(
                  z.discriminatedUnion('field_type', [
                    z
                      .object({ field_type: z.literal('text'), text: z.string().max(100000) })
                      .strict(),
                    z
                      .object({
                        field_type: z.literal('image'),
                        image_info: z.object({ image_id: imageId }).strict(),
                      })
                      .strict(),
                  ]),
                )
                .min(1)
                .max(100),
            })
            .strict(),
        })
        .strict(),
    })
    .strict(),
]);
const image = z
  .object({ image_id_list: z.array(imageId).min(1).max(50), image_ratio: z.enum(['1:1', '3:4']) })
  .strict();
const price = z.object({ model_id: integer, original_price: positive }).strict();
const stock = z
  .object({
    model_id: integer,
    seller_stock: z
      .array(
        z.object({ stock: integer, location_id: z.string().min(1).max(64).optional() }).strict(),
      )
      .length(1),
  })
  .strict();

/** Envelope bounds are pilot safeguards; the service must validate current shop/category limits. */
export const fieldOperationSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('title'),
        value: z
          .string()
          .regex(/^SANDBOX QA(?:\s|$)/)
          .max(100000),
      })
      .strict(),
    z.object({ kind: z.literal('description'), value: description }).strict(),
    z
      .object({ kind: z.literal('gallery'), value: image, preserveCover: z.array(imageId).max(1) })
      .strict(),
    z.object({ kind: z.literal('cover'), value: z.array(imageId).length(1) }).strict(),
    z.object({ kind: z.literal('price'), value: z.array(price).min(1).max(50) }).strict(),
    z.object({ kind: z.literal('stock'), value: z.array(stock).min(1).max(50) }).strict(),
  ])
  .superRefine((operation, context) => {
    const fail = (message: string) => context.addIssue({ code: 'custom', message });
    if (operation.kind === 'gallery') {
      if (new Set(operation.value.image_id_list).size !== operation.value.image_id_list.length)
        fail('Duplicate gallery image');
      if (operation.preserveCover.length !== (operation.value.image_ratio === '3:4' ? 1 : 0))
        fail('The viewed cover must be preserved for a 3:4 gallery');
    }
    if (operation.kind === 'price' || operation.kind === 'stock') {
      const ids = operation.value.map((entry) => entry.model_id);
      if (new Set(ids).size !== ids.length) fail('Duplicate model identity');
      if (ids.includes(0) && ids.length !== 1)
        fail('Default model cannot be combined with variations');
    }
  });
export type FieldOperation = z.infer<typeof fieldOperationSchema>;
export type FieldSnapshot = {
  item: Record<string, unknown>;
  models: {
    model: Record<string, unknown>[];
    tier_variation: Record<string, unknown>[];
    [key: string]: unknown;
  };
};
export type FieldAcknowledgement = { successIds: string[]; failureIds: string[] };
export type ItemPromotionSnapshot = {
  itemId: string;
  /** Omission is observable API behavior; it is not an explicit empty promotion list. */
  promotionFieldPresent: boolean;
  item: Record<string, unknown> & { item_id: string; promotion?: Record<string, unknown>[] };
};
const record = z.record(z.string(), z.unknown());
const modelResponse = z
  .object({ model: z.array(record), tier_variation: z.array(record) })
  .passthrough();
const common = z.object({
  error: z.string(),
  request_id: z.string().optional(),
  warning: z.string().optional(),
  response: z.unknown().optional(),
});

function invalid<T>(result: ProductOutcome<unknown>): ProductOutcome<T> {
  return {
    kind: 'unknown',
    reason: 'invalid_response',
    ...(result.requestId ? { requestId: result.requestId } : {}),
    ...(result.httpStatus !== undefined ? { httpStatus: result.httpStatus } : {}),
  };
}

/**
 * Fixed TEST transport only. The service owns technical source membership, a fresh baseline,
 * field limits, exact model/warehouse mapping, durable write intent, lock and independent QC.
 * A successful acknowledgement is never a verified listing. There are no retries here.
 */
export class SandboxFieldClient {
  private readonly credentials: ShopCredentials;
  private readonly reader: SandboxCreateClient;
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
      throw new Error('SANDBOX_FIELD_SCOPE_INVALID');
    this.credentials = { ...credentials };
    this.reader = new SandboxCreateClient(this.credentials, transport);
  }

  async read(itemId: string): Promise<ProductOutcome<FieldSnapshot>> {
    const id = itemIdSchema.parse(itemId);
    const base = await this.reader.readBaseItems([id]);
    if (base.kind !== 'success') return base;
    const item = base.data[0]!;
    if (typeof item.has_model !== 'boolean') return invalid(base);
    if (!item.has_model)
      return { ...base, data: { item, models: { model: [], tier_variation: [] } } };
    const models = await this.reader.readModels(id);
    if (models.kind !== 'success') return models;
    const parsed = modelResponse.safeParse(models.data);
    if (!parsed.success || !parsed.data.model.length) return invalid(models);
    return { ...models, data: { item, models: parsed.data } };
  }

  /**
   * Read-only evidence, never permission to change price. Source snapshot 2026-09-08:
   * get_item_promotion (updated 2026-07-31) includes ongoing AND upcoming entries.
   * https://open.shopee.com/documents/v2/v2.product.get_item_promotion?module=89&type=1
   * Announcements /1280 and /1377 deprecate promotion_id and direct detail reads here;
   * an empty/omitted detail list does not resolve a contradictory has_promotion=true flag.
   */
  async readPromotions(itemId: string): Promise<ProductOutcome<ItemPromotionSnapshot>> {
    const id = itemIdSchema.parse(itemId);
    const result = await this.call('/api/v2/product/get_item_promotion', undefined, [
      ['item_id_list', id],
    ]);
    if (result.kind !== 'success') return result;
    const parsed = z
      .object({
        success_list: z.array(
          z
            .object({
              item_id: itemIdSchema,
              promotion: z.array(record).optional(),
            })
            .passthrough(),
        ),
        failure_list: z.array(z.object({ item_id: itemIdSchema }).passthrough()).optional(),
      })
      .safeParse(result.data);
    if (
      !parsed.success ||
      parsed.data.success_list.length !== 1 ||
      (parsed.data.failure_list?.length ?? 0) !== 0 ||
      parsed.data.success_list[0]!.item_id !== id
    )
      return invalid(result);
    const item = parsed.data.success_list[0]!;
    return {
      ...result,
      data: { itemId: id, promotionFieldPresent: Object.hasOwn(item, 'promotion'), item },
    };
  }

  private async call(
    path: string,
    body?: Record<string, unknown>,
    query: [string, string][] = [],
  ): Promise<ProductOutcome<unknown>> {
    const c = this.credentials,
      timestamp = Math.floor(Date.now() / 1000);
    const url = new URL(path, API_HOSTS.sandbox);
    for (const [key, value] of Object.entries({
      partner_id: c.partnerId,
      shop_id: c.shopId,
      access_token: c.accessToken,
      timestamp: String(timestamp),
      sign: signRequest({ ...c, path, timestamp }),
    }))
      url.searchParams.set(key, value);
    for (const [key, value] of query) url.searchParams.append(key, value);
    try {
      const response = await this.transport(url, {
        method: body === undefined ? 'GET' : 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
        headers: {
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      if (text.length > 3 * 1024 * 1024)
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
      const safe = (value: string) =>
        !value.includes(c.accessToken) && !value.includes(c.partnerKey);
      const requestId =
        parsed.data.request_id && safe(parsed.data.request_id)
          ? parsed.data.request_id.match(/^[A-Za-z0-9_-]{1,128}$/)?.[0]
          : undefined;
      const info = { httpStatus: response.status, ...(requestId ? { requestId } : {}) };
      if (parsed.data.error) {
        const code =
          /^[A-Za-z0-9_.-]{1,100}$/.test(parsed.data.error) && safe(parsed.data.error)
            ? parsed.data.error
            : 'unrecognized_error';
        if (
          response.status >= 500 ||
          /(?:^|\.)(?:error_network|error_server|error_inner|error_unknown|error_system_busy|error_update_price_fail|error_busi_update_stock_failed|error_busi_update_item_failed)$/.test(
            code,
          )
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

  private modelAcknowledgement(
    result: ProductOutcome<unknown>,
    operation: Extract<FieldOperation, { kind: 'price' | 'stock' }>,
  ): ProductOutcome<FieldAcknowledgement> {
    if (result.kind !== 'success') return result;
    const parsed = z
      .object({
        success_list: z.array(z.object({ model_id: responseId }).passthrough()),
        failure_list: z.array(z.object({ model_id: responseId })),
      })
      .safeParse(result.data);
    if (!parsed.success) return invalid(result);
    const successes = parsed.data.success_list,
      failures = parsed.data.failure_list;
    const requested = operation.value.map((entry) => String(entry.model_id));
    const received = [...successes, ...failures].map((entry) => entry.model_id);
    if (
      received.length !== requested.length ||
      new Set(received).size !== received.length ||
      received.some((id) => !requested.includes(id))
    )
      return invalid(result);
    for (const success of successes) {
      if (operation.kind === 'price') {
        const source = operation.value.find(
          (entry) => String(entry.model_id) === success.model_id,
        )!;
        const value = z
          .union([integer, z.string().regex(/^\d+(?:\.0+)?$/)])
          .safeParse(success.original_price);
        if (!value.success || Number(value.data) !== source.original_price) return invalid(result);
      } else {
        const source = operation.value.find((entry) => String(entry.model_id) === success.model_id)!
          .seller_stock[0]!;
        if (
          !integer.safeParse(success.stock).success ||
          success.stock !== source.stock ||
          (success.location_id ?? '') !== (source.location_id ?? '')
        )
          return invalid(result);
      }
    }
    return {
      ...result,
      data: {
        successIds: requested.filter((id) => successes.some((entry) => entry.model_id === id)),
        failureIds: requested.filter((id) => failures.some((entry) => entry.model_id === id)),
      },
    };
  }

  async execute(
    itemId: string,
    raw: FieldOperation,
  ): Promise<ProductOutcome<FieldAcknowledgement>> {
    const id = itemIdSchema.parse(itemId);
    if (['803934364', '846056124'].includes(id)) throw new Error('SANDBOX_FIELD_TARGET_PROTECTED');
    const operation = fieldOperationSchema.parse(raw),
      body: Record<string, unknown> = { item_id: Number(id) };
    if (operation.kind === 'price' || operation.kind === 'stock') {
      body[operation.kind === 'price' ? 'price_list' : 'stock_list'] = operation.value;
      return this.modelAcknowledgement(
        await this.call('/api/v2/product/update_' + operation.kind, body),
        operation,
      );
    }
    if (operation.kind === 'title') body.item_name = operation.value;
    if (operation.kind === 'description') Object.assign(body, operation.value);
    if (operation.kind === 'gallery') {
      body.image = operation.value;
      if (operation.preserveCover.length)
        body.promotion_images = { image_id_list: operation.preserveCover };
    }
    if (operation.kind === 'cover') body.promotion_images = { image_id_list: operation.value };
    const result = await this.call('/api/v2/product/update_item', body);
    if (result.kind !== 'success') return result;
    const acknowledgement = z.object({ item_id: itemIdSchema }).safeParse(result.data);
    if (!acknowledgement.success || acknowledgement.data.item_id !== id) return invalid(result);
    return { ...result, data: { successIds: [], failureIds: [] } };
  }
}
