import { signRequest } from './sign.js';
import { API_HOSTS, type ShopCredentials } from './shop-info.js';

export type PreparedWireResponse = (
  | { kind: 'success'; response: Record<string, unknown>; requestId: string }
  | { kind: 'rejected'; code: string; requestId?: string }
  | { kind: 'unknown'; code: string; requestId?: string }
) & { envelope?: Record<string, unknown> };
export type PreparedAllowedShop = { partnerId: string; shopId: string };
const reads = new Set(
  [
    'product/get_category',
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
  ].map((name) => '/api/v2/' + name),
);
const writes = new Set(
  [
    'add_item',
    'init_tier_variation',
    'update_item',
    'update_model',
    'add_model',
    'delete_model',
    'update_tier_variation',
    'update_price',
    'update_stock',
  ].map((name) => '/api/v2/product/' + name),
);
const safeCode = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(value) ? value : undefined;
const safeId = (value: unknown): string =>
  typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(value) ? value : '';
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** No retry, no arbitrary URL, no production. Mutation durability is owned by PreparedWireRunner. */
export class SandboxPreparedTransport {
  private readonly credentials: ShopCredentials;
  constructor(
    credentials: ShopCredentials,
    allowed: PreparedAllowedShop[],
    private readonly transport: typeof fetch = fetch,
  ) {
    if (
      credentials.environment !== 'sandbox' ||
      !/^[1-9]\d*$/.test(credentials.partnerId) ||
      !/^[1-9]\d*$/.test(credentials.shopId) ||
      !credentials.partnerKey ||
      !credentials.accessToken ||
      !allowed.some(
        (shop) => shop.partnerId === credentials.partnerId && shop.shopId === credentials.shopId,
      )
    )
      throw new Error('PREPARED_WIRE_SCOPE_FORBIDDEN');
    this.credentials = { ...credentials };
  }
  read(path: string, query: Record<string, string> = {}, signal?: AbortSignal) {
    if (
      !reads.has(path) ||
      Object.keys(query).some((key) =>
        ['partner_id', 'shop_id', 'access_token', 'timestamp', 'sign'].includes(key),
      )
    )
      return Promise.reject(new Error('PREPARED_WIRE_ENDPOINT_FORBIDDEN'));
    return this.call(path, 'GET', query, undefined, false, signal);
  }
  write(path: string, payload: Record<string, unknown>, signal?: AbortSignal) {
    if (
      !writes.has(path) ||
      !record(payload) ||
      ['803934364', '846056124'].includes(String(payload.item_id)) ||
      (path.endsWith('/add_item') && payload.item_status !== 'UNLIST') ||
      ('item_status' in payload && payload.item_status !== 'UNLIST')
    )
      return Promise.reject(new Error('PREPARED_WIRE_WRITE_FORBIDDEN'));
    return this.call(path, 'POST', {}, payload, false, signal);
  }
  upload(
    bytes: Uint8Array,
    mime: 'image/png' | 'image/jpeg',
    options: { scene: 'normal'; ratio: '1:1' | '3:4' } | { scene: 'desc'; ratio?: '1:1' | '3:4' },
    signal?: AbortSignal,
  ) {
    if (
      !['image/png', 'image/jpeg'].includes(mime) ||
      !bytes.length ||
      bytes.length > 10_000_000 ||
      !['normal', 'desc'].includes(options.scene) ||
      (options.ratio !== undefined && !['1:1', '3:4'].includes(options.ratio)) ||
      (options.scene === 'normal' && options.ratio === undefined)
    )
      return Promise.reject(new Error('PREPARED_WIRE_MEDIA_INVALID'));
    const form = new FormData();
    form.set(
      'image',
      new Blob([new Uint8Array(bytes)], { type: mime }),
      mime === 'image/png' ? 'source.png' : 'source.jpg',
    );
    form.set('scene', options.scene);
    if (options.ratio !== undefined) form.set('ratio', options.ratio);
    return this.call('/api/v2/media_space/upload_image', 'POST', {}, form, true, signal);
  }
  private async call(
    path: string,
    method: 'GET' | 'POST',
    query: Record<string, string>,
    body: Record<string, unknown> | FormData | undefined,
    publicApi: boolean,
    signal?: AbortSignal,
  ): Promise<PreparedWireResponse> {
    if (signal?.aborted) return { kind: 'unknown', code: 'PREPARED_WIRE_CANCELLED' };
    const { partnerId, shopId, partnerKey, accessToken } = this.credentials;
    const timestamp = Math.floor(Date.now() / 1000),
      url = new URL(path, API_HOSTS.sandbox);
    const signature = signRequest({
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
      sign: signature,
      ...(!publicApi ? { shop_id: shopId, access_token: accessToken } : {}),
    }))
      url.searchParams.set(key, value);
    const redact = (value: unknown): unknown => {
      if (typeof value === 'string')
        return [accessToken, partnerKey, signature].reduce(
          (text, secret) => text.replaceAll(secret, '[redacted]'),
          value,
        );
      if (Array.isArray(value)) return value.map(redact);
      if (record(value))
        return Object.fromEntries(
          Object.entries(value).map(([key, child]) => [String(redact(key)), redact(child)]),
        );
      return value;
    };
    try {
      const response = await this.transport(url, {
        method,
        redirect: 'error',
        signal: AbortSignal.any([AbortSignal.timeout(12000), ...(signal ? [signal] : [])]),
        headers: {
          Accept: 'application/json',
          ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}),
      });
      const rawText = await response.text();
      if (rawText.length > 4 * 1024 * 1024)
        return { kind: 'unknown', code: 'PREPARED_WIRE_INVALID_RESPONSE' };
      const raw: unknown = redact(JSON.parse(rawText));
      if (!record(raw) || typeof raw.error !== 'string')
        return { kind: 'unknown', code: 'PREPARED_WIRE_INVALID_RESPONSE' };
      const requestId = safeId(raw.request_id);
      if (raw.error) {
        const uncertain =
          response.status >= 500 ||
          /(?:^|\.)(error_server|error_inner|error_unknown|error_network|error_system_busy|error_busi_add_item_failed)$/.test(
            raw.error,
          );
        return {
          kind: uncertain ? 'unknown' : 'rejected',
          code: safeCode(raw.error) ?? 'PREPARED_WIRE_REJECTED',
          envelope: raw,
          ...(requestId ? { requestId } : {}),
        };
      }
      if (!response.ok || !requestId)
        return { kind: 'unknown', code: 'PREPARED_WIRE_INVALID_RESPONSE' };
      const envelopeOnly = [
        '/api/v2/product/update_model',
        '/api/v2/product/update_tier_variation',
        '/api/v2/product/delete_model',
      ].includes(path);
      const data = path.endsWith('/get_shop_info')
        ? raw
        : raw.response === undefined && envelopeOnly
          ? {}
          : raw.response;
      if (!record(data))
        return { kind: 'unknown', code: 'PREPARED_WIRE_INVALID_RESPONSE', requestId };
      return { kind: 'success', response: data, requestId, envelope: raw };
    } catch {
      return { kind: 'unknown', code: 'PREPARED_WIRE_TRANSPORT' };
    }
  }
}
