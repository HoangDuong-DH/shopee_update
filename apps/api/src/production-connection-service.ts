import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Repository, transaction } from '@shopee/persistence';
import { SecretBox, readShopInfo } from '@shopee/gateway';

// Explicit pilot enrollment requested by the owner. This is not a product-write allowlist.
export const productionPilotTarget = Object.freeze({
  environment: 'production' as const,
  partnerId: '2010476',
  shopId: '1423724897',
  expectedHandle: 'vuatinhdau.vn',
  appName: 'VestaPro',
  consoleUrl: 'https://open.shopee.com/console/app/218272',
});
export const connectionIdentity = z.object({partnerId:z.string().regex(/^[1-9]\d{0,9}$/).refine(v=>Number(v)<=4294967295),shopId:z.string().regex(/^[1-9]\d{0,15}$/).refine(v=>Number.isSafeInteger(Number(v)))});
const secret = z.string().trim().min(8).max(4096);
const optionalSecret = z.preprocess(
  (value) => (typeof value === 'string' && !value.trim() ? undefined : value),
  secret.optional(),
);
const inputSchema = z
  .object({
    partnerId: connectionIdentity.shape.partnerId,
    shopId: connectionIdentity.shape.shopId,
    expectedRevision: z.number().int().nonnegative(),
    partnerKey: optionalSecret,
    accessToken: secret,
    refreshToken: optionalSecret,
  })
  .strict();

async function currentConnection(repo: Repository, target = productionPilotTarget as {partnerId:string;shopId:string}) {
  return (
    await repo.pool.query(
      'SELECT * FROM connections WHERE environment=$1 AND partner_id=$2 AND shop_id=$3',
      ['production', target.partnerId, target.shopId],
    )
  ).rows[0];
}

/** Partner keys belong to the app, not a shop. Reuse only within the same production partner. */
export async function savedProductionPartnerKey(repo:Repository,partnerId:string) {
  return (await repo.pool.query(`SELECT partner_key_ciphertext,partner_id,shop_id FROM connections
    WHERE environment='production' AND partner_id=$1 AND partner_key_ciphertext IS NOT NULL
    ORDER BY updated_at DESC,id LIMIT 1`,[partnerId])).rows[0];
}

export async function productionConnectionTarget(repo: Repository, raw:unknown = productionPilotTarget) {
  const target=connectionIdentity.parse(raw);
  const row = await currentConnection(repo,target);
  const savedKey=row?.partner_key_ciphertext ? row : await savedProductionPartnerKey(repo,target.partnerId);
  return {
    ...productionPilotTarget, ...target,
    expectedHandle: row?.name ?? (target.shopId===productionPilotTarget.shopId ? productionPilotTarget.expectedHandle : `Shop ${target.shopId}`),
    appName: target.partnerId===productionPilotTarget.partnerId ? productionPilotTarget.appName : `Ứng dụng ${target.partnerId}`,
    consoleUrl: target.partnerId===productionPilotTarget.partnerId ? productionPilotTarget.consoleUrl : "https://open.shopee.com/console/app",
    tokenExpiresAt: row?.expires_at?.toISOString() ?? null,
    refreshStatus:row?.refresh_status ?? "idle", refreshReason:row?.refresh_reason ?? null,
    autoRefresh:row?.auto_refresh ?? true,
    connectionId: row?.id ?? null,
    connectionRevision: row?.revision ?? 0,
    state: row?.refresh_status==='reauth_required' ? 'reauth_required' : row?.refresh_status==='unknown' ? 'refresh_unknown' : row?.expires_at && new Date(row.expires_at).getTime()<=Date.now() ? 'token_expired' : row?.state ?? 'disconnected',
    officialName: row?.name ?? null,
    hasSavedKey: Boolean(savedKey?.partner_key_ciphertext),
    automaticRefreshReady: Boolean(row?.auto_refresh),
    productionWrites: false,
  };
}

