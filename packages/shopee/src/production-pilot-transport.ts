import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '@shopee/domain';
import { signRequest } from './sign.js';
import type { ShopCredentials } from './shop-info.js';
import type { PreparedWireResponse } from './prepared-transport.js';

export type ProductionPilotTransportScope = Readonly<{
  environment: 'production';
  partnerId: string;
  shopId: string;
}>;
const target: ProductionPilotTransportScope = Object.freeze({
  environment: 'production',
  partnerId: '2010476',
  shopId: '1423724897',
});
const host = 'https://partner.shopeemobile.com';
const uploadPath = '/api/v2/media_space/upload_image';
const addPath = '/api/v2/product/add_item';
const initPath = '/api/v2/product/init_tier_variation';
const publishPath = '/api/v2/product/unlist_item';
const updatePath = '/api/v2/product/update_item';
const warehousePath = '/api/v2/shop/get_warehouse_detail';
const maximumResponseBytes = 4 * 1024 * 1024; // Operational envelope bound, not a Shopee limit.
const readPaths = new Set(
  [
    'product/get_category',
    'product/category_recommend',
    'product/get_size_chart_list',
    'product/get_size_chart_detail',
    'product/get_attribute_tree',
    'product/get_brand_list',
    'product/get_item_limit',
    'product/get_item_list',
    'product/get_item_base_info',
    'product/get_model_list',
    'product/get_item_promotion',
    'logistics/get_channel_list',
    'shop/get_shop_info',
    'shop/get_warehouse_detail',
  ].map((value) => '/api/v2/' + value),
);
const authFields = new Set([
  'partner_id',
  'partner_key',
  'shop_id',
  'access_token',
  'refresh_token',
  'timestamp',
  'sign',
]);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const positiveId = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const imageId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,512}$/.test(value);
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const safeErrors = new Set([
  'error_param',
  'error_auth',
  'error_sign',
  'invalid_partner_id',
  'invalid_acceess_token',
  'invalid_access_token',
  'error_partner_key_expired',
  'error_api_permission',
  'error_limit',
  'error_rate_limit',
  'source_ip_undeclared',
  'error_api_call_restricted',
  'api_suspended',
  'error_network',
  'error_data',
  'error_server',
  'error_inner',
  'error_unknown',
  'error_system_busy',
  'error_busi',
  'error_busi_add_item_failed',
  'error_tier_img_partial',
  'error_tier_img_old_app',
  'partner_shop_no_link',
  'shop_no_linked',
  'shop_banned',
  'error_unlist_item_all_failed',
  'error_unlist_item_failed',
  'error_get_shop_fail',
  'error_set_normal_unlisted_item',
]);
const uncertainErrors = new Set([
  'error_server',
  'error_inner',
  'error_unknown',
  'error_network',
  'error_system_busy',
  'error_busi_add_item_failed',
  'error_unlist_item_failed',
  'error_get_shop_fail',
]);
const safeCode = (value: string) => {
  const plain = value.replace(/^product\./, '');
  return safeErrors.has(plain) ? value : 'PRODUCTION_PILOT_API_REJECTED';
};

export type ProductionPilotMutationPermit = { operationId: string; stepId: string };
export type ProductionPilotMutationIntent = ProductionPilotMutationPermit & {
  path: string;
  fingerprint: string;
};
export type ProductionPilotImageOptions =
  { scene: 'normal'; ratio: '1:1' | '3:4' } | { scene: 'desc'; ratio?: '1:1' | '3:4' };
export type ProductionPilotTransportOptions = {
  transport?: typeof fetch;
  /** Per-request bound. The default stays short for interactive use; large
   * description-image uploads may opt into a longer, still bounded wait. */
  requestTimeoutMs?: number;
  /** Must atomically claim a durable, exact-scope journal step with this fingerprint.
   * Merely receiving an HTTP request or matching an operation ID is not authorization. */
  authorizeMutation?: (intent: Readonly<ProductionPilotMutationIntent>) => Promise<boolean>;
};
const permitSchema = z
  .object({ operationId: z.string().uuid(), stepId: z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/) })
  .strict();
