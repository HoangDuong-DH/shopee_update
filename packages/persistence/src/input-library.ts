import {
  canonicalJson,
  type InputBatchDetail,
  type InputBatchFile,
  type InputBatchRecord,
  type InputBatchState,
  type InputBatchSummary,
  type InputLibrary,
  type InputLibraryImport,
  type ListingDraft,
  type Fact,
  type WorkbookImport,
} from '@shopee/domain';
import { folderManifestSchema } from '../../domain/src/folder-manifest.js';
import { compileDescription } from '../../domain/src/source/normalize.js';
import type { Pool, PoolClient } from 'pg';
import { transaction } from './db.js';
import { localArchiveList, lockLocalSourceSelection, assertLocalResourcesActive, type LocalLifecycle } from './local-archives.js';

const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();
const sourceRecord = (row: any): InputLibraryImport => ({
  id: row.id,
  sha256: row.sha256,
  filename: row.filename,
  kind: row.kind,
  bytes: Number(row.bytes),
  status: row.status,
  message: row.message,
  createdAt: iso(row.created_at),
  body: row.body,
});
const batchRecord = (row: any): InputBatchRecord => ({
  id: row.id,
  revision: row.revision,
  state: row.state,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
});
const extensionKind = (name: string): InputLibraryImport['kind'] | undefined => {
  const extension = name.slice(name.lastIndexOf('.')).toLowerCase();
  return extension === '.xlsx'
    ? 'xlsx'
    : extension === '.docx'
      ? 'docx'
      : ['.png', '.jpg', '.jpeg', '.webp'].includes(extension)
        ? 'image'
        : undefined;
};
const groupFor = (path: string, mode: InputBatchState['mode']): string =>
  path
    .split('/')
    .slice(0, mode === 'single_listing' ? 1 : 2)
    .join('/');

