import 'dotenv/config';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool, Repository } from '../packages/persistence/src/index.js';
import {
  SecretBox,
  SandboxPreparedTransport,
  variationBaselineFingerprint,
  type FieldSnapshot,
  type VariationMutationIntent,
  type VariationMutationContext,
} from '../packages/shopee/src/index.js';
import { VariationExecutionService } from '../apps/api/src/variation-execution.js';
const arg = process.argv.find((v) => v.startsWith('--case='))?.slice(7),
  execute = process.argv.includes('--execute');
const targets: Record<string, string> = {
  'rename-one': '803934786',
  'reorder-one': '803934786',
  'rename-two': '803934787',
  'add-one': '803934786',
  'remove-combination': '803934787',
};
if (!arg || !targets[arg]) throw new Error('EXPLICIT_SANDBOX_CASE_REQUIRED');
const itemId = targets[arg],
  folder = join('.local/acceptance-20260914/variation-qc/live', arg);
const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  await mkdir(folder, { recursive: true });
  if (await exists(join(folder, 'result.json'))) throw new Error('CASE_RECORDED_DO_NOT_REPLAY');
  const bound = (
    await pool.query(
      "SELECT * FROM sandbox_create_trial_items WHERE item_id=$1 AND state='verified' AND stage='done'",
      [itemId],
    )
  ).rows[0];
  if (!bound?.source_key.startsWith('SBX-BULK-')) throw new Error('TECHNICAL_SOURCE_REQUIRED');
  const connection = (
    await pool.query('SELECT * FROM connections WHERE id=$1', [bound.connection_id])
  ).rows[0];
  if (
    connection?.environment !== 'sandbox' ||
    connection.partner_id !== '1232297' ||
    connection.shop_id !== '227418363' ||
    connection.state !== 'connected'
  )
    throw new Error('TEST_SCOPE_REQUIRED');
  const scope = {
    environment: 'sandbox' as const,
    partnerId: connection.partner_id,
    shopId: connection.shop_id,
    connectionRevision: connection.revision,
    capabilityRevision: connection.capability_revision,
  };
  const box = new SecretBox(process.env.APP_ENCRYPTION_KEY ?? ''),
    owner = 'sandbox:1232297:227418363';
  const secrets = {
    ...(box.open(connection.partner_key_ciphertext, owner) as any),
    ...(box.open(connection.token_ciphertext, owner) as any),
  };
  const allowed = [{ partnerId: '1232297', shopId: '227418363' }];
  const client = new SandboxPreparedTransport(
    {
      environment: 'sandbox',
      partnerId: scope.partnerId,
      shopId: scope.shopId,
      partnerKey: secrets.partnerKey,
      accessToken: secrets.accessToken,
    },
    allowed,
  );
  let input: any;
  if (await exists(join(folder, 'intent.json')))
    input = JSON.parse(await readFile(join(folder, 'intent.json'), 'utf8'));
  else {
    const base = await client.read('/api/v2/product/get_item_base_info', {
      item_id_list: itemId,
      need_tax_info: 'true',
      need_complaint_policy: 'true',
    });
    if (base.kind !== 'success') throw new Error('TEST_BASE_READ_FAILED');
    const items = base.response.item_list as any[];
    if (
      items?.length !== 1 ||
      String(items[0].item_id) !== itemId ||
      items[0].item_status !== 'UNLIST' ||
      items[0].item_sku !== bound.source_key ||
      !items[0].item_name.startsWith('SANDBOX QA ')
    )
      throw new Error('TECHNICAL_TARGET_CHANGED');
    const models = await client.read('/api/v2/product/get_model_list', { item_id: itemId });
    const promotion = await client.read('/api/v2/product/get_item_promotion', {
      item_id_list: itemId,
    });
    const limits = await client.read('/api/v2/product/get_item_limit', {
      category_id: String(items[0].category_id),
    });
    if (models.kind !== 'success' || limits.kind !== 'success')
      throw new Error('TEST_METADATA_UNAVAILABLE');
    const baseline = { item: items[0], models: models.response } as FieldSnapshot;
    const tiers = (models.response.tier_variation as any[]).map((t) => ({
      name: t.name,
      options: t.option_list.map((o: any, previousIndex: number) => ({
        name: o.option,
        previousIndex,
        ...(o.image?.image_id ? { imageId: o.image.image_id } : {}),
      })),
    }));
    const intent: VariationMutationIntent = {
      version: 1,
      itemId,
      baselineFingerprint: variationBaselineFingerprint(baseline),
      source: {
        key: 'SBX-STRUCTURE-20260914-' + arg,
        digest: '0'.repeat(64),
        refs: [folder + '/source.json'],
      },
      tiers,
      retained: baseline.models.model.map((m) => ({
        modelId: String(m.model_id),
        tierIndex: m.tier_index as number[],
      })),
      removedModelIds: [],
      added: [],
    };
    if (arg.startsWith('rename')) {
      intent.tiers[0]!.name = 'Mau bia QA';
      intent.tiers[0]!.options[0]!.name = 'Cam QA';
    }
    if (arg === 'reorder-one') {
      intent.tiers[0]!.options.reverse();
      intent.retained.forEach((m) => {
        m.tierIndex = [1 - m.tierIndex[0]!];
      });
    }
    if (arg === 'add-one') {
      const pos = intent.tiers[0]!.options.length;
      intent.tiers[0]!.options.push({
        name: 'Xanh QA them',
        previousIndex: null,
        imageId: (intent.tiers[0]!.options[0] as any).imageId,
      });
      intent.added = [
        {
          sku: 'SBX-STRUCTURE-20260914-NEW',
          tierIndex: [pos],
          originalPrice: 22000,
          stock: 2,
          locationId: 'VNZ',
        },
      ];
    }
    if (arg === 'remove-combination') {
      intent.removedModelIds = [intent.retained.pop()!.modelId];
    }
    const source = {
      kind: 'synthetic-sandbox-variation-intent',
      authorized: 'User requested diverse mock test data; technical sandbox only',
      tiers: intent.tiers,
      retained: intent.retained,
      removedModelIds: intent.removedModelIds,
      added: intent.added,
    };
    intent.source.digest = createHash('sha256').update(JSON.stringify(source)).digest('hex');
    const context: VariationMutationContext = {
      baseline,
      scope: { environment: 'sandbox', partnerId: scope.partnerId, shopId: scope.shopId },
      promotionSnapshot: promotion.envelope,
      allowedLocationIds: ['VNZ'],
      resolvedImageIds: tiers.flatMap((t) =>
        t.options.flatMap((o: any) => (o.imageId ? [o.imageId] : [])),
      ),
      maxVariationPriceRatio: {
        value: 5,
        source:
          'knowledge-base/shopee-open-platform/documents/guide/en/223.md; VN table updated2024-03-18; snapshot2026-09-08',
      },
      itemLimits: limits.response,
    };
    input = { id: randomUUID(), connectionId: connection.id, scope, intent, context };
    await writeFile(join(folder, 'source.json'), JSON.stringify(source, null, 2), { flag: 'wx' });
    await writeFile(join(folder, 'intent.json'), JSON.stringify(input, null, 2), { flag: 'wx' });
    await writeFile(
      join(folder, 'read-evidence.json'),
      JSON.stringify({ base, models, promotion, limits }, null, 2),
      { flag: 'wx' },
    );
  }
  const service = new VariationExecutionService(new Repository(pool), { allowedShops: allowed });
  const prepared = await service.prepare(input);
  console.log(
    JSON.stringify({
      case: arg,
      id: prepared.id,
      state: prepared.state,
      plan:
        prepared.plan.kind === 'ready'
          ? prepared.plan.steps.map((s: { path: string; payload: unknown }) => ({
              path: s.path,
              payload: s.payload,
            }))
          : prepared.plan,
    }),
  );
  if (execute) {
    const result = await service.run(prepared.id);
    await writeFile(join(folder, 'result.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
    console.log(
      JSON.stringify({
        case: arg,
        state: result.state,
        result: result.result,
        steps: result.steps.map((s) => ({
          ordinal: s.ordinal,
          state: s.state,
          requestId: s.receipt?.requestId,
          qc: s.qc?.state,
        })),
      }),
    );
  }
} finally {
  await pool.end();
}