const scopeSchema = z
  .object({
    environment: z.literal('production'),
    partnerId: z
      .string()
      .regex(/^[1-9]\d{0,9}$/)
      .refine((value) => Number(value) <= 4294967295),
    shopId: z
      .string()
      .regex(/^[1-9]\d{0,15}$/)
      .refine((value) => Number.isSafeInteger(Number(value))),
  })
  .strict();
const descriptionFieldSchema = z.union([
  z.object({ field_type: z.literal('text'), text: z.string().max(4000) }).strict(),
  z
    .object({
      field_type: z.literal('image'),
      image_info: z.object({ image_id: z.string().regex(/^[A-Za-z0-9_-]{1,512}$/) }).strict(),
    })
    .strict(),
]);
const descriptionUpdateSchema = z
  .object({
    item_id: z.number().int().positive(),
    description_type: z.literal('extended'),
    description_info: z
      .object({
        extended_description: z
          .object({
            field_list: z.array(descriptionFieldSchema).min(1).max(50),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();
const logisticsAndParentSkuUpdateSchema = z
  .object({
    item_id: z.number().int().positive(),
    // Parent/listing SKU is intentionally blank. Sellable identity belongs to model_sku.
    item_sku: z.literal(''),
    logistic_info: z
      .array(
        z
          .object({
            logistic_id: z.number().int().positive(),
            enabled: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.logistic_info.map((entry) => entry.logistic_id)).size !== value.logistic_info.length)
      context.addIssue({ code: 'custom', path: ['logistic_info'], message: 'Duplicate channel' });
  });
const itemUpdateSchema = z.union([descriptionUpdateSchema, logisticsAndParentSkuUpdateSchema]);
const credentialSchema = z
  .object({
    ...scopeSchema.shape,
    partnerKey: z.string().min(1).max(4096).regex(/^\S+$/),
    accessToken: z.string().min(1).max(4096).regex(/^\S+$/),
  })
  .strict();
const publicationSchema = z
  .object({
    item_list: z
      .array(
        z
          .object({
            item_id: z.number().int().positive().refine(Number.isSafeInteger),
            unlist: z.literal(false),
          })
          .strict(),
      )
      .length(1),
  })
  .strict();

// Hash exactly the JSON-compatible payload that will be transmitted. Reject non-JSON values
// rather than signing one representation while sending another via toJSON/getters/undefined.
function snapshotPayload(value: unknown): Record<string, unknown> {
  let nodes = 0;
  const copy = (entry: unknown, depth: number): unknown => {
    if (++nodes > 100000 || depth > 50) throw new Error('PRODUCTION_PILOT_WRITE_FORBIDDEN');
    if (entry === null || typeof entry === 'string' || typeof entry === 'boolean') return entry;
    if (typeof entry === 'number' && Number.isFinite(entry)) return entry;
    if (Array.isArray(entry)) {
      if (entry.length > 100000 || Object.keys(entry).length !== entry.length)
        throw new Error('PRODUCTION_PILOT_WRITE_FORBIDDEN');
      return Array.from({ length: entry.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(entry, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, 'value'))
          throw new Error('PRODUCTION_PILOT_WRITE_FORBIDDEN');
        return copy(descriptor.value, depth + 1);
      });
    }
    if (!record(entry)) throw new Error('PRODUCTION_PILOT_WRITE_FORBIDDEN');
    return Object.fromEntries(
      Object.keys(entry).map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(entry, key)!;
        if (!Object.hasOwn(descriptor, 'value'))
          throw new Error('PRODUCTION_PILOT_WRITE_FORBIDDEN');
        return [key, copy(descriptor.value, depth + 1)];
      }),
    );
  };
  if (!record(value)) throw new Error('PRODUCTION_PILOT_WRITE_FORBIDDEN');
  const result = copy(value, 0) as Record<string, unknown>;
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > maximumResponseBytes)
    throw new Error('PRODUCTION_PILOT_WRITE_FORBIDDEN');
  return result;
}
export function productionPilotWriteFingerprint(
  path: string,
  payload: Record<string, unknown>,
  scope: ProductionPilotTransportScope = target,
): string {
  const body = snapshotPayload(payload);
  if (
    ![addPath, initPath, publishPath, updatePath].includes(path) ||
    (path === updatePath && !itemUpdateSchema.safeParse(body).success) ||
    (path === publishPath && !publicationSchema.safeParse(body).success)
  )
    throw new Error('PRODUCTION_PILOT_WRITE_FORBIDDEN');
  return sha(
    canonicalJson({ scope: scopeSchema.parse(scope), method: 'POST', path, payload: body }),
  );
}
function checkImage(bytes: Uint8Array, mime: string, options: ProductionPilotImageOptions) {
  // upload_image doc, source 2025-09-08: public signing, original PNG/JPEG, max 10 MB,
  // explicit normal/desc scene; 3:4 remains conditional on the shop's separately proven access.
  if (
    !(bytes instanceof Uint8Array) ||
    !bytes.length ||
    bytes.length > 10_000_000 ||
    !['image/png', 'image/jpeg'].includes(mime) ||
    !record(options) ||
    Object.keys(options).some((key) => !['scene', 'ratio'].includes(key)) ||
    !['normal', 'desc'].includes(options.scene) ||
    (options.ratio !== undefined && !['1:1', '3:4'].includes(options.ratio)) ||
    (options.scene === 'normal' && options.ratio === undefined)
  )
    throw new Error('PRODUCTION_PILOT_MEDIA_INVALID');
}
export function productionPilotUploadFingerprint(
  bytes: Uint8Array,
  mime: 'image/png' | 'image/jpeg',
  options: ProductionPilotImageOptions,
  scope: ProductionPilotTransportScope = target,
): string {
  checkImage(bytes, mime, options);
  return sha(
    canonicalJson({
      scope: scopeSchema.parse(scope),
      method: 'POST',
      path: uploadPath,
      media: {
        sha256: sha(bytes),
        bytes: bytes.byteLength,
        mime,
        scene: options.scene,
        ...(options.ratio === undefined ? {} : { ratio: options.ratio }),
      },
    }),
  );
}

async function boundedBody(response: Response): Promise<string | undefined> {
  if (!response.body) return undefined;
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maximumResponseBytes) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(next.value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    reader.releaseLock();
  }
}

/** Scope-limited transport, not a writer coordinator. Credentials are decrypted by the caller.
 * No retries, generic updates or deletion. Publication is a separate, single-item permit.
 * Durable replay prevention and created-item ownership belong to the
 * journal callback; consumed permits here additionally prevent duplicate sends on one instance. */
export class ProductionPilotTransport {
  private readonly credentials: ShopCredentials;
  private readonly scope: ProductionPilotTransportScope;
  private readonly transport: typeof fetch;
  private readonly authorizeMutation?: ProductionPilotTransportOptions['authorizeMutation'];
  private readonly requestTimeoutMs: number;
  private readonly consumed = new Set<string>();
  constructor(credentials: ShopCredentials, options: ProductionPilotTransportOptions = {}) {
    const parsed = credentialSchema.safeParse(credentials);
    if (!parsed.success) throw new Error('PRODUCTION_PILOT_SCOPE_FORBIDDEN');
    this.credentials = { ...parsed.data };
    this.scope = Object.freeze({
      environment: parsed.data.environment,
      partnerId: parsed.data.partnerId,
      shopId: parsed.data.shopId,
    });
    this.transport = options.transport ?? fetch;
    this.authorizeMutation = options.authorizeMutation;
    this.requestTimeoutMs = Number.isSafeInteger(options.requestTimeoutMs) && options.requestTimeoutMs! >= 1_000 && options.requestTimeoutMs! <= 60_000
      ? options.requestTimeoutMs!
      : 12_000;
  }
  async read(
    path: string,
    query: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<PreparedWireResponse> {
    if (
      !readPaths.has(path) ||
      !record(query) ||
      Object.keys(query).length > 30 ||
      Object.entries(query).some(
        ([key, value]) =>
          !/^[a-z][a-z0-9_]*$/.test(key) ||
          authFields.has(key) ||
          typeof value !== 'string' ||
          value.length > 4096,
      )
    )
      throw new Error('PRODUCTION_PILOT_ENDPOINT_FORBIDDEN');
    return this.call(path, 'GET', { ...query }, undefined, false, signal);
  }
  private async claim(path: string, fingerprint: string, permit: ProductionPilotMutationPermit) {
    const parsed = permitSchema.safeParse(permit);
    if (!parsed.success || !this.authorizeMutation)
      throw new Error('PRODUCTION_PILOT_PERMIT_REQUIRED');
    const key = `${parsed.data.operationId}:${parsed.data.stepId}`;
    if (this.consumed.has(key)) throw new Error('PRODUCTION_PILOT_PERMIT_CONSUMED');
    this.consumed.add(key);
    let allowed = false;
    try {
      allowed = await this.authorizeMutation(Object.freeze({ ...parsed.data, path, fingerprint }));
    } catch {
      /* Exceptions may carry credentials or DB connection strings. */
    }
    if (allowed !== true) throw new Error('PRODUCTION_PILOT_PERMIT_DENIED');
  }
  async write(
    path: string,
    payload: Record<string, unknown>,
    permit: ProductionPilotMutationPermit,
    signal?: AbortSignal,
  ): Promise<PreparedWireResponse> {
    const body = snapshotPayload(payload);
    const publication = path === publishPath ? publicationSchema.safeParse(body) : undefined;
    const itemUpdate = path === updatePath ? itemUpdateSchema.safeParse(body) : undefined;
    if (
      Object.keys(body).some((key) => authFields.has(key.toLowerCase())) ||
      (path !== addPath && path !== initPath && path !== publishPath && path !== updatePath) ||
      (publication && !publication.success) ||
      (itemUpdate && !itemUpdate.success) ||
      (path === addPath &&
        (body.item_status !== 'UNLIST' ||
          Object.hasOwn(body, 'item_id') ||
          typeof body.item_name !== 'string' ||
          !body.item_name ||
          typeof body.item_sku !== 'string' ||
          !body.item_sku ||
          !positiveId(body.category_id))) ||
      (path === initPath &&
        (!positiveId(body.item_id) ||
          Object.hasOwn(body, 'item_status') ||
          !Array.isArray(body.model) ||
          body.model.length < 1 ||
          body.model.length > 50 ||
          !Array.isArray(body.standardise_tier_variation) ||
          body.standardise_tier_variation.length < 1 ||
          body.standardise_tier_variation.length > 2))
    )
      throw new Error('PRODUCTION_PILOT_WRITE_FORBIDDEN');
    if (signal?.aborted) return { kind: 'unknown', code: 'PRODUCTION_PILOT_CANCELLED' };
    await this.claim(path, productionPilotWriteFingerprint(path, body, this.scope), permit);
    const result = await this.call(path, 'POST', {}, JSON.stringify(body), false, signal);
    if (path !== publishPath || !publication?.success || result.kind !== 'success') return result;
    // unlist_item's HTTP/envelope success may still contain per-item failures.
    // This is a receipt only; the coordinator must additionally verify NORMAL and preserved fields.
    const expectedItemId = publication.data.item_list[0]!.item_id;
    const { failure_list: failures, success_list: successes } = result.response;
    const sameItem = (value: unknown) =>
      (positiveId(value) ||
        (typeof value === 'string' && /^[1-9]\d*$/.test(value) && positiveId(Number(value)))) &&
      String(value) === String(expectedItemId);
    const unresolved = (): PreparedWireResponse => ({
      kind: 'unknown',
      code: 'PRODUCTION_PILOT_PUBLISH_RESPONSE_UNVERIFIED',
      requestId: result.requestId,
      envelope: result.envelope,
    });
    if (!Array.isArray(failures) || !Array.isArray(successes)) return unresolved();
    if (
      failures.length === 0 &&
      successes.length === 1 &&
      record(successes[0]) &&
      sameItem(successes[0].item_id) &&
      successes[0].unlist === false
    )
      return result;
    if (
      successes.length === 0 &&
      failures.length === 1 &&
      record(failures[0]) &&
      sameItem(failures[0].item_id) &&
      typeof failures[0].failed_reason === 'string' &&
      failures[0].failed_reason.trim()
    ) {
      return {
        kind: 'rejected',
        code: 'PRODUCTION_PILOT_PUBLISH_REJECTED',
        requestId: result.requestId,
        envelope: result.envelope,
      };
    }
    return unresolved();
  }
  async upload(
    bytes: Uint8Array,
    mime: 'image/png' | 'image/jpeg',
    options: ProductionPilotImageOptions,
    permit: ProductionPilotMutationPermit,
    signal?: AbortSignal,
  ): Promise<PreparedWireResponse> {
    checkImage(bytes, mime, options);
    const original = Uint8Array.from(bytes),
      imageOptions = { ...options };
    if (signal?.aborted) return { kind: 'unknown', code: 'PRODUCTION_PILOT_CANCELLED' };
    const fingerprint = productionPilotUploadFingerprint(original, mime, imageOptions, this.scope);
    await this.claim(uploadPath, fingerprint, permit);
    const form = new FormData();
    form.set(
      'image',
      new Blob([original], { type: mime }),
      mime === 'image/png' ? 'source.png' : 'source.jpg',
    );
    form.set('scene', imageOptions.scene);
    if (imageOptions.ratio !== undefined) form.set('ratio', imageOptions.ratio);
    const result = await this.call(uploadPath, 'POST', {}, form, true, signal);
    if (result.kind !== 'success') return result;
    const data = result.response,
      ids: string[] = [];
    const invalid = (): PreparedWireResponse => ({
      kind: 'unknown',
      code: 'PRODUCTION_PILOT_INVALID_IMAGE_RESPONSE',
      requestId: result.requestId,
      envelope: result.envelope,
    });
    if (data.image_info !== undefined) {
      if (!record(data.image_info) || !imageId(data.image_info.image_id)) return invalid();
      ids.push(data.image_info.image_id);
    }
    if (data.image_info_list !== undefined) {
      if (!Array.isArray(data.image_info_list) || data.image_info_list.length !== 1)
        return invalid();
      const entry = data.image_info_list[0];
      if (
        !record(entry) ||
        entry.id !== 0 ||
        (typeof entry.error !== 'string' && entry.error !== null)
      )
        return invalid();
      if (entry.error)
        return {
          kind: 'unknown',
          code: 'PRODUCTION_PILOT_IMAGE_PROCESSING_UNRESOLVED',
          requestId: result.requestId,
          envelope: result.envelope,
        };
      if (!record(entry.image_info) || !imageId(entry.image_info.image_id)) return invalid();
      ids.push(entry.image_info.image_id);
    }
    return new Set(ids).size === 1 ? result : invalid();
  }
  private async call(
    path: string,
    method: 'GET' | 'POST',
    query: Record<string, string>,
    body: string | FormData | undefined,
    publicApi: boolean,
    signal?: AbortSignal,
  ): Promise<PreparedWireResponse> {
    if (signal?.aborted) return { kind: 'unknown', code: 'PRODUCTION_PILOT_CANCELLED' };
    const { partnerId, shopId, partnerKey, accessToken } = this.credentials;
    const timestamp = Math.floor(Date.now() / 1000),
      url = new URL(path, host);
    const sign = signRequest({
      partnerId,
      partnerKey,
      path,
      timestamp,
      ...(!publicApi ? { accessToken, shopId } : {}),
    });
    for (const [key, value] of Object.entries({
      ...query,
      partner_id: partnerId,
      timestamp: String(timestamp),
      sign,
      ...(!publicApi ? { shop_id: shopId, access_token: accessToken } : {}),
    }))
      url.searchParams.set(key, value);
    const secrets = [partnerKey, accessToken, sign].flatMap((secret) => [
      secret,
      encodeURIComponent(secret),
    ]);
    const redact = (entry: unknown, depth = 0): unknown => {
      if (depth > 80) return '[too-deep]';
      if (typeof entry === 'string')
        return secrets.reduce((value, secret) => value.replaceAll(secret, '[redacted]'), entry);
      if (Array.isArray(entry)) return entry.map((value) => redact(value, depth + 1));
      if (record(entry))
        return Object.fromEntries(
          Object.entries(entry).map(([key, value]) => [
            String(redact(key, depth + 1)),
            ['access_token', 'refresh_token', 'partner_key', 'sign', 'authorization_code'].includes(
              key.toLowerCase(),
            )
              ? '[redacted]'
              : redact(value, depth + 1),
          ]),
        );
      return entry;
    };
    try {
      const response = await this.transport(url, {
        method,
        redirect: 'error',
        signal: AbortSignal.any([AbortSignal.timeout(this.requestTimeoutMs), ...(signal ? [signal] : [])]),
        headers: {
          Accept: 'application/json',
          ...(typeof body === 'string' ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body === undefined ? {} : { body }),
      });
      const text = await boundedBody(response);
      if (text === undefined) return { kind: 'unknown', code: 'PRODUCTION_PILOT_INVALID_RESPONSE' };
      let raw: unknown;
      try {
        raw = redact(JSON.parse(text));
      } catch {
        return { kind: 'unknown', code: 'PRODUCTION_PILOT_INVALID_RESPONSE' };
      }
      if (!record(raw) || typeof raw.error !== 'string')
        return { kind: 'unknown', code: 'PRODUCTION_PILOT_INVALID_RESPONSE' };
      const requestId =
        typeof raw.request_id === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(raw.request_id)
          ? raw.request_id
          : undefined;
      if (raw.error)
        return {
          kind:
            response.status >= 500 ||
            uncertainErrors.has(raw.error.replace(/^product\./, '')) ||
            (path === publishPath &&
              record(raw.response) &&
              Array.isArray(raw.response.success_list) &&
              raw.response.success_list.length > 0)
              ? 'unknown'
              : 'rejected',
          code: safeCode(raw.error),
          envelope: raw,
          ...(requestId ? { requestId } : {}),
        };
      if (!response.ok || !requestId)
        return { kind: 'unknown', code: 'PRODUCTION_PILOT_INVALID_RESPONSE' };
      // get_warehouse_detail documents response as object[] (source 2025-01-13).
      // Keep the shared record-shaped interface and the original sanitized envelope.
      const data =
        path === warehousePath
          ? Array.isArray(raw.response) && raw.response.every(record)
            ? { warehouses: raw.response }
            : undefined
          : path === '/api/v2/shop/get_shop_info'
            ? raw
            : raw.response;
      if (!record(data))
        return {
          kind: 'unknown',
          code: 'PRODUCTION_PILOT_INVALID_RESPONSE',
          requestId,
          envelope: raw,
        };
      return { kind: 'success', response: data, requestId, envelope: raw };
    } catch {
      return { kind: 'unknown', code: 'PRODUCTION_PILOT_TRANSPORT' };
    }
  }
}
