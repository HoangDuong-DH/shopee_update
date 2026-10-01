/** Preserve the historical localhost:5442 test setup outside rehearsal. In isolated
 * mode, accept only the exact named rehearsal target; never fall back to live. */
export function assertLocalIntegrationDatabase(database: URL, env: NodeJS.ProcessEnv = process.env): void {
  if (!['postgres:', 'postgresql:'].includes(database.protocol)) throw Error('LOCAL_TEST_DATABASE_REQUIRED');
  if (env.INTERNAL_ISOLATED_MODE === '1') {
    if (database.hostname !== '127.0.0.1' || database.port !== '5443'
      || database.pathname !== '/shopee_internal_test' || database.username !== 'shopee_internal')
      throw Error('ISOLATED_TEST_DATABASE_REQUIRED');
    return;
  }
  if (!['localhost', '127.0.0.1'].includes(database.hostname) || database.port !== '5442')
    throw Error('LOCAL_TEST_DATABASE_REQUIRED');
}
