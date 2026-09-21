import 'dotenv/config';
import { randomUUID, createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Pool, Repository, migrate } from '../../packages/persistence/src/index.js';
import type {
  PreparedDocument,
  PreparedEntry,
  PreparedGateway,
  PreparedMetadata,
  PreparedRemote,
  Scope,
} from '../../packages/domain/src/index.js';
import {
  PreparedExecutionService,
  preparedExecutionFingerprint,
  validatePreparedEntry,
} from '../../apps/api/src/prepared-execution.js';

const schema = 'test_prepared_' + randomUUID().replaceAll('-', '');
const admin = new Pool({ connectionString: process.env.DATABASE_URL });
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: `-c search_path=${schema}`,
});
const repo = new Repository(pool);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
let serial = 0;
let gateway: StatefulGateway;
let service: PreparedExecutionService;

class StatefulGateway implements PreparedGateway {
  readonly mode = 'simulation' as const;
  items = new Map<string, PreparedRemote>();
  writes: { kind: string; owner: string; itemId: string }[] = [];
  metadataRows = new Map<string, PreparedMetadata>();
  loseCreate = false;
  partialUpdate = false;
  badRead = false;
  tamperUpdate = false;
  beforeCreate?: () => Promise<void>;
  nextId = 1000;
  key(scope: Scope, itemId: string) {
    return `${scope.partnerId}:${scope.shopId}:${itemId}`;
  }
  ok<T>(data: T) {
    return { kind: 'success' as const, data: structuredClone(data), requestId: randomUUID() };
  }
  async metadata(scope: Scope, category: string) {
    const data = this.metadataRows.get(`${scope.shopId}:${category}`);
    return data ? this.ok(data) : { kind: 'rejected' as const, code: 'WRONG_SHOP_CATEGORY' };
  }
  async find(scope: Scope, sourceKey: string) {
    return this.ok(
      [...this.items.entries()]
        .filter(
          ([key, row]) =>
            key.startsWith(`${scope.partnerId}:${scope.shopId}:`) &&
            row.document.sourceKey === sourceKey,
        )
        .map(([, row]) => row),
    );
  }
  async read(scope: Scope, itemId: string) {
    const found = this.items.get(this.key(scope, itemId));
    if (!found) return { kind: 'rejected' as const, code: 'WRONG_SHOP_ITEM' };
    const copy = structuredClone(found);
    copy.document.models.reverse();
    copy.modelBindings.reverse();
    if (this.badRead) copy.extra.protected = 'changed';
    return this.ok(copy);
  }
  async create(scope: Scope, document: PreparedDocument) {
    await this.beforeCreate?.();
    if (!(await this.metadata(scope, document.categoryId)).kind.includes('success'))
      return { kind: 'rejected' as const, code: 'WRONG_SHOP_CATEGORY' };
    const itemId = String(++this.nextId);
    this.items.set(this.key(scope, itemId), {
      itemId,
      document: structuredClone(document),
      modelBindings: document.models.map((m, index) => ({
        sku: m.sku,
        modelId: `${itemId}${index}`,
        tierIndex: [...m.tierIndex],
      })),
      extra: { protected: 'must stay', nested: { array: [] }, currency: 'VND' },
    });
    this.writes.push({ kind: 'create', owner: scope.shopId, itemId });
    if (this.loseCreate) return { kind: 'unknown' as const, code: 'LOST_AFTER_COMMIT' };
    return this.ok({ itemId });
  }
  async update(
    scope: Scope,
    itemId: string,
    expected: PreparedRemote,
    fields: any[],
    selected: string[],
  ) {
    const row = this.items.get(this.key(scope, itemId));
    if (!row) return { kind: 'rejected' as const, code: 'WRONG_SHOP_ITEM' };
    this.writes.push({ kind: 'update', owner: scope.shopId, itemId });
    for (const field of fields) {
      if (['price', 'stock', 'variationImages'].includes(field)) {
        const chosen = this.partialUpdate ? selected.slice(0, 1) : selected;
        for (const sku of chosen) {
          const model = row.document.models.find((m) => m.sku === sku)!;
          const desired = expected.document.models.find((m) => m.sku === sku)!;
          if (field === 'price') model.originalPrice = desired.originalPrice;
          if (field === 'stock') model.stock = desired.stock;
          if (field === 'variationImages') model.image = structuredClone(desired.image);
        }
      } else (row.document as any)[field] = structuredClone((expected.document as any)[field]);
    }
    if (this.tamperUpdate) (row.extra.nested as any).array = {};
    return this.partialUpdate
      ? { kind: 'rejected' as const, code: 'PARTIAL_MODELS' }
      : this.ok(null);
  }
}

beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
});
afterAll(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});
beforeEach(async () => {
  await pool.query(
    'TRUNCATE prepared_execution_bindings, prepared_execution_jobs, prepared_execution_batches CASCADE',
  );
  gateway = new StatefulGateway();
  service = new PreparedExecutionService(repo, gateway);
});
async function entry(
  sourceKey = `SOURCE-${++serial}`,
  shopId = `900${++serial}`,
): Promise<PreparedEntry> {
  const connectionId = randomUUID();
  await pool.query(
    "INSERT INTO connections(id,environment,partner_id,shop_id,name,state,revision,capability_revision) VALUES($1,'sandbox','999',$2,'Simulated shop','connected',1,1)",
    [connectionId, shopId],
  );
  const media = {
    importId: randomUUID(),
    sha256: hash(sourceKey),
    width: 900,
    height: 1200,
    mime: 'image/png',
  };
  const document: PreparedDocument = {
    sourceKey,
    title: `Prepared ${sourceKey}`,
    description: [
      { type: 'text', text: 'Exact\n\nẮ & < >' },
      { type: 'image', image: media },
    ],
    cover: { ...media, width: 1200, height: 1200 },
    gallery: [media],
    tierNames: ['Màu'],
    models: ['A', 'B'].map((sku, index) => ({
      sku: `${sourceKey}-${sku}`,
      optionLabels: [sku],
      tierIndex: [index],
      originalPrice: String(20000 + index * 1000),
      stock: 5 + index,
      image: media,
    })),
    categoryId: '700',
    brandId: '9',
    attributes: { material: ['cotton'] },
    logistics: [{ channelId: '55', enabled: true }],
    weightGrams: 100,
    dimensionCm: { length: 10, width: 8, height: 4 },
    publication: 'unlisted',
  };
  gateway.metadataRows.set(`${shopId}:700`, {
    categoryId: '700',
    supported: true,
    requiredAttributes: ['material'],
    allowedAttributeValues: { material: ['cotton', 'paper'] },
    brandIds: ['9'],
    channelIds: ['55'],
    maxGallery: 8,
    maxModels: 50,
    minPrice: 100,
    maxPrice: 1000000,
    maxStock: 999,
  });
  return {
    folderKey: sourceKey,
    connectionId,
    scope: {
      environment: 'sandbox',
      partnerId: '999',
      shopId,
      connectionRevision: 1,
      capabilityRevision: 1,
    },
    sourceFingerprint: hash(document),
    sourceRefs: [
      {
        kind: 'product_file',
        fileSha256: hash(sourceKey),
        locator: 'Prices!B4',
        filename: 'price.xlsx',
        observedAt: '2026-09-14T00:00:00Z',
      },
    ],
    document,
  };
}
const fields = [
  'title',
  'description',
  'cover',
  'gallery',
  'variationImages',
  'price',
  'stock',
  'attributes',
  'logistics',
] as const;
async function prepare(
  entries: PreparedEntry[],
  operation: 'create' | 'update' = 'create',
  fieldMask: any[] = [...fields],
  selectedSkus?: string[],
) {
  const input = {
    batchId: randomUUID(),
    inputSourceDigest: hash(entries.map((e) => e.sourceFingerprint)),
    entries,
    operation,
    fieldMask,
    ...(selectedSkus === undefined ? {} : { selectedSkus }),
  };
  return service.prepare({ ...input, fingerprint: preparedExecutionFingerprint(input) });
}
async function createOne(e: PreparedEntry) {
  const batch = await prepare([e]);
  await service.submit(batch.id, batch.fingerprint);
  expect(await service.runOnce()).toBe(true);
  const result = await service.get(batch.id);
  expect(result.jobs[0]!.state).toBe('verified');
  return result.jobs[0]!;
}

