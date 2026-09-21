import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { canonicalJson } from '@shopee/domain';
import { type Repository, transaction } from '@shopee/persistence';
import { preparedWireMediaRequirements } from '../../../packages/shopee/src/prepared-wire.js';
import {
  productionBatchPass1Root,
  readProductionBatchManifest,
  productionPublicationMode,
} from './production-batch-source.js';

const sha = z.string().regex(/^[a-f0-9]{64}$/),
  uuid = z.string().uuid();
const owner = 'production:2010476:1423724897';
const scope = { environment: 'production', partnerId: '2010476', shopId: '1423724897' } as const;
const fp = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function fail(code: string): never {
  throw Error('PRODUCTION_EXECUTION_POLICY_' + code);
}
const sourceSchema = z
  .object({
    sourceKey: z.string().min(1),
    sourceIdentity: z.string().min(1),
    sourceRevision: z.number().int().positive(),
    documentSha256: sha,
    operationId: uuid.nullable(),
    itemId: z
      .string()
      .regex(/^[1-9]\d*$/)
      .nullable(),
    sourceFingerprint: sha.nullable(),
  })
  .strict()
  .refine((s) =>
    s.operationId === null
      ? s.itemId === null && s.sourceFingerprint === null
      : s.itemId !== null && s.sourceFingerprint !== null,
  );
