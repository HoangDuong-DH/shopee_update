import { signRequest } from '../../../packages/shopee/src/sign.js';
import type { ShopCredentials } from '../../../packages/shopee/src/shop-info.js';
import type { PreparedWireResponse } from '../../../packages/shopee/src/prepared-transport.js';

const paths = new Set(
  [
    'get_item_list',
    'get_item_base_info',
    'get_model_list',
    'get_category',
    'get_attribute_tree',
  ].map((p) => '/api/v2/product/' + p),
);
const allowedQueries = new Set([
  'offset',
  'page_size',
  'item_status',
  'item_id_list',
  'item_id',
  'category_id_list',
  'language',
]);
const secretKeys =
  /^(?:access_token|refresh_token|partner_key|token_ciphertext|partner_key_ciphertext|sign|authorization|cookie|password)$/i;
export function sanitizeKnowledge(value: unknown, secrets: string[] = []): any {
  if (typeof value === 'string')
    return secrets.reduce((v, s) => (s ? v.split(s).join('[redacted]') : v), value);
  if (Array.isArray(value)) return value.map((v) => sanitizeKnowledge(v, secrets));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !secretKeys.test(k))
        .map(([k, v]) => [k, sanitizeKnowledge(v, secrets)]),
    );
  return value;
}
const safeCode = (value: unknown) =>
  typeof value === 'string' &&
  /^(?:product\.)?(?:error_[a-z_]+|invalid_acceess_token|invalid_access_token|partner_shop_no_link|shop_no_linked|shop_banned|source_ip_undeclared|api_suspended)$/.test(
    value,
  )
    ? value
    : 'KNOWLEDGE_READ_REJECTED';
/** Separate GET-only adapter. There is deliberately no write, upload, refresh or arbitrary URL method. */
export class SellerKnowledgeTransport {
  constructor(
    private credentials: ShopCredentials,
    private transport: typeof fetch = fetch,
  ) {
    if (
      credentials.environment !== 'production' ||
      !/^\d+$/.test(credentials.partnerId) ||
      !/^\d+$/.test(credentials.shopId) ||
      !credentials.accessToken ||
      !credentials.partnerKey
    )
      throw Error('KNOWLEDGE_CONNECTION_INVALID');
  }
  async read(path: string, query: Record<string, string>): Promise<PreparedWireResponse> {
    if (
      !paths.has(path) ||
      Object.entries(query).some(
        ([k, v]) => !allowedQueries.has(k) || typeof v !== 'string' || v.length > 4096,
      )
    )
      throw Error('KNOWLEDGE_ENDPOINT_FORBIDDEN');
    const c = this.credentials,
      timestamp = Math.floor(Date.now() / 1000),
      url = new URL(path, 'https://partner.shopeemobile.com');
    for (const [key, value] of Object.entries({
      ...query,
      partner_id: c.partnerId,
      shop_id: c.shopId,
      access_token: c.accessToken,
      timestamp: String(timestamp),
      sign: signRequest({ ...c, path, timestamp }),
    }))
      url.searchParams.set(key, value);
    try {
      const response = await this.transport(url, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
      });
      if (!response.body) return { kind: 'unknown', code: 'KNOWLEDGE_EMPTY_RESPONSE' };
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 4 * 1024 * 1024) {
            await reader.cancel();
            return { kind: 'unknown', code: 'KNOWLEDGE_RESPONSE_TOO_LARGE' };
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
      const raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const requestId =
        typeof raw.request_id === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(raw.request_id)
          ? sanitizeKnowledge(raw.request_id, [c.partnerKey, c.accessToken])
          : undefined;
      if (!response.ok)
        return {
          kind: 'unknown',
          code:
            response.status === 429
              ? 'error_rate_limit'
              : response.status >= 500
                ? 'error_server'
                : 'KNOWLEDGE_HTTP_REJECTED',
          requestId,
        };
      if (raw.error) return { kind: 'rejected', code: safeCode(raw.error), requestId };
      if (
        !requestId ||
        !raw.response ||
        typeof raw.response !== 'object' ||
        Array.isArray(raw.response)
      )
        return { kind: 'unknown', code: 'KNOWLEDGE_RESPONSE_INVALID', requestId };
      const responseBody = sanitizeKnowledge(raw.response, [c.partnerKey, c.accessToken]);
      const publicRequestId = sanitizeKnowledge(requestId, [c.partnerKey, c.accessToken]);
      return {
        kind: 'success',
        requestId: publicRequestId,
        response: responseBody,
        envelope: {
          request_id: publicRequestId,
          response: responseBody,
          ...(raw.warning
            ? { warning: sanitizeKnowledge(raw.warning, [c.partnerKey, c.accessToken]) }
            : {}),
        },
      };
    } catch {
      return { kind: 'unknown', code: 'KNOWLEDGE_NETWORK_ERROR' };
    }
  }
}
