import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from '../packages/persistence/src/index.js';
import { SecretBox } from '../packages/shopee/src/index.js';
import { ProductionPilotTransport } from '../packages/shopee/src/production-pilot-transport.js';
import type { PreparedWireResponse } from '../packages/shopee/src/prepared-transport.js';

// Read-only, exact four-source inspection. Full category_recommend source read (2022-07-04):
// GET, required item_name; optional cover image ID is deliberately omitted. Suggestions are
// not proof of category registration, document approval, product fit, or permission to publish.
const scope = Object.freeze({ environment: 'production' as const, partnerId: '2010476', shopId: '1423724897' });
const batchId = 'production-batch-pass1-20260915';
const sourceRoot = resolve('.local', batchId);
const receiptPath = resolve(sourceRoot, 'source-audit/source-receipt.json');
const definitions = [
  ['row-119', '510', 'DAHUwW7ykRA'], ['row-193', '775', 'DAHUw7s0-JQ'],
  ['row-194', '777', 'DAHUw9nu-fA'], ['row-192', '772', 'DAHUw8fpWQM'],
] as const;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function fail(code: string): never { throw new Error('PASS1_CATEGORY_' + code); }
const positiveId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
type Source = { sourceKey: string; title: string; sourceFileId: string; markdownSha256: string };
type Candidate = { categoryId: number; path: string | null; inShopTree: boolean; leaf: boolean | null; pathVerified: boolean };
type ListingResult = { sourceKey: string; state: 'success' | 'rejected' | 'unknown'; requestId?: string;
  code?: string; candidates: Candidate[] };
type Read = (path: string, query: Record<string, string>) => Promise<PreparedWireResponse>;
type Save = (name: string, value: unknown) => Promise<void>;
type Options = { receiptBytes: Buffer; expectedSha256: string;
  readMarkdown: (path: string) => Promise<Buffer>; read: Read; save: Save };

async function sources(options: Options): Promise<Source[]> {
  if (!/^[a-f0-9]{64}$/.test(options.expectedSha256) || options.receiptBytes.length > 8 * 1024 * 1024 ||
    hash(options.receiptBytes) !== options.expectedSha256) fail('SOURCE_DIGEST_MISMATCH');
  let raw: unknown;
  try { raw = JSON.parse(options.receiptBytes.toString('utf8')); } catch { fail('SOURCE_INVALID'); }
  if (!record(raw) || raw.version !== 1 || raw.batchId !== batchId || !record(raw.scope) ||
    Object.entries(scope).some(([key, value]) => (raw.scope as Record<string, unknown>)[key] !== value) ||
    !Array.isArray(raw.listings) || raw.listings.length !== 4 || !Array.isArray(raw.sourceFiles)) fail('SOURCE_SCOPE_INVALID');
  const receipt = raw as { listings: Record<string, unknown>[]; sourceFiles: Record<string, unknown>[] };
  const result: Source[] = [];
  for (const [sourceKey, sourceNumber, canvaId] of definitions) {
    const matches = receipt.listings.filter(entry => record(entry) && entry.sourceKey === sourceKey);
    const listing = matches[0];
    if (matches.length !== 1 || !listing || listing.sourceNumber !== sourceNumber || listing.canvaId !== canvaId ||
      listing.sourceFileId !== 'markdown-' + sourceNumber || typeof listing.title !== 'string' ||
      !listing.title.trim() || listing.title.length > 4096) fail('SOURCE_LISTING_INVALID');
    const files = receipt.sourceFiles.filter(entry => record(entry) && entry.id === listing.sourceFileId);
    const file = files[0];
    if (files.length !== 1 || !file || file.role !== 'listing-markdown' || typeof file.path !== 'string' ||
      !file.path.toLowerCase().endsWith('.md') || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) fail('SOURCE_FILE_INVALID');
    const markdown = await options.readMarkdown(file.path as string);
    if (markdown.length > 8 * 1024 * 1024 || hash(markdown) !== file.sha256) fail('MARKDOWN_DIGEST_MISMATCH');
    result.push({ sourceKey, title: listing.title as string, sourceFileId: listing.sourceFileId as string,
      markdownSha256: file.sha256 as string });
  }
  return result;
}

