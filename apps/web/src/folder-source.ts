import type { CatalogRow, SourceRef, WordImport } from '@shopee/domain';
import type { ImportRecord } from './api.js';
import type { EditorSeed } from './Editor.js';

export type FolderMode = 'single_listing' | 'parent_with_listing_folders';
export type FolderFile = { name: string; relativePath: string; size: number; type?: string };
export type UploadedFolderFile = {
  relativePath: string;
  /** Digest computed from the selected file bytes, before an import record is reused. */
  sha256?: string;
  record: ImportRecord | null;
  error?: string;
};
export type FolderGroup = { key: string; name: string; files: FolderFile[] };
export type FolderIssue = {
  code: string;
  message: string;
  field: string;
  severity: 'block' | 'warn';
  relativePath?: string;
};
export type ParagraphRange = { start: number; end: number };
export type FolderSourceRules = {
  wordPath?: string;
  word?:
    | {
        kind: 'labeled_sections';
        titleHeader: string;
        descriptionHeader: string;
        headline: 'first_line' | 'none';
        paragraphSeparator: '\n' | '\n\n';
      }
    | {
        kind: 'paragraphs';
        title: ParagraphRange;
        headline?: ParagraphRange;
        body?: ParagraphRange;
        paragraphSeparator: '\n' | '\n\n';
      };
  media?:
    | {
        convention: 'explicit_selection';
        coverPath?: string;
        galleryPaths: string[];
        descriptionPaths: string[];
      }
    | {
        convention: 'cover-and-g-number';
        gallery: 'all_g' | number[];
        descriptionImages: 'all_g' | number[];
      };
  membership?: {
    tierNames: string[];
    variants: { sku: string; optionLabels: string[]; imagePath?: string; rowKey?: string }[];
  };
};
export type FolderImage = { relativePath: string; importId: string; name: string };
export type FolderVariantCandidate = {
  sku: string;
  optionLabels?: string[];
  imagePath?: string;
  sourceRows: CatalogRow[];
};
export type FolderAssembly = {
  key: string;
  productKey: string;
  name: string;
  sourceFingerprint: string;
  seed?: EditorSeed;
  issues: FolderIssue[];
  candidates: {
    title?: string;
    headline?: string;
    body?: string;
    images: FolderImage[];
    wordFiles: { relativePath: string; record: ImportRecord }[];
    cover?: FolderImage;
    gallery: FolderImage[];
    descriptionImages: FolderImage[];
    variants: FolderVariantCandidate[];
  };
  provenance: SourceRef[];
};
export type FolderAssemblyInput = {
  group: FolderGroup;
  files: UploadedFolderFile[];
  priceSource: { importId: string; sheet: string; priceProfile: string | null; rows: CatalogRow[] };
  rules: FolderSourceRules;
  productKey?: string;
};

function pathParts(path: string): string[] | undefined {
  if (!path || path.startsWith('/') || path.includes('\\') || /[\u0000-\u001f:]/.test(path)) return;
  const parts = path.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return;
  return parts;
}
function issue(
  code: string,
  message: string,
  field: string,
  relativePath?: string,
  severity: 'block' | 'warn' = 'block',
): FolderIssue {
  return { code, message, field, severity, ...(relativePath ? { relativePath } : {}) };
}

