import { z } from 'zod';
import type { ShopConnection } from '@shopee/domain';
import type { Pool } from 'pg';
import { transaction } from './db.js';

const publicColumns =
  'id,name,display_name,name_revision,region,state,environment,partner_id,shop_id,revision,capability_revision,expires_at,capabilities,updated_at,auto_refresh,refresh_status,refresh_reason,health_checked_at';
const renameInput = z
  .object({
    displayName: z
      .string()
      .regex(/^[^\u0000-\u001f\u007f]+$/)
      .trim()
      .min(1)
      .max(120)
      .nullable(),
    expectedNameRevision: z.number().int().min(0).max(2147483646),
  })
  .strict();

function publicShop(row: any): ShopConnection {
  return {
    id: row.id,
    name: row.display_name ?? row.name,
    officialName: row.name,
    displayName: row.display_name,
    nameRevision: row.name_revision,
    region: row.region,
    state: row.refresh_status==='unknown' ? 'refresh_unknown' : row.refresh_status==='reauth_required' ? 'reauth_required' : row.state==='connected' && row.expires_at && new Date(row.expires_at).getTime()<=Date.now() ? 'token_expired' : row.state,
    autoRefresh:row.auto_refresh,refreshStatus:row.refresh_status,refreshReason:row.refresh_reason,healthCheckedAt:row.health_checked_at?.toISOString(),
    tokenExpiresAt: row.expires_at?.toISOString(),
    capabilities: row.capabilities,
    updatedAt: row.updated_at.toISOString(),
    scope: {
      environment: row.environment,
      partnerId: row.partner_id,
      shopId: row.shop_id,
      connectionRevision: row.revision,
      capabilityRevision: row.capability_revision,
    },
  };
}

/** Names here are local labels. The official Shopee name and connection revisions remain separate. */
export async function listShopConnections(pool: Pool): Promise<ShopConnection[]> {
  return (
    await pool.query(
      `SELECT ${publicColumns} FROM connections ORDER BY environment,COALESCE(display_name,name),id`,
    )
  ).rows.map(publicShop);
}

export async function setConnectionDisplayName(
  pool: Pool,
  connectionId: string,
  raw: unknown,
): Promise<ShopConnection> {
  const id = z.string().uuid().parse(connectionId);
  const input = renameInput.parse(raw);
  return transaction(pool, async (connection) => {
    const current = (
      await connection.query(`SELECT ${publicColumns} FROM connections WHERE id=$1 FOR UPDATE`, [
        id,
      ])
    ).rows[0];
    if (!current) throw new Error('CONNECTION_NAME_NOT_FOUND');
    // A lost 200 response can be replayed after name_revision has advanced. Exact current value
    // is already the requested result, so acknowledge it without touching either revision.
    if (current.display_name === input.displayName) return publicShop(current);
    if (current.name_revision !== input.expectedNameRevision)
      throw new Error('CONNECTION_NAME_REVISION_CONFLICT');
    const updated = await connection.query(
      `UPDATE connections SET display_name=$2,name_revision=name_revision+1 WHERE id=$1 AND name_revision=$3 RETURNING ${publicColumns}`,
      [id, input.displayName, input.expectedNameRevision],
    );
    return publicShop(updated.rows[0]);
  });
}
