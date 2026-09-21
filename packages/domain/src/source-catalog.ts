/** Received material is evidence, not a publishable product or a confirmed shop binding. */
export type SourceListingIntent =
  | { kind: 'create'; itemId: null }
  | { kind: 'update'; itemId: string }
  | { kind: 'invalid'; itemId: null };

/** User rule, 16 Sep: a blank source ID means new; a supplied ID targets that existing link.
 * This derives intent only. It does not prove shop ownership or permit a remote write. */
export function sourceListingIntent(value: unknown): SourceListingIntent {
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim()))
    return { kind: 'create', itemId: null };
  const text = typeof value === 'string' ? value.trim()
    : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : '';
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text)))
    return { kind: 'invalid', itemId: null };
  return { kind: 'update', itemId: text };
}

/** Historical catalog snapshots stay immutable; obsolete blank-ID warnings are not current errors. */
export function currentCatalogIssues(issues: CatalogIssue[]): CatalogIssue[] {
  return issues.filter((issue) => issue.code !== 'missing_item_id');
}

export interface CatalogEvidence {
  sourceId: string;
  sheet?: string;
  cell?: string;
  label: string;
}
export interface CatalogText {
  label: string;
  value: string;
  evidence: CatalogEvidence;
}
export interface CatalogIssue {
  code: string;
  message: string;
  action: string;
}
export interface CatalogDesign {
  id: string;
  title: string;
  url: string;
  folderId: string;
  pageCount: number;
  observedPageCount: number;
  complete: boolean;
  updatedAt: string;
}
export interface CatalogCandidate extends CatalogDesign {
  reason: string;
  status: 'suggested';
}
export interface CatalogListing {
  id: string;
  brand: string;
  sourceNumber: string | null;
  itemId: string | null;
  title: string;
  sheet: string;
  row: number;
  contentAvailable: boolean;
  variationAvailable: boolean;
  designCandidateCount: number;
  issues: CatalogIssue[];
  /** Derived for list display; never changes or approves the received source. */
  operationalConcernCount?: number;
  status: 'needs_review';
}
export interface CatalogListingDetail extends CatalogListing {
  titleSource: CatalogEvidence;
  contents: CatalogText[];
  variations: CatalogText[];
  reviewNotes: CatalogText[];
  designCandidates: CatalogCandidate[];
  shopBinding: null;
  priceSource: null;
  stockSource: null;
  attributeReference: null;
  operationalReferences?: CatalogOperationalReference[];
}
export interface CatalogOperationalReference {
  shopHandle: string;
  itemId: string;
  title: string;
  sourceUrl: string;
  observedAt: string;
  categoryLabel: string;
  categoryGuideUrl: string;
  attributes: { label: string; value: string }[];
  concerns: string[];
  apiVerified: false;
  approvedForReuse: false;
}
export interface SourceCatalogSummary {
  id: string;
  name: string;
  revision: number;
  receivedAt: string;
  counts: { listings: number; designs: number; pages: number; needsReview: number };
  brands: { name: string; count: number }[];
}
export interface SourceCatalogDetail extends SourceCatalogSummary {
  sources: {
    id: string;
    name: string;
    kind: 'workbook' | 'canva_folder';
    sha256?: string;
    url?: string;
  }[];
  notes: string[];
  missing: string[];
  originalAssetsDownloaded: false;
  publishable: false;
  importFingerprint: string;
}
export interface CatalogListingPage {
  items: CatalogListing[];
  total: number;
  page: number;
  pageSize: number;
}
