import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Repository, transaction } from '@shopee/persistence';
import { SecretBox, exchangeProductionAuthorization } from '@shopee/gateway';
import {
  connectProductionPilot, connectionIdentity, savedProductionPartnerKey,
  productionPilotTarget as target,
} from './production-connection-service.js';

export const productionCallbackUrl =
  'http://127.0.0.1:4310/v1/connections/production-pilot/callback';
export const productionAuthorizationCookie = 'shopee_production_authorization';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const nonce = z.string().regex(/^[a-f0-9]{64}$/);
const secret = z.string().trim().min(8).max(4096);
const numericId = z
  .string()
  .regex(/^[1-9]\d{0,15}$/)
  .refine((v) => Number.isSafeInteger(Number(v)));
const prepareSchema = z
  .object({
    partnerId: connectionIdentity.shape.partnerId,
    shopId: connectionIdentity.shape.shopId,
    expectedRevision: z.number().int().nonnegative(),
    partnerKey: z.preprocess((v) => (v === '' ? undefined : v), secret.optional()),
  })
  .strict();
const callbackSchema = z
  .object({
    state: nonce,
    code: z.string().min(1).max(4096).optional(),
    shop_id: numericId.optional(),
    main_account_id: numericId.optional(),
    error: z.string().min(1).max(256).optional(),
    error_description: z.string().max(1024).optional(),
  })
  .strict();
type Options = { encryptionKey?: string; transport?: typeof fetch; allowOtherShops?: boolean };
const boxFor = (options: Options) =>
  new SecretBox(options.encryptionKey ?? process.env.APP_ENCRYPTION_KEY ?? '');
