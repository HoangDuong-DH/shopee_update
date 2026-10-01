const callbackPath = '/v1/connections/production-pilot/callback';

/** Return to the UI of this installation, keeping rehearsal and operating tabs separate. */
export function productionApplicationLocation(
  env: Record<string, string | undefined> = process.env,
): string {
  try {
    const port = env.WEB_PORT ?? '5173';
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw Error();
    const url = new URL(env.PUBLIC_WEB_ORIGIN ?? `http://127.0.0.1:${port}`);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.pathname !== '/' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw Error();
    return url.href;
  } catch {
    throw Error('AUTHORIZATION_APPLICATION_CONFIGURATION_INVALID');
  }
}

/**
 * Supported installation: root UI and /v1 callback on one cookie host and scheme.
 * Local API/UI ports may differ. Proxy path prefixes and cross-host callbacks
 * are not supported by the host-only /v1/connections authorization cookie.
 */
export function productionAuthorizationLocation(
  env: Record<string, string | undefined> = process.env,
): string {
  try {
    const port = env.API_PORT ?? '4310';
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw Error();
    const origin = new URL(env.PUBLIC_API_ORIGIN ?? `http://127.0.0.1:${port}`);
    if (
      origin.pathname !== '/' ||
      origin.search ||
      origin.hash ||
      origin.username ||
      origin.password
    )
      throw Error();
    const url = env.SHOPEE_AUTHORIZATION_CALLBACK_URL
      ? new URL(env.SHOPEE_AUTHORIZATION_CALLBACK_URL)
      : new URL(callbackPath, origin);
    const application = new URL(productionApplicationLocation(env));
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.pathname !== callbackPath ||
      url.hostname !== application.hostname ||
      url.protocol !== application.protocol ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw Error();
    return url.href;
  } catch {
    throw Error('AUTHORIZATION_CALLBACK_CONFIGURATION_INVALID');
  }
}
