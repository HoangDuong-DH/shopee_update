import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type KnowledgeSource = {
  id: string;
  title: string;
  url: string;
  kind: string;
  corpus: 'open-platform' | 'seller-vn';
  sourceUpdatedAt: string | null;
  capturedAt: string | null;
  sha256: string;
  integrity?: 'manifest_verified' | 'computed_only';
};

export type KnowledgeHit = KnowledgeSource & { excerpt: string };

export const KNOWLEDGE_ERROR_CODES = {
  UNKNOWN_DOCUMENT: 'KNOWLEDGE_UNKNOWN_DOCUMENT',
  OPEN_PLATFORM_UNAVAILABLE: 'KNOWLEDGE_OPEN_PLATFORM_UNAVAILABLE',
  SELLER_VN_UNAVAILABLE: 'KNOWLEDGE_SELLER_VN_UNAVAILABLE',
  SOURCE_NOT_ALLOWED: 'KNOWLEDGE_SOURCE_NOT_ALLOWED',
  PATH_OUTSIDE_ROOT: 'KNOWLEDGE_PATH_OUTSIDE_ROOT',
  DOCUMENT_UNAVAILABLE: 'KNOWLEDGE_DOCUMENT_UNAVAILABLE',
  DOCUMENT_TOO_LARGE: 'KNOWLEDGE_DOCUMENT_TOO_LARGE',
  INTEGRITY_MISMATCH: 'KNOWLEDGE_INTEGRITY_MISMATCH',
} as const;

type Corpus = KnowledgeSource['corpus'];
type RootConfig = { corpus: Corpus; root: string };
type ManifestRecord = Record<string, unknown>;
type IndexedSource = KnowledgeSource & { manifestId: string; path: string };

const MAX_QUERY_LENGTH = 512;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const MAX_EXCERPT_LENGTH = 600;
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;

export class KnowledgeLibrary {
  readonly #roots: RootConfig[];

  constructor(roots: RootConfig[]) {
    this.#roots = roots.map(({ corpus, root }) => ({ corpus, root: resolve(root) }));
  }

  async search(query: string, limit = DEFAULT_LIMIT): Promise<{ hits: KnowledgeHit[]; issues: string[] }> {
    const boundedLimit = Number.isFinite(limit)
      ? Math.max(1, Math.min(MAX_LIMIT, Math.trunc(limit)))
      : DEFAULT_LIMIT;
    const ftsQuery = toPlainTextFtsQuery(query.slice(0, MAX_QUERY_LENGTH));
    if (!ftsQuery) return { hits: [], issues: [] };

    const corpusHits: KnowledgeHit[][] = [];
    const issues: string[] = [];
    for (const config of this.#roots) {
      try {
        const manifest = await loadManifest(config);
        corpusHits.push(await searchIndex(config, manifest, ftsQuery, boundedLimit));
      } catch {
        corpusHits.push([]);
        issues.push(unavailableCode(config.corpus));
      }
    }
    return { hits: roundRobin(corpusHits, boundedLimit), issues };
  }

