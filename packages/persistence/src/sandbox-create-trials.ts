import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '@shopee/domain';
import { transaction, type Pool } from './db.js';
import type { PoolClient } from 'pg';

export type SandboxMutationLaneFamily =
  'create' | 'field' | 'listing' | 'media' | 'wire' | 'variation';
/** All live sandbox writers reserve the same owner lane before recording mutation intent. */
export async function lockSandboxMutationLane(
  query: Pick<PoolClient, 'query'>,
  ownerKey: string,
  tryOnly = false,
): Promise<boolean> {
  if (tryOnly)
    return (
      (
        await query.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS ok', [
          'prepared-wire:' + ownerKey,
        ])
      ).rows[0].ok === true
    );
  await query.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'prepared-wire:' + ownerKey,
  ]);
  return true;
}
export async function sandboxMutationLaneBusy(
  query: Pick<PoolClient, 'query'>,
  ownerKey: string,
  exclude?: { family: SandboxMutationLaneFamily; id: string },
): Promise<boolean> {
  const result = await query.query(
    `SELECT EXISTS (
    SELECT 1 FROM (
      SELECT 'create' AS family,i.id,concat(c.environment,':',c.partner_id,':',c.shop_id) AS owner_key
      FROM sandbox_create_trial_items i JOIN connections c ON c.id=i.connection_id WHERE i.state IN ('running','unknown')
      UNION ALL SELECT 'field',r.id,concat(c.environment,':',c.partner_id,':',c.shop_id)
      FROM sandbox_field_trials r JOIN connections c ON c.id=r.connection_id WHERE r.state='unknown'
      UNION ALL SELECT 'listing',r.id,concat(c.environment,':',c.partner_id,':',c.shop_id)
      FROM sandbox_listing_runs r JOIN connections c ON c.id=r.connection_id WHERE r.state IN ('in_flight','unknown')
        AND NOT EXISTS (SELECT 1 FROM sandbox_listing_reconciliations q
          WHERE q.run_id=r.id AND q.verified AND q.run_revision=r.revision
            AND q.run_input_fingerprint=r.input_fingerprint AND q.run_snapshot=to_jsonb(r))
      UNION ALL SELECT 'media',r.id,concat(c.environment,':',c.partner_id,':',c.shop_id)
      FROM sandbox_trial_preparations r JOIN connections c ON c.id=r.connection_id WHERE r.state IN ('preparing','unknown')
      UNION ALL SELECT 'wire',id,owner_key FROM prepared_wire_operations WHERE state IN ('running','unknown')
      UNION ALL SELECT 'variation',id,owner_key FROM variation_operations WHERE state IN ('running','unknown')
    ) busy WHERE owner_key=$1 AND ($2::text IS NULL OR family<>$2 OR id::text<>$3)
  ) AS busy`,
    [ownerKey, exclude?.family ?? null, exclude?.id ?? null],
  );
  return result.rows[0].busy === true;
}

const syntheticKey = z.string().regex(/^SBX-BULK-[A-Za-z0-9._:-]{1,160}$/);
// This is only an envelope guard; the worker parses the full shared gateway schema before intent.
const createSchema = z
  .object({
    item_sku: syntheticKey,
    item_name: z
      .string()
      .regex(/^SANDBOX QA(?:\s|$)/)
      .max(200),
    item_status: z.literal('UNLIST'),
    description_type: z.literal('normal'),
  })
  .passthrough();