/** Reads get_shop_info only. No worker enqueue, product mutation, or credential rotation. */
export async function connectProductionPilot(
  repo: Repository,
  raw: unknown,
  options: {
    transport?: typeof fetch;
    allowOtherShops?: boolean;
    encryptionKey?: string;
    authorizationReceipt?: { attemptId: string; expiresAt: Date };
  } = {},
) {
  const input = inputSchema.parse(raw);
  if(!options.allowOtherShops && (input.partnerId!==productionPilotTarget.partnerId || input.shopId!==productionPilotTarget.shopId)) throw Error("PRODUCTION_CONNECTION_SCOPE_INVALID");
  const scopeKey=`production:${input.partnerId}:${input.shopId}`;
  const box = new SecretBox(options.encryptionKey ?? process.env.APP_ENCRYPTION_KEY ?? '');
  const before = await currentConnection(repo,input);
  if ((before?.revision ?? 0) !== input.expectedRevision)
    throw new Error('PRODUCTION_CONNECTION_REVISION_CONFLICT');
  let partnerKey = input.partnerKey;
  let refreshToken = input.refreshToken;
  try {
    if(!partnerKey && !before?.partner_key_ciphertext) {
      const saved=await savedProductionPartnerKey(repo,input.partnerId);
      if(saved)partnerKey=z.object({partnerKey:secret}).parse(box.open(saved.partner_key_ciphertext,`production:${saved.partner_id}:${saved.shop_id}`)).partnerKey;
    }
    if (!partnerKey && before?.partner_key_ciphertext)
      partnerKey = z
        .object({ partnerKey: secret })
        .parse(box.open(before.partner_key_ciphertext, scopeKey)).partnerKey;
    if (!refreshToken && before?.token_ciphertext)
      refreshToken = z
        .object({ refreshToken: secret.optional() })
        .parse(box.open(before.token_ciphertext, scopeKey)).refreshToken;
  } catch {
    throw new Error('PRODUCTION_CONNECTION_SAVED_KEY_INVALID');
  }
  if (!partnerKey) throw new Error('PRODUCTION_CONNECTION_KEY_REQUIRED');
  const result = await readShopInfo(
    {
      environment: 'production',
      partnerId: input.partnerId,
      shopId: input.shopId,
      partnerKey,
      accessToken: input.accessToken,
    },
    options.transport,
  );
  if (result.kind !== 'success') {
    // Never expose arbitrary upstream error text (which could contain credentials).
    return result.kind === 'rejected'
      ? {
          kind: 'rejected' as const,
          code: [
            'error_partner_key_expired',
            'error_sign',
            'error_auth',
            'invalid_acceess_token',
            'partner_shop_no_link',
            'shop_no_linked',
            'shop_banned',
            'error_api_permission',
            'source_ip_undeclared',
            'error_rate_limit',
            'error_limit',
          ].includes(result.code)
            ? result.code
            : 'PRODUCTION_CONNECTION_REJECTED',
        }
      : { kind: 'unknown' as const, reason: result.reason };
  }
  if (result.info.region !== 'VN' || result.info.status !== 'NORMAL')
    throw new Error('PRODUCTION_CONNECTION_SHOP_NOT_READY');
  if (
    result.info.authorizationExpiresAt !== undefined &&
    result.info.authorizationExpiresAt * 1000 <= Date.now()
  )
    throw new Error('PRODUCTION_CONNECTION_AUTH_EXPIRED');
  const revision = input.expectedRevision + 1;
  const capabilityRevision = (before?.capability_revision ?? 0) + 1;
  const connectionId = before?.id ?? randomUUID();
  const observedAt = new Date().toISOString();
  const capabilities = [
    {
      name: 'shop.read',
      state: 'supported',
      scope: {
        environment: 'production',
        partnerId: input.partnerId,
        shopId: input.shopId,
        connectionRevision: revision,
        capabilityRevision,
      },
      observedAt,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      constraints: { platformStatus: result.info.status },
      sources: [
        {
          kind: 'official_doc',
          url: 'https://open.shopee.com/documents/v2/v2.shop.get_shop_info?module=92&type=1',
          locator: 'v2.shop.get_shop_info',
          observedAt,
          sourceUpdatedAt: '2026-05-19',
          fileSha256: 'bb24205fdb71e6d15958318e0e73ab7307da4a8a447430033a572f8d03f8efd8',
        },
      ],
    },
  ];
  await transaction(repo.pool, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      'connection-enrollment:' + scopeKey,
    ]);
    const current = (
      await c.query(
        'SELECT id,revision FROM connections WHERE environment=$1 AND partner_id=$2 AND shop_id=$3 FOR UPDATE',
        ['production', input.partnerId, input.shopId],
      )
    ).rows[0];
    if ((current?.revision ?? 0) !== input.expectedRevision || current?.id !== before?.id)
      throw new Error('PRODUCTION_CONNECTION_REVISION_CONFLICT');
    const receipt = options.authorizationReceipt;
    if (receipt) {
      const attempt = (
        await c.query(
          `SELECT id FROM production_authorization_attempts
        WHERE id=$1 AND status='exchanging' AND partner_id=$2 AND shop_id=$3
        AND expected_revision=$4 AND expires_at>now() FOR UPDATE`,
          [receipt.attemptId, input.partnerId, input.shopId, input.expectedRevision],
        )
      ).rows[0];
      if (
        !attempt ||
        !Number.isFinite(receipt.expiresAt.getTime()) ||
        receipt.expiresAt.getTime() <= Date.now()
      )
        throw new Error('PRODUCTION_CONNECTION_AUTH_EXPIRED');
    }
    const tokenCiphertext = box.seal({ accessToken: input.accessToken, refreshToken }, scopeKey);
    const keyCiphertext = box.seal({ partnerKey }, scopeKey);
    if (current) {
      await c.query(
        `UPDATE connections SET name=$2,region='VN',revision=$3,capability_revision=$4,
         state='connected',token_ciphertext=$5,partner_key_ciphertext=$6,capabilities=$7,
         expires_at=$8,updated_at=now() WHERE id=$1`,
        [
          connectionId,
          result.info.shopName,
          revision,
          capabilityRevision,
          tokenCiphertext,
          keyCiphertext,
          JSON.stringify(capabilities),
          receipt?.expiresAt ?? null,
        ],
      );
    } else {
      await c.query(
        `INSERT INTO connections(id,environment,partner_id,shop_id,name,region,revision,
         capability_revision,state,token_ciphertext,partner_key_ciphertext,capabilities,expires_at)
         VALUES($1,'production',$2,$3,$4,'VN',$5,$6,'connected',$7,$8,$9,$10)`,
        [
          connectionId,
          input.partnerId,
          input.shopId,
          result.info.shopName,
          revision,
          capabilityRevision,
          tokenCiphertext,
          keyCiphertext,
          JSON.stringify(capabilities),
          receipt?.expiresAt ?? null,
        ],
      );
    }
    await c.query("UPDATE connections SET auto_refresh=true,refresh_status='idle',refresh_reason=NULL,next_refresh_at=NULL,health_checked_at=now() WHERE id=$1",[connectionId]);
    await c.query(
      `INSERT INTO connection_checks(id,connection_id,connection_revision,endpoint,request_id,result)
       VALUES($1,$2,$3,'v2.shop.get_shop_info',$4,$5)`,
      [randomUUID(), connectionId, revision, result.info.requestId, result.info],
    );
    if (receipt)
      await c.query(
        `UPDATE production_authorization_attempts SET status='verified',
      key_ciphertext=NULL,connection_id=$2,connection_revision=$3,updated_at=now() WHERE id=$1`,
        [receipt.attemptId, connectionId, revision],
      );
  });
  return {
    kind: 'success' as const,
    connectionId,
    connectionRevision: revision,
    info: result.info,
    tokenExpiryKnown: Boolean(options.authorizationReceipt),
    automaticRefreshReady: Boolean(refreshToken),
    productionWrites: false,
  };
}