  async readDocument(id: string): Promise<{ source: KnowledgeSource; text: string }> {
    const separator = id.indexOf(':');
    const corpus = id.slice(0, separator) as Corpus;
    const manifestId = separator >= 0 ? id.slice(separator + 1) : '';
    if (!manifestId || (corpus !== 'open-platform' && corpus !== 'seller-vn')) {
      throw new Error(KNOWLEDGE_ERROR_CODES.UNKNOWN_DOCUMENT);
    }
    const config = this.#roots.find((candidate) => candidate.corpus === corpus);
    if (!config) throw new Error(KNOWLEDGE_ERROR_CODES.UNKNOWN_DOCUMENT);

    let manifest: Map<string, IndexedSource>;
    try {
      manifest = await loadManifest(config);
    } catch {
      throw new Error(unavailableCode(corpus));
    }
    const indexed = manifest.get(manifestId);
    if (!indexed) throw new Error(KNOWLEDGE_ERROR_CODES.UNKNOWN_DOCUMENT);
    assertAllowedShopeeUrl(indexed.url);

    const rootPath = await realpath(config.root).catch(() => {
      throw new Error(unavailableCode(corpus));
    });
    const candidate = resolve(rootPath, indexed.path);
    if (!isConfined(rootPath, candidate)) throw new Error(KNOWLEDGE_ERROR_CODES.PATH_OUTSIDE_ROOT);
    const actualPath = await realpath(candidate).catch(() => {
      throw new Error(KNOWLEDGE_ERROR_CODES.DOCUMENT_UNAVAILABLE);
    });
    if (!isConfined(rootPath, actualPath)) throw new Error(KNOWLEDGE_ERROR_CODES.PATH_OUTSIDE_ROOT);

    const file = await stat(actualPath);
    if (!file.isFile()) throw new Error(KNOWLEDGE_ERROR_CODES.DOCUMENT_UNAVAILABLE);
    if (file.size > MAX_DOCUMENT_BYTES) throw new Error(KNOWLEDGE_ERROR_CODES.DOCUMENT_TOO_LARGE);
    const buffer = await readFile(actualPath);
    if (buffer.byteLength > MAX_DOCUMENT_BYTES) throw new Error(KNOWLEDGE_ERROR_CODES.DOCUMENT_TOO_LARGE);
    const actualHash = createHash('sha256').update(buffer).digest('hex');
    if (indexed.sha256) {
      if (actualHash.toLowerCase() !== indexed.sha256.toLowerCase()) {
        throw new Error(KNOWLEDGE_ERROR_CODES.INTEGRITY_MISMATCH);
      }
    }
    return {
      source: {
        ...publicSource(indexed),
        sha256: actualHash,
        integrity: indexed.sha256 ? 'manifest_verified' : 'computed_only',
      },
      text: buffer.toString('utf8'),
    };
  }
}

async function loadManifest(config: RootConfig): Promise<Map<string, IndexedSource>> {
  const rootPath = await realpath(config.root);
  const manifestCandidate = resolve(rootPath, 'manifest.json');
  if (!isConfined(rootPath, manifestCandidate)) throw new Error('Invalid manifest.');
  const manifestPath = await realpath(manifestCandidate);
  if (!isConfined(rootPath, manifestPath)) throw new Error('Invalid manifest.');
  const info = await stat(manifestPath);
  if (!info.isFile() || info.size > MAX_MANIFEST_BYTES) throw new Error('Invalid manifest.');
  const parsed: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('Invalid manifest.');

  const entries = new Map<string, IndexedSource>();
  for (const raw of parsed) {
    if (!isRecord(raw)) continue;
    const source = manifestSource(config.corpus, raw);
    if (!source) continue;
    entries.set(source.manifestId, source);
  }
  return entries;
}

function manifestSource(corpus: Corpus, raw: ManifestRecord): IndexedSource | null {
  const manifestId = stringValue(raw.id);
  const title = stringValue(raw.title);
  const path = stringValue(raw.path);
  const url = stringValue(raw.source_url);
  const kind = stringValue(raw.kind);
  if (!manifestId || !title || !path || !url || !kind || isAbsolute(path)) return null;
  const sha256 = corpus === 'open-platform'
    ? stringValue(raw.markdown_sha256) ?? stringValue(raw.sha256) ?? ''
    : stringValue(raw.sha256) ?? stringValue(raw.markdown_sha256) ?? '';
  return {
    manifestId,
    path,
    id: `${corpus}:${manifestId}`,
    title,
    url,
    kind,
    corpus,
    sourceUpdatedAt: corpus === 'open-platform'
      ? nullableString(raw.source_updated_at)
      : nullableString(raw.source_date),
    capturedAt: nullableString(raw.retrieved_at),
    sha256,
  };
}