export function groupDirectoryFiles(
  files: FolderFile[],
  mode: FolderMode,
): { bundles: FolderGroup[]; issues: FolderIssue[] } {
  const issues: FolderIssue[] = [];
  const groups = new Map<string, FolderGroup>();
  const seen = new Set<string>();
  const roots = new Set<string>();
  if (!['single_listing', 'parent_with_listing_folders'].includes(mode))
    return {
      bundles: [],
      issues: [
        issue(
          'FOLDER_MODE_REQUIRED',
          'Chọn nhập một thư mục listing hoặc thư mục cha chứa nhiều listing.',
          'folder',
        ),
      ],
    };
  for (const file of files) {
    const parts = pathParts(file.relativePath);
    if (
      !parts ||
      parts.length < 2 ||
      parts.at(-1) !== file.name ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0
    ) {
      issues.push(
        issue(
          'FOLDER_PATH_INVALID',
          'Tệp chưa có đường dẫn thư mục hợp lệ.',
          'folder',
          file.relativePath,
        ),
      );
      continue;
    }
    roots.add(parts[0]);
    if (seen.has(file.relativePath)) {
      issues.push(
        issue(
          'FOLDER_PATH_DUPLICATE',
          'Có hai tệp trùng đường dẫn trong lần nhập.',
          'folder',
          file.relativePath,
        ),
      );
      continue;
    }
    seen.add(file.relativePath);
    if (mode === 'parent_with_listing_folders' && parts.length < 3) {
      issues.push(
        issue(
          'FILE_OUTSIDE_LISTING_FOLDER',
          'Tệp nằm trực tiếp trong thư mục cha. Chưa biết tệp thuộc listing nào.',
          'folder',
          file.relativePath,
        ),
      );
      continue;
    }
    const key = parts.slice(0, mode === 'single_listing' ? 1 : 2).join('/');
    const group = groups.get(key) ?? {
      key,
      name: parts[mode === 'single_listing' ? 0 : 1],
      files: [],
    };
    group.files.push({ ...file });
    groups.set(key, group);
  }
  if (roots.size > 1)
    return {
      bundles: [],
      issues: [
        ...issues,
        issue('MULTIPLE_SELECTED_ROOTS', 'Chọn một thư mục gốc cho mỗi lần đọc.', 'folder'),
      ],
    };
  return { bundles: [...groups.values()], issues };
}