function publicStatus(row: any) {
  return {
    attemptId: row.id,
    status: row.status,
    connectionRevision: row.connection_revision ?? undefined,
    reason:row.reason ?? undefined,
  };
}
async function expireStaged(repo: Repository) {
  await repo.pool.query(`UPDATE production_authorization_attempts SET
    status=CASE WHEN status='pending' THEN 'expired' ELSE 'unknown' END,
    key_ciphertext=NULL,reason='ATTEMPT_EXPIRED',updated_at=now()
    WHERE status IN ('pending','exchanging') AND expires_at<=now()`);
}
export async function prepareProductionAuthorization(
  repo: Repository,
  raw: unknown,
  options: Options = {},
) {
  const input = prepareSchema.parse(raw),
    box = boxFor(options);
  if(!options.allowOtherShops && (input.partnerId!==target.partnerId || input.shopId!==target.shopId)) throw Error("PRODUCTION_CONNECTION_SCOPE_INVALID");
  const scope=`production:${input.partnerId}:${input.shopId}`;
  await expireStaged(repo);
  const attemptId = randomUUID(),
    state = randomBytes(32).toString('hex'),
    browserSecret = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await transaction(repo.pool, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      'connection-enrollment:' + scope,
    ]);
    const current = (
      await c.query(
        `SELECT revision,partner_key_ciphertext FROM connections
      WHERE environment='production' AND partner_id=$1 AND shop_id=$2`,
        [input.partnerId, input.shopId],
      )
    ).rows[0];
    if ((current?.revision ?? 0) !== input.expectedRevision)
      throw new Error('PRODUCTION_CONNECTION_REVISION_CONFLICT');
    if (
      (
        await c.query(
          `SELECT id FROM production_authorization_attempts WHERE partner_id=$1 AND shop_id=$2 AND status='exchanging' AND expires_at>now()`,[input.partnerId,input.shopId],
        )
      ).rowCount
    )
      throw new Error('PRODUCTION_AUTHORIZATION_BUSY');
    let partnerKey = input.partnerKey;
    if(!partnerKey && !current?.partner_key_ciphertext) {
      const saved=await savedProductionPartnerKey(repo,input.partnerId);
      if(saved)partnerKey=z.object({partnerKey:secret}).parse(box.open(saved.partner_key_ciphertext,`production:${saved.partner_id}:${saved.shop_id}`)).partnerKey;
    }
    if (!partnerKey && current?.partner_key_ciphertext) {
      try {
        partnerKey = z
          .object({ partnerKey: secret })
          .parse(box.open(current.partner_key_ciphertext, scope)).partnerKey;
      } catch {
        throw new Error('PRODUCTION_CONNECTION_SAVED_KEY_INVALID');
      }
    }
    if (!partnerKey) throw new Error('PRODUCTION_CONNECTION_KEY_REQUIRED');
    await c.query(`UPDATE production_authorization_attempts SET status='expired',reason='SUPERSEDED',
      key_ciphertext=NULL,updated_at=now() WHERE status='pending' AND partner_id=$1 AND shop_id=$2`,[input.partnerId,input.shopId]);
    await c.query(
      `INSERT INTO production_authorization_attempts
      (id,partner_id,shop_id,expected_revision,state_hash,browser_hash,key_ciphertext,status,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'pending',$8)`,
      [
        attemptId,
        input.partnerId,
        input.shopId,
        input.expectedRevision,
        digest(state),
        digest(browserSecret),
        box.seal({ partnerKey }, `${scope}:authorization:${attemptId}`),
        expiresAt,
      ],
    );
  });
  const url = new URL('https://open.shopee.com/auth');
  for (const [key, value] of Object.entries({
    partner_id: input.partnerId,
    auth_type: 'seller',
    redirect_uri: productionCallbackUrl,
    response_type: 'code',
    state,
  }))
    url.searchParams.set(key, value);
  // This secret is internal to the controller; emit it only as an HttpOnly cookie.
  return {
    attemptId,
    authorizationUrl: url.href,
    callbackUrl: productionCallbackUrl,
    expiresAt: expiresAt.toISOString(),
    browserSecret,
  };
}
export async function productionAuthorizationStatus(
  repo: Repository,
  attemptId: string,
  browserSecret: string,
) {
  z.string().uuid().parse(attemptId);
  nonce.parse(browserSecret);
  await expireStaged(repo);
  const row = (
    await repo.pool.query(
      'SELECT * FROM production_authorization_attempts WHERE id=$1 AND browser_hash=$2',
      [attemptId, digest(browserSecret)],
    )
  ).rows[0];
  if (!row) throw new Error('PRODUCTION_AUTHORIZATION_NOT_FOUND');
  return publicStatus(row);
}
export async function cancelProductionAuthorization(repo:Repository,attemptId:string,browserSecret:string) {
  z.string().uuid().parse(attemptId);nonce.parse(browserSecret);
  const changed=await repo.pool.query(`UPDATE production_authorization_attempts SET status='expired',reason='USER_CANCELLED',key_ciphertext=NULL,updated_at=now()
    WHERE id=$1 AND browser_hash=$2 AND status='pending' RETURNING id`,[attemptId,digest(browserSecret)]);
  const result=await productionAuthorizationStatus(repo,attemptId,browserSecret);
  if(!changed.rowCount && result.status==='exchanging')throw Error('PRODUCTION_AUTHORIZATION_BUSY');
  return result;
}
export async function finishProductionAuthorization(
  repo: Repository,
  raw: unknown,
  browserSecret: string,
  options: Options = {},
) {
  const query = callbackSchema.parse(raw);
  nonce.parse(browserSecret);
  if (!query.error && (!query.code || Boolean(query.shop_id) === Boolean(query.main_account_id)))
    throw new Error('PRODUCTION_AUTHORIZATION_INVALID_CALLBACK');

  await expireStaged(repo);
  const staged=(await repo.pool.query('SELECT partner_id,shop_id FROM production_authorization_attempts WHERE state_hash=$1 AND browser_hash=$2',[digest(query.state),digest(browserSecret)])).rows[0];
  if(!staged)throw Error('PRODUCTION_AUTHORIZATION_INVALID_CALLBACK');
  const input={partnerId:staged.partner_id as string,shopId:staged.shop_id as string};
  const scope=`production:${input.partnerId}:${input.shopId}`;
  if(query.shop_id && query.shop_id!==input.shopId)throw Error('PRODUCTION_AUTHORIZATION_WRONG_SHOP');
  const row = await transaction(repo.pool, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      'connection-enrollment:' + scope,
    ]);
    const row = (
      await c.query(
        'SELECT * FROM production_authorization_attempts WHERE state_hash=$1 AND browser_hash=$2 FOR UPDATE',
        [digest(query.state), digest(browserSecret)],
      )
    ).rows[0];
    if (!row) throw new Error('PRODUCTION_AUTHORIZATION_INVALID_CALLBACK');
    if (row.status === 'expired') throw new Error('PRODUCTION_AUTHORIZATION_EXPIRED');
    if (row.status !== 'pending') return { ...row, claimed: false };
    const current = (
      await c.query(
        `SELECT revision FROM connections WHERE environment='production'
      AND partner_id=$1 AND shop_id=$2`,
        [input.partnerId, input.shopId],
      )
    ).rows[0];
    if (query.error || (current?.revision ?? 0) !== row.expected_revision) {
      await c.query(
        `UPDATE production_authorization_attempts SET status='rejected',key_ciphertext=NULL,
        reason=$2,updated_at=now() WHERE id=$1`,
        [row.id, query.error ? 'SELLER_DECLINED' : 'REVISION_CHANGED'],
      );
      return { ...row, status: 'rejected', claimed: false };
    }
    const claimed = await c.query(
      "UPDATE production_authorization_attempts SET status='exchanging',updated_at=now() WHERE id=$1 AND expires_at>clock_timestamp() RETURNING id",
      [row.id],
    );
    if (!claimed.rowCount) {
      await c.query("UPDATE production_authorization_attempts SET status='expired',key_ciphertext=NULL,reason='ATTEMPT_EXPIRED',updated_at=now() WHERE id=$1", [row.id]);
      return { ...row, status: 'expired', claimed: false };
    }
    return { ...row, status: 'exchanging', claimed: true };
  });
  if (!row.claimed) return publicStatus(row);
  async function end(status: 'rejected' | 'unknown', reason: string) {
    await repo.pool.query(
      `UPDATE production_authorization_attempts SET status=$2,reason=$3,key_ciphertext=NULL,
      updated_at=now() WHERE id=$1 AND status='exchanging'`,
      [row.id, status, reason],
    );
    return productionAuthorizationStatus(repo, row.id, browserSecret);
  }
  try {
    const { partnerKey } = z
      .object({ partnerKey: secret })
      .parse(boxFor(options).open(row.key_ciphertext, `${scope}:authorization:${row.id}`));
    const exchangeStartedAt = Date.now();
    const token = await exchangeProductionAuthorization(
      {
        partnerId: input.partnerId,
        partnerKey,
        code: query.code!,
        shopId: query.shop_id,
        mainAccountId: query.main_account_id,
      },
      options.transport,
    );
    if (token.kind !== 'success')
      return end(
        token.kind === 'rejected' ? 'rejected' : 'unknown',
        'TOKEN_EXCHANGE_' + token.kind.toUpperCase(),
      );
    if (
      (query.main_account_id && !token.shopIdList) ||
      (token.shopIdList && !token.shopIdList.includes(input.shopId))
    )
      return end('rejected', 'UNEXPECTED_GRANT_SCOPE');
    const connected = await connectProductionPilot(
      repo,
      {
        partnerId: input.partnerId,
        shopId: input.shopId,
        expectedRevision: row.expected_revision,
        partnerKey,
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
      },
      {
        ...options, allowOtherShops:true,
        authorizationReceipt: {
          attemptId: row.id,
          expiresAt: new Date(exchangeStartedAt + token.expiresIn * 1000),
        },
      },
    );
    if (connected.kind !== 'success')
      return end(
        connected.kind === 'rejected' ? 'rejected' : 'unknown',
        'SHOP_READ_' + connected.kind.toUpperCase(),
      );
    return productionAuthorizationStatus(repo, row.id, browserSecret);
  } catch {
    return end('unknown', 'EXCHANGE_OR_PERSISTENCE_UNCERTAIN');
  }
}