async function searchIndex(
  config: RootConfig,
  manifest: Map<string, IndexedSource>,
  query: string,
  limit: number,
): Promise<KnowledgeHit[]> {
  const rootPath = await realpath(config.root);
  const indexCandidate = resolve(rootPath, 'search.sqlite');
  const indexPath = await realpath(indexCandidate);
  if (!isConfined(rootPath, indexPath)) throw new Error(KNOWLEDGE_ERROR_CODES.PATH_OUTSIDE_ROOT);
  const indexInfo = await stat(indexPath);
  if (!indexInfo.isFile()) throw new Error(unavailableCode(config.corpus));
  const database = new DatabaseSync(indexPath, { readOnly: true });
  try {
    const schema = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chunks'").get() as
      | { sql?: string }
      | undefined;
    if (!schema?.sql?.toLowerCase().includes('virtual table chunks using fts5')) throw new Error('Invalid search index.');
    const isOpen = config.corpus === 'open-platform';
    const documentColumn = isOpen ? 'document_id' : 'doc_id';
    const textColumn = isOpen ? 'content' : 'body';
    const metadataHits = exactMetadataHits(manifest, query, limit);
    const rows = database
      .prepare(
        `SELECT ${documentColumn} AS documentId, ${textColumn} AS body FROM chunks WHERE chunks MATCH ? ORDER BY rank LIMIT ?`,
      )
      .all(query, Math.min(limit * 4, 200)) as { documentId: string; body: string }[];
    const seen = new Set(metadataHits.map((hit) => hit.id));
    const hits: KnowledgeHit[] = [...metadataHits];
    for (const row of rows) {
      const publicId = `${config.corpus}:${row.documentId}`;
      if (seen.has(publicId)) continue;
      const source = manifest.get(row.documentId);
      if (!source || !isAllowedShopeeUrl(source.url)) continue;
      seen.add(publicId);
      hits.push({ ...publicSource(source), excerpt: excerpt(row.body) });
      if (hits.length >= limit) break;
    }
    return hits;
  } finally {
    database.close();
  }
}

function exactMetadataHits(
  manifest: Map<string, IndexedSource>,
  ftsQuery: string,
  limit: number,
): KnowledgeHit[] {
  const terms = [...ftsQuery.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  const requested = terms.join('.').toLowerCase();
  if (!requested || (!requested.includes('_') && !/^v\d+\./.test(requested))) return [];
  const requestedTerminal = requested.split('.').at(-1) ?? requested;

  return [...manifest.values()]
    .filter((source) => {
      if (!isAllowedShopeeUrl(source.url)) return false;
      const title = source.title.toLowerCase();
      const terminal = title.split('.').at(-1) ?? title;
      return title === requested || terminal === requestedTerminal;
    })
    .sort((left, right) => {
      const leftTitle = left.title.toLowerCase();
      const rightTitle = right.title.toLowerCase();
      return Number(rightTitle === requested) - Number(leftTitle === requested)
        || Number(right.kind.toLowerCase() === 'api') - Number(left.kind.toLowerCase() === 'api')
        || Number(right.manifestId.toLowerCase().endsWith(':en')) - Number(left.manifestId.toLowerCase().endsWith(':en'))
        || left.title.localeCompare(right.title);
    })
    .slice(0, limit)
    .map((source) => ({ ...publicSource(source), excerpt: '' }));
}

function toPlainTextFtsQuery(query: string): string {
  const terms = query.normalize('NFKC').match(/[\p{L}\p{N}_]+/gu) ?? [];
  return terms.slice(0, 32).map((term) => `"${term.replaceAll('"', '""')}"`).join(' AND ');
}

function excerpt(value: unknown): string {
  const text = typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
  return text.length <= MAX_EXCERPT_LENGTH ? text : `${text.slice(0, MAX_EXCERPT_LENGTH - 1)}…`;
}

function isConfined(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

function isAllowedShopeeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return false;
    const host = url.hostname.toLowerCase();
    return host === 'open.shopee.com'
      || host === 'spx.vn'
      || host.endsWith('.shopee.vn')
      || host.endsWith('.shopeemobile.com')
      || host.endsWith('.susercontent.com')
      || host === 'cdngarenanow-a.akamaihd.net';
  } catch {
    return false;
  }
}

function assertAllowedShopeeUrl(value: string): void {
  if (!isAllowedShopeeUrl(value)) throw new Error(KNOWLEDGE_ERROR_CODES.SOURCE_NOT_ALLOWED);
}

function unavailableCode(corpus: Corpus): string {
  return corpus === 'open-platform'
    ? KNOWLEDGE_ERROR_CODES.OPEN_PLATFORM_UNAVAILABLE
    : KNOWLEDGE_ERROR_CODES.SELLER_VN_UNAVAILABLE;
}

function roundRobin(groups: KnowledgeHit[][], limit: number): KnowledgeHit[] {
  const merged: KnowledgeHit[] = [];
  for (let index = 0; merged.length < limit; index += 1) {
    let added = false;
    for (const group of groups) {
      const hit = group[index];
      if (!hit) continue;
      merged.push(hit);
      added = true;
      if (merged.length >= limit) break;
    }
    if (!added) break;
  }
  return merged;
}

function publicSource(source: IndexedSource): KnowledgeSource {
  const { manifestId: _manifestId, path: _path, ...result } = source;
  return result;
}

function isRecord(value: unknown): value is ManifestRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
