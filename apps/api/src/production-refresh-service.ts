import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { Repository, transaction } from '@shopee/persistence';
import { SecretBox, readShopInfo } from '@shopee/gateway';
import { preparedWireMediaRequirements } from '../../../packages/shopee/src/prepared-wire.js';
import {
  exchangeProductionRefresh,
  parseProductionRefreshResponse,
  type ProductionRefreshReceipt,
} from '../../../packages/shopee/src/production-refresh.js';


const secret = z.string().min(1).max(4096).regex(/^\S+$/u);
const fail = (code: string): never => {
  throw Error('PRODUCTION_REFRESH_' + code);
};
type Result = {
  kind: 'success' | 'already_saved' | 'rejected' | 'unknown';
  connectionId: string;
  connectionRevision?: number;
  expiresAt?: string;
  code?: string;
  receiptPath?: string;
};
async function durableCreate(path: string, body: unknown) {
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(body));
    await file.sync();
  } finally {
    await file.close();
  }
}
/** Called under the same owner advisory lock used by create/publication journals.
 * Completed acknowledgements need refresh for QC; no existing lane is removed or rewritten. */
async function requireReadOnlyLane(db: PoolClient, connectionId: string, owner:string) {
  const pending = (
    await db.query(
      // A reservation without a lane or any step has never obtained permission to send.
      // Under the same shop lock, rotation is safe: step authorization requires the exact
      // connection revision. Preserve the reservation; its next run must renew preflight.
      `SELECT o.id FROM production_pilot_operations o WHERE o.owner_key=$1 AND
        (o.state IN ('sent','unknown') OR (o.state='authorized' AND
          (o.item_id IS NOT NULL OR EXISTS(SELECT 1 FROM production_pilot_steps s WHERE s.operation_id=o.id)
          OR EXISTS(SELECT 1 FROM production_pilot_lanes l WHERE l.operation_id=o.id))))
        UNION ALL SELECT id FROM production_pilot_publications WHERE owner_key=$1 AND state IN ('authorized','sent','unknown')`,
      [owner],
    )
  ).rows;
  if (pending.length) fail('WRITER_ACTIVE');
  const lane = (
    await db.query(
      'SELECT operation_id FROM production_pilot_lanes WHERE owner_key=$1 FOR UPDATE',
      [owner],
    )
  ).rows[0];
  if (!lane) return;
  const op = (
    await db.query('SELECT * FROM production_pilot_operations WHERE id=$1 FOR SHARE', [
      lane.operation_id,
    ])
  ).rows[0];
  if (
    !op ||
    op.connection_id !== connectionId ||
    !['acknowledged', 'verified'].includes(op.state) ||
    !op.item_id
  )
    fail('WRITER_ACTIVE');
  let keys: string[];
  try {
    const doc = op.source_payload.document;
    keys = [
      ...preparedWireMediaRequirements(doc).map((_, i) => 'media-' + i),
      'create',
      ...(doc.tierNames.length ? ['variations'] : []),
    ];
  } catch {
    fail('WRITER_ACTIVE');
  }
  const steps = (
    await db.query(
      'SELECT step_key,state FROM production_pilot_steps WHERE operation_id=$1 FOR SHARE',
      [op.id],
    )
  ).rows;
  if (
    steps.length !== keys!.length ||
    !keys!.every((key) =>
      steps.some((step) => step.step_key === key && step.state === 'acknowledged'),
    )
  )
    fail('WRITER_ACTIVE');
  const publication = (
    await db.query(
      'SELECT state FROM production_pilot_publications WHERE create_operation_id=$1 FOR SHARE',
      [op.id],
    )
  ).rows[0];
  if (publication && !['acknowledged', 'verified'].includes(publication.state))
    fail('WRITER_ACTIVE');
}

/** Trusted server/CLI only. One encrypted receipt per connection revision, no HTTP route.
 * A lost DB save can recover from that receipt without reusing the single-use refresh token. */
