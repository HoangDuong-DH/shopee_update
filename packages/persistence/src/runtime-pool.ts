import type { PoolConfig } from 'pg';

function timeout(raw: string | undefined, fallback: number, maximum: number) {
  if(raw === undefined) return fallback;
  const value=Number(raw);
  if(!Number.isInteger(value) || value<1000 || value>maximum) throw Error('DATABASE_TIMEOUT_CONFIGURATION_INVALID');
  return value;
}
/** Server-side statement deadlines cancel SQL rather than leaving a client-only
 * timed-out query running. Never automatically retry a timed-out mutation. */
export function runtimePoolConfig(env: NodeJS.ProcessEnv = process.env): PoolConfig {
  return {
    connectionString: env.DATABASE_URL,
    connectionTimeoutMillis: timeout(env.DB_CONNECTION_TIMEOUT_MS,5000,30000),
    statement_timeout: timeout(env.DB_STATEMENT_TIMEOUT_MS,120000,600000),
    idle_in_transaction_session_timeout: timeout(env.DB_IDLE_TRANSACTION_TIMEOUT_MS,120000,600000),
    application_name: env.INTERNAL_ISOLATED_MODE==='1'?'shopee-uploader-isolated':'shopee-uploader',
  };
}
