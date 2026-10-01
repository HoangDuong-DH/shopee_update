export type AuthorizationScope = { partnerId: string; shopId: string };
export type SavedAuthorizationAttempt = AuthorizationScope & {
  attemptId: string; authorizationUrl: string; callbackUrl: string; expiresAt: string | number;
};
export function authorizationExpiry(value: string | number): number {
  return typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
}
export function validAuthorizationAttempt(value: unknown, scope: AuthorizationScope, expectedCallback: string | undefined, now = Date.now()): value is SavedAuthorizationAttempt {
  if (!expectedCallback || !value || typeof value !== 'object') return false;
  const row = value as SavedAuthorizationAttempt;
  try {
    const url = new URL(row.authorizationUrl), callback = new URL(row.callbackUrl), trusted = new URL(expectedCallback);
    return row.partnerId === scope.partnerId && row.shopId === scope.shopId &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.attemptId) &&
      Number.isFinite(authorizationExpiry(row.expiresAt)) && authorizationExpiry(row.expiresAt) > now &&
      url.origin === 'https://open.shopee.com' && url.pathname === '/auth' && !url.username && !url.password &&
      url.searchParams.get('partner_id') === scope.partnerId &&
      (!url.searchParams.has('redirect_uri') || url.searchParams.get('redirect_uri') === callback.href) &&
      callback.href === trusted.href && !callback.username && !callback.password && !callback.search && !callback.hash &&
      callback.pathname.endsWith('/v1/connections/production-pilot/callback') &&
      (callback.protocol === 'https:' || callback.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(callback.hostname));
  } catch { return false; }
}