it('validates one source envelope without accepting unsafe numbers or mutating its input', async () => {
  const source = await entry();
  const checked = validatePreparedEntry(source);
  expect(checked).toEqual(source);
  expect(checked).not.toBe(source);
  checked.document.title = 'Separate parsed value';
  expect(source.document.title).not.toBe(checked.document.title);
  for (const change of [
    (value: PreparedEntry) => {
      value.document.models[0]!.originalPrice = '9007199254740992';
    },
    (value: PreparedEntry) => {
      value.document.dimensionCm.width = 1.5;
    },
    (value: PreparedEntry) => {
      value.document.gallery[0]!.width = Number.MAX_SAFE_INTEGER + 1;
    },
    (value: PreparedEntry) => {
      value.document.cover.mime = 'image/svg+xml';
    },
  ]) {
    const invalid = structuredClone(source);
    change(invalid);
    expect(() => validatePreparedEntry(invalid)).toThrow();
  }
  expect(() => validatePreparedEntry(null)).toThrow();
  expect(source.sourceRefs[0]!.locator).toBe('Prices!B4');
  expect(gateway.writes).toHaveLength(0);
});

it('uses immutable entries, distinct shop state, persistent queue, binding and idempotent submit', async () => {
  const entries = [await entry('SAME-SOURCE'), await entry('SAME-SOURCE')];
  const batch = await prepare(entries);
  expect(batch.jobs.every((job) => job.state === 'prepared')).toBe(true);
  expect(gateway.writes).toHaveLength(0);
  await service.submit(batch.id, batch.fingerprint);
  await service.submit(batch.id, batch.fingerprint);
  while (await service.runOnce()) {
    /* drain the actual coordinator */
  }
  const done = await service.get(batch.id);
  expect(done.state).toBe('verified');
  expect(done.counts.verified).toBe(2);
  expect(done.jobs[0]!.entry.sourceRefs).toEqual(entries[0]!.sourceRefs);
  expect(gateway.writes).toHaveLength(2);
  await service.submit(batch.id, batch.fingerprint);
  expect(await service.runOnce()).toBe(false);
  expect((await service.list()).map((b) => b.id)).toContain(batch.id);
  await expect(
    pool.query("UPDATE prepared_execution_jobs SET entry='{}' WHERE id=$1", [done.jobs[0]!.id]),
  ).rejects.toThrow();
});

it('preserves each sourced model weight and dimensions through validation, storage and simulated create', async () => {
  const source = await entry('MODEL-SHIPPING-SOURCE');
  source.document.models[0]!.weightGrams = 322.3;
  source.document.models[0]!.dimensionCm = { length: 12, width: 12, height: 28 };
  source.document.models[1]!.weightGrams = 130.9;
  source.sourceFingerprint = hash(source.document);
  const original = structuredClone(source);
  const checked = validatePreparedEntry(source);
  expect(checked).toEqual(original);
  checked.document.models[0]!.dimensionCm!.length = 99;
  expect(source).toEqual(original);
  const result = await createOne(source);
  expect(result.entry.document.models).toEqual(original.document.models);
  const created = [...gateway.items.values()][0]!;
  expect(created.document.models).toEqual(original.document.models);
  expect(created.document.models[1]).not.toHaveProperty('dimensionCm');
});

it('rejects model shipping with missing weight, malformed dimensions or untiered placement', async () => {
  const source = await entry('MODEL-SHIPPING-INVALID');
  for (const change of [
    (value: PreparedEntry) => {
      value.document.models[0]!.dimensionCm = { length: 12, width: 12, height: 28 };
    },
    (value: PreparedEntry) => {
      value.document.models[0]!.weightGrams = Number.NaN;
    },
    (value: PreparedEntry) => {
      Object.assign(value.document.models[0], {
        weightGrams: 322.3,
        dimensionCm: { length: 12, width: 12 },
      });
    },
    (value: PreparedEntry) => {
      value.document.tierNames = [];
      value.document.models = [
        {
          ...value.document.models[0]!,
          image: undefined,
          tierIndex: [],
          optionLabels: [],
          weightGrams: 322.3,
        },
      ];
    },
  ]) {
    const invalid = structuredClone(source);
    change(invalid);
    expect(() => validatePreparedEntry(invalid)).toThrow();
  }
  expect(gateway.writes).toHaveLength(0);
});

