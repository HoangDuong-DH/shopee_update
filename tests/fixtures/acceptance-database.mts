import { resolve } from 'node:path';
const onboardingModule = '../../scripts/onboarding-core.mjs';

/** Default fixture DB is fixed; release rehearsals may use only a proved owned install. */
export async function assertAcceptanceDatabase(root = process.cwd()): Promise<void> {
  const env = process.env;
  const target = new URL(env.DATABASE_URL ?? 'postgres://invalid/invalid');
  if (env.INTERNAL_ISOLATED_MODE !== '1' || target.protocol !== 'postgres:' || target.hostname !== '127.0.0.1'
    || target.search || target.hash) throw Error('INTERNAL_ACCEPTANCE_ISOLATION_REQUIRED');
  if (target.port === '5443' && target.pathname === '/shopee_internal_test' && target.username === 'shopee_internal') return;
  if (env.INTERNAL_ACCEPTANCE_OWNED_BOOTSTRAP !== '1' || target.port === '5442'
    || env.PRODUCTION_PILOT_ENABLED !== '0' || env.SHOPEE_PRODUCTION_WRITES !== 'false'
    || env.CONNECTION_MAINTENANCE_ENABLED !== '0') throw Error('INTERNAL_ACCEPTANCE_ISOLATION_REQUIRED');
  const { readOwnedConfiguration, inspectOwnedDatabase } = await import(onboardingModule);
  const owned = await readOwnedConfiguration(resolve(root));
  if (owned.receipt.status !== 'complete' || owned.env.DATABASE_URL !== env.DATABASE_URL
    || owned.env.APP_ENCRYPTION_KEY !== env.APP_ENCRYPTION_KEY) throw Error('INTERNAL_ACCEPTANCE_OWNERSHIP_REQUIRED');
  const database = await inspectOwnedDatabase(owned);
  if (!database.exists || !database.running || !database.healthy) throw Error('INTERNAL_ACCEPTANCE_OWNERSHIP_REQUIRED');
}