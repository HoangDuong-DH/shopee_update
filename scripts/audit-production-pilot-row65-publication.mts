import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from '@shopee/persistence';
import { canonicalJson } from '@shopee/domain';
import { normalizePreparedWireSnapshot } from '../packages/shopee/src/prepared-wire.js';

// Only SQL SELECTs inside a read-only transaction, and local immutable evidence reads.
const operationId = '007738be-04ec-4ead-88d2-825062b29056', itemId = '51267858328';
const scope = { environment: 'production', partnerId: '2010476', shopId: '1423724897' };
const directory = resolve('.local/production-pilot-1423724897');
const hash = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const normalized = (r: any) => normalizePreparedWireSnapshot({ item: r.raw.base.response.item_list[0], models: r.raw.models.response });
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  const client = await pool.connect();
  let op: any, steps: any[], created: any[], publications: any[], verified: any[], cases: any[], reviews: any[], row2Rows: any[], laneCount: number;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    op = (await client.query('SELECT * FROM production_pilot_operations WHERE id=$1', [operationId])).rows[0];
    steps = (await client.query('SELECT * FROM production_pilot_steps WHERE operation_id=$1 ORDER BY ordinal', [operationId])).rows;
    created = (await client.query('SELECT * FROM production_pilot_verifications WHERE operation_id=$1', [operationId])).rows;
    publications = (await client.query('SELECT * FROM production_pilot_publications WHERE create_operation_id=$1', [operationId])).rows;
    verified = (await client.query('SELECT v.* FROM production_pilot_publication_verifications v JOIN production_pilot_publications p ON p.id=v.operation_id WHERE p.create_operation_id=$1', [operationId])).rows;
    cases = (await client.query("SELECT * FROM image_qc_cases WHERE id='8e7e10d0-b3ee-4b3a-8985-cfce3ab3e326'")).rows;
    reviews = (await client.query("SELECT * FROM image_qc_reviews WHERE case_id='8e7e10d0-b3ee-4b3a-8985-cfce3ab3e326'")).rows;
    laneCount = Number((await client.query('SELECT count(*) AS count FROM production_pilot_lanes WHERE operation_id=$1', [operationId])).rows[0].count);
    row2Rows = (await client.query(`SELECT row_to_json(o) AS operation,
      (SELECT json_agg(v ORDER BY v.id) FROM production_pilot_verifications v WHERE v.operation_id=o.id) AS verifications,
      (SELECT json_agg(s ORDER BY s.id) FROM production_pilot_steps s WHERE s.operation_id=o.id) AS steps,
      (SELECT json_agg(p ORDER BY p.id) FROM production_pilot_publications p WHERE p.create_operation_id=o.id) AS publications
      FROM production_pilot_operations o WHERE o.id='ec195c1c-b2e1-44d9-a866-e14a39988a9b'`)).rows;
    await client.query('COMMIT');
  } finally { client.release(); }
  if (!op || op.owner_key !== 'production:2010476:1423724897' || op.item_id !== itemId || op.source_revision !== 4 || created.length !== 1 || publications.length !== 1 || verified.length !== 1) throw Error('AUDIT_SCOPE_OR_COVERAGE_MISMATCH');
  const publication = publications[0], createProof = created[0], publishProof = verified[0];
  const originalAudit = JSON.parse(await readFile(resolve(directory, 'row65-initial-source-audit.json'), 'utf8'));
  const weightBytes = await readFile(resolve(directory, 'weight-reviews', operationId + '.json'));
  const weightReviewSha256 = createHash('sha256').update(weightBytes).digest('hex');
  const weightReview = JSON.parse(weightBytes.toString('utf8'));
  const row2Hash = createHash('sha256').update(JSON.stringify(row2Rows)).digest('hex');
  const expectedRow2Hash = '4774b33d82dfb176bb6a7cb94e6536d23695874f9e3affdf12aaf8f37af31358';
  const pre = publication.preflight_readbacks, post = publishProof.readbacks, createReads = createProof.readbacks;
  const expectedPostRaw = structuredClone(publication.expected_raw);
  expectedPostRaw.item.item_status = 'NORMAL';
  const expectedPostProjection = { ...op.expected_projection, status: 'NORMAL' };
  const countByKind = Object.fromEntries([...new Set(steps.map(s => s.kind))].map(kind => [kind, steps.filter(s => s.kind === kind).length]));
  const readAudit = (r: any, phase: string) => {
    const image = r.raw.coverImageQc, weight = r.raw.weightReview;
    return {
      phase, observedAt: r.observedAt, requestIds: r.requestIds, itemStatus: r.raw.base.response.item_list[0].item_status,
      connectionRevision: r.connectionRevision,
      scopeMatches: r.shopId === scope.shopId && r.partnerId === scope.partnerId && r.itemId === itemId,
      originalEnvelopesSuccessful: r.raw.base.error === '' && r.raw.models.error === '',
      requestIdsMatchEnvelopes: equal([...r.requestIds].sort(), [r.raw.base.request_id, r.raw.models.request_id].sort()),
      rawHashMatches: r.rawSha256 === undefined ? null : r.rawSha256 === hash(r.raw),
      projectionHashMatches: r.projectionSha256 === undefined ? null : r.projectionSha256 === hash(r.projection),
      cover: image,
      coverCaseBindingMatches: image?.caseId === cases[0]?.id && image?.caseFingerprint === cases[0]?.fingerprint && image?.sourceSha256 === cases[0]?.source_sha256 && image?.outputSha256 === cases[0]?.output_sha256 && image?.sourceFingerprint === op.source_fingerprint,
      weight: weight,
      weightReviewFileMatches: weight?.reviewSha256 === weightReviewSha256 && weight?.sourceFingerprint === op.source_fingerprint && weight?.operationId === operationId && weight?.itemId === itemId,
    };
  };
  const allReads = [...createReads.map((r: any) => readAudit(r, 'created_unlisted')), ...pre.map((r: any) => readAudit(r, 'before_publish')), ...post.map((r: any) => readAudit(r, 'published'))];
  const checks = {
    createVerified: op.state === 'verified' && createProof.phase === 'created_unlisted',
    publicationVerified: publication.state === 'verified' && publishProof.phase === 'published' && publishProof.basis === 'acknowledged',
    exactStepCounts: steps.length === 13 && steps.filter(s => s.kind === 'media').length === 11 && steps.filter(s => s.kind === 'create').length === 1 && steps.filter(s => s.kind === 'variations').length === 1,
    allCreateStepsAcknowledged: steps.every(s => s.state === 'acknowledged' && s.receipt?.kind === 'success'),
    uniqueStepReceiptIds: new Set(steps.map(s => s.receipt?.requestId)).size === steps.length,
    singleExactPublishPayload: publication.path === '/api/v2/product/unlist_item' && equal(publication.payload, { item_list: [{ item_id: Number(itemId), unlist: false }] }),
    singleExactPublishReceipt: publication.receipt?.kind === 'success' && equal(publication.receipt.response, { success_list: [{ item_id: Number(itemId), unlist: false }], failure_list: [] }),
    sourceHashStillInitial: op.source_fingerprint === originalAudit.sourceFingerprint,
    sourcePayloadStillInitial: equal(op.source_payload.document, originalAudit.frozenDocument),
    sourceFingerprintRecomputes: op.source_fingerprint === hash({ scope, sourceIdentity: op.source_identity, sourceRevision: op.source_revision, sourcePayload: op.source_payload, expectedProjection: op.expected_projection }),
    publicationSourceBindingMatches: publication.source_fingerprint === op.source_fingerprint && publication.create_verification_id === createProof.id && publication.item_id === itemId,
    createEvidenceFingerprintMatches: createProof.evidence_fingerprint === hash(createReads),
    publicationEvidenceFingerprintMatches: publishProof.evidence_fingerprint === hash(post),
    twoCreateReadsStable: createReads.length === 2 && equal(normalized(createReads[0]), normalized(createReads[1])),
    twoPrePublishReadsMatchOriginal: pre.length === 2 && pre.every((r: any) => equal(normalized(r), normalized(createReads[1])) && equal(r.projection, op.expected_projection)),
    twoNormalReadsPreserveAllOtherRawFields: post.length === 2 && post.every((r: any) => equal(normalized(r), expectedPostRaw)),
    twoNormalProjectionsMatchSource: post.length === 2 && post.every((r: any) => equal(r.projection, expectedPostProjection)),
    twoNormalReadsStable: post.length === 2 && equal(normalized(post[0]), normalized(post[1])),
    allReadProofsScopedAndBound: allReads.every(r => r.scopeMatches && r.originalEnvelopesSuccessful && r.requestIdsMatchEnvelopes && r.coverCaseBindingMatches && r.weightReviewFileMatches && r.rawHashMatches !== false && r.projectionHashMatches !== false),
    laneReleased: laneCount === 0,
    row2Unchanged: row2Hash === expectedRow2Hash,
  };
  const output = {
    observedAt: new Date().toISOString(), operationId, itemId, sourceFingerprint: op.source_fingerprint,
    sourceIdentity: op.source_identity, sourceRevision: op.source_revision, sourceWeightGrams: op.source_payload.document.models.map((m: any) => ({ sku: m.sku, weightGrams: m.weightGrams })),
    create: { state: op.state, verificationId: createProof.id, verifiedAt: createProof.verified_at, countByKind, steps: steps.map(s => ({ kind: s.kind, path: s.path, state: s.state, requestId: s.receipt?.requestId, sentAt: s.sent_at, recordedAt: s.recorded_at })) },
    publication: { id: publication.id, state: publication.state, connectionRevision: publication.connection_revision, path: publication.path, payload: publication.payload, requestId: publication.receipt?.requestId, receipt: publication.receipt, sentAt: publication.sent_at, recordedAt: publication.recorded_at, verificationId: publishProof.id, verifiedAt: publishProof.verified_at, evidenceFingerprint: publishProof.evidence_fingerprint },
    checks, failedChecks: Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name),
    reads: allReads, coverCase: cases[0], coverReview: reviews[0], weightReviewSha256, weightReview,
    row2Hash, expectedRow2Hash,
    mutations: 0, newShopeeApiReads: 0,
    note: 'Counts describe this immutable operation journal and its single publication. Original source/payloads and raw envelopes remain unchanged. The separate authorized weight and reviewed cover proofs are verified by hashes; no generic comparison rule was relaxed by this audit.'
  };
  const path = resolve(directory, 'row65-final-publication-audit.json');
  await writeFile(path, JSON.stringify(output, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ path, checks, failedChecks: output.failedChecks, publication: output.publication, publishedReads: allReads.filter(r => r.phase === 'published').map(r => ({ observedAt: r.observedAt, requestIds: r.requestIds, status: r.itemStatus, connectionRevision: r.connectionRevision })), weightReviewSha256, coverCaseFingerprint: cases[0]?.fingerprint, row2Hash }, null, 2));
} finally { await pool.end(); }
