import type { Issue, SourceRef, Environment } from './contracts.js';
export type PatchSelection = {
  name: string;
  workOrders: { id: string; revision: number }[];
  fileRefs: { importId: string; relativePath?: string }[];
  workbooks: {
    importId: string;
    sheet: string;
    blockKey: string;
    workOrderIds: string[];
    fields: ('price' | 'stock')[];
  }[];
  contents: {
    workOrderId: string;
    word?: {
      importId: string;
      titleParagraphs?: number[];
      descriptionParagraphs?: number[];
      separator: '\n' | '\n\n';
    };
    coverImportId?: string;
    gallery?: { mode: 'replace'; importIds: string[] };
    descriptionImages?: { mode: 'replace'; importIds: string[] };
    descriptionLayout?: 'preserve_source' | 'images_after_first_paragraph';
    variantImages?: { sku: string; importId: string }[];
  }[];
};
export type PatchTarget = {
  workOrderId: string;
  workOrderRevision: number;
  productKey: string;
  sourceRevision: number;
  connectionId: string;
  connectionRevision: number;
  environment: Environment;
  partnerId: string;
  shopId: string;
  shopName: string;
  itemId: string;
  title: string;
};
export type PatchOperation = {
  id: string;
  workOrderId: string;
  sku?: string;
  field: 'price' | 'stock' | 'title' | 'description' | 'cover' | 'gallery' | 'variantImage';
  action: 'set' | 'replace';
  before: unknown;
  after: unknown;
  sources: (SourceRef & { importId?: string })[];
  state: 'changed' | 'unchanged' | 'blocked';
  issues: Issue[];
};
export type PatchPreview = {
  selection: PatchSelection;
  targets: PatchTarget[];
  operations: PatchOperation[];
  issues: Issue[];
  executionBlockers: { workOrderId: string; code: string; message: string }[];
  comparisonBasis: 'saved_source';
  remoteRead: false;
  fingerprint: string;
  semanticFingerprint: string;
};
export type PatchReceipt = {
  id: string;
  revision: 1;
  name: string;
  state: 'prepared';
  createdAt: string;
  preview: PatchPreview;
  selectedOperationIds: string[];
  fingerprint: string;
};
