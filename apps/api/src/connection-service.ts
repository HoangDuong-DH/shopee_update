import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Repository, transaction } from '@shopee/persistence';
import { SecretBox, readShopInfo } from '@shopee/gateway';
const schema = z.object({
  connectionId: z.string().uuid(),
  expectedRevision: z.number().int().positive(),
  partnerKey: z.string().min(8).max(4096),
  accessToken: z.string().min(8).max(4096),
  refreshToken: z.string().max(4096).optional(),
});
export async function connectSandbox(repo: Repository, raw: unknown) {
  const input = schema.parse(raw),
    box = new SecretBox(process.env.APP_ENCRYPTION_KEY ?? '');
  const connection = (
    await repo.pool.query('SELECT * FROM connections WHERE id=$1', [input.connectionId])
  ).rows[0];
  if (!connection || connection.environment !== 'sandbox')
    throw new Error('INVALID_SANDBOX_CONNECTION');
  if (connection.revision !== input.expectedRevision) throw new Error('PRODUCT_REVISION_CONFLICT');
  const result = await readShopInfo({
    environment: 'sandbox',
    partnerId: connection.partner_id,
    shopId: connection.shop_id,
    partnerKey: input.partnerKey,
    accessToken: input.accessToken,
  });
  if (result.kind !== 'success') return result;
  const scopeKey = `sandbox:${connection.partner_id}:${connection.shop_id}`;
  const revision = connection.revision + 1,
    scope = {
      environment: 'sandbox',
      partnerId: connection.partner_id,
      shopId: connection.shop_id,
      connectionRevision: revision,
      capabilityRevision: connection.capability_revision + 1,
    };
  const checkedAt = new Date().toISOString();
  const capability = {
    name: 'shop.read',
    state: 'supported',
    scope,
    observedAt: checkedAt,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    constraints: { platformStatus: result.info.status },
    sources: [
      {
        kind: 'official_doc',
        fileSha256: 'bb24205fdb71e6d15958318e0e73ab7307da4a8a447430033a572f8d03f8efd8',
        locator: 'v2.shop.get_shop_info',
        observedAt: checkedAt,
        sourceUpdatedAt: '2026-05-19',
        url: 'https://open.shopee.com/documents/v2/v2.shop.get_shop_info?module=92&type=1',
      },
    ],
  };
  await transaction(repo.pool, async (c) => {
    const updated = await c.query(
      `UPDATE connections SET name=$2,region=$3,revision=$4,capability_revision=capability_revision+1,state='connected',token_ciphertext=$5,partner_key_ciphertext=$6,capabilities=$7,expires_at=NULL,updated_at=now() WHERE id=$1 AND revision=$8 RETURNING id`,
      [
        connection.id,
        result.info.shopName,
        result.info.region,
        revision,
        box.seal({ accessToken: input.accessToken, refreshToken: input.refreshToken }, scopeKey),
        box.seal({ partnerKey: input.partnerKey }, scopeKey),
        JSON.stringify([capability]),
        input.expectedRevision,
      ],
    );
    if (!updated.rowCount) throw new Error('PRODUCT_REVISION_CONFLICT');
    await c.query(
      'INSERT INTO connection_checks(id,connection_id,connection_revision,endpoint,request_id,result) VALUES($1,$2,$3,$4,$5,$6)',
      [
        randomUUID(),
        connection.id,
        revision,
        'v2.shop.get_shop_info',
        result.info.requestId,
        result.info,
      ],
    );
  });
  return {
    kind: 'success',
    info: result.info,
    connectionRevision: revision,
    tokenExpiryKnown: false,
    automaticRefreshReady: false,
  };
}