const bodySchema = z
  .object({
    version: z.literal(1),
    id: uuid,
    preparationId: uuid,
    preparationFingerprint: sha,
    publicationMode: z.literal('hidden_for_review'),
    imageQcPolicy: z.literal('defer_image_qc'),
    createdAt: z.iso.datetime(),
    scope: z
      .object({
        environment: z.literal('production'),
        partnerId: z.literal('2010476'),
        shopId: z.literal('1423724897'),
      })
      .strict(),
    batches: z
      .array(
        z
          .object({
            batchId: uuid,
            manifestSha256: sha,
            priorStatusFingerprint: sha,
            sources: z.array(sourceSchema).min(1).max(4),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();
export type ExecutionPolicyReceipt = z.infer<typeof bodySchema> & { fingerprint: string };
const requestSchema = z
  .object({
    id: uuid,
    expectedFingerprint: sha,
    publicationMode: z.literal('hidden_for_review'),
    imageQcPolicy: z.literal('defer_image_qc'),
    batches: z
      .array(
        z
          .object({
            batchId: uuid,
            expectedStatusFingerprint: sha,
            sourceKeys: z.array(z.string().min(1)).min(1).max(4),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();
type Loaded = { value: any; sha256: string };
type Options = {
  batchStatus?: (id: string) => Promise<any>;
  root?: string;
  loadManifest?: (batchId: string) => Promise<Loaded>;
};
function validated(row: any): ExecutionPolicyReceipt {
  const body = bodySchema.parse(row.body);
  if (
    body.id !== row.id ||
    body.preparationId !== row.preparation_id ||
    fp(body) !== row.fingerprint ||
    new Set(body.batches.map((b) => b.batchId)).size !== body.batches.length ||
    new Set(body.batches.flatMap((b) => b.sources.map((s) => s.sourceIdentity))).size !==
      body.batches.flatMap((b) => b.sources).length
  )
    fail('RECEIPT_INVALID');
  return { ...body, fingerprint: row.fingerprint };
}
/** A runtime policy never replaces source authorization or changes operation identity. */
export function assertExecutionPolicySource(
  receipt: ExecutionPolicyReceipt,
  binding: {
    batchId: string;
    manifestSha256: string;
    sourceIdentity: string;
    sourceRevision: number;
    documentSha256: string;
    operationId?: string;
    itemId?: string;
    sourceFingerprint?: string;
  },
) {
  const { fingerprint, ...body } = receipt;
  bodySchema.parse(body);
  if (fp(body) !== fingerprint) fail('RECEIPT_INVALID');
  const batch = receipt.batches.find(
    (b) => b.batchId === binding.batchId && b.manifestSha256 === binding.manifestSha256,
  );
  const source = batch?.sources.find(
    (s) =>
      s.sourceIdentity === binding.sourceIdentity &&
      s.sourceRevision === binding.sourceRevision &&
      s.documentSha256 === binding.documentSha256,
  );
  if (
    !source ||
    (source.operationId !== null &&
      (source.operationId !== binding.operationId ||
        source.itemId !== binding.itemId ||
        source.sourceFingerprint !== binding.sourceFingerprint))
  )
    fail('SOURCE_MISMATCH');
  return source;
}

export class ProductionExecutionPolicyService {
  constructor(
    private readonly repo: Repository,
    private readonly options: Options = {},
  ) {}
  async getForPreparation(id: string): Promise<ExecutionPolicyReceipt | null> {
    uuid.parse(id);
    const row = (
      await this.repo.pool.query(
        'SELECT * FROM production_execution_policies WHERE preparation_id=$1',
        [id],
      )
    ).rows[0];
    return row ? validated(row) : null;
  }
  async getForBatch(
    batchId: string,
    manifestSha256: string,
  ): Promise<ExecutionPolicyReceipt | null> {
    uuid.parse(batchId);
    sha.parse(manifestSha256);
    const rows = (
      await this.repo.pool.query(
        `SELECT p.* FROM production_execution_policies p WHERE EXISTS
      (SELECT 1 FROM jsonb_array_elements(p.body->'batches') b WHERE b->>'batchId'=$1)`,
        [batchId],
      )
    ).rows;
    if (!rows.length) return null;
    if (rows.length !== 1) fail('RECEIPT_CONFLICT');
    const receipt = validated(rows[0]);
    if (!receipt.batches.some((b) => b.batchId === batchId && b.manifestSha256 === manifestSha256))
      fail('MANIFEST_CHANGED');
    return receipt;
  }
  private async loadManifest(batchId: string): Promise<Loaded> {
    if (this.options.loadManifest) return this.options.loadManifest(batchId);
    const saved = JSON.parse(
      await readFile(
        resolve(this.options.root ?? productionBatchPass1Root, 'web-registry', batchId + '.json'),
        'utf8',
      ),
    );
    if (saved.batchId !== batchId) fail('REGISTRATION_CHANGED');
    return readProductionBatchManifest(saved.manifestPath, saved.expectedSha256);
  }
  /** Local immutable choice only: this method never starts a runner or calls Shopee. */
  async convert(preparationId: string, raw: unknown): Promise<ExecutionPolicyReceipt> {
    uuid.parse(preparationId);
    const input = requestSchema.parse(raw),
      requestHash = fp(input);
    if (
      new Set(input.batches.map((b) => b.batchId)).size !== input.batches.length ||
      input.batches.some((b) => new Set(b.sourceKeys).size !== b.sourceKeys.length)
    )
      fail('SOURCE_SET_MISMATCH');
    if (!this.options.batchStatus) fail('STATUS_READER_REQUIRED');
    return transaction(this.repo.pool, async (c) => {
      // Same namespaces as parent and child coordinators. Fail promptly while any dispatch owns them.
      for (const key of [
        'production-preparation-owner:' + owner,
        'production-preparation-execution:' + preparationId,
        'production-batch-coordinator:' + owner,
      ]) {
        const row = (
          await c.query(
            "SELECT pg_try_advisory_xact_lock(hashtextextended(current_schema()||':'||$1,0)) AS locked",
            [key],
          )
        ).rows[0];
        if (!row?.locked) fail('IN_PROGRESS');
      }
      const old = (
        await c.query('SELECT * FROM production_execution_policies WHERE preparation_id=$1', [
          preparationId,
        ])
      ).rows[0];
      if (old) {
        if (old.request_hash !== requestHash || old.id !== input.id) fail('CONFLICT');
        return validated(old);
      }
      const preparation = (
        await c.query('SELECT * FROM production_source_preparations WHERE id=$1 FOR SHARE', [
          preparationId,
        ])
      ).rows[0];
      if (
        !preparation?.registration ||
        preparation.fingerprint !== input.expectedFingerprint ||
        fp(preparation.body) !== preparation.fingerprint
      )
        fail('PREPARATION_CHANGED');
      const execution = (
        await c.query(
          'SELECT body FROM production_preparation_executions WHERE preparation_id=$1 FOR SHARE',
          [preparationId],
        )
      ).rows[0];
      if (execution?.body.state === 'running') fail('IN_PROGRESS');
      const registered = z
        .array(z.object({ batchId: uuid, manifestSha256: sha }).passthrough())
        .min(1)
        .max(20)
        .parse(preparation.registration.batches);
      if (new Set(registered.map((b) => b.batchId)).size !== registered.length)
        fail('REGISTRATION_CHANGED');
      const snapshots: {
        loaded: Loaded;
        status: any;
        requested: z.infer<typeof requestSchema>['batches'][number];
      }[] = [];
      for (const batch of registered) {
        const loaded = await this.loadManifest(batch.batchId),
          manifest = loaded.value;
        if (
          loaded.sha256 !== batch.manifestSha256 ||
          manifest.batchId !== batch.batchId ||
          manifest.version !== 2 ||
          manifest.preparation?.id !== preparationId ||
          manifest.preparation?.fingerprint !== preparation.fingerprint ||
          !same(manifest.scope, scope)
        )
          fail('MANIFEST_CHANGED');
        const status = await this.options.batchStatus!(batch.batchId);
        if (status.manifestSha256 !== batch.manifestSha256 || status.busy || status.interrupted)
          fail('STATUS_UNSAFE');
        if (
          !Array.isArray(status.listings) ||
          status.listings.length !== manifest.listings.length ||
          new Set(status.listings.map((s: any) => s.sourceKey)).size !== manifest.listings.length ||
          !manifest.listings.every((s: any) =>
            status.listings.some((r: any) => r.sourceKey === s.sourceKey),
          )
        )
          fail('STATUS_UNSAFE');
        const remaining = status.listings.filter((s: any) => s.state !== 'published');
        const requested = input.batches.find((b) => b.batchId === batch.batchId);
        if (!remaining.length) {
          if (requested) fail('SOURCE_SET_MISMATCH');
          continue;
        }
        if (
          !requested ||
          status.executionEnabled === false ||
          productionPublicationMode(manifest) !== 'publish_after_verification' ||
          requested.expectedStatusFingerprint !== status.statusFingerprint ||
          remaining.length !== requested.sourceKeys.length ||
          !remaining.every(
            (s: any) =>
              requested.sourceKeys.includes(s.sourceKey) &&
              ['not_sent', 'created_readback_pending', 'created_unlisted'].includes(s.state),
          )
        )
          fail('SOURCE_SET_MISMATCH');
        snapshots.push({ loaded, status, requested });
      }
      if (snapshots.length !== input.batches.length) fail('SOURCE_SET_MISMATCH');
      // Block concurrent journal mutations while binding existing operations; status calls above may read the journal.
      if (
        !(
          await c.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked', [
            'production-pilot:' + owner,
          ])
        ).rows[0]?.locked
      )
        fail('IN_PROGRESS');
      const bound: ExecutionPolicyReceipt['batches'] = [];
      for (const { loaded, status, requested } of snapshots) {
        const manifest = loaded.value,
          sources: ExecutionPolicyReceipt['batches'][number]['sources'] = [];
        const authorization = {
          batchId: manifest.batchId,
          manifestSha256: loaded.sha256,
          authorizationReference: manifest.authorizationReference,
          sources: manifest.listings.map((s: any) => ({
            sourceIdentity: s.sourceIdentity,
            sourceRevision: s.sourceRevision,
            documentSha256: fp(s.document),
          })),
        };
        for (const source of manifest.listings.filter((s: any) =>
          requested.sourceKeys.includes(s.sourceKey),
        )) {
          const rows = (
            await c.query(
              'SELECT * FROM production_pilot_operations WHERE owner_key=$1 AND source_identity=$2 FOR SHARE',
              [owner, source.sourceIdentity],
            )
          ).rows;
          const state = status.listings.find((r: any) => r.sourceKey === source.sourceKey)?.state;
          if (rows.length > 1 || (state === 'not_sent' ? rows.length !== 0 : rows.length !== 1))
            fail('SOURCE_CHANGED');
          const op = rows[0];
          if (op) {
            const payload = op.source_payload;
            if (
              op.source_revision !== source.sourceRevision ||
              !['acknowledged', 'verified'].includes(op.state) ||
              !op.item_id ||
              !same(payload.batchAuthorization, authorization) ||
              !same(payload.document, source.document) ||
              op.source_fingerprint !==
                fp({
                  scope,
                  sourceIdentity: source.sourceIdentity,
                  sourceRevision: source.sourceRevision,
                  sourcePayload: payload,
                  expectedProjection: op.expected_projection,
                })
            )
              fail('OPERATION_CHANGED');
            if (
              (
                await c.query(
                  'SELECT id FROM production_pilot_publications WHERE create_operation_id=$1',
                  [op.id],
                )
              ).rows.length
            )
              fail('PUBLICATION_ALREADY_STARTED');
            const steps = (
              await c.query(
                'SELECT step_key,state FROM production_pilot_steps WHERE operation_id=$1',
                [op.id],
              )
            ).rows;
            const keys = [
              ...preparedWireMediaRequirements(source.document).map((_, i) => 'media-' + i),
              'create',
              ...(source.document.tierNames.length ? ['variations'] : []),
            ];
            if (
              steps.length !== keys.length ||
              !keys.every(
                (key) =>
                  steps.filter((s) => s.step_key === key && s.state === 'acknowledged').length ===
                  1,
              )
            )
              fail('ALL_ACK_REQUIRED');
          }
          sources.push({
            sourceKey: source.sourceKey,
            sourceIdentity: source.sourceIdentity,
            sourceRevision: source.sourceRevision,
            documentSha256: fp(source.document),
            operationId: op?.id ?? null,
            itemId: op?.item_id ?? null,
            sourceFingerprint: op?.source_fingerprint ?? null,
          });
        }
        bound.push({
          batchId: manifest.batchId,
          manifestSha256: loaded.sha256,
          priorStatusFingerprint: requested.expectedStatusFingerprint,
          sources,
        });
      }
      const body = bodySchema.parse({
        version: 1,
        id: input.id,
        preparationId,
        preparationFingerprint: preparation.fingerprint,
        scope,
        publicationMode: input.publicationMode,
        imageQcPolicy: input.imageQcPolicy,
        createdAt: new Date().toISOString(),
        batches: bound,
      });
      const fingerprint = fp(body);
      await c.query(
        'INSERT INTO production_execution_policies(id,preparation_id,request_hash,request,body,fingerprint) VALUES($1,$2,$3,$4,$5,$6)',
        [input.id, preparationId, requestHash, input, body, fingerprint],
      );
      return { ...body, fingerprint };
    });
  }
}