function validateShape(state: InputBatchState): Map<string, InputBatchFile[]> {
  const groups = new Map<string, InputBatchFile[]>();
  const paths = new Map<string, InputBatchFile>();
  const roots = new Set<string>();
  let bytes = 0;
  for (const file of state.files) {
    const parts = file.relativePath.split('/');
    if (
      /[\x00-\x1f\\:*?"<>|]/.test(file.relativePath) ||
      parts.some((part) => !part || part === '.' || part === '..') ||
      parts.length < (state.mode === 'single_listing' ? 2 : 3) ||
      parts.at(-1) !== file.name ||
      paths.has(file.relativePath)
    )
      throw new Error('INPUT_BATCH_PATH_INVALID');
    bytes += file.size;
    roots.add(parts[0]);
    paths.set(file.relativePath, file);
    const key = groupFor(file.relativePath, state.mode);
    const grouped = groups.get(key);
    if (grouped) grouped.push(file);
    else groups.set(key, [file]);
  }
  if (roots.size > 1 || groups.size > 500 || bytes > 50 * 1024 * 1024 * 1024)
    throw new Error('INPUT_BATCH_PATH_INVALID');
  const keys = Object.entries(state.productKeys);
  if (
    keys.length !== groups.size ||
    keys.some(([key]) => !groups.has(key)) ||
    new Set(keys.map(([, key]) => key)).size !== keys.length
  )
    throw new Error('INPUT_BATCH_PRODUCT_KEY_CONFLICT');
  const requirePath = (group: string, path: string, kind: 'image' | 'docx') => {
    const file = paths.get(path);
    if (
      !groups.has(group) ||
      !file ||
      groupFor(path, state.mode) !== group ||
      extensionKind(file.name) !== kind
    )
      throw new Error('INPUT_BATCH_SELECTION_INVALID');
  };
  for (const [group, media] of Object.entries(state.visual)) {
    if (!groups.has(group)) throw new Error('INPUT_BATCH_SELECTION_INVALID');
    for (const list of [media.galleryPaths, media.descriptionPaths]) {
      if (new Set(list).size !== list.length) throw new Error('INPUT_BATCH_SELECTION_INVALID');
      for (const path of list) requirePath(group, path, 'image');
    }
    if (media.coverPath) requirePath(group, media.coverPath, 'image');
  }
  for (const [group, path] of Object.entries(state.wordPaths)) requirePath(group, path, 'docx');
  return groups;
}

// Display-only reopening check. Uses already parsed records and stored hashes, never source bytes.
// Merely naming an existing product in a portable manifest must not mark an intake complete.
function savedManifestMatches(
  state: InputBatchState,
  group: string,
  saved: ListingDraft | undefined,
  sources: ReadonlyMap<string, InputLibraryImport>,
): boolean {
  const stored = state.manifests?.[group];
  const parsed = folderManifestSchema.safeParse(stored?.document);
  if (!parsed.success || !saved || !stored) return false;
  const m = parsed.data,
    selection = state.priceSelection;
  const sidecar = state.files.filter((f) => f.relativePath === group + '/listing-source.json');
  if (
    m.product.sourceRevision <= 0 ||
    saved.productKey !== m.product.productKey ||
    saved.revision !== m.product.sourceRevision ||
    sidecar.length !== 1 ||
    stored.relativePath !== sidecar[0]!.relativePath ||
    stored.sha256 !== sidecar[0]!.sha256 ||
    sidecar[0]!.importId ||
    !selection ||
    (m.sourceListingId?.value ?? null) !== (saved.sourceListingId?.value ?? null)
  )
    return false;
  const price = sources.get(selection.importId),
    workbook = price?.body as WorkbookImport | undefined;
  if (
    price?.status !== 'ready' ||
    price.kind !== 'xlsx' ||
    price.sha256 !== m.priceSource.sha256 ||
    selection.sheet !== m.priceSource.sheet ||
    (m.priceSource.selectionMode === 'operator_choice'
      ? !selection.priceProfile?.trim()
      : selection.priceProfile !== m.priceSource.priceProfile) ||
    !Array.isArray(workbook?.rows)
  )
    return false;
  function file(ref: { path: string; sha256: string }, kind: 'docx' | 'image') {
    const matches = state.files.filter((f) => f.relativePath === group + '/' + ref.path);
    if (matches.length !== 1 || !matches[0]!.importId || matches[0]!.sha256 !== ref.sha256)
      return undefined;
    const source = sources.get(matches[0]!.importId!);
    return source?.kind === kind &&
      source.status === 'ready' &&
      source.sha256 === ref.sha256 &&
      source.bytes === matches[0]!.size
      ? source
      : undefined;
  }
  const word = file(m.word, 'docx');
  const paragraphs = (word?.body as { paragraphs?: unknown } | undefined)?.paragraphs;
  if (!Array.isArray(paragraphs) || paragraphs.some((p) => typeof p !== 'string')) return false;
  const text = (range: { start: number; end: number } | undefined) =>
    !range
      ? ''
      : range.end > paragraphs.length
        ? undefined
        : paragraphs.slice(range.start - 1, range.end).join(m.word.paragraphSeparator);
  const title = text(m.word.title),
    headline = text(m.word.headline),
    body = text(m.word.body);
  if (
    title === undefined ||
    headline === undefined ||
    body === undefined ||
    saved.title.value !== title
  )
    return false;
  const refs = [
    ...(m.media.cover ? [m.media.cover] : []),
    ...m.media.gallery,
    ...m.media.description,
    ...m.variants.flatMap((v) => (v.image ? [v.image] : [])),
  ];
  if (refs.some((ref) => !file(ref, 'image'))) return false;
  const assetHash = (key: string | undefined) => {
    if (!key) return null;
    const assets = saved!.assets.filter((asset) => asset.key === key);
    return assets.length === 1 && assets[0]!.sha256 ? assets[0]!.sha256 : undefined;
  };
  const usedAssetKeys = [
    ...(saved.coverKey ? [saved.coverKey] : []),
    ...saved.galleryKeys,
    ...saved.description.flatMap((block) => (block.type === 'image' ? [block.assetKey] : [])),
    ...saved.variants.flatMap((variant) => (variant.imageKey ? [variant.imageKey] : [])),
  ];
  if (usedAssetKeys.some((key) => assetHash(key) === undefined)) return false;
  const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
  const samePriceFact = (actual: Fact<string>, expected: Fact<string> | undefined) => {
    if (
      !expected ||
      !actual.confirmed ||
      !expected.confirmed ||
      actual.value !== expected.value ||
      actual.sources.length !== 1 ||
      expected.sources.length !== 1
    )
      return false;
    const a = actual.sources[0]!,
      b = expected.sources[0]!;
    return (
      a.kind === 'product_file' &&
      b.kind === 'product_file' &&
      a.fileSha256 === price.sha256 &&
      b.fileSha256 === price.sha256 &&
      a.locator === b.locator &&
      b.locator.startsWith(selection.sheet + '!') &&
      /^[A-Z]+[1-9]\d*$/.test(b.locator.slice(selection.sheet.length + 1))
    );
  };
  const description = compileDescription(
    headline,
    body,
    m.media.description.map((ref) => ref.sha256),
  );
  const savedDescription = saved.description.map((block) =>
    block.type === 'text'
      ? { type: 'text', text: block.text }
      : { type: 'image', assetKey: assetHash(block.assetKey) },
  );
  if (
    !same(savedDescription, description) ||
    assetHash(saved.coverKey) !== (m.media.cover?.sha256 ?? null) ||
    !same(
      saved.galleryKeys.map(assetHash),
      m.media.gallery.map((ref) => ref.sha256),
    ) ||
    !same(saved.tierNames, m.tierNames) ||
    saved.variants.length !== m.variants.length
  )
    return false;
  return m.variants.every((variant, index) => {
    const rows = workbook.rows.filter(
      (row) =>
        row.sku.value === variant.sku &&
        row.sheet === selection.sheet &&
        (row.priceProfile ?? null) === selection.priceProfile &&
        (!variant.rowKey || row.key === variant.rowKey),
    );
    const actual = saved.variants[index];
    return (
      rows.length === 1 &&
      !!actual &&
      samePriceFact(actual.sku, rows[0]!.sku) &&
      samePriceFact(actual.originalPrice, rows[0]!.originalPrice) &&
      actual.key === rows[0]!.key &&
      actual.sku.value === variant.sku &&
      actual.originalPrice.value === rows[0]!.originalPrice!.value &&
      same(actual.optionLabels, variant.optionLabels) &&
      assetHash(actual.imageKey) === (variant.image?.sha256 ?? null)
    );
  });
}

export class InputLibraryRepository {
  constructor(readonly pool: Pool) {}

  private async validateReferences(client: PoolClient, state: InputBatchState) {
    const ids = [
      ...new Set([
        ...state.files.flatMap((file) => (file.importId ? [file.importId] : [])),
        ...(state.priceSelection ? [state.priceSelection.importId] : []),
      ]),
    ];
    const rows = ids.length
      ? (
          await client.query(
            `SELECT id,sha256,bytes,kind,status,CASE WHEN id=$2::uuid THEN body ELSE NULL END AS body
             FROM source_files WHERE id=ANY($1::uuid[]) FOR SHARE`,
            [ids, state.priceSelection?.importId ?? null],
          )
        ).rows
      : [];
    const sources = new Map(rows.map((row) => [row.id, row]));
    for (const file of state.files) {
      if (!file.importId) continue;
      const source = sources.get(file.importId);
      if (
        !source ||
        !file.sha256 ||
        source.sha256 !== file.sha256 ||
        Number(source.bytes) !== file.size ||
        extensionKind(file.name) !== source.kind
      )
        throw new Error('INPUT_BATCH_SOURCE_MISMATCH');
    }
    if (state.priceSelection) {
      const selection = state.priceSelection;
      const source = sources.get(selection.importId);
      const workbook = source?.body as WorkbookImport | undefined;
      if (
        source?.kind !== 'xlsx' ||
        source.status !== 'ready' ||
        !Array.isArray(workbook?.rows) ||
        !Array.isArray(workbook?.sheets) ||
        !workbook.sheets.some((sheet) => sheet.name === selection.sheet) ||
        !workbook.rows.some(
          (row) =>
            row.sheet === selection.sheet && (row.priceProfile ?? null) === selection.priceProfile,
        )
      )
        throw new Error('INPUT_BATCH_PRICE_INVALID');
    }
  }

  async save(
    id: string,
    expectedRevision: number,
    state: InputBatchState,
  ): Promise<InputBatchRecord> {
    validateShape(state);
    const canonical = canonicalJson(state);
    return transaction(this.pool, async (client) => {
      await lockLocalSourceSelection(client);
      await assertLocalResourcesActive(client, [
        {kind:'input_batch',resourceId:id},
        ...Object.values(state.productKeys).map(resourceId=>({kind:'product' as const,resourceId})),
        ...state.files.flatMap(file=>file.importId ? [{kind:'pricebook' as const,resourceId:file.importId}] : []),
        ...(state.priceSelection ? [{kind:'pricebook' as const,resourceId:state.priceSelection.importId}] : []),
      ]);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'input-batch:' + id,
      ]);
      const current = await client.query('SELECT * FROM input_batches WHERE id=$1 FOR UPDATE', [
        id,
      ]);
      const replay = await client.query(
        `SELECT b.id,r.revision,r.state,b.created_at,r.created_at AS updated_at
         FROM input_batch_revisions r JOIN input_batches b ON b.id=r.batch_id
         WHERE r.batch_id=$1 AND r.revision=$2`,
        [id, expectedRevision + 1],
      );
      if (replay.rows[0] && canonicalJson(replay.rows[0].state) === canonical)
        return batchRecord(replay.rows[0]);
      if ((current.rows[0]?.latest_revision ?? 0) !== expectedRevision)
        throw new Error('INPUT_BATCH_REVISION_CONFLICT');
      if (expectedRevision > 0) {
        const previous = (
          await client.query(
            'SELECT state FROM input_batch_revisions WHERE batch_id=$1 AND revision=$2',
            [id, expectedRevision],
          )
        ).rows[0]?.state as InputBatchState | undefined;
        for (const [group, mapping] of Object.entries(previous?.pendingMappings ?? {})) {
          const next = state.pendingMappings?.[group];
          if (
            !next ||
            canonicalJson({
              relativePath: mapping.relativePath,
              sha256: mapping.sha256,
              document: mapping.document,
            }) !==
              canonicalJson({
                relativePath: next.relativePath,
                sha256: next.sha256,
                document: next.document,
              })
          )
            throw new Error('INPUT_BATCH_PENDING_SOURCE_CHANGED');
        }
      }
      await this.validateReferences(client, state);
      const keys = Object.entries(state.productKeys).sort(([, left], [, right]) =>
        left.localeCompare(right),
      );
      const productKeys = keys.map(([, key]) => key);
      if (productKeys.length)
        await client.query(
          `SELECT pg_advisory_xact_lock(hashtextextended(product_key,0))
           FROM (SELECT unnest($1::text[]) AS product_key ORDER BY product_key) ordered_keys`,
          [productKeys],
        );
      const claims = await client.query(
        'SELECT * FROM input_batch_products WHERE batch_id=$1 OR product_key=ANY($2::text[])',
        [id, productKeys],
      );
      const priorGroups = new Map(
        claims.rows
          .filter((row) => row.batch_id === id)
          .map((row) => [row.group_key, row.product_key]),
      );
      const claimedKeys = new Map(claims.rows.map((row) => [row.product_key, row]));
      const existingProducts = new Set(
        (
          await client.query('SELECT product_key FROM products WHERE product_key=ANY($1::text[])', [
            productKeys,
          ])
        ).rows.map((row) => row.product_key),
      );
      for (const [group, key] of keys) {
        if (priorGroups.has(group) && priorGroups.get(group) !== key)
          throw new Error('INPUT_BATCH_PRODUCT_KEY_CONFLICT');
        const other = claimedKeys.get(key);
        if (other && (other.batch_id !== id || other.group_key !== group))
          throw new Error('INPUT_BATCH_PRODUCT_KEY_CONFLICT');
        if (!other && existingProducts.has(key))
          throw new Error('INPUT_BATCH_PRODUCT_KEY_CONFLICT');
      }
      const revision = expectedRevision + 1;
      const stored = await client.query(
        `INSERT INTO input_batches(id,latest_revision) VALUES($1,$2)
         ON CONFLICT(id) DO UPDATE SET latest_revision=$2,updated_at=now() RETURNING *`,
        [id, revision],
      );
      const snapshot = await client.query(
        'INSERT INTO input_batch_revisions(batch_id,revision,state) VALUES($1,$2,$3) RETURNING created_at',
        [id, revision, state],
      );
      const sourceIds = [
        ...new Set([
          ...state.files.flatMap((file) => (file.importId ? [file.importId] : [])),
          ...(state.priceSelection ? [state.priceSelection.importId] : []),
        ]),
      ];
      if (sourceIds.length)
        await client.query(
          'INSERT INTO input_batch_sources(batch_id,revision,source_id) SELECT $1,$2,unnest($3::uuid[])',
          [id, revision, sourceIds],
        );
      if (keys.length)
        await client.query(
          `INSERT INTO input_batch_products(batch_id,group_key,product_key)
           SELECT $1,group_key,product_key FROM unnest($2::text[],$3::text[]) AS pairs(group_key,product_key)
           ON CONFLICT(batch_id,group_key) DO NOTHING`,
          [id, keys.map(([group]) => group), productKeys],
        );
      return {
        id,
        revision,
        state,
        createdAt: iso(stored.rows[0].created_at),
        updatedAt: iso(snapshot.rows[0].created_at),
      };
    });
  }

  async get(id: string): Promise<InputBatchDetail | null> {
    const result = await this.pool.query(
      `SELECT b.id,r.revision,r.state,b.created_at,r.created_at AS updated_at
       FROM input_batches b JOIN input_batch_revisions r
       ON r.batch_id=b.id AND r.revision=b.latest_revision WHERE b.id=$1`,
      [id],
    );
    if (!result.rows[0]) return null;
    const record = batchRecord(result.rows[0]);
    const ids = [
      ...new Set([
        ...record.state.files.flatMap((file) => (file.importId ? [file.importId] : [])),
        ...(record.state.priceSelection ? [record.state.priceSelection.importId] : []),
      ]),
    ];
    const imports = ids.length
      ? (
          await this.pool.query(
            'SELECT * FROM source_files WHERE id=ANY($1::uuid[]) ORDER BY created_at,id',
            [ids],
          )
        ).rows.map(sourceRecord)
      : [];
    return { ...record, imports };
  }

  async list(lifecycle: LocalLifecycle = 'active'): Promise<InputBatchSummary[]> {
    const result = await this.pool.query(
      `SELECT b.id,r.revision,r.state,r.state->>'name' AS name,r.created_at AS updated_at,a.archived_at,
       jsonb_array_length(r.state->'files') AS file_count,
       (SELECT count(*)::int FROM jsonb_object_keys(r.state->'productKeys')) AS folder_count,
       r.state->'priceSelection' AS price_selection,
       (SELECT count(*)::int FROM jsonb_each_text(r.state->'productKeys') k
        JOIN products p ON p.product_key=COALESCE(
          CASE WHEN COALESCE(r.state->'manifests'->k.key,r.state->'pendingMappings'->k.key)->'document'->'product'->>'sourceRevision'='0'
            THEN (SELECT c.product_key FROM folder_source_claims c
              WHERE c.product_key=COALESCE(r.state->'manifests'->k.key,r.state->'pendingMappings'->k.key)->'document'->'product'->>'productKey') END,
          k.value)
        WHERE COALESCE(r.state->'manifests'->k.key->'document'->'product'->>'sourceRevision','0')='0') AS completed_count
       FROM input_batches b JOIN input_batch_revisions r
       ON r.batch_id=b.id AND r.revision=b.latest_revision
       LEFT JOIN local_resource_archives a ON a.kind='input_batch' AND a.resource_id=b.id::text
       WHERE $1='all' OR (a.archived_at IS NOT NULL)=($1='archived') ORDER BY b.updated_at DESC,b.id`,
      [lifecycle],
    );
    const candidates = result.rows.flatMap((row) =>
      Object.entries((row.state as InputBatchState).manifests ?? {})
        .filter(([, manifest]) => manifest.document.product.sourceRevision > 0)
        .map(([group, manifest]) => ({
          state: row.state as InputBatchState,
          group,
          productKey: manifest.document.product.productKey,
        })),
    );
    const ids = [
      ...new Set(
        candidates.flatMap(({ state }) => [
          ...state.files.flatMap((file) => (file.importId ? [file.importId] : [])),
          ...(state.priceSelection ? [state.priceSelection.importId] : []),
        ]),
      ),
    ];
    const keys = [...new Set(candidates.map((c) => c.productKey))];
    const [sourceRows, productRows] = candidates.length
      ? await Promise.all([
          this.pool.query(
            `SELECT id,sha256,filename,kind,bytes,status,message,created_at,
        CASE WHEN kind IN ('docx','xlsx') THEN body ELSE NULL END AS body
        FROM source_files WHERE id=ANY($1::uuid[])`,
            [ids],
          ),
          this.pool.query(
            `SELECT p.product_key,r.body FROM products p JOIN product_revisions r
        ON r.product_key=p.product_key AND r.revision=p.latest_revision WHERE p.product_key=ANY($1::text[])`,
            [keys],
          ),
        ])
      : [{ rows: [] }, { rows: [] }];
    const sources = new Map<string, InputLibraryImport>(
      sourceRows.rows.map((row) => [row.id, sourceRecord(row)]),
    );
    const products = new Map<string, ListingDraft>(
      productRows.rows.map((row) => [row.product_key, row.body]),
    );
    return result.rows.map((row) => ({
      id: row.id,
      revision: row.revision,
      name: row.name,
      updatedAt: iso(row.updated_at),
      folderCount: row.folder_count,
      fileCount: row.file_count,
      completedCount:
        row.completed_count +
        Object.entries((row.state as InputBatchState).manifests ?? {}).filter(
          ([group, manifest]) =>
            manifest.document.product.sourceRevision > 0 &&
            savedManifestMatches(
              row.state,
              group,
              products.get(manifest.document.product.productKey),
              sources,
            ),
        ).length,
      priceSelection: row.price_selection,
      archived:!!row.archived_at,
      archivedAt:row.archived_at ? iso(row.archived_at) : null,
    }));
  }

  async library(lifecycle: LocalLifecycle = 'active'): Promise<InputLibrary> {
    const [batches, workbooks, unassigned] = await Promise.all([
      this.list(lifecycle),
      this.pool.query(`SELECT id,filename,status,created_at,bytes,
        COALESCE(jsonb_array_length(body->'rows'),0) AS row_count,
        COALESCE(jsonb_array_length(body->'sheets'),0) AS sheet_count,
        COALESCE(jsonb_array_length(body->'issues'),0) +
        COALESCE((SELECT sum(jsonb_array_length(COALESCE(r->'issues','[]'::jsonb)))::int
          FROM jsonb_array_elements(COALESCE(body->'rows','[]'::jsonb)) r),0) AS issue_count
        FROM source_files WHERE kind='xlsx' ORDER BY created_at DESC,id`),
      this.pool.query(`
        WITH batch_sources AS (
          SELECT s.source_id FROM input_batches b JOIN input_batch_sources s
          ON s.batch_id=b.id AND s.revision=b.latest_revision
        ), product_sources AS (
          SELECT a->>'key' AS id,a->>'sha256' AS sha256 FROM products p
          JOIN product_revisions r ON r.product_key=p.product_key AND r.revision=p.latest_revision
          CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r.body->'assets','[]'::jsonb)) a
          UNION ALL
          SELECT NULL, ref.value #>> '{}' FROM products p
          JOIN product_revisions r ON r.product_key=p.product_key AND r.revision=p.latest_revision
          CROSS JOIN LATERAL jsonb_path_query(r.body,'$.**.fileSha256') AS ref(value)
        )
        SELECT s.*,NULL AS body FROM source_files s WHERE s.kind<>'xlsx'
        AND NOT EXISTS(SELECT 1 FROM batch_sources b WHERE b.source_id=s.id)
        AND NOT EXISTS(SELECT 1 FROM product_sources p WHERE p.id=s.id::text OR p.sha256=s.sha256)
        ORDER BY s.created_at DESC,s.id
      `),
    ]);
    return {
      batches,
      priceBooks: await localArchiveList(this.pool, 'pricebook', workbooks.rows.map((row) => {
        return {
          id: row.id,
          filename: row.filename,
          status: row.status,
          createdAt: iso(row.created_at),
          bytes: Number(row.bytes),
          rowCount: row.row_count,
          sheetCount: row.sheet_count,
          issueCount: row.issue_count,
        };
      }), row => row.id, lifecycle),
      unassigned: lifecycle === 'archived' ? [] : unassigned.rows.map(sourceRecord),
    };
  }
}