it('runs an enqueue guard inside the transaction and rolls back queueing when the guard fails', async () => {
  const batch = await prepare([await entry()]);
  const guard = vi.fn(async (client: Pick<Pool, 'query'>) => {
    await client.query('UPDATE prepared_execution_batches SET submitted_at=now() WHERE id=$1', [
      batch.id,
    ]);
    throw new Error('PREPARED_INPUT_REVISION_CHANGED');
  });
  await expect(service.submit(batch.id, batch.fingerprint, guard)).rejects.toThrow(
    'PREPARED_INPUT_REVISION_CHANGED',
  );
  const stopped = await service.get(batch.id);
  expect(stopped.jobs[0]!.state).toBe('prepared');
  expect(stopped.submittedAt).toBeNull();
  expect(await service.runOnce()).toBe(false);
  expect(guard).toHaveBeenCalledOnce();
  const accepted = vi.fn(async (client: Pick<Pool, 'query'>) => {
    const connection = await client.query('SELECT id FROM connections WHERE id=$1 FOR SHARE', [
      batch.jobs[0]!.entry.connectionId,
    ]);
    expect(connection.rowCount).toBe(1);
  });
  await service.submit(batch.id, batch.fingerprint, accepted);
  expect((await service.get(batch.id)).state).toBe('queued');
  await service.submit(batch.id, batch.fingerprint, guard);
  expect(accepted).toHaveBeenCalledOnce();
  expect(guard).toHaveBeenCalledOnce();
  expect(gateway.writes).toHaveLength(0);
});

it('uses the supplied batch ID and returns the same prepare receipt after a lost response', async () => {
  const e = await entry();
  const input = {
    batchId: randomUUID(),
    inputSourceDigest: hash(e),
    entries: [e],
    operation: 'create' as const,
    fieldMask: [],
  };
  const request = { ...input, fingerprint: preparedExecutionFingerprint(input) };
  const first = await service.prepare(request),
    replay = await service.prepare(request);
  expect(first.id).toBe(input.batchId);
  expect(replay).toEqual(first);
  const changed = { ...input, inputSourceDigest: hash('different input') };
  await expect(
    service.prepare({ ...changed, fingerprint: preparedExecutionFingerprint(changed) }),
  ).rejects.toThrow('PREPARED_INTENT_CONFLICT');
});

it('retains unknown create after lost acknowledgement, blocks a new UUID and reconciles only by reads', async () => {
  const e = await entry();
  gateway.loseCreate = true;
  const batch = await prepare([e]);
  await service.submit(batch.id, batch.fingerprint);
  await service.runOnce();
  const job = (await service.get(batch.id)).jobs[0]!;
  expect(job.state).toBe('unknown');
  expect(await service.runOnce()).toBe(false);
  const repeated = await prepare([e]);
  expect(repeated.jobs[0]!.state).toBe('blocked');
  expect(gateway.writes).toHaveLength(1);
  expect((await service.reconcile(job.id)).state).toBe('verified');
  expect((await service.reconcile(job.id)).state).toBe('verified');
  expect(gateway.writes).toHaveLength(1);
});

it.each(['price', 'stock', 'variationImages'] as const)(
  'updates selected %s while retaining other models, extra and bindings',
  async (field) => {
    const e = await entry();
    const original = await createOne(e);
    const before = structuredClone(gateway.items.get(gateway.key(e.scope, original.itemId!))!);
    const revised = structuredClone(e);
    revised.sourceFingerprint = hash('revision-' + field);
    revised.document.models[0]!.originalPrice = '33000';
    revised.document.models[0]!.stock = 0;
    revised.document.models[0]!.image = { ...revised.document.cover, sha256: hash('new-image') };
    revised.document.models[1]!.originalPrice = '88000';
    revised.document.models[1]!.stock = 900;
    revised.document.title = 'Do not change';
    const batch = await prepare([revised], 'update', [field], [e.document.models[0]!.sku]);
    await service.submit(batch.id, batch.fingerprint);
    await service.runOnce();
    const done = (await service.get(batch.id)).jobs[0]!;
    expect(done.state).toBe('verified');
    const after = gateway.items.get(gateway.key(e.scope, original.itemId!))!;
    expect(after.document.models[1]).toEqual(before.document.models[1]);
    expect(after.extra).toEqual(before.extra);
    expect(after.modelBindings).toEqual(before.modelBindings);
    expect(after.document.title).toBe(before.document.title);
    expect(
      after.document.models[0]![
        field === 'price' ? 'originalPrice' : field === 'stock' ? 'stock' : 'image'
      ],
    ).toEqual(
      revised.document.models[0]![
        field === 'price' ? 'originalPrice' : field === 'stock' ? 'stock' : 'image'
      ],
    );
  },
);