function foldName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLocaleLowerCase('vi');
}
function isolatedSku(stem: string, sku: string): boolean {
  let at = stem.indexOf(sku);
  while (at !== -1) {
    const before = at ? stem[at - 1] : '';
    const after = stem[at + sku.length] ?? '';
    if ((!before || !/[\p{L}\p{N}]/u.test(before)) && (!after || !/[\p{L}\p{N}]/u.test(after)))
      return true;
    at = stem.indexOf(sku, at + 1);
  }
  return false;
}
async function hash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function extractWord(
  word: WordImport,
  rules: FolderSourceRules['word'],
): { title?: string; headline?: string; body?: string; locators: string[]; issues: FolderIssue[] } {
  const issues: FolderIssue[] = [];
  const locators: string[] = [];
  const paragraphs = word.paragraphs;
  if (!rules) {
    // These labels are only recognition candidates. They never choose a SKU or media role.
    const lines = paragraphs.flatMap((text) => text.split('\n'));
    const titles = ['TIÊU ĐỀ', 'TIÊU ĐỀ SẢN PHẨM', 'PRODUCT TITLE'];
    const descriptions = ['BÀI MÔ TẢ ĐĂNG BÁN', 'MÔ TẢ SẢN PHẨM', 'PRODUCT DESCRIPTION'];
    const titleHeaders = titles.filter((label) => lines.some((line) => line.trim() === label));
    const descriptionHeaders = descriptions.filter((label) =>
      lines.some((line) => line.trim() === label),
    );
    if (titleHeaders.length === 1 && descriptionHeaders.length === 1)
      rules = {
        kind: 'labeled_sections',
        titleHeader: titleHeaders[0],
        descriptionHeader: descriptionHeaders[0],
        headline: 'none',
        paragraphSeparator: '\n',
      };
    else
      return {
        body: paragraphs.join('\n'),
        locators: ['paragraphs:1-' + paragraphs.length],
        issues: [
          issue(
            'WORD_SECTIONS_UNRESOLVED',
            'Đã đọc nội dung Word. Chọn đoạn tiêu đề và mô tả một lần để ứng dụng dùng đúng nguồn.',
            'word',
          ),
        ],
      };
  }
  if (rules.kind === 'paragraphs') {
    const select = (range: ParagraphRange | undefined, field: string): string => {
      if (!range) return '';
      if (
        !Number.isInteger(range.start) ||
        !Number.isInteger(range.end) ||
        range.start < 1 ||
        range.end < range.start ||
        range.end > paragraphs.length
      ) {
        issues.push(issue('WORD_RANGE_INVALID', 'Vị trí đoạn Word không còn khớp nguồn.', field));
        return '';
      }
      locators.push('paragraphs:' + range.start + '-' + range.end);
      return paragraphs.slice(range.start - 1, range.end).join(rules.paragraphSeparator);
    };
    return {
      title: select(rules.title, 'title'),
      headline: select(rules.headline, 'headline'),
      body: select(rules.body, 'body'),
      issues,
      locators,
    };
  }
  // Flatten with the selected paragraph separators while retaining exact source line text.
  const joined = paragraphs.join(rules.paragraphSeparator);
  const flat = joined.split('\n');
  const titlePositions = flat.flatMap((text, index) =>
    text.trim() === rules.titleHeader ? [index] : [],
  );
  const bodyPositions = flat.flatMap((text, index) =>
    text.trim() === rules.descriptionHeader ? [index] : [],
  );
  if (
    titlePositions.length !== 1 ||
    bodyPositions.length !== 1 ||
    bodyPositions[0] <= titlePositions[0]
  )
    return {
      locators,
      issues: [
        issue(
          'WORD_HEADERS_AMBIGUOUS',
          'Không tìm thấy duy nhất hai mục tiêu đề và mô tả theo quy tắc đã chọn.',
          'word',
        ),
      ],
    };
  const titleLines = flat
    .slice(titlePositions[0] + 1, bodyPositions[0])
    .filter((text) => text.trim() !== '');
  const title = titleLines.length === 1 ? titleLines[0] : undefined;
  if (!title)
    issues.push(
      issue(
        'WORD_TITLE_AMBIGUOUS',
        'Mục tiêu đề có nhiều dòng hoặc đang trống. Cần chọn đúng tiêu đề đã chuẩn bị.',
        'title',
      ),
    );
  let contentStart = bodyPositions[0] + 1;
  // Only blank section separators before the first content line are outside the selected section.
  while (contentStart < flat.length && flat[contentStart] === '') contentStart++;
  const description = flat.slice(contentStart).join('\n');
  let headline = '',
    body = description;
  if (rules.headline === 'first_line') {
    const split = description.indexOf('\n');
    headline = split === -1 ? description : description.slice(0, split);
    body = split === -1 ? '' : description.slice(split + 1);
  }
  locators.push('section:' + rules.titleHeader, 'section:' + rules.descriptionHeader);
  return { title, headline, body, locators, issues };
}

