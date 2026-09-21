import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  Repository,
  BlobStore,
  SandboxCreateTrialStore,
  transaction,
  lockSandboxMutationLane,
  sandboxMutationLaneBusy,
} from '@shopee/persistence';
import {
  SandboxCreateClient,
  SandboxProductClient,
  SecretBox,
  readShopInfo,
  productFingerprint,
  type ProductOutcome,
  type ShopCredentials,
} from '@shopee/gateway';
import {
  trialPreparationInput,
  syntheticTrial,
  syntheticTrialImages,
  type TrialPreparationInput,
} from './sandbox-trial-fixtures.js';
import { validateTrialMetadata, type TrialMetadata } from './sandbox-trial-preflight.js';

const scope = { environment: 'sandbox' as const, partnerId: '1232297', shopId: '227418363' };
const object = z.record(z.string(), z.unknown());
const id = z
  .union([z.number().int().positive().max(Number.MAX_SAFE_INTEGER), z.string().regex(/^[1-9]\d*$/)])
  .transform(String);
function requireSuccess<T>(result: ProductOutcome<T>): T {
  if (result.kind === 'success') return result.data;
  throw new Error(
    result.kind === 'rejected'
      ? 'SANDBOX_API_REJECTED:' + result.code
      : 'SANDBOX_TRIAL_READ_UNKNOWN',
  );
}
export class SandboxTrialService {
  readonly store: SandboxCreateTrialStore;
  constructor(
    readonly repo: Repository,
    readonly blobs: BlobStore,
    readonly options: {
      encryptionKey?: string;
      transport?: typeof fetch;
      pause?: () => Promise<void>;
    } = {},
  ) {
    this.store = new SandboxCreateTrialStore(repo.pool);
  }
  private pause() {
    return this.options.pause?.() ?? new Promise<void>((resolve) => setTimeout(resolve, 300));
  }
  private async context(input: Pick<TrialPreparationInput, 'connectionId' | 'connectionRevision'>) {
    const row = (
      await this.repo.pool.query('SELECT * FROM connections WHERE id=$1', [input.connectionId])
    ).rows[0];
    if (
      !row ||
      row.environment !== scope.environment ||
      row.partner_id !== scope.partnerId ||
      row.shop_id !== scope.shopId
    )
      throw new Error('SANDBOX_SCOPE_NOT_ALLOWED');
    if (row.revision !== input.connectionRevision)
      throw new Error('SANDBOX_CONNECTION_REVISION_CHANGED');
    if (row.state !== 'connected' || !row.token_ciphertext || !row.partner_key_ciphertext)
      throw new Error('SANDBOX_CONNECTION_REQUIRED');
    const box = new SecretBox(this.options.encryptionKey ?? process.env.APP_ENCRYPTION_KEY ?? '');
    let secrets: { partnerKey: string; accessToken: string };
    try {
      secrets = z.object({ partnerKey: z.string().min(1), accessToken: z.string().min(1) }).parse({
        ...object.parse(box.open(row.partner_key_ciphertext, 'sandbox:1232297:227418363')),
        ...object.parse(box.open(row.token_ciphertext, 'sandbox:1232297:227418363')),
      });
    } catch {
      throw new Error('SANDBOX_CONNECTION_REQUIRED');
    }
    const credentials: ShopCredentials = { ...scope, ...secrets };
    return {
      credentials,
      client: new SandboxCreateClient(credentials, this.options.transport),
      media: new SandboxProductClient(credentials, this.options.transport),
    };
  }
  async get(preparationId: string) {
    const row = (
      await this.repo.pool.query(
        'SELECT id,trial_key,connection_id,connection_revision,state,manifest,fingerprint,issues,uploads,metadata,trial_id,created_at,updated_at FROM sandbox_trial_preparations WHERE id=$1',
        [z.string().uuid().parse(preparationId)],
      )
    ).rows[0];
    if (!row) throw new Error('SANDBOX_TRIAL_PREPARATION_NOT_FOUND');
    return row;
  }
  async list() {
    return this.store.list();
  }
  async getTrial(trialId: string) {
    const trial = await this.store.get(z.string().uuid().parse(trialId));
    if (!trial) throw new Error('SANDBOX_TRIAL_NOT_FOUND');
    return trial;
  }
  private async discover(input: TrialPreparationInput) {
    const { client, credentials } = await this.context(input),
      receipts: { api: string; requestId?: string; observedAt: string }[] = [];
    const read = async <T>(api: string, call: () => Promise<ProductOutcome<T>>) => {
      await this.pause();
      const result = await call();
      const data = requireSuccess(result);
      receipts.push({ api, requestId: result.requestId, observedAt: new Date().toISOString() });
      return data;
    };
    // Auth failure ends preflight immediately; never proceeds to media or listing writes.
    const shop = await readShopInfo(credentials, this.options.transport);
    if (shop.kind !== 'success')
      throw new Error(
        shop.kind === 'rejected'
          ? 'SANDBOX_API_REJECTED:' + shop.code
          : 'SANDBOX_TRIAL_READ_UNKNOWN',
      );
    const categories = await read('get_category', () => client.categories());
    const category = z
      .array(object)
      .parse(categories.category_list)
      .find((c) => String(c.category_id) === '301378');
    if (!category) throw new Error('SANDBOX_TRIAL_CATEGORY_NOT_FOUND');
    const attributes = await read('get_attribute_tree', () => client.attributes('301378'));
    const brands = await read('get_brand_list', () => client.brands('301378'));
    const channels = await read('get_channel_list', () => client.channels());
    const limits = await read('get_item_limit', () => client.creationLimits('301378'));
    const existing: Record<string, unknown>[] = [],
      seen = new Set<string>();
    let offset = 0;
    let advertisedCount: number | undefined;
    for (let page = 0; page < 20; page++) {
      const list = await read('get_item_list', () =>
        client.listItemsPage({
          offset,
          statuses: ['NORMAL', 'BANNED', 'UNLIST', 'REVIEWING', 'SELLER_DELETE', 'SHOPEE_DELETE'],
        }),
      );
      if (
        typeof list.total_count !== 'number' ||
        !Number.isSafeInteger(list.total_count) ||
        list.total_count < 0 ||
        (advertisedCount !== undefined && advertisedCount !== list.total_count)
      )
        throw new Error('SANDBOX_TRIAL_ITEM_SCAN_INCOMPLETE');
      advertisedCount = list.total_count;
      const ids = z
        .array(z.object({ item_id: id }))
        .parse(list.item ?? list.item_list ?? [])
        .map((x) => x.item_id);
      for (const key of ids) {
        if (seen.has(key)) throw new Error('SANDBOX_TRIAL_ITEM_SCAN_DUPLICATE');
        seen.add(key);
      }
      for (let pos = 0; pos < ids.length; pos += 50)
        existing.push(
          ...(await read('get_item_base_info', () =>
            client.readBaseItems(ids.slice(pos, pos + 50)),
          )),
        );
      if (list.has_next_page === false && seen.size !== advertisedCount)
        throw new Error('SANDBOX_TRIAL_ITEM_SCAN_INCOMPLETE');
      if (list.has_next_page === false)
        return {
          metadata: { category, attributes, brands, channels, limits, existing } as TrialMetadata,
          receipts,
        };
      if (
        list.has_next_page !== true ||
        typeof list.next_offset !== 'number' ||
        list.next_offset <= offset
      )
        throw new Error('SANDBOX_TRIAL_ITEM_SCAN_INCOMPLETE');
      offset = list.next_offset;
    }
    throw new Error('SANDBOX_TRIAL_ITEM_SCAN_LIMIT');
  }
  async inspect(raw: unknown) {
    const input = trialPreparationInput.parse(raw);
    const evidence = await this.discover(input);
    const mock = syntheticTrial(input, ['synthetic-cover', 'synthetic-orange', 'synthetic-green']);
    return {
      ...evidence,
      issues: validateTrialMetadata(mock.items, evidence.metadata),
      scope,
      connectionRevision: input.connectionRevision,
    };
  }
  async prepare(raw: unknown) {
    const input = trialPreparationInput.parse(raw);
    await this.context(input);
    const preparationId = randomUUID();
    const added = await transaction(this.repo.pool, async (c) => {
      const ownerKey = 'sandbox:1232297:227418363';
      await lockSandboxMutationLane(c, ownerKey);
      // Replaying an existing preparation may read its receipt even while its
      // unresolved upload reserves the lane. It never uploads again.
      if (
        (
          await c.query('SELECT 1 FROM sandbox_trial_preparations WHERE trial_key=$1', [
            input.trialKey,
          ])
        ).rowCount
      )
        return { rowCount: 0 };
      if (await sandboxMutationLaneBusy(c, ownerKey)) throw new Error('SANDBOX_TRIAL_SHOP_BUSY');
      return c.query(
        `INSERT INTO sandbox_trial_preparations(id,trial_key,connection_id,connection_revision,input,state) VALUES($1,$2,$3,$4,$5,'preparing') ON CONFLICT(trial_key) DO NOTHING RETURNING id`,
        [preparationId, input.trialKey, input.connectionId, input.connectionRevision, input],
      );
    });
    if (!added.rowCount) {
      const old = (
        await this.repo.pool.query(
          'SELECT id,input FROM sandbox_trial_preparations WHERE trial_key=$1',
          [input.trialKey],
        )
      ).rows[0];
      if (productFingerprint(old.input) !== productFingerprint(input))
        throw new Error('SANDBOX_TRIAL_PREPARATION_CONFLICT');
      return this.get(old.id); // Never rerun an upload whose receipt may have been lost.
    }
    try {
      const evidence = await this.discover(input),
        preliminary = syntheticTrial(input, [
          'synthetic-cover',
          'synthetic-orange',
          'synthetic-green',
        ]);
      const issues = validateTrialMetadata(preliminary.items, evidence.metadata);
      const proof = {
        ...evidence,
        validatedAt: new Date().toISOString(),
        scope,
        source: {
          kind: 'synthetic_technical_fixture',
          version: 1,
          realProduct: false,
          stockDecision: '3 base; 3-6 per synthetic model, this sandbox trial only',
        },
        coverage: {
          categoryIds: [301378],
          imageRatio: '1:1',
          description: 'normal',
          status: 'UNLIST',
          tierCounts: [
            ...new Set(
              preliminary.items.map((x) =>
                x.tiers ? (x.tiers.standardise_tier_variation as unknown[]).length : 0,
              ),
            ),
          ],
        },
      };
      await this.repo.pool.query(
        'UPDATE sandbox_trial_preparations SET metadata=$2,issues=$3,state=$4,updated_at=now() WHERE id=$1',
        [preparationId, proof, JSON.stringify(issues), issues.length ? 'blocked' : 'preparing'],
      );
      if (issues.length) return this.get(preparationId);
      const { media } = await this.context(input),
        images = await syntheticTrialImages(input.trialKey),
        imageIds: string[] = [];
      const uploads: Record<string, unknown> = {};
      for (let index = 0; index < images.length; index++) {
        const bytes = images[index],
          sha256 = await this.blobs.put(bytes),
          startedAt = new Date().toISOString();
        uploads[index] = {
          state: 'intent',
          sha256,
          bytes: bytes.length,
          mime: 'image/png',
          width: 1000,
          height: 1000,
          startedAt,
        };
        await this.repo.pool.query(
          'UPDATE sandbox_trial_preparations SET uploads=$2,updated_at=now() WHERE id=$1',
          [preparationId, uploads],
        );
        await this.context(input);
        await this.pause();
        const result = await media.upload(bytes, 'image/png', 'normal', '1:1');
        uploads[index] = {
          ...(uploads[index] as object),
          state: result.kind,
          result,
          finishedAt: new Date().toISOString(),
        };
        await this.repo.pool.query(
          'UPDATE sandbox_trial_preparations SET uploads=$2,updated_at=now() WHERE id=$1',
          [preparationId, uploads],
        );
        if (result.kind !== 'success') {
          await this.repo.pool.query(
            'UPDATE sandbox_trial_preparations SET state=$2,issues=$3,updated_at=now() WHERE id=$1',
            [
              preparationId,
              result.kind === 'unknown' ? 'unknown' : 'blocked',
              JSON.stringify([result.kind === 'rejected' ? result.code : 'MEDIA_RECEIPT_UNKNOWN']),
            ],
          );
          return this.get(preparationId);
        }
        imageIds.push(result.data.imageId);
      }
      const manifest = syntheticTrial(input, imageIds),
        fingerprint = productFingerprint(manifest);
      await this.repo.pool.query(
        "UPDATE sandbox_trial_preparations SET state='prepared',manifest=$2,fingerprint=$3,updated_at=now() WHERE id=$1",
        [preparationId, manifest, fingerprint],
      );
      return this.get(preparationId);
    } catch (error) {
      const safe =
        error instanceof Error && /^SANDBOX_[A-Za-z0-9_:.-]+$/.test(error.message)
          ? error.message
          : 'SANDBOX_TRIAL_PREPARATION_FAILED';
      await this.repo.pool.query(
        "UPDATE sandbox_trial_preparations SET state=CASE WHEN EXISTS(SELECT 1 FROM jsonb_each(uploads) u WHERE u.value->>'state'='intent') THEN 'unknown' ELSE 'blocked' END,issues=$2,updated_at=now() WHERE id=$1",
        [preparationId, JSON.stringify([safe])],
      );
      throw new Error(safe);
    }
  }
  async submit(preparationId: string, raw: unknown) {
    const input = z
      .object({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .parse(raw);
    const prepared = await this.get(preparationId);
    if (prepared.state !== 'prepared' || !prepared.manifest || prepared.issues.length)
      throw new Error('SANDBOX_TRIAL_NOT_PREPARED');
    if (
      prepared.fingerprint !== input.fingerprint ||
      productFingerprint(prepared.manifest) !== input.fingerprint
    )
      throw new Error('SANDBOX_TRIAL_FINGERPRINT_MISMATCH');
    if (prepared.trial_id) return this.getTrial(prepared.trial_id);
    await this.context({
      connectionId: prepared.connection_id,
      connectionRevision: prepared.connection_revision,
    });
    const validatedAt = Date.parse(prepared.metadata.validatedAt);
    if (
      !Number.isFinite(validatedAt) ||
      Date.now() - validatedAt > 15 * 60 * 1000 ||
      validatedAt > Date.now()
    )
      throw new Error('SANDBOX_TRIAL_PREFLIGHT_EXPIRED');
    if (prepared.manifest.items.length > 1) {
      const previous = await this.store.list();
      if (
        !previous.some(
          (t) =>
            t.connectionId === prepared.connection_id &&
            t.connectionRevision === prepared.connection_revision &&
            t.state === 'verified' &&
            t.items.length === 1,
        )
      )
        throw new Error('SANDBOX_TRIAL_SINGLE_ITEM_REQUIRED');
    }
    // Store provides atomic source uniqueness and submission idempotency even if this HTTP receipt is lost.
    const trial = await this.store.submit(prepared.manifest, prepared.metadata);
    await this.repo.pool.query(
      'UPDATE sandbox_trial_preparations SET trial_id=$2,updated_at=now() WHERE id=$1',
      [preparationId, trial.id],
    );
    return trial;
  }
}