it('does not call partial model updates verified and never replays them', async () => {
  const e = await entry();
  await createOne(e);
  gateway.partialUpdate = true;
  const revised = structuredClone(e);
  revised.sourceFingerprint = hash('partial');
  revised.document.models.forEach((m) => (m.originalPrice = '44000'));
  const batch = await prepare([revised], 'update', ['price']);
  await service.submit(batch.id, batch.fingerprint);
  await service.runOnce();
  const job = (await service.get(batch.id)).jobs[0]!;
  expect(job.state).toBe('unknown');
  expect(job.result?.mismatchedPaths.length).toBeGreaterThan(0);
  expect((await service.reconcile(job.id)).state).toBe('unknown');
  expect(await service.runOnce()).toBe(false);
  expect(gateway.writes).toHaveLength(2);
});

it('blocks prewrite drift and a changed connection revision', async () => {
  const e = await entry();
  const created = await createOne(e);
  const revised = structuredClone(e);
  revised.sourceFingerprint = hash('drift');
  revised.document.title = 'New exact title';
  const batch = await prepare([revised], 'update', ['title']);
  gateway.items.get(gateway.key(e.scope, created.itemId!))!.extra.protected = 'external drift';
  await service.submit(batch.id, batch.fingerprint);
  await service.runOnce();
  expect((await service.get(batch.id)).jobs[0]!.state).toBe('blocked');
  expect(gateway.writes).toHaveLength(1);
  const other = await entry();
  const pending = await prepare([other]);
  await service.submit(pending.id, pending.fingerprint);
  await pool.query('UPDATE connections SET revision=2 WHERE id=$1', [other.connectionId]);
  await service.runOnce();
  expect((await service.get(pending.id)).jobs[0]!.state).toBe('blocked');
  expect(gateway.writes).toHaveLength(1);
});

it('preflights category, required attributes, brand, channels, prices and stock before any mutation', async () => {
  const entries = await Promise.all(Array.from({ length: 6 }, () => entry()));
  entries[0]!.document.categoryId = 'invalid';
  entries[1]!.document.attributes = {};
  entries[2]!.document.brandId = 'unknown';
  entries[3]!.document.logistics[0]!.channelId = 'unknown';
  entries[4]!.document.models[0]!.originalPrice = '1';
  entries[5]!.document.models[0]!.stock = 1000;
  const batch = await prepare(entries);
  expect(batch.jobs.every((job) => job.state === 'blocked')).toBe(true);
  await service.submit(batch.id, batch.fingerprint);
  expect(await service.runOnce()).toBe(false);
  expect(gateway.writes).toHaveLength(0);
});

it('supports queued pause/cancel and refuses resume after unknown mutation', async () => {
  const batch = await prepare([await entry()]);
  await service.submit(batch.id, batch.fingerprint);
  const id = batch.jobs[0]!.id;
  await service.control(id, 'pause');
  expect(await service.runOnce()).toBe(false);
  await service.control(id, 'resume');
  await service.control(id, 'cancel');
  expect(await service.runOnce()).toBe(false);
  expect((await service.get(batch.id)).jobs[0]!.state).toBe('cancelled');
  gateway.loseCreate = true;
  const second = await prepare([await entry()]);
  await service.submit(second.id, second.fingerprint);
  await service.runOnce();
  await expect(service.control(second.jobs[0]!.id, 'resume')).rejects.toThrow(
    'PREPARED_RECONCILIATION_REQUIRED',
  );
});

it('an unresolved owner does not stop another shop, including with two worker invocations', async () => {
  const first = await entry();
  const second = await entry();
  gateway.loseCreate = true;
  const a = await prepare([first]);
  await service.submit(a.id, a.fingerprint);
  await service.runOnce();
  gateway.loseCreate = false;
  const b = await prepare([second]);
  await service.submit(b.id, b.fingerprint);
  await Promise.all([service.runOnce(), service.runOnce()]);
  expect((await service.get(a.id)).state).toBe('unknown');
  expect((await service.get(b.id)).state).toBe('verified');
  expect(gateway.writes).toHaveLength(2);
});