function tree(raw: unknown) {
  if (!Array.isArray(raw) || !raw.length || raw.length > 100000) return fail('TREE_INVALID');
  const entries = new Map<number, Record<string, unknown>>();
  for (const entry of raw) {
    if (!record(entry) || !positiveId(entry.category_id) || entries.has(entry.category_id) ||
      typeof entry.parent_category_id !== 'number' || !Number.isSafeInteger(entry.parent_category_id) || entry.parent_category_id < 0 ||
      typeof entry.has_children !== 'boolean' || typeof entry.original_category_name !== 'string' ||
      typeof entry.display_category_name !== 'string') fail('TREE_INVALID');
    entries.set(entry.category_id as number, entry);
  }
  return (id: number): Candidate => {
    const start = entries.get(id);
    if (!start) return { categoryId: id, path: null, inShopTree: false, leaf: null, pathVerified: false };
    const labels: string[] = [], seen = new Set<number>();
    let cursor: Record<string, unknown> | undefined = start;
    while (cursor) {
      const current = cursor.category_id as number;
      if (seen.has(current) || seen.size > 32) return { categoryId: id, path: null,
        inShopTree: true, leaf: start.has_children === false, pathVerified: false };
      seen.add(current);
      labels.unshift((cursor.display_category_name || cursor.original_category_name) as string);
      const parent = cursor.parent_category_id as number;
      if (parent === 0) return { categoryId: id, path: labels.join(' > '), inShopTree: true,
        leaf: start.has_children === false, pathVerified: true };
      cursor = entries.get(parent);
    }
    return { categoryId: id, path: null, inShopTree: true, leaf: start.has_children === false, pathVerified: false };
  };
}