export async function refreshProductionPilotConnection(
  repo: Repository,
  options: {
    expectedRevision: number;
    connectionId?: string;
    mode: 'refresh' | 'recover';
    receiptRoot: string;
    encryptionKey?: string;
    transport?: typeof fetch;
  },
): Promise<Result> {
  if (
    !Number.isSafeInteger(options.expectedRevision) ||
    options.expectedRevision < 1 ||
    !['refresh', 'recover'].includes(options.mode) ||
    !isAbsolute(options.receiptRoot)
  )
    fail('INPUT_INVALID');
  const identity=options.connectionId ? (await repo.pool.query("SELECT partner_id,shop_id FROM connections WHERE id=$1 AND environment='production'",[z.string().uuid().parse(options.connectionId)])).rows[0] : {partner_id:'2010476',shop_id:'1423724897'};
  if(!identity)fail('CONNECTION_REQUIRED');
  const target={partnerId:identity.partner_id as string,shopId:identity.shop_id as string};
  const owner=`production:${target.partnerId}:${target.shopId}`;
  const box = new SecretBox(options.encryptionKey ?? process.env.APP_ENCRYPTION_KEY ?? '');
  return transaction(repo.pool, async (db) => {
    await db.query("SET LOCAL lock_timeout = '5s'");
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      'production-pilot:' + owner,
    ]);
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      'connection-enrollment:' + owner,
    ]);
    const row = (
      await db.query(
        "SELECT * FROM connections WHERE environment='production' AND partner_id=$1 AND shop_id=$2 FOR UPDATE",[target.partnerId,target.shopId],
      )
    ).rows[0];
    if (!row || (row.state !== 'connected' && !(options.mode==='recover' && row.state==='refresh_unknown'))) fail('CONNECTION_REQUIRED');
    if (
      row.revision !== options.expectedRevision &&
      !(options.mode === 'recover' && row.revision === options.expectedRevision + 1)
    )
      fail('REVISION_CONFLICT');
    await requireReadOnlyLane(db, row.id, owner);
    if (
      (
        await db.query(
          "SELECT id FROM production_authorization_attempts WHERE partner_id=$1 AND shop_id=$2 AND status IN ('pending','exchanging') AND expires_at>now()",[target.partnerId,target.shopId],
        )
      ).rowCount
    )
      fail('AUTHORIZATION_ACTIVE');
    let partnerKey: string, tokens: { accessToken: string; refreshToken: string };
    try {
      partnerKey = z
        .object({ partnerKey: secret })
        .parse(box.open(row.partner_key_ciphertext, owner)).partnerKey;
      tokens = z
        .object({ accessToken: secret, refreshToken: secret })
        .parse(box.open(row.token_ciphertext, owner));
    } catch {
      fail('SAVED_CREDENTIALS_INVALID');
    }
    const directory = join(options.receiptRoot, row.id + '-r' + options.expectedRevision),
      intentPath = join(directory, 'intent.json'),
      receiptPath = join(directory, 'response.sealed.json');
    const aad = owner + ':refresh:' + row.id + ':' + options.expectedRevision;
    await mkdir(directory, { recursive: true });
    let intent: {
      id: string;
      connectionId: string;
      connectionRevision: number;
      owner: string;
      startedAt: string;
    };
    let outcome: ReturnType<typeof parseProductionRefreshResponse>;
    if (options.mode === 'refresh') {
      intent = {
        id: randomUUID(),
        connectionId: row.id,
        connectionRevision: options.expectedRevision,
        owner,
        startedAt: new Date().toISOString(),
      };
      try {
        await durableCreate(intentPath, intent);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') fail('ALREADY_ATTEMPTED');
        throw e;
      }
      outcome = await exchangeProductionRefresh(
        {
          partnerId: target.partnerId,
          shopId: target.shopId,
          partnerKey: partnerKey!,
          refreshToken: tokens!.refreshToken,
        },
        {
          transport: options.transport, scope:target,
          capture: async (receipt) => {
            await durableCreate(receiptPath, {
              version: 1,
              ciphertext: box.seal({ intent, receipt }, aad),
            });
          },
        },
      );
    } else {
      try {
        intent = JSON.parse(await readFile(intentPath, 'utf8'));
        const stored = JSON.parse(await readFile(receiptPath, 'utf8'));
        const opened = box.open(stored.ciphertext, aad) as {
          intent: typeof intent;
          receipt: ProductionRefreshReceipt;
        };
        if (
          stored.version !== 1 ||
          JSON.stringify(opened.intent) !== JSON.stringify(intent) ||
          intent.connectionId !== row.id ||
          intent.connectionRevision !== options.expectedRevision ||
          intent.owner !== owner ||
          !Number.isFinite(Date.parse(intent.startedAt)) ||
          Date.parse(intent.startedAt) > Date.now()
        )
          fail('RECEIPT_UNAVAILABLE');
        outcome = parseProductionRefreshResponse(opened.receipt,target);
      } catch {
        fail('RECEIPT_UNAVAILABLE');
      }
    }
    if (outcome!.kind !== 'success')
      return {
        kind: outcome!.kind,
        connectionId: row.id,
        code: outcome!.kind === 'rejected' ? outcome!.code : 'PRODUCTION_REFRESH_UNRESOLVED',
        receiptPath,
      };
    const renewed = outcome!;
    const tokenExpiresAt = Date.parse(intent!.startedAt) + renewed.expiresIn * 1000;
    if (row.revision === options.expectedRevision + 1) {
      if (
        tokens!.accessToken !== renewed.accessToken ||
        tokens!.refreshToken !== renewed.refreshToken ||
        !row.expires_at ||
        new Date(row.expires_at).getTime() > tokenExpiresAt
      )
        fail('REVISION_CONFLICT');
      return {
        kind: 'already_saved',
        connectionId: row.id,
        connectionRevision: row.revision,
        expiresAt: new Date(row.expires_at).toISOString(),
        receiptPath,
      };
    }
    if (tokenExpiresAt <= Date.now())
      return {
        kind: 'unknown',
        connectionId: row.id,
        code: 'PRODUCTION_REFRESH_RECEIPT_EXPIRED',
        receiptPath,
      };
    const verified = await readShopInfo(
      {
        environment: 'production',
        partnerId: target.partnerId,
        shopId: target.shopId,
        partnerKey: partnerKey!,
        accessToken: renewed.accessToken,
      },
      options.transport,
    );
    if (
      verified.kind !== 'success' ||
      verified.info.region !== 'VN' ||
      verified.info.status !== 'NORMAL'
    )
      return {
        kind: 'unknown',
        connectionId: row.id,
        code: 'PRODUCTION_REFRESH_SHOP_READ_UNVERIFIED',
        receiptPath,
      };
    const expiresAt = new Date(
      Math.min(
        tokenExpiresAt,
        verified.info.authorizationExpiresAt === undefined
          ? Infinity
          : verified.info.authorizationExpiresAt * 1000,
      ),
    );
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now())
      return {
        kind: 'unknown',
        connectionId: row.id,
        code: 'PRODUCTION_REFRESH_AUTH_EXPIRED',
        receiptPath,
      };
    const result = await db.query(
      "UPDATE connections SET state='connected',refresh_status='healthy',refresh_reason=NULL,health_checked_at=now(),next_refresh_at=NULL,token_ciphertext=$2,expires_at=$3,revision=revision+1,capability_revision=capability_revision+1,capabilities='[]',updated_at=now() WHERE id=$1 AND revision=$4 RETURNING revision",
      [
        row.id,
        box.seal({ accessToken: renewed.accessToken, refreshToken: renewed.refreshToken }, owner),
        expiresAt,
        options.expectedRevision,
      ],
    );
    if (result.rowCount !== 1) fail('REVISION_CONFLICT');
    const requestId =
      verified.info.requestId &&
      /^[A-Za-z0-9_:-]{1,128}$/.test(verified.info.requestId) &&
      ![partnerKey!, renewed.accessToken, renewed.refreshToken].includes(verified.info.requestId)
        ? verified.info.requestId
        : null;
    await db.query(
      "INSERT INTO connection_checks(id,connection_id,connection_revision,endpoint,request_id,result) VALUES($1,$2,$3,'v2.shop.get_shop_info',$4,$5)",
      [
        randomUUID(),
        row.id,
        options.expectedRevision + 1,
        requestId,
        {
          kind: 'success',
          region: 'VN',
          status: 'NORMAL',
          refreshIntentId: intent!.id,
          tokenExpiresAt: expiresAt.toISOString(),
        },
      ],
    );
    return {
      kind: 'success',
      connectionId: row.id,
      connectionRevision: options.expectedRevision + 1,
      expiresAt: expiresAt.toISOString(),
      receiptPath,
    };
  });
}