it('bounds a never-settling create and continues another shop without replaying the unresolved owner', async () => {
  service = new PreparedExecutionService(repo, gateway, { requestTimeoutMs: 20 });
  const first = await entry();
  const sameOwner = structuredClone(first);
  sameOwner.folderKey += '-NEXT';
  sameOwner.document.sourceKey += '-NEXT';
  sameOwner.sourceFingerprint = hash('pending owner next source');
  const second = await entry();
  const original = gateway.create.bind(gateway);
  const attempted: string[] = [];
  gateway.create = async (scope, document) => {
    attempted.push(scope.shopId);
    return scope.shopId === first.scope.shopId ? new Promise(() => {}) : original(scope, document);
  };
  const batch = await prepare([first, sameOwner, second]);
  await service.submit(batch.id, batch.fingerprint);
  expect(await service.runOnce()).toBe(true);
  const progressing = await service.get(batch.id);
  expect(progressing.state).toBe('queued');
  expect(progressing.hasActiveWork).toBe(true);
  expect(progressing.counts.unknown).toBe(1);
  expect(await service.runOnce()).toBe(true);
  expect(await service.runOnce()).toBe(false);
  const result = await service.get(batch.id);
  expect(result.jobs.map((job) => job.state)).toEqual(['unknown', 'queued', 'verified']);
  expect(result.state).toBe('unknown');
  expect(result.hasActiveWork).toBe(false);
  expect(result.jobs[0]!.receipt).toEqual({ kind: 'unknown', code: 'PREPARED_GATEWAY_TIMEOUT' });
  await expect(service.reconcile(result.jobs[0]!.id)).rejects.toThrow('PREPARED_STILL_RUNNING');
  expect(attempted).toEqual([first.scope.shopId, second.scope.shopId]);
  expect(gateway.writes).toHaveLength(1);
}, 1500);

it('exposes active dispatch as running while the durable write intent is unknown, then ends polling on timeout', async () => {
  service = new PreparedExecutionService(repo, gateway, { requestTimeoutMs: 300 });
  let started!: () => void;
  const dispatched = new Promise<void>((resolve) => {
    started = resolve;
  });
  gateway.create = async () => {
    started();
    return new Promise(() => {});
  };
  const batch = await prepare([await entry()]);
  await service.submit(batch.id, batch.fingerprint);
  const running = service.runOnce();
  await dispatched;
  try {
    const active = await service.get(batch.id);
    expect(active.state).toBe('running');
    expect(active.hasActiveWork).toBe(true);
    expect(active.counts.running).toBe(1);
    expect(active.counts.unknown).toBe(0);
    expect(active.jobs[0]).toMatchObject({
      state: 'running',
      durableState: 'unknown',
      inFlight: true,
      mutationSent: true,
    });
    const durable = (
      await pool.query('SELECT state FROM prepared_execution_jobs WHERE id=$1', [
        active.jobs[0]!.id,
      ])
    ).rows[0];
    expect(durable.state).toBe('unknown');
  } finally {
    await running;
  }
  const timedOut = await service.get(batch.id);
  expect(timedOut.state).toBe('unknown');
  expect(timedOut.hasActiveWork).toBe(false);
  expect(timedOut.jobs[0]).toMatchObject({
    state: 'unknown',
    durableState: 'unknown',
    inFlight: false,
  });
});

it('does not advertise queued work as active when another batch holds that owner in settled unknown', async () => {
  const first = await entry();
  const second = structuredClone(first);
  second.folderKey += '-NEXT';
  second.document.sourceKey += '-NEXT';
  second.sourceFingerprint = hash('another batch same blocked owner');
  const one = await prepare([first]);
  const two = await prepare([second]);
  gateway.loseCreate = true;
  await service.submit(one.id, one.fingerprint);
  await service.runOnce();
  await service.submit(two.id, two.fingerprint);
  const waiting = await service.get(two.id);
  expect(waiting.state).toBe('unknown');
  expect(waiting.hasActiveWork).toBe(false);
  expect(waiting.jobs[0]).toMatchObject({ state: 'queued', blockedByUnresolvedOwner: true });
  expect(await service.runOnce()).toBe(false);
});

it('does not adopt a timed-out create when its promise later completes without explicit read reconciliation', async () => {
  service = new PreparedExecutionService(repo, gateway, { requestTimeoutMs: 20 });
  const e = await entry();
  let complete!: () => void;
  const gate = new Promise<void>((resolve) => {
    complete = resolve;
  });
  gateway.beforeCreate = () => gate;
  const batch = await prepare([e]);
  await service.submit(batch.id, batch.fingerprint);
  await service.runOnce();
  expect((await service.get(batch.id)).jobs[0]!.state).toBe('unknown');
  complete();
  await new Promise((resolve) => setImmediate(resolve));
  const beforeReconcile = (await service.get(batch.id)).jobs[0]!;
  expect(beforeReconcile.state).toBe('unknown');
  expect(beforeReconcile.itemId).toBeNull();
  expect(gateway.writes).toHaveLength(1);
  expect(await service.runOnce()).toBe(false);
  expect((await service.reconcile(beforeReconcile.id)).state).toBe('verified');
  expect(gateway.writes).toHaveLength(1);
}, 1500);

