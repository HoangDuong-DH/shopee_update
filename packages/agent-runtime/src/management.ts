import type { Scope } from '@shopee/domain';
import { z } from 'zod';

export const managementModes = [
  'inspect',
  'prepare',
  'publish_hidden',
  'recover',
  'handoff',
] as const;

export type ManagementMode = (typeof managementModes)[number];
export type ManagementAuthorization =
  'read_only' | 'local_preparation' | 'explicit_production_write';

export type ManagementCorridorInput = {
  mode: ManagementMode;
  scope: Scope;
  authorization: ManagementAuthorization;
  source: { planId: string; revision: number; fingerprint: string };
  operationId?: string | null;
  targetCount?: number;
};

export type ManagementCorridor = {
  version: 1;
  mode: ManagementMode;
  risk: 'read_only' | 'local_change' | 'production_write' | 'recovery';
  scope: Scope;
  source: ManagementCorridorInput['source'];
  canWriteShopee: boolean;
  blockedBy: string[];
  requiredSequence: string[];
  allowedCapabilities: string[];
  stopConditions: string[];
  claimBoundary: string[];
};

const fingerprint = /^[a-f0-9]{64}$/;

export function buildManagementCorridor(input: ManagementCorridorInput): ManagementCorridor {
  if (!Number.isInteger(input.source.revision) || input.source.revision < 1)
    throw new Error('MANAGEMENT_SOURCE_INVALID');
  if (!fingerprint.test(input.source.fingerprint)) throw new Error('MANAGEMENT_SOURCE_INVALID');
  if (
    input.targetCount !== undefined &&
    (!Number.isInteger(input.targetCount) || input.targetCount < 0)
  )
    throw new Error('MANAGEMENT_TARGET_COUNT_INVALID');

  const writeMode = input.mode === 'publish_hidden';
  const recoveryMode = input.mode === 'recover';
  const blockedBy: string[] = [];
  if (writeMode && input.authorization !== 'explicit_production_write')
    blockedBy.push('EXPLICIT_WRITE_AUTHORIZATION_REQUIRED');
  if (writeMode && input.scope.environment !== 'production')
    blockedBy.push('PRODUCTION_SCOPE_REQUIRED');
  if (writeMode && !input.operationId) blockedBy.push('REGISTERED_OPERATION_REQUIRED');
  if (recoveryMode && !input.operationId) blockedBy.push('RECOVERY_OPERATION_REQUIRED');

  const baseSequence = [
    'read_current_handoff',
    'bind_partner_shop_connection_and_capability_revision',
    'bind_plan_revision_source_revision_and_fingerprint',
    'inspect_authoritative_source_and_unresolved_issues',
  ];
  const requiredSequence = writeMode
    ? [
        ...baseSequence,
        'confirm_explicit_write_authorization_for_exact_targets',
        'run_server_side_preflight',
        'execute_registered_operation_once',
        'persist_request_receipts',
        'read_back_remote_state',
        'keep_listing_hidden_until_qc',
      ]
    : recoveryMode
      ? [
          ...baseSequence,
          'load_durable_request_receipts',
          'read_remote_state_before_any_retry',
          'classify_outcome_as_verified_failed_or_unknown',
          'retry_only_a_classified_transient_failure',
        ]
      : input.mode === 'prepare'
        ? [...baseSequence, 'prepare_local_draft', 'record_issues_without_remote_write']
        : input.mode === 'handoff'
          ? [...baseSequence, 'separate_fact_inference_and_unknown', 'record_do_not_replay_items']
          : [...baseSequence, 'use_read_only_tools_and_cited_sources'];

  return {
    version: 1,
    mode: input.mode,
    risk: writeMode
      ? 'production_write'
      : recoveryMode
        ? 'recovery'
        : input.mode === 'prepare'
          ? 'local_change'
          : 'read_only',
    scope: structuredClone(input.scope),
    source: structuredClone(input.source),
    canWriteShopee: writeMode && blockedBy.length === 0,
    blockedBy,
    requiredSequence,
    allowedCapabilities: writeMode
      ? ['inspect_plan', 'search_knowledge', 'read_source', 'execute_registered_operation']
      : recoveryMode
        ? ['inspect_plan', 'search_knowledge', 'read_source', 'read_remote_state']
        : ['inspect_plan', 'search_knowledge', 'read_source'],
    stopConditions: [
      'scope_or_connection_revision_changed',
      'source_revision_or_fingerprint_changed',
      'authoritative_source_is_missing_or_ambiguous',
      'remote_result_is_unknown',
      'shop_or_api_requires_unverified_metadata',
      'requested_action_exceeds_authorization',
    ],
    claimBoundary: [
      'upload_ack_is_not_listing_verification',
      'http_success_can_contain_a_business_error',
      'create_success_is_not_qc_or_publication_success',
      'fixture_or_sandbox_evidence_is_not_production_evidence',
      'unknown_outcome_must_not_be_replayed_without_readback',
    ],
  };
}

export const managementHandoffSchema = z
  .object({
    version: z.literal(1),
    updatedAt: z.string().datetime(),
    repository: z.object({ branch: z.string().min(1), commit: z.string().min(7) }).strict(),
    objective: z.string().min(1),
    state: z.enum(['stable', 'attention', 'blocked']),
    authoritativeSources: z
      .array(
        z
          .object({
            label: z.string().min(1),
            location: z.string().min(1),
            kind: z.enum(['code', 'database', 'file', 'remote_readback', 'documentation']),
          })
          .strict(),
      )
      .min(1),
    activeWork: z.array(
      z
        .object({
          name: z.string().min(1),
          status: z.enum(['complete', 'in_progress', 'blocked', 'not_started']),
          nextAction: z.string().min(1),
        })
        .strict(),
    ),
    doNotReplay: z.array(z.string().min(1)),
    verification: z.array(
      z
        .object({
          check: z.string().min(1),
          result: z.enum(['passed', 'failed', 'not_run', 'not_applicable']),
          evidence: z.string().min(1).optional(),
        })
        .strict(),
    ),
    knownLimits: z.array(z.string().min(1)),
    nextActions: z.array(z.string().min(1)),
  })
  .strict();

export type ManagementHandoff = z.infer<typeof managementHandoffSchema>;

export function parseManagementHandoff(value: unknown): ManagementHandoff {
  return managementHandoffSchema.parse(value);
}

export function renderManagementBrief(corridor: ManagementCorridor): string {
  return [
    `mode=${corridor.mode}`,
    `risk=${corridor.risk}`,
    `scope=${corridor.scope.environment}/${corridor.scope.partnerId}/${corridor.scope.shopId}`,
    `source=${corridor.source.planId}@${corridor.source.revision}`,
    `canWriteShopee=${String(corridor.canWriteShopee)}`,
    `blockedBy=${corridor.blockedBy.join(',') || 'none'}`,
    `sequence=${corridor.requiredSequence.join(' -> ')}`,
    `stop=${corridor.stopConditions.join(',')}`,
    `claims=${corridor.claimBoundary.join(',')}`,
  ].join('\n');
}