export async function assembleFolderListing(input: FolderAssemblyInput): Promise<FolderAssembly> {
  const { group, rules, priceSource } = input;
  const issues: FolderIssue[] = [];
  if (!priceSource.importId || !priceSource.sheet)
    issues.push(
      issue('PRICE_SCOPE_REQUIRED', 'Chọn đúng bảng giá và trang tính chung cho lô này.', 'price'),
    );
  const provenance: SourceRef[] = [];
  const paths = new Set(group.files.map((file) => file.relativePath));
  const uploaded = new Map<string, UploadedFolderFile>();
  for (const file of input.files) {
    if (!paths.has(file.relativePath)) continue;
    if (uploaded.has(file.relativePath)) {
      issues.push(
        issue(
          'IMPORTED_PATH_DUPLICATE',
          'Có nhiều kết quả đọc cho cùng một tệp.',
          'sources',
          file.relativePath,
        ),
      );
      continue;
    }
    uploaded.set(file.relativePath, file);
  }
  const images: FolderImage[] = [];
  const wordFiles: { relativePath: string; record: ImportRecord }[] = [];
  for (const file of group.files) {
    const received = uploaded.get(file.relativePath);
    const record = received?.record;
    if (!record || record.status !== 'ready') {
      issues.push(
        issue(
          'FOLDER_FILE_NOT_READY',
          'Tệp chưa đọc xong hoặc cần tải lại.',
          'sources',
          file.relativePath,
        ),
      );
      continue;
    }
    const hasHashProof = received?.sha256 !== undefined;
    if (hasHashProof && received.sha256 !== record.sha256) {
      issues.push(
        issue(
          'FOLDER_FILE_CONTENT_CHANGED',
          'Nội dung tệp trả về không khớp tệp đã chọn trong thư mục.',
          'sources',
          file.relativePath,
        ),
      );
      continue;
    }
    if (!hasHashProof && record.filename !== file.name) {
      issues.push(
        issue(
          'FOLDER_FILE_IDENTITY_CHANGED',
          'Tên tệp trả về không khớp tệp trong thư mục.',
          'sources',
          file.relativePath,
        ),
      );
      continue;
    }
    if (record.kind === 'image')
      images.push({ relativePath: file.relativePath, importId: record.id, name: file.name });
    if (record.kind === 'docx') wordFiles.push({ relativePath: file.relativePath, record });
    const body = record.body as { source?: SourceRef } | undefined;
    if (body?.source) provenance.push({ ...body.source, locator: file.relativePath });
  }
  const sourceFingerprint = await hash({
    group: group.key,
    files: [...uploaded]
      .map(([path, received]) => [
        path,
        received.sha256 ?? received.record?.sha256 ?? 'unavailable',
      ])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
  });
  const productKey = input.productKey ?? 'folder-' + sourceFingerprint;
  const candidates: FolderAssembly['candidates'] = {
    images,
    wordFiles,
    gallery: [],
    descriptionImages: [],
    variants: [],
  };
  const chosenWords = rules.wordPath
    ? wordFiles.filter((file) => file.relativePath === rules.wordPath)
    : wordFiles;
  if (chosenWords.length !== 1)
    issues.push(
      issue(
        'WORD_FILE_UNRESOLVED',
        chosenWords.length
          ? 'Có nhiều tệp Word. Chọn tệp chứa nội dung listing này.'
          : 'Chưa có tệp Word đã đọc xong trong bộ này.',
        'word',
      ),
    );
  else {
    const chosen = chosenWords[0];
    const word = chosen.record.body as WordImport | undefined;
    if (
      !word ||
      !Array.isArray(word.paragraphs) ||
      word.paragraphs.some((text) => typeof text !== 'string')
    )
      issues.push(
        issue('WORD_BODY_INVALID', 'Kết quả đọc Word chưa hợp lệ.', 'word', chosen.relativePath),
      );
    else {
      const extracted = extractWord(word, rules.word);
      candidates.title = extracted.title;
      candidates.headline = extracted.headline;
      candidates.body = extracted.body;
      issues.push(
        ...extracted.issues.map((item) => ({ ...item, relativePath: chosen.relativePath })),
      );
      provenance.push(
        ...extracted.locators.map((locator) => ({
          ...word.source,
          locator: chosen.relativePath + '#' + locator,
        })),
      );
    }
  }
  const imageByPath = new Map(images.map((image) => [image.relativePath, image]));
  const takeImages = (selected: string[], field: string): FolderImage[] => {
    const found: FolderImage[] = [];
    const seen = new Set<string>();
    for (const path of selected) {
      if (seen.has(path)) {
        issues.push(
          issue(
            'DUPLICATE_ROLE_IMAGE',
            'Một tệp xuất hiện hai lần trong cùng vị trí ảnh.',
            field,
            path,
          ),
        );
        continue;
      }
      seen.add(path);
      const image = imageByPath.get(path);
      if (image) found.push(image);
      else
        issues.push(
          issue(
            'ROLE_IMAGE_NOT_IN_FOLDER',
            'Ảnh được chọn chưa có hoặc chưa sẵn sàng trong đúng thư mục listing.',
            field,
            path,
          ),
        );
    }
    return found;
  };
  if (rules.media?.convention === 'explicit_selection') {
    candidates.cover = takeImages(rules.media.coverPath ? [rules.media.coverPath] : [], 'cover')[0];
    candidates.gallery = takeImages(rules.media.galleryPaths, 'gallery');
    candidates.descriptionImages = takeImages(rules.media.descriptionPaths, 'descriptionImages');
  } else if (rules.media?.convention === 'cover-and-g-number') {
    const covers: FolderImage[] = [];
    const numbered = new Map<number, FolderImage[]>();
    for (const image of images) {
      const stem = foldName(image.name.replace(/\.[^.]+$/, ''));
      if (/(?:^|[-_\s])(?:anh[-_\s]*)?(?:bia|cover)$/.test(stem)) covers.push(image);
      const match = stem.match(/(?:^|[-_\s])g([1-9][0-9]*)$/);
      if (match) {
        const n = Number(match[1]);
        numbered.set(n, [...(numbered.get(n) ?? []), image]);
      }
    }
    if (covers.length === 1) candidates.cover = covers[0];
    else if (covers.length > 1)
      issues.push(
        issue('COVER_AMBIGUOUS', 'Có nhiều ảnh mang tên ảnh bìa. Chọn đúng một ảnh.', 'cover'),
      );
    const numberedPaths = (selection: 'all_g' | number[], field: string): string[] => {
      const numbers =
        selection === 'all_g' ? [...numbered.keys()].sort((a, b) => a - b) : selection;
      return numbers.flatMap((n) => {
        const matches = numbered.get(n) ?? [];
        if (matches.length !== 1) {
          issues.push(issue('G_IMAGE_UNRESOLVED', `Ảnh g${n} không tìm thấy duy nhất.`, field));
          return [];
        }
        return [matches[0].relativePath];
      });
    };
    candidates.gallery = takeImages(numberedPaths(rules.media.gallery, 'gallery'), 'gallery');
    candidates.descriptionImages = takeImages(
      numberedPaths(rules.media.descriptionImages, 'descriptionImages'),
      'descriptionImages',
    );
  }
  if (!candidates.cover)
    issues.push(
      issue('COVER_NOT_SELECTED', 'Chọn ảnh bìa của listing trong các ảnh đã đọc.', 'cover'),
    );
  if (!candidates.gallery.length)
    issues.push(
      issue(
        'GALLERY_NOT_SELECTED',
        'Chọn các ảnh sản phẩm và giữ đúng thứ tự đã chuẩn bị.',
        'gallery',
      ),
    );
  const scopedRows = priceSource.rows.filter(
    (row) =>
      row.sheet === priceSource.sheet && (row.priceProfile ?? null) === priceSource.priceProfile,
  );
  const variants: EditorSeed['variants'] = [];
  const membership = rules.membership;
  if (!membership) {
    const skuSet = [...new Set(scopedRows.map((row) => row.sku.value))].filter(Boolean);
    for (const image of images) {
      const stem = image.name.replace(/\.[^.]+$/, '');
      const matches = skuSet.filter((sku) => isolatedSku(stem, sku));
      if (matches.length === 1)
        candidates.variants.push({
          sku: matches[0],
          imagePath: image.relativePath,
          sourceRows: scopedRows.filter((row) => row.sku.value === matches[0]),
        });
      else if (matches.length > 1)
        issues.push(
          issue(
            'IMAGE_SKU_AMBIGUOUS',
            'Tên ảnh chứa nhiều mã SKU phù hợp; chưa tự chọn mã.',
            'variants',
            image.relativePath,
          ),
        );
    }
    issues.push(
      issue(
        'MEMBERSHIP_NOT_MAPPED',
        'Chưa có nguồn xác định đầy đủ SKU, tên và thứ tự phân loại của bộ này. Dùng bảng listing đã chuẩn bị hoặc lưu cách ghép một lần.',
        'variants',
      ),
    );
  } else {
    if (
      membership.tierNames.length > 2 ||
      membership.tierNames.some((name) => !name.trim() || name.length > 200) ||
      new Set(membership.tierNames).size !== membership.tierNames.length
    )
      issues.push(issue('TIER_NAMES_INVALID', 'Tên và số nhóm phân loại chưa hợp lệ.', 'variants'));
    if (
      !membership.variants.length ||
      membership.variants.length > 2000 ||
      (!membership.tierNames.length && membership.variants.length !== 1)
    )
      issues.push(
        issue('VARIANT_COUNT_INVALID', 'Số SKU chưa khớp cấu trúc phân loại đã chọn.', 'variants'),
      );
    const seenSku = new Set<string>(),
      seenLabels = new Set<string>();
    for (const variant of membership.variants) {
      const matches = scopedRows.filter(
        (row) => row.sku.value === variant.sku && (!variant.rowKey || row.key === variant.rowKey),
      );
      candidates.variants.push({
        sku: variant.sku,
        optionLabels: [...variant.optionLabels],
        imagePath: variant.imagePath,
        sourceRows: matches,
      });
      const labelsKey = JSON.stringify(variant.optionLabels);
      if (
        seenSku.has(variant.sku) ||
        (membership.tierNames.length > 0 && seenLabels.has(labelsKey))
      )
        issues.push(
          issue(
            'DUPLICATE_VARIANT',
            'Có SKU hoặc tổ hợp phân loại bị lặp trong nguồn mapping.',
            'variants',
          ),
        );
      seenSku.add(variant.sku);
      seenLabels.add(labelsKey);
      if (
        !variant.sku.trim() ||
        variant.optionLabels.length !== membership.tierNames.length ||
        variant.optionLabels.some((label) => !label.trim() || label.length > 200)
      )
        issues.push(
          issue(
            'VARIANT_LABELS_INVALID',
            'SKU hoặc tên phân loại chưa khớp cấu trúc nguồn.',
            'variants',
          ),
        );
      if (matches.length !== 1) {
        issues.push(
          issue(
            'VARIANT_PRICE_SOURCE_UNRESOLVED',
            `SKU “${variant.sku}” không khớp duy nhất một dòng trong bộ giá đã chọn.`,
            'price',
          ),
        );
        continue;
      }
      const row = matches[0];
      if (!row.originalPrice || !/^[1-9][0-9]*$/.test(row.originalPrice.value))
        issues.push(
          issue('ORIGINAL_PRICE_INVALID', `GIÁ GỐC của SKU “${variant.sku}” chưa hợp lệ.`, 'price'),
        );
      for (const sourceIssue of row.issues)
        issues.push(
          issue(
            sourceIssue.code,
            sourceIssue.message,
            sourceIssue.field,
            undefined,
            sourceIssue.severity,
          ),
        );
      provenance.push(...row.sku.sources, ...(row.originalPrice?.sources ?? []));
      const image = variant.imagePath
        ? takeImages([variant.imagePath], 'variantImage')[0]
        : undefined;
      variants.push({
        importId: priceSource.importId,
        rowKey: row.key,
        optionLabels: [...variant.optionLabels],
        ...(image ? { imageId: image.importId } : {}),
      });
    }
  }
  let seed: EditorSeed | undefined;
  if (
    membership &&
    !issues.some((item) => item.severity === 'block') &&
    candidates.title !== undefined
  )
    seed = {
      productKey,
      expectedRevision: 0,
      title: candidates.title,
      headline: candidates.headline ?? '',
      body: candidates.body ?? '',
      coverId: candidates.cover?.importId,
      galleryIds: candidates.gallery.map((image) => image.importId),
      descriptionImageIds: candidates.descriptionImages.map((image) => image.importId),
      tierNames: [...membership.tierNames],
      variants,
    };
  return {
    key: group.key,
    productKey,
    name: group.name,
    sourceFingerprint,
    seed,
    issues,
    candidates,
    provenance,
  };
}