it('does not read a timed-out pending update as complete even when selected values already match', async () => {
  const e = await entry();
  await createOne(e);
  service = new PreparedExecutionService(repo, gateway, { requestTimeoutMs: 20 });
  e.sourceFingerprint = hash('unchanged value explicit new command');
  gateway.update = async () => new Promise(() => {});
  const batch = await prepare([e], 'update', ['title']);
  await service.submit(batch.id, batch.fingerprint);
  await service.runOnce();
  const job = (await service.get(batch.id)).jobs[0]!;
  expect(job.state).toBe('unknown');
  expect(job.readback).toBeNull();
  await expect(service.reconcile(job.id)).rejects.toThrow('PREPARED_STILL_RUNNING');
  expect(gateway.writes).toHaveLength(1);
}, 1500);

it('same stock instruction under a new batch ID cannot replenish an order decrement', async () => {
  const e = await entry();
  const original = await createOne(e);
  const revised = structuredClone(e);
  revised.sourceFingerprint = hash('stock-command-2');
  revised.document.models[0]!.stock = 9;
  const update = await prepare([revised], 'update', ['stock'], [e.document.models[0]!.sku]);
  await service.submit(update.id, update.fingerprint);
  await service.runOnce();
  gateway.items.get(gateway.key(e.scope, original.itemId!))!.document.models[0]!.stock = 8;
  const replay = await prepare([revised], 'update', ['stock'], [e.document.models[0]!.sku]);
  expect(replay.jobs[0]!.state).toBe('blocked');
  await service.submit(replay.id, replay.fingerprint);
  expect(await service.runOnce()).toBe(false);
  expect(gateway.items.get(gateway.key(e.scope, original.itemId!))!.document.models[0]!.stock).toBe(
    8,
  );
  expect(gateway.writes).toHaveLength(2);
});

it('the logistics field group includes sourced weight and dimensions while protecting other fields', async () => {
  const e = await entry();
  const created = await createOne(e);
  const revised = structuredClone(e);
  revised.sourceFingerprint = hash('shipping change');
  revised.document.weightGrams = 250;
  revised.document.dimensionCm = { length: 20, width: 10, height: 8 };
  revised.document.title = 'Unselected source title';
  revised.document.models[0]!.stock = 99;
  const batch = await prepare([revised], 'update', ['logistics']);
  expect(batch.jobs[0]!.expected.document.weightGrams).toBe(250);
  expect(batch.jobs[0]!.expected.document.dimensionCm).toEqual(revised.document.dimensionCm);
  const original = gateway.update.bind(gateway);
  gateway.update = async (scope, itemId, expected, fields, selected) => {
    const result = await original(scope, itemId, expected, fields, selected);
    const remote = gateway.items.get(gateway.key(scope, itemId))!;
    remote.document.weightGrams = expected.document.weightGrams;
    remote.document.dimensionCm = structuredClone(expected.document.dimensionCm);
    return result;
  };
  await service.submit(batch.id, batch.fingerprint);
  await service.runOnce();
  const job = (await service.get(batch.id)).jobs[0]!;
  expect(job.state).toBe('verified');
  const remote = gateway.items.get(gateway.key(e.scope, created.itemId!))!;
  expect(remote.document.title).toBe(e.document.title);
  expect(remote.document.models).toEqual(e.document.models);
  expect(remote.modelBindings).toEqual((created.readback as any).data.modelBindings.toReversed());
});

it('fails closed without an explicit simulation gateway or for production scope', async () => {
  expect(() => new PreparedExecutionService(repo, undefined as any)).toThrow(
    'PREPARED_SIMULATION_REQUIRED',
  );
  const e = await entry();
  e.scope.environment = 'production';
  await expect(prepare([e])).rejects.toThrow();
  expect(gateway.writes).toHaveLength(0);
});

it('unknown reconciliation does not adopt ambiguous source matches', async () => {
  const e = await entry();
  gateway.loseCreate = true;
  const batch = await prepare([e]);
  await service.submit(batch.id, batch.fingerprint);
  await service.runOnce();
  const first = [...gateway.items.values()][0]!;
  gateway.items.set(gateway.key(e.scope, 'duplicate'), {
    ...structuredClone(first),
    itemId: 'duplicate',
  });
  expect((await service.reconcile(batch.jobs[0]!.id)).state).toBe('unknown');
  expect(gateway.writes).toHaveLength(1);
});

