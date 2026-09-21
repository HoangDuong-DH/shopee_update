import { createHmac } from 'node:crypto';
import { z } from 'zod';

export type ProductionAuthorizationCredentials = {
  partnerId: string;
  partnerKey: string;
  code: string;
  shopId?: string;
  mainAccountId?: string;
};

export type ProductionAuthorizationResult =
  | {
      kind: 'success';
      accessToken: string;
      refreshToken: string;
      expiresIn: number;
      shopIdList?: string[];
      requestId?: string;
    }
  | { kind: 'rejected'; code: string }
  | { kind: 'unknown'; reason: 'transport' | 'invalid_response' };

// Sources: guide 20 (2026-07-23), v2.public.get_access_token (2026-07-13).
// The authorization code is single-use. This gateway intentionally never retries.
const endpoint = 'https://partner.shopeemobile.com/api/v2/auth/token/get';
const path = '/api/v2/auth/token/get';
const maximumResponseBytes = 64 * 1024; // Operational response bound, not a Shopee policy.
const opaqueValue = z.string().min(1).max(4096).regex(/^\S+$/u);
const identifier = z
  .string()
  .regex(/^[1-9]\d*$/)
  .refine((value) => Number.isSafeInteger(Number(value)));
const inputSchema = z
  .object({
    partnerId: identifier.refine((value) => Number(value) <= 4294967295),
    partnerKey: opaqueValue,
    code: opaqueValue,
    shopId: identifier.optional(),
    mainAccountId: identifier.optional(),
  })
  .strict()
  .refine((value) => (value.shopId === undefined) !== (value.mainAccountId === undefined));
const responseId = z.number().int().positive().safe();
const successSchema = z.object({
  error: z.literal(''),
  access_token: opaqueValue,
  refresh_token: opaqueValue,
  // Prose defines a duration in seconds, valid up to four hours. The API's
  // epoch-shaped example is inconsistent; do not silently interpret it as TTL.
  expire_in: z
    .number()
    .int()
    .positive()
    .max(4 * 60 * 60),
  request_id: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,128}$/)
    .optional(),
  shop_id_list: z.array(responseId).max(2000).optional(),
  // This adapter enrolls shops only. Additional authorization types need an
  // explicitly separate scope; they must not silently enter this pilot.
  merchant_id_list: z.array(responseId).max(0).optional(),
  supplier_id_list: z.array(responseId).max(0).optional(),
  user_id_list: z.array(responseId).max(0).optional(),
  principal_id_list: z.array(responseId).max(0).optional(),
});
const safeErrorCodes = new Set([
  'error_network',
  'error_data',
  'error_param',
  'invalid_code',
  'invalid_main_acount_id',
  'invalid_shop_id',
  'error_server',
  'error_auth',
  'error_sign',
  'invalid_partner_id',
  'error_api_call_restricted',
  'api_suspended',
  'error_limit',
  'error_rate_limit',
  'source_ip_undeclared',
  'error_partner_key_expired',
  'error_api_permission',
]);

function signPublic(partnerId: string, partnerKey: string, timestamp: number): string {
  return createHmac('sha256', partnerKey)
    .update(`${partnerId}${path}${timestamp}`, 'utf8')
    .digest('hex');
}

async function readBoundedBody(response: Response): Promise<string | undefined> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximumResponseBytes) {
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

export async function exchangeProductionAuthorization(
  credentials: ProductionAuthorizationCredentials,
  transport: typeof fetch = fetch,
): Promise<ProductionAuthorizationResult> {
  const input = inputSchema.safeParse(credentials);
  if (!input.success) return { kind: 'rejected', code: 'INVALID_AUTHORIZATION_INPUT' };
  const { partnerId, partnerKey, code, shopId, mainAccountId } = input.data;
  const timestamp = Math.floor(Date.now() / 1000);
  const url = new URL(endpoint);
  url.searchParams.set('partner_id', partnerId);
  url.searchParams.set('timestamp', String(timestamp));
  url.searchParams.set('sign', signPublic(partnerId, partnerKey, timestamp));
  try {
    const response = await transport(url, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(12000),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        partner_id: Number(partnerId),
        code,
        ...(shopId ? { shop_id: Number(shopId) } : { main_account_id: Number(mainAccountId) }),
      }),
    });
    const text = await readBoundedBody(response);
    if (text === undefined) return { kind: 'unknown', reason: 'invalid_response' };
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { kind: 'unknown', reason: 'invalid_response' };
    }
    const common = z.object({ error: z.string() }).safeParse(raw);
    if (!common.success) return { kind: 'unknown', reason: 'invalid_response' };
    if (common.data.error)
      return {
        kind: 'rejected',
        code: safeErrorCodes.has(common.data.error) ? common.data.error : 'AUTHORIZATION_REJECTED',
      };
    if (!response.ok) return { kind: 'unknown', reason: 'transport' };
    const result = successSchema.safeParse(raw);
    if (!result.success || (mainAccountId && !result.data.shop_id_list?.length))
      return { kind: 'unknown', reason: 'invalid_response' };
    return {
      kind: 'success',
      accessToken: result.data.access_token,
      refreshToken: result.data.refresh_token,
      expiresIn: result.data.expire_in,
      ...(result.data.shop_id_list ? { shopIdList: result.data.shop_id_list.map(String) } : {}),
      ...(result.data.request_id ? { requestId: result.data.request_id } : {}),
    };
  } catch {
    // Do not emit upstream exception text: it can contain a signed URL or code.
    return { kind: 'unknown', reason: 'transport' };
  }
}
