export type InputPriceSelection = {
  importId: string;
  sheet: string;
  priceProfile: string | null;
};

export type InputBatchFile = {
  relativePath: string;
  name: string;
  size: number;
  importId?: string;
  sha256?: string;
  error?: string;
};

export type InputBatchState = {
  version: 1;
  name: string;
  mode: 'single_listing' | 'parent_with_listing_folders';
  files: InputBatchFile[];
  priceSelection: InputPriceSelection | null;
  visual: Record<
    string,
    { coverPath?: string; galleryPaths: string[]; descriptionPaths: string[] }
  >;
  wordPaths: Record<string, string>;
  wordRule: {
    titleHeader: string;
    descriptionHeader: string;
    headline: 'first_line' | 'none';
    paragraphSeparator: '\n' | '\n\n';
  } | null;
  productKeys: Record<string, string>;
};

export type InputBatchRecord = {
  id: string;
  revision: number;
  state: InputBatchState;
  createdAt: string;
  updatedAt: string;
};

export type InputBatchSummary = {
  id: string;
  revision: number;
  name: string;
  updatedAt: string;
  folderCount: number;
  fileCount: number;
  completedCount: number;
  priceSelection: InputPriceSelection | null;
};

export type InputLibraryImport = {
  id: string;
  sha256: string;
  filename: string;
  kind: 'xlsx' | 'docx' | 'image';
  bytes: number;
  status: string;
  message: string;
  createdAt: string;
  body: unknown;
};

export type InputBatchDetail = InputBatchRecord & { imports: InputLibraryImport[] };

export type InputLibrary = {
  priceBooks: {
    id: string;
    filename: string;
    status: string;
    createdAt: string;
    bytes: number;
    rowCount: number;
    sheetCount: number;
    issueCount: number;
  }[];
  batches: InputBatchSummary[];
  unassigned: InputLibraryImport[];
};
