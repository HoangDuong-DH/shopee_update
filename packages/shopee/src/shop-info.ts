import { z } from 'zod';
import { signRequest } from './sign.js';
export type ShopCredentials = {
  environment: 'sandbox' | 'production';
  partnerId: string;
  shopId: string;
  partnerKey: string;
  accessToken: string;
};
export type ShopInfo = {
  shopName: string;
  region: string;
  status: string;
  authorizationExpiresAt?: number;
  fulfillment?: string;
  requestId?: string;
};
export type ShopInfoResult =
  | { kind: 'success'; info: ShopInfo }
  | { kind: 'rejected'; code: string; requestId?: string }
  | { kind: 'unknown'; reason: 'transport' | 'invalid_response' };
export const API_HOSTS = {
  sandbox: 'https://openplatform.sandbox.test-stable.shopee.sg',
  production: 'https://partner.shopeemobile.com',
} as const;
export async function readShopInfo(
  credentials: ShopCredentials,
  transport: typeof fetch = fetch,
): Promise<ShopInfoResult> {
  const { environment, partnerId, shopId, partnerKey, accessToken } = credentials;
  if (!Object.hasOwn(API_HOSTS, environment) || !/^\d+$/.test(partnerId) || !/^\d+$/.test(shopId))
    throw new Error('INVALID_CONNECTION_SCOPE');
  const path = '/api/v2/shop/get_shop_info',
    timestamp = Math.floor(Date.now() / 1000),
    url = new URL(path, API_HOSTS[environment]);
  const sign = signRequest({ partnerId, path, timestamp, partnerKey, accessToken, shopId });
  for (const [key, value] of Object.entries({
    partner_id: partnerId,
    shop_id: shopId,
    timestamp: String(timestamp),
    access_token: accessToken,
    sign,
  }))
    url.searchParams.set(key, value);
  try {
    const response = await transport(url, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(12000),
      headers: { Accept: 'application/json' },
    });
    const text = await response.text();
    if (text.length > 2 * 1024 * 1024) return { kind: 'unknown', reason: 'invalid_response' };
    const raw = JSON.parse(text);
    const common = z
      .object({ error: z.string(), request_id: z.string().optional() })
      .safeParse(raw);
    if (!common.success) return { kind: 'unknown', reason: 'invalid_response' };
    if (common.data.error)
      return { kind: 'rejected', code: common.data.error, requestId: common.data.request_id };
    if (!response.ok) return { kind: 'unknown', reason: 'transport' };
    // This API returns shop fields at the top level, unlike most Product endpoints.
    const parsed = z
      .object({
        shop_name: z.string().min(1),
        region: z.string().min(1),
        status: z.string().min(1),
        expire_time: z.number().int().optional(),
        shop_fulfillment_flag: z.string().optional(),
      })
      .safeParse(raw);
    if (!parsed.success) return { kind: 'unknown', reason: 'invalid_response' };
    return {
      kind: 'success',
      info: {
        shopName: parsed.data.shop_name,
        region: parsed.data.region,
        status: parsed.data.status,
        authorizationExpiresAt: parsed.data.expire_time,
        fulfillment: parsed.data.shop_fulfillment_flag,
        requestId: common.data.request_id,
      },
    };
  } catch {
    return { kind: 'unknown', reason: 'transport' };
  }
}
