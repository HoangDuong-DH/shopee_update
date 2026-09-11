import { createHmac } from 'node:crypto';
export function signRequest(input: {
  partnerId: string;
  path: string;
  timestamp: number;
  partnerKey: string;
  accessToken?: string;
  shopId?: string;
}): string {
  if (
    !/^\d+$/.test(input.partnerId) ||
    !/^\/api\/v2\/[a-z_]+\/[a-z_]+$/.test(input.path) ||
    !Number.isSafeInteger(input.timestamp)
  )
    throw new Error('INVALID_SIGN_INPUT');
  if ((input.accessToken === undefined) !== (input.shopId === undefined))
    throw new Error('INVALID_SIGN_SCOPE');
  const base =
    input.partnerId +
    input.path +
    input.timestamp +
    (input.accessToken ?? '') +
    (input.shopId ?? '');
  return createHmac('sha256', input.partnerKey).update(base, 'utf8').digest('hex');
}