it('a gateway cannot change the persisted intended value by mutating its create argument', async () => {
  const e = await entry();
  const original = gateway.create.bind(gateway);
  gateway.create = async (scope, document) => {
    document.title = 'Gateway altered source';
    return original(scope, document);
  };
  const batch = await prepare([e]);
  await service.submit(batch.id, batch.fingerprint);
  await service.runOnce();
  const job = (await service.get(batch.id)).jobs[0]!;
  expect(job.state).toBe('unknown');
  expect(job.expected.document.title).toBe(e.document.title);
  expect(job.result.mismatchedPaths).toContain('document.title');
});

it('detects a protected [] to {} shape change after an otherwise correct update', async () => {
  const e = await entry();
  await createOne(e);
  const revised = structuredClone(e);
  revised.sourceFingerprint = hash('shape');
  revised.document.title = 'Selected title';
  const batch = await prepare([revised], 'update', ['title']);
  gateway.tamperUpdate = true;
  await service.submit(batch.id, batch.fingerprint);
  await service.runOnce();
  const job = (await service.get(batch.id)).jobs[0]!;
  expect(job.state).toBe('unknown');
  expect(job.result.mismatchedPaths).toContain('extra.nested.array');
});

it('recovers a storage crash after remote create without replaying the mutation', async () => {
  let clock = Date.now();
  service = new PreparedExecutionService(repo, gateway, {
    now: () => new Date(clock),
    leaseMs: 1000,
  });
  const batch = await prepare([await entry()]);
  await service.submit(batch.id, batch.fingerprint);
  const originalQuery = pool.query.bind(pool);
  const spy = vi.spyOn(pool, 'query').mockImplementation((...args: any[]) => {
    if (
      typeof args[0] === 'string' &&
      args[0].startsWith('UPDATE prepared_execution_jobs SET receipt=')
    )
      throw new Error('Simulated storage outage after remote commit');
    return (originalQuery as any)(...args);
  });
  try {
    await expect(service.runOnce()).rejects.toThrow('Simulated storage outage');
  } finally {
    spy.mockRestore();
  }
  const job = (await service.get(batch.id)).jobs[0]!;
  expect(job.state).toBe('running');
  expect(job.durableState).toBe('unknown');
  expect(job.inFlight).toBe(true);
  expect(job.mutationSent).toBe(true);
  await expect(service.reconcile(job.id)).rejects.toThrow('PREPARED_STILL_RUNNING');
  clock += 2000;
  service = new PreparedExecutionService(repo, gateway, {
    now: () => new Date(clock),
    leaseMs: 1000,
  });
  expect((await service.get(batch.id)).jobs[0]).toMatchObject({
    state: 'unknown',
    durableState: 'unknown',
    inFlight: false,
  });
  expect(await service.runOnce()).toBe(false);
  expect((await service.reconcile(job.id)).state).toBe('verified');
  expect(gateway.writes).toHaveLength(1);
});

it('allows read-only reconciliation with renewed credentials for the same owner', async () => {
  const e = await entry();
  gateway.loseCreate = true;
  const batch = await prepare([e]);
  await service.submit(batch.id, batch.fingerprint);
  await service.runOnce();
  await pool.query('UPDATE connections SET revision=2,capability_revision=2 WHERE id=$1', [
    e.connectionId,
  ]);
  const job = await service.reconcile(batch.jobs[0]!.id);
  expect(job.state).toBe('verified');
  expect(job.result.readScope.connectionRevision).toBe(2);
  expect(gateway.writes).toHaveLength(1);
});

it('blocks an expired connection before mutation and rejects a changed preparation fingerprint', async () => {
  const e = await entry();
  const batch = await prepare([e]);
  await service.submit(batch.id, batch.fingerprint);
  await pool.query("UPDATE connections SET expires_at=now()-interval '1 minute' WHERE id=$1", [
    e.connectionId,
  ]);
  await service.runOnce();
  expect((await service.get(batch.id)).jobs[0]!.state).toBe('blocked');
  expect(gateway.writes).toHaveLength(0);
  await expect(service.submit(batch.id, '0'.repeat(64))).rejects.toThrow(
    'PREPARED_FINGERPRINT_MISMATCH',
  );
});
