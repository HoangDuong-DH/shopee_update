// Loaded before API/worker code in the isolated rehearsal only.
// Native PostgreSQL traffic is configured separately; this is a fetch guard,
// not a replacement for an OS firewall or container egress policy.
export function allowLocalFetch(input) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  return ['http:', 'https:'].includes(url.protocol)
    && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    && !url.username && !url.password;
}

if (process.env.INTERNAL_ISOLATED_MODE === '1') {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (!allowLocalFetch(input)) throw new Error('ISOLATED_EXTERNAL_REQUEST_BLOCKED');
    // Never follow a local server redirect to an external endpoint.
    const response = await originalFetch(input, { ...init, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400)
      throw new Error('ISOLATED_REDIRECT_BLOCKED');
    return response;
  };
}
