import { createHmac } from 'node:crypto';
import { z } from 'zod';

// v2.public.refresh_access_token, updated 2026-07-13; guide20 updated 2026-07-23.
// Refresh tokens are single-use. This gateway never retries or follows redirects.
export type ProductionRefreshReceipt = { status: number; body: string };
export type ProductionRefreshResult =
  | {
      kind: 'success';
      accessToken: string;
      refreshToken: string;
      expiresIn: number;
      requestId?: string;
    }
  | { kind: 'rejected'; code: string }
  | { kind: 'unknown'; reason: 'transport' | 'invalid_response' | 'receipt' };
const secret = z.string().min(1).max(4096).regex(/^\S+$/u);
const inputSchema = z
  .object({
    partnerId: z.string().regex(/^[1-9]\d{0,9}$/).refine(v=>Number(v)<=4294967295),
    shopId: z.string().regex(/^[1-9]\d{0,15}$/).refine(v=>Number.isSafeInteger(Number(v))),
    partnerKey: secret,
    refreshToken: secret,
  })
  .strict();
const outputSchema = z.object({
  error: z.literal(''),
  partner_id: z.number().int().positive().safe(),
  shop_id: z.number().int().positive().safe(),
  access_token: secret,
  refresh_token: secret,
  expire_in: z.number().int().positive().max(14400),
  request_id: z
    .string()
    .regex(/^[A-Za-z0-9_:-]{1,128}$/)
    .optional(),
  merchant_id: z.literal(0).optional(),
  supplier_id: z.literal(0).optional(),
  user_id: z.literal(0).optional(),
  principal_id: z.literal(0).optional(),
  merchant_id_list: z.array(z.unknown()).max(0).optional(),
  supplier_id_list: z.array(z.unknown()).max(0).optional(),
  user_id_list: z.array(z.unknown()).max(0).optional(),
  principal_id_list: z.array(z.unknown()).max(0).optional(),
});
const rejected = new Set([
  'error_auth',
  'error_sign',
  'invalid_partner_id',
  'error_api_permission',
  'error_api_call_restricted',
  'source_ip_undeclared',
  'error_partner_key_expired',
  'refresh_token_expired',
  'shop_access_expired',
  'shop_banned',
  'shop_no_linked',
  'error_shop_refresh_token',
]);
export function parseProductionRefreshResponse(
  receipt: ProductionRefreshReceipt,
  scope={partnerId:'2010476',shopId:'1423724897'},
): ProductionRefreshResult {
  try {
    if (receipt.status < 200 || receipt.status >= 300 || Buffer.byteLength(receipt.body) > 65536)
      return { kind: 'unknown', reason: 'invalid_response' };
    const raw = JSON.parse(receipt.body);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      return { kind: 'unknown', reason: 'invalid_response' };
    if (raw.error) {
      if (raw.access_token || raw.refresh_token || !rejected.has(raw.error))
        return { kind: 'unknown', reason: 'invalid_response' };
      return { kind: 'rejected', code: raw.error };
    }
    const parsed = outputSchema.safeParse(raw);
    if (!parsed.success || String(parsed.data.partner_id)!==scope.partnerId || String(parsed.data.shop_id)!==scope.shopId) return { kind: 'unknown', reason: 'invalid_response' };
    const value = parsed.data;
    return {
      kind: 'success',
      accessToken: value.access_token,
      refreshToken: value.refresh_token,
      expiresIn: value.expire_in,
      ...(value.request_id &&
      value.request_id !== value.access_token &&
      value.request_id !== value.refresh_token
        ? { requestId: value.request_id }
        : {}),
    };
  } catch {
    return { kind: 'unknown', reason: 'invalid_response' };
  }
}
export async function exchangeProductionRefresh(
  credentials: { partnerId: string; shopId: string; partnerKey: string; refreshToken: string },
  options: {
    transport?: typeof fetch;
    scope?: {partnerId:string;shopId:string};
    capture: (receipt: ProductionRefreshReceipt) => Promise<void>;
  },
): Promise<ProductionRefreshResult> {
  const parsed = inputSchema.safeParse(credentials);
  if (!parsed.success) return { kind: 'rejected', code: 'INVALID_PRODUCTION_REFRESH_INPUT' };
  const scope=options.scope ?? {partnerId:'2010476',shopId:'1423724897'};
  if(parsed.data.partnerId!==scope.partnerId || parsed.data.shopId!==scope.shopId)return {kind:'rejected',code:'INVALID_PRODUCTION_REFRESH_INPUT'};
  const input = parsed.data,
    path = '/api/v2/auth/access_token/get',
    timestamp = Math.floor(Date.now() / 1000);
  const url = new URL(path, 'https://partner.shopeemobile.com');
  url.searchParams.set('partner_id', input.partnerId);
  url.searchParams.set('timestamp', String(timestamp));
  url.searchParams.set(
    'sign',
    createHmac('sha256', input.partnerKey)
      .update(input.partnerId + path + timestamp)
      .digest('hex'),
  );
  try {
    const response = await (options.transport ?? fetch)(url, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(12000),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        partner_id: Number(input.partnerId),
        shop_id: Number(input.shopId),
        refresh_token: input.refreshToken,
      }),
    });
    if (!response.body) return { kind: 'unknown', reason: 'invalid_response' };
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 65536) {
          await reader.cancel().catch(() => {});
          return { kind: 'unknown', reason: 'invalid_response' };
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    const receipt = { status: response.status, body: Buffer.concat(chunks).toString('utf8') };
    try {
      await options.capture(receipt);
    } catch {
      return { kind: 'unknown', reason: 'receipt' };
    }
    return parseProductionRefreshResponse(receipt,scope);
  } catch {
    return { kind: 'unknown', reason: 'transport' };
  }
}
