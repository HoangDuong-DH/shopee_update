/** Direct backend sandbox operations. These types do not imply production capability. */
export type SandboxField = 'title' | 'description' | 'gallery';
export type RemoteDescriptionBlock =
  { type: 'text'; text: string } | { type: 'image'; imageId: string };
export type SandboxSnapshot = {
  itemId: string;
  title: string;
  descriptionType: 'normal' | 'extended';
  description: RemoteDescriptionBlock[];
  gallery: { imageIds: string[]; ratio: string | null };
  coverImageIds: string[];
  categoryId: string;
  status: string;
  tierNames: string[];
  models: {
    modelId: string;
    sku: string;
    tierIndex: number[];
    optionLabels: string[];
    originalPrice: string | null;
    currentPrice: string | null;
    currency: string | null;
    availableStock: number | null;
    reservedStock: number | null;
  }[];
  /** Sanitized source response fields for preservation checks; no credentials or URLs. */
  protectedFields: Record<string, unknown>;
  fingerprint: string;
  observedAt: string;
  requestIds: string[];
};
export type SandboxScopeInput = {
  connectionId: string;
  itemId: string;
  productKey: string;
  sourceRevision: number;
};
export type SandboxCheck = {
  code: string;
  field: string;
  message: string;
};
export type SandboxReadResult = {
  scope: { environment: 'sandbox'; partnerId: string; shopId: string; connectionRevision: number };
  snapshot: SandboxSnapshot;
  source: { productKey: string; revision: number; title: string; skus: string[] };
  comparison: { field: SandboxField; state: 'equal' | 'different' | 'media_mapping_required' }[];
  limits: Record<string, unknown> | null;
  checks: SandboxCheck[];
  capabilities: {
    title: 'available';
    description: 'requires_preflight';
    gallery: 'requires_preflight';
    cover: 'not_implemented';
    productionWrite: false;
    automaticTokenRefresh: false;
  };
};
export type SandboxPrepareInput = SandboxScopeInput & {
  id: string;
  workOrderId: string;
  workOrderRevision: number;
  baselineFingerprint: string;
  fieldMask: SandboxField[];
};
export type SandboxRun = {
  id: string;
  workOrderId: string;
  workOrderRevision: number;
  revision: number;
  state: 'prepared' | 'in_flight' | 'unknown' | 'verified' | 'rejected' | 'drift';
  connectionId: string;
  itemId: string;
  productKey: string;
  sourceRevision: number;
  fieldMask: SandboxField[];
  baseline: SandboxSnapshot;
  preview: { field: SandboxField; before: unknown; after: unknown }[];
  uploads: {
    assetKey: string;
    sha256: string;
    scene: 'normal' | 'desc';
    imageId: string;
    reusedFromRunId?: string;
  }[];
  result: {
    code: string;
    message: string;
    requestIds: string[];
    failure?: {
      stage: 'media_upload';
      outcome: 'rejected' | 'unknown';
      code?: string;
      reason?: 'transport' | 'invalid_response';
      httpStatus?: number;
      requestId?: string;
    };
    selectedFieldsMatch?: boolean;
    unselectedFieldsMatch?: boolean;
    after?: SandboxSnapshot;
  } | null;
  createdAt: string;
  updatedAt: string;
};