export async function inspectPass1Recommendations(options: Options) {
  const selectedSources = await sources(options);
  await options.save('source', { scope, batchId, sourceReceiptSha256: options.expectedSha256,
    sources: selectedSources, readOnly: true, uploads: 0, mutations: 0, categorySelection: null });
  const read = async (path: string, query: Record<string, string>, name: string) => {
    const result = await options.read(path, query);
    await options.save(name, { observedAt: new Date().toISOString(), scope, method: 'GET', path, query, result });
    return result;
  };
  const shop = await read('/api/v2/shop/get_shop_info', {}, 'shop');
  if (shop.kind !== 'success' || typeof shop.response.shop_name !== 'string' || !shop.response.shop_name ||
    shop.response.region !== 'VN' || shop.response.status !== 'NORMAL' ||
    (shop.response.shop_id !== undefined && String(shop.response.shop_id) !== scope.shopId)) fail('SHOP_UNVERIFIED');
  const categories = await read('/api/v2/product/get_category', { language: 'vi' }, 'categories');
  if (categories.kind !== 'success') fail('TREE_READ_FAILED');
  const candidate = tree(categories.response.category_list);
  const listings: ListingResult[] = [];
  for (const source of selectedSources) {
    const response = await read('/api/v2/product/category_recommend', { item_name: source.title }, source.sourceKey);
    const common = { sourceKey: source.sourceKey, ...(response.requestId ? { requestId: response.requestId } : {}) };
    if (response.kind !== 'success') {
      listings.push({ ...common, state: response.kind, code: response.code, candidates: [] });
      continue;
    }
    const ids = response.response.category_id;
    if (!Array.isArray(ids) || ids.length > 1000 || !ids.every(positiveId) || new Set(ids).size !== ids.length) {
      listings.push({ ...common, state: 'unknown', code: 'PASS1_CATEGORY_RECOMMENDATION_INVALID', candidates: [] });
      continue;
    }
    listings.push({ ...common, state: 'success', candidates: ids.map(candidate) });
  }
  return { readOnly: true, mutations: 0, uploads: 0, sourceReceiptSha256: options.expectedSha256,
    scope, shop: { name: shop.response.shop_name, region: shop.response.region, requestId: shop.requestId },
    categoryTreeRequestId: categories.requestId, categorySelection: null, categoryAuthorizationVerified: false,
    productDocumentApprovalVerified: false, listings };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !/^--source-sha256=[a-f0-9]{64}$/.test(args[0] ?? '')) {
    console.error('Usage: inspect-pass1-category-recommendations.mts --source-sha256=<frozen receipt SHA-256>');
    process.exitCode = 1; return;
  }
  const expectedSha256 = args[0]!.split('=')[1]!;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const output = resolve(sourceRoot, 'category-recommendations', randomUUID());
  let created = false;
  try {
    const receiptBytes = await readFile(receiptPath);
    // Verify the entire source before decrypting credentials or contacting Shopee.
    await sources({ receiptBytes, expectedSha256, readMarkdown: readFile,
      read: async () => fail('UNEXPECTED_SOURCE_NETWORK'), save: async () => undefined });
    const rows = (await pool.query(`SELECT id,environment,partner_id,shop_id,revision,state,expires_at,
      partner_key_ciphertext,token_ciphertext FROM connections
      WHERE environment='production' AND partner_id=$1 AND shop_id=$2`, [scope.partnerId, scope.shopId])).rows;
    const row = rows[0];
    if (rows.length !== 1 || !row || row.state !== 'connected' || !row.expires_at ||
      new Date(row.expires_at).getTime() <= Date.now()) fail('CONNECTION_NOT_READY');
    const box = new SecretBox(process.env.APP_ENCRYPTION_KEY ?? '');
    const context = `${scope.environment}:${scope.partnerId}:${scope.shopId}`;
    const key = box.open(row.partner_key_ciphertext, context) as { partnerKey: string };
    const token = box.open(row.token_ciphertext, context) as { accessToken: string };
    // No mutation permit is constructed or supplied.
    const transport = new ProductionPilotTransport({ ...scope, partnerKey: key.partnerKey, accessToken: token.accessToken });
    const save: Save = async (name, value) => {
      if (!/^[A-Za-z0-9_-]+$/.test(name)) fail('EVIDENCE_NAME_INVALID');
      await writeFile(resolve(output, name + '.json'), JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
    };
    await mkdir(output, { recursive: true }); created = true;
    const result = await inspectPass1Recommendations({ receiptBytes, expectedSha256, readMarkdown: readFile, save,
      read: async (path, query) => {
        const current = (await pool.query(`SELECT revision,state,expires_at FROM connections
          WHERE id=$1 AND environment='production' AND partner_id=$2 AND shop_id=$3`,
        [row.id, scope.partnerId, scope.shopId])).rows[0];
        if (!current || current.revision !== row.revision || current.state !== 'connected' ||
          !current.expires_at || new Date(current.expires_at).getTime() <= Date.now()) fail('CONNECTION_CHANGED');
        return transport.read(path, query);
      } });
    await save('summary', { ...result, connectionId: row.id, connectionRevision: row.revision });
    console.log(JSON.stringify({ ...result, evidenceDirectory: output }));
    if (result.listings.some(entry => entry.state !== 'success')) process.exitCode = 2;
  } catch (error) {
    const code = error instanceof Error && /^PASS1_CATEGORY_[A-Z_]+$/.test(error.message)
      ? error.message : 'PASS1_CATEGORY_INSPECTION_FAILED';
    if (created) await writeFile(resolve(output, 'failure.json'), JSON.stringify({ code }), { flag: 'wx', mode: 0o600 }).catch(() => undefined);
    console.error(JSON.stringify({ code, ...(created ? { evidenceDirectory: output } : {}) }));
    process.exitCode = 1;
  } finally { await pool.end(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