export const sandboxCreateTrialManifestSchema = z
  .object({
    trialKey: syntheticKey,
    connectionId: z.string().uuid(),
    connectionRevision: z.number().int().positive(),
    items: z
      .array(
        z
          .object({
            sourceKey: syntheticKey,
            create: createSchema,
            tiers: z.record(z.string(), z.unknown()).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(80),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    if (new Set(manifest.items.map((item) => item.sourceKey)).size !== manifest.items.length)
      ctx.addIssue({
        code: 'custom',
        path: ['items'],
        message: 'Duplicate synthetic source identity',
      });
    manifest.items.forEach((item, index) => {
      if (
        item.sourceKey !== item.create.item_sku ||
        (item.tiers && Object.hasOwn(item.tiers, 'item_id'))
      )
        ctx.addIssue({
          code: 'custom',
          path: ['items', index],
          message: 'Synthetic item identity mismatch',
        });
    });
  });
export type SandboxCreateTrialManifest = z.infer<typeof sandboxCreateTrialManifestSchema>;
export type SandboxCreateTrialState =
  'queued' | 'running' | 'waiting' | 'verified' | 'failed' | 'unknown';
export type SandboxCreateTrialStage =
  'queued' | 'create_intent' | 'created' | 'tiers_intent' | 'readback' | 'done';
export type SandboxCreateTrialItem = {
  id: string;
  trialId: string;
  sourceKey: string;
  position: number;
  intent: SandboxCreateTrialManifest['items'][number];
  state: SandboxCreateTrialState;
  stage: SandboxCreateTrialStage;
  itemId: string | null;
  leaseEpoch: number;
  leaseUntil: string | null;
  workerId: string | null;
  nextRunAt: string;
  attemptCount: number;
  readCount: number;
  result: unknown;
  createdAt: string;
  updatedAt: string;
  events?: { id: string; code: string; details: unknown; createdAt: string }[];
};
export type SandboxCreateTrial = {
  id: string;
  trialKey: string;
  connectionId: string;
  connectionRevision: number;
  manifestFingerprint: string;
  state: SandboxCreateTrialState;
  paused: boolean;
  pauseReason: string | null;
  manifest: SandboxCreateTrialManifest;
  evidence: unknown;
  items: SandboxCreateTrialItem[];
  createdAt: string;
  updatedAt: string;
};
export type SandboxCreateTrialClaim = SandboxCreateTrialItem & {
  connectionId: string;
  connectionRevision: number;
  evidence: unknown;
  workerId: string;
  leaseUntil: string;
};
const iso = (value: Date | string) => new Date(value).toISOString();
const sha = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
function itemRow(row: any): SandboxCreateTrialItem {
  return {
    id: row.id,
    trialId: row.trial_id,
    sourceKey: row.source_key,
    position: row.position,
    intent: row.intent,
    state: row.state,
    stage: row.stage,
    itemId: row.item_id,
    leaseEpoch: row.lease_epoch,
    leaseUntil: row.lease_until ? iso(row.lease_until) : null,
    workerId: row.worker_id,
    nextRunAt: iso(row.next_run_at),
    attemptCount: row.attempt_count,
    readCount: row.read_count,
    result: row.result,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}
function assertSafeJson(value: unknown) {
  const serialized = JSON.stringify(value);
  if (!serialized || Buffer.byteLength(serialized) > 8 * 1024 * 1024)
    throw new Error('SANDBOX_TRIAL_INPUT_INVALID');
  const inspect = (input: unknown) => {
    if (!input || typeof input !== 'object') return;
    for (const [key, child] of Object.entries(input)) {
      if (/^(access_token|refresh_token|partner_key|authorization|password|cookie)$/i.test(key))
        throw new Error('SANDBOX_TRIAL_SECRET_INPUT');
      inspect(child);
    }
  };
  inspect(value);
}
export class SandboxCreateTrialStore {
  constructor(
    readonly pool: Pool,
    readonly options: { now?: () => Date; leaseMs?: number } = {},
  ) {}
  private now() {
    return this.options.now?.() ?? new Date();
  }
  private async event(
    client: PoolClient,
    itemId: string,
    epoch: number,
    code: string,
    details: unknown = {},
  ) {
    assertSafeJson(details);
    await client.query(
      'INSERT INTO sandbox_create_trial_events(trial_item_id,lease_epoch,code,details,created_at) VALUES($1,$2,$3,$4,$5)',
      [itemId, epoch, code, details, this.now()],
    );
  }
  async submit(raw: unknown, evidence: unknown): Promise<SandboxCreateTrial> {
    const manifest = sandboxCreateTrialManifestSchema.parse(raw);
    assertSafeJson(manifest);
    assertSafeJson(evidence);
    const fingerprint = sha({ manifest, evidence });
    const id = await transaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'sandbox-create-submit:' + manifest.connectionId + ':' + manifest.trialKey,
      ]);
      const prior = (
        await client.query(
          'SELECT id,fingerprint FROM sandbox_create_trials WHERE connection_id=$1 AND trial_key=$2',
          [manifest.connectionId, manifest.trialKey],
        )
      ).rows[0];
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new Error('SANDBOX_TRIAL_IDEMPOTENCY_CONFLICT');
        return prior.id as string;
      }
      const connection = (
        await client.query(
          'SELECT environment,partner_id,shop_id,revision,state FROM connections WHERE id=$1 FOR SHARE',
          [manifest.connectionId],
        )
      ).rows[0];
      if (
        !connection ||
        connection.environment !== 'sandbox' ||
        connection.partner_id !== '1232297' ||
        connection.shop_id !== '227418363'
      )
        throw new Error('SANDBOX_TRIAL_SCOPE_NOT_ALLOWED');
      if (connection.state !== 'connected' || connection.revision !== manifest.connectionRevision)
        throw new Error('SANDBOX_TRIAL_CONNECTION_CHANGED');
      const id = randomUUID(),
        now = this.now();
      await client.query(
        'INSERT INTO sandbox_create_trials(id,trial_key,connection_id,connection_revision,fingerprint,manifest,evidence,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8)',
        [
          id,
          manifest.trialKey,
          manifest.connectionId,
          manifest.connectionRevision,
          fingerprint,
          manifest,
          evidence,
          now,
        ],
      );
      for (const [position, item] of manifest.items.entries()) {
        const itemId = randomUUID();
        try {
          await client.query(
            'INSERT INTO sandbox_create_trial_items(id,trial_id,connection_id,source_key,position,intent,next_run_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7,$7)',
            [itemId, id, manifest.connectionId, item.sourceKey, position, item, now],
          );
        } catch (error) {
          if ((error as { code?: string }).code === '23505')
            throw new Error('SANDBOX_TRIAL_SOURCE_EXISTS');
          throw error;
        }
        await this.event(client, itemId, 0, 'QUEUED');
      }
      return id;
    });
    return (await this.get(id))!;
  }
  async get(id: string): Promise<SandboxCreateTrial | null> {
    const row = (await this.pool.query('SELECT * FROM sandbox_create_trials WHERE id=$1', [id]))
      .rows[0];
    if (!row) return null;
    const items = (
      await this.pool.query(
        'SELECT * FROM sandbox_create_trial_items WHERE trial_id=$1 ORDER BY position',
        [id],
      )
    ).rows.map(itemRow);
    const events = (
      await this.pool.query(
        'SELECT e.* FROM sandbox_create_trial_events e JOIN sandbox_create_trial_items i ON i.id=e.trial_item_id WHERE i.trial_id=$1 ORDER BY e.id',
        [id],
      )
    ).rows;
    for (const item of items)
      item.events = events
        .filter((event) => event.trial_item_id === item.id)
        .map((event) => ({
          id: String(event.id),
          code: event.code,
          details: event.details,
          createdAt: iso(event.created_at),
        }));
    const states = items.map((item) => item.state);
    const state: SandboxCreateTrialState = states.includes('unknown')
      ? 'unknown'
      : states.includes('running')
        ? 'running'
        : states.every((value) => value === 'verified')
          ? 'verified'
          : states.every((value) => ['verified', 'failed'].includes(value))
            ? 'failed'
            : row.paused || states.includes('waiting')
              ? 'waiting'
              : 'queued';
    return {
      id: row.id,
      trialKey: row.trial_key,
      connectionId: row.connection_id,
      connectionRevision: row.connection_revision,
      manifestFingerprint: row.fingerprint,
      state,
      paused: row.paused,
      pauseReason: row.pause_reason,
      manifest: row.manifest,
      evidence: row.evidence,
      items,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    };
  }
  async list(): Promise<SandboxCreateTrial[]> {
    const rows = (
      await this.pool.query(
        'SELECT id FROM sandbox_create_trials ORDER BY created_at DESC LIMIT 30',
      )
    ).rows;
    return Promise.all(rows.map(async (row) => (await this.get(row.id))!));
  }
  async claim(workerId: string): Promise<SandboxCreateTrialClaim | null> {
    return transaction(this.pool, async (client) => {
      const locked = await lockSandboxMutationLane(client, 'sandbox:1232297:227418363', true);
      if (!locked) return null;
      const now = this.now();
      const expired = (
        await client.query(
          "SELECT * FROM sandbox_create_trial_items WHERE state='running' AND lease_until <= $1 ORDER BY id FOR UPDATE",
          [now],
        )
      ).rows;
      for (const item of expired) {
        const uncertain = ['create_intent', 'tiers_intent'].includes(item.stage);
        await client.query(
          'UPDATE sandbox_create_trial_items SET state=$2,lease_until=NULL,worker_id=NULL,next_run_at=$3,updated_at=$3,result=$4 WHERE id=$1',
          [
            item.id,
            uncertain ? 'unknown' : 'waiting',
            now,
            uncertain
              ? {
                  code: 'LEASE_EXPIRED_AFTER_INTENT',
                  message: 'Chưa rõ kết quả ghi; không tự gửi lại.',
                }
              : item.result,
          ],
        );
        if (uncertain)
          await client.query(
            "UPDATE sandbox_create_trials SET paused=true,pause_reason='LEASE_EXPIRED_AFTER_INTENT',updated_at=$2 WHERE id=$1",
            [item.trial_id, now],
          );
        await this.event(
          client,
          item.id,
          item.lease_epoch,
          uncertain ? 'RECOVERY_UNKNOWN' : 'RECOVERY_SAFE_READ',
        );
      }
      // An unresolved mutation also holds the shop lane: another batch must not run beside a late request.
      if (await sandboxMutationLaneBusy(client, 'sandbox:1232297:227418363')) return null;
      const candidate = (
        await client.query(
          "SELECT i.*,t.connection_revision,t.evidence FROM sandbox_create_trial_items i JOIN sandbox_create_trials t ON t.id=i.trial_id WHERE i.state IN ('queued','waiting') AND i.next_run_at <= $1 AND NOT t.paused ORDER BY i.created_at,i.position FOR UPDATE OF i SKIP LOCKED LIMIT 1",
          [now],
        )
      ).rows[0];
      if (!candidate) return null;
      const leaseUntil = new Date(now.getTime() + (this.options.leaseMs ?? 60000));
      const item = (
        await client.query(
          "UPDATE sandbox_create_trial_items SET state='running',worker_id=$2,lease_epoch=lease_epoch+1,lease_until=$3,updated_at=$4 WHERE id=$1 RETURNING *",
          [candidate.id, workerId, leaseUntil, now],
        )
      ).rows[0];
      await this.event(client, item.id, item.lease_epoch, 'CLAIMED', { stage: item.stage });
      return {
        ...itemRow(item),
        connectionId: item.connection_id,
        connectionRevision: candidate.connection_revision,
        evidence: candidate.evidence,
        workerId,
        leaseUntil: iso(leaseUntil),
      };
    });
  }
  private async owned(client: PoolClient, claim: SandboxCreateTrialClaim) {
    return (
      await client.query(
        "SELECT * FROM sandbox_create_trial_items WHERE id=$1 AND lease_epoch=$2 AND worker_id=$3 AND state='running' AND lease_until>$4 FOR UPDATE",
        [claim.id, claim.leaseEpoch, claim.workerId, this.now()],
      )
    ).rows[0];
  }
  async beginMutation(
    claim: SandboxCreateTrialClaim,
    stage: 'create_intent' | 'tiers_intent',
    payload: unknown,
  ): Promise<string | null> {
    assertSafeJson(payload);
    return transaction(this.pool, async (client) => {
      const item = await this.owned(client, claim);
      if (!item) return null;
      if (
        (stage === 'create_intent' && (item.stage !== 'queued' || item.item_id)) ||
        (stage === 'tiers_intent' && (item.stage !== 'created' || !item.item_id))
      )
        throw new Error('SANDBOX_TRIAL_STAGE_CONFLICT');
      const expected =
        stage === 'create_intent'
          ? item.intent.create
          : { ...item.intent.tiers, item_id: Number(item.item_id) };
      if (sha(payload) !== sha(expected)) throw new Error('SANDBOX_TRIAL_PAYLOAD_CHANGED');
      // Recheck the credential version at the durable boundary, after context decryption.
      const connection = (
        await client.query(
          'SELECT environment,partner_id,shop_id,revision,state FROM connections WHERE id=$1 FOR SHARE',
          [claim.connectionId],
        )
      ).rows[0];
      if (
        !connection ||
        connection.environment !== 'sandbox' ||
        connection.partner_id !== '1232297' ||
        connection.shop_id !== '227418363' ||
        connection.state !== 'connected' ||
        connection.revision !== claim.connectionRevision
      )
        throw new Error('SANDBOX_TRIAL_CONNECTION_CHANGED');
      const id = randomUUID();
      await client.query(
        'INSERT INTO sandbox_create_trial_attempts(id,trial_item_id,lease_epoch,stage,input_fingerprint,input,started_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [id, claim.id, claim.leaseEpoch, stage, sha(payload), payload, this.now()],
      );
      await client.query(
        'UPDATE sandbox_create_trial_items SET stage=$2,attempt_count=attempt_count+1,updated_at=$3,lease_until=$4 WHERE id=$1',
        [
          claim.id,
          stage,
          this.now(),
          new Date(this.now().getTime() + (this.options.leaseMs ?? 60000)),
        ],
      );
      await this.event(client, claim.id, claim.leaseEpoch, stage.toUpperCase(), {
        attemptId: id,
        fingerprint: sha(payload),
      });
      return id;
    });
  }
  async finishMutation(
    claim: SandboxCreateTrialClaim,
    attemptId: string,
    outcome:
      | { kind: 'success'; itemId: string; requestId?: string }
      | { kind: 'rejected' | 'unknown'; code: string; requestId?: string; auth?: boolean },
  ): Promise<boolean> {
    return transaction(this.pool, async (client) => {
      const now = this.now();
      const attempt = (
        await client.query(
          'SELECT * FROM sandbox_create_trial_attempts WHERE id=$1 AND trial_item_id=$2 AND lease_epoch=$3 FOR UPDATE',
          [attemptId, claim.id, claim.leaseEpoch],
        )
      ).rows[0];
      if (!attempt) throw new Error('SANDBOX_TRIAL_ATTEMPT_NOT_FOUND');
      if (attempt.outcome && sha(attempt.outcome) !== sha(outcome))
        throw new Error('SANDBOX_TRIAL_RECEIPT_CONFLICT');
      if (!attempt.outcome)
        await client.query(
          'UPDATE sandbox_create_trial_attempts SET outcome=$2,finished_at=$3 WHERE id=$1',
          [attemptId, outcome, now],
        );
      const item = await this.owned(client, claim);
      if (!item) {
        await this.event(client, claim.id, claim.leaseEpoch, 'LATE_RECEIPT', {
          attemptId,
          outcome,
        });
        return false;
      }
      const mutation = attempt.stage === 'create_intent';
      if (outcome.kind === 'success') {
        if (!/^[1-9]\d*$/.test(outcome.itemId) || (!mutation && outcome.itemId !== item.item_id))
          throw new Error('SANDBOX_TRIAL_ITEM_ID_MISMATCH');
        await client.query(
          "UPDATE sandbox_create_trial_items SET item_id=$2,stage=$3,state='waiting',lease_until=NULL,worker_id=NULL,next_run_at=$4,updated_at=$5,result=$6 WHERE id=$1",
          [
            claim.id,
            outcome.itemId,
            mutation ? 'created' : 'readback',
            new Date(now.getTime() + 5000),
            now,
            { code: mutation ? 'ITEM_CREATED' : 'TIERS_INITIALIZED', requestId: outcome.requestId },
          ],
        );
      } else {
        await client.query(
          'UPDATE sandbox_create_trial_items SET state=$2,lease_until=NULL,worker_id=NULL,updated_at=$3,result=$4 WHERE id=$1',
          [claim.id, outcome.kind === 'unknown' ? 'unknown' : 'failed', now, outcome],
        );
        if (outcome.kind === 'unknown' || outcome.auth)
          await client.query(
            'UPDATE sandbox_create_trials SET paused=true,pause_reason=$2,updated_at=$3 WHERE id=$1',
            [claim.trialId, outcome.code, now],
          );
      }
      await this.event(client, claim.id, claim.leaseEpoch, 'MUTATION_RESULT', {
        attemptId,
        outcome,
        durationMs: now.getTime() - new Date(attempt.started_at).getTime(),
      });
      if (
        mutation &&
        outcome.kind === 'rejected' &&
        !outcome.auth &&
        outcome.code !== 'unrecognized_error' &&
        /^[A-Za-z0-9_.-]{1,100}$/.test(outcome.code)
      ) {
        // Three matching completed creates is a pilot safeguard, not a Shopee quota.
        // Include successes and different errors so either breaks the same-trial streak.
        const recent = (
          await client.query(
            "SELECT a.id,a.outcome FROM sandbox_create_trial_attempts a JOIN sandbox_create_trial_items i ON i.id=a.trial_item_id WHERE i.trial_id=$1 AND a.stage='create_intent' AND a.finished_at IS NOT NULL ORDER BY a.finished_at DESC,a.started_at DESC,i.position DESC LIMIT 3",
            [item.trial_id],
          )
        ).rows;
        if (
          recent.length === 3 &&
          recent.every(
            (entry) =>
              entry.outcome?.kind === 'rejected' &&
              !entry.outcome.auth &&
              entry.outcome.code === outcome.code,
          )
        ) {
          const paused = await client.query(
            'UPDATE sandbox_create_trials SET paused=true,pause_reason=$2,updated_at=$3 WHERE id=$1 AND NOT paused',
            [item.trial_id, 'REPEATED_CREATE_REJECTION:' + outcome.code, now],
          );
          if (paused.rowCount)
            await this.event(client, claim.id, claim.leaseEpoch, 'REPEATED_CREATE_REJECTION', {
              code: outcome.code,
              consecutiveCount: 3,
              attemptIds: recent.map((entry) => entry.id),
            });
        }
      }
      await client.query('UPDATE sandbox_create_trials SET updated_at=$2 WHERE id=$1', [
        claim.trialId,
        now,
      ]);
      return true;
    });
  }
  async finishRead(
    claim: SandboxCreateTrialClaim,
    result: {
      verified: boolean;
      issues: string[];
      requestIds: string[];
      evidence?: unknown;
      auth?: boolean;
      code?: string;
    },
  ): Promise<boolean> {
    assertSafeJson(result);
    return transaction(this.pool, async (client) => {
      const item = await this.owned(client, claim);
      if (!item) return false;
      const now = this.now(),
        count = item.read_count + 1;
      const waiting = !result.verified && !result.auth && count < 4;
      const state = result.verified
        ? 'verified'
        : result.auth
          ? 'failed'
          : waiting
            ? 'waiting'
            : 'unknown';
      await client.query(
        'UPDATE sandbox_create_trial_items SET state=$2,stage=$3,read_count=$4,result=$5,lease_until=NULL,worker_id=NULL,next_run_at=$6,updated_at=$7 WHERE id=$1',
        [
          claim.id,
          state,
          result.verified ? 'done' : 'readback',
          count,
          result,
          new Date(now.getTime() + 5000),
          now,
        ],
      );
      if (state === 'unknown' || result.auth)
        await client.query(
          'UPDATE sandbox_create_trials SET paused=true,pause_reason=$2,updated_at=$3 WHERE id=$1',
          [claim.trialId, result.code ?? 'READBACK_INCONCLUSIVE', now],
        );
      await this.event(
        client,
        claim.id,
        claim.leaseEpoch,
        result.verified ? 'READBACK_VERIFIED' : waiting ? 'READBACK_WAITING' : 'READBACK_BLOCKED',
        result,
      );
      await client.query('UPDATE sandbox_create_trials SET updated_at=$2 WHERE id=$1', [
        item.trial_id,
        now,
      ]);
      return true;
    });
  }
  async failBeforeSend(claim: SandboxCreateTrialClaim, code: string, pause = false) {
    return transaction(this.pool, async (client) => {
      const item = await this.owned(client, claim);
      if (!item) return false;
      if (['create_intent', 'tiers_intent'].includes(item.stage))
        throw new Error('SANDBOX_TRIAL_UNCERTAIN_MUTATION');
      await client.query(
        "UPDATE sandbox_create_trial_items SET state='failed',lease_until=NULL,worker_id=NULL,result=$2,updated_at=$3 WHERE id=$1",
        [claim.id, { code }, this.now()],
      );
      if (pause)
        await client.query(
          'UPDATE sandbox_create_trials SET paused=true,pause_reason=$2,updated_at=$3 WHERE id=$1',
          [claim.trialId, code, this.now()],
        );
      await this.event(client, claim.id, claim.leaseEpoch, 'PRE_SEND_FAILED', { code });
      return true;
    });
  }
}
