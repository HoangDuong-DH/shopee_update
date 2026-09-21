export type Id = string;
export type IsoTime = string;
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Environment = 'sandbox' | 'production';
export type SourceRef = {
  fileSha256: string;
  locator: string;
  observedAt: IsoTime;
  kind: 'product_file' | 'user_decision' | 'official_doc' | 'seller_observation';
  filename?: string;
  url?: string;
  sourceUpdatedAt?: IsoTime;
  effectiveAt?: IsoTime;
};
export type Fact<T> = { value: T; sources: SourceRef[]; confirmed: boolean };
export type MoneyVnd = string;
export type Issue = {
  code: string;
  severity: 'block' | 'warn';
  field: string;
  message: string;
  sources: SourceRef[];
};
export type Scope = {
  environment: Environment;
  partnerId: Id;
  shopId: Id;
  connectionRevision: number;
  capabilityRevision: number;
};
export type AssetRef = {
  key: string;
  sha256: string;
  bytes: number;
  mime: string;
  width: number;
  height: number;
  durationMs?: number;
  source: SourceRef;
};
export type ContentBlock = { type: 'text'; text: string } | { type: 'image'; assetKey: string };
export type Variant = {
  key: string;
  sku: Fact<string>;
  optionLabels: string[];
  originalPrice: Fact<MoneyVnd>;
  promotionTarget?: Fact<MoneyVnd>;
  imageKey?: string;
  declaredWeightGrams?: Fact<string>;
};
export type DraftField =
  | 'title'
  | 'description'
  | 'gallery'
  | 'category'
  | 'brand'
  | 'attributes'
  | 'variations'
  | 'price'
  | 'stock'
  | 'logistics'
  | 'video'
  | 'sizeChart'
  | 'identifiers'
  | 'compliance'
  | 'fulfillment'
  | 'publication';
export type SourceSelection = {
  folderBinding?: import('./folder-source-identity.js').FolderSourceBinding;
  /** Exact ID from the source; null/blank means create, a supplied ID means update. */
  sourceListingId?: string | null;
  title: string;
  headline: string;
  body: string;
  coverId?: string;
  galleryIds: string[];
  descriptionImageIds: string[];
  tierNames: string[];
  variants: { importId: string; rowKey: string; optionLabels: string[]; imageId?: string }[];
};
export type ListingDraft = {
  folderSource?: import('./folder-source-identity.js').FolderSourceProof;
  productKey: string;
  revision: number;
  sourceSelection?: SourceSelection;
  sourceListingId?: Fact<string | null>;
  title: Fact<string>;
  description: ContentBlock[];
  coverKey: string;
  galleryKeys: string[];
  tierNames: string[];
  variants: Variant[];
  assets: AssetRef[];
  categoryId?: Fact<Id>;
  brandId?: Fact<Id>;
  attributes: Record<string, Fact<Json>>;
  logistics: Record<string, Fact<Json>>;
  videoKeys?: string[];
  sizeChartKey?: string;
  identifiers?: Record<string, Fact<Json>>;
  compliance?: Record<string, Fact<Json>>;
  fulfillment?: Record<string, Fact<Json>>;
  publication?: Fact<'listed' | 'unlisted'>;
  issues: Issue[];
};
export type StockInstruction = {
  scope: Scope;
  sku: string;
  quantity: number;
  revision: number;
  commandId: string;
  decidedAt: IsoTime;
  source: SourceRef;
};
export type Capability = {
  name: string;
  state: 'supported' | 'denied' | 'unknown' | 'manual_required';
  scope: Scope;
  observedAt: IsoTime;
  expiresAt: IsoTime;
  constraints: Record<string, Json>;
  sources: SourceRef[];
};
export type ListingSnapshot = {
  itemId: Id;
  scope: Scope;
  observedAt: IsoTime;
  fingerprint: string;
  fields: Partial<Record<DraftField, Json>>;
  models: { modelId: Id; sku: string; tierIndex: number[]; fields: Record<string, Json> }[];
  platformStatus: string;
  deboosted: boolean | null;
  qualityGrade: number | null;
};
export type ChangePlan = {
  id: string;
  revision: number;
  fingerprint: string;
  scope: Scope;
  productKey: string;
  sourceRevision: number;
  operation: 'create' | 'update' | 'promotion';
  itemId?: Id;
  fieldMask: DraftField[];
  desired: ListingDraft;
  stocks: StockInstruction[];
  baseline?: ListingSnapshot;
  issues: Issue[];
  createdAt: IsoTime;
};
export type JobState =
  | 'queued'
  | 'running'
  | 'waiting_retry'
  | 'waiting_input'
  | 'waiting_external'
  | 'unknown'
  | 'verified'
  | 'failed'
  | 'cancelled';
export type StepState = 'pending' | 'in_flight' | 'unknown' | 'verified' | 'failed';
export type ApiOutcome =
  | { kind: 'success'; requestId?: string; data: Json }
  | { kind: 'partial'; requestId?: string; data: Json; failures: Json[] }
  | { kind: 'rejected'; code: string; requestId?: string; data: Json }
  | { kind: 'unknown'; reason: 'timeout' | 'disconnected' | 'invalid_response' };
export type Clock = { now(): Date };
export type CatalogSourceField =
  | 'sku'
  | 'name'
  | 'brand'
  | 'category'
  | 'originalPrice'
  | 'promotionTarget'
  | 'unitOfMeasure'
  | 'physicalWeightGrams'
  | 'declaredWeightGrams'
  | 'imageUrl';
export type CatalogRow = {
  key: string;
  sheet: string;
  row: number;
  headerRow: number;
  block?: string;
  priceProfile?: string;
  sheetVisibility?: 'visible' | 'hidden' | 'veryHidden';
  hiddenPriceColumns?: string[];
  sourceHeaders?: Partial<Record<CatalogSourceField, Fact<string>>>;
  sku: Fact<string>;
  name: Fact<string>;
  brand?: Fact<string>;
  category?: Fact<string>;
  unitOfMeasure?: Fact<string>;
  originalPrice?: Fact<MoneyVnd>;
  promotionTarget?: Fact<MoneyVnd>;
  physicalWeightGrams?: Fact<string>;
  declaredWeightGrams?: Fact<string>;
  imageUrl?: Fact<string>;
  issues: Issue[];
};
export type WorkbookImport = {
  source: SourceRef;
  rows: CatalogRow[];
  issues: Issue[];
  sheets: {
    name: string;
    rowCount: number;
    importedRows: number;
    headerRows: number[];
    visibility?: 'visible' | 'hidden' | 'veryHidden';
    hiddenColumns?: string[];
  }[];
};
export type WordImport = { source: SourceRef; paragraphs: string[] };
export type ShopConnection = {
  id: string;
  scope: Scope;
  name: string;
  /** Local alias, separate from the last shop name returned by Shopee. */
  displayName?: string | null;
  officialName?: string;
  nameRevision?: number;
  region: string;
  state: 'disconnected' | 'connected' | 'reauth_required' | 'refresh_unknown' | 'token_expired';
  autoRefresh?:boolean; refreshStatus?:string; refreshReason?:string|null; healthCheckedAt?:string;
  tokenExpiresAt?: IsoTime;
  capabilities: Capability[];
  updatedAt: IsoTime;
};
export type JobRecord = {
  id: string;
  planId: string;
  planRevision: number;
  scope: Scope;
  state: JobState;
  paused: boolean;
  cancelRequested: boolean;
  leaseEpoch: number;
  createdAt: IsoTime;
  updatedAt: IsoTime;
  nextRunAt: IsoTime;
  message: string;
  attemptCount: number;
};
