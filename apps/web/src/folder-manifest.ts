import type { FolderManifest, ListingDraft } from '@shopee/domain';
import { compileDescription } from '../../../packages/domain/src/source/normalize.js';
import { folderManifestSchema } from '../../../packages/domain/src/folder-manifest.js';
import type { FolderAssemblyInput, FolderIssue, FolderSourceRules } from './folder-source.js';
import type { EditorSeed } from './Editor.js';

export function resolveFolderManifest(input: FolderAssemblyInput): {
  document?: FolderManifest;
  rules?: FolderSourceRules;
  issues: FolderIssue[];
} {
  const issues: FolderIssue[] = [];
  const block = (code: string, message: string, field = 'manifest') =>
    issues.push({ code, message, field, severity: 'block' });
  const parsed = folderManifestSchema.safeParse(input.manifest);
  if (!parsed.success) {
    block(
      'FOLDER_MANIFEST_INVALID',
      'Hồ sơ đi kèm chưa hợp lệ. Kiểm tra tên tầng, SKU, tổ hợp phân loại và đường dẫn tệp.',
    );
    return { issues };
  }
  const m = parsed.data;
  if (
    input.priceSource.sha256 !== m.priceSource.sha256 ||
    input.priceSource.sheet !== m.priceSource.sheet ||
    (m.priceSource.selectionMode !== 'operator_choice' &&
      input.priceSource.priceProfile !== m.priceSource.priceProfile)
  )
    block(
      'FOLDER_MANIFEST_PRICE_MISMATCH',
      'Bảng giá hoặc bộ giá đang chọn khác hồ sơ. Chọn đúng tệp gốc, trang tính và bộ giá đã chuẩn bị.',
      'price',
    );
  if (m.priceSource.selectionMode === 'operator_choice' && !input.priceSource.priceProfile?.trim())
    block(
      'FOLDER_MANIFEST_PRICE_CHOICE_REQUIRED',
      'Hồ sơ đã giữ danh sách SKU. Chọn bộ giá phù hợp với shop một lần để tiếp tục.',
      'price',
    );
  const path = (name: string) => input.group.key + '/' + name;
  const required = [
    m.word,
    ...(m.media.cover ? [m.media.cover] : []),
    ...m.media.gallery,
    ...m.media.description,
    ...m.variants.flatMap((v) => (v.image ? [v.image] : [])),
  ];
  for (const ref of required) {
    const name = path(ref.path),
      files = input.files.filter((f) => f.relativePath === name);
    const received = files[0];
    if (
      files.length !== 1 ||
      !input.group.files.some((f) => f.relativePath === name) ||
      received?.sha256 !== ref.sha256 ||
      received.record?.sha256 !== ref.sha256 ||
      received.record.status !== 'ready' ||
      received.record.kind !== (ref === m.word ? 'docx' : 'image')
    )
      block(
        'FOLDER_MANIFEST_FILE_MISMATCH',
        `Tệp “${ref.path}” thiếu, đã đổi hoặc không khớp hồ sơ gốc.`,
        'sources',
      );
  }
  return {
    document: m,
    issues,
    rules: {
      wordPath: path(m.word.path),
      word: {
        kind: 'paragraphs',
        title: m.word.title,
        ...(m.word.headline ? { headline: m.word.headline } : {}),
        ...(m.word.body ? { body: m.word.body } : {}),
        paragraphSeparator: m.word.paragraphSeparator,
      },
      media: {
        convention: 'explicit_selection',
        ...(m.media.cover ? { coverPath: path(m.media.cover.path) } : {}),
        galleryPaths: m.media.gallery.map((f) => path(f.path)),
        descriptionPaths: m.media.description.map((f) => path(f.path)),
      },
      membership: {
        tierNames: m.tierNames,
        variants: m.variants.map((v) => ({
          sku: v.sku,
          optionLabels: v.optionLabels,
          ...(v.rowKey ? { rowKey: v.rowKey } : {}),
          ...(v.image ? { imagePath: path(v.image.path) } : {}),
        })),
      },
    },
  };
}

/** Opening an existing source is read-only and requires the exact revision and canonical content. */
export function compareManifestSavedDraft(
  manifest: FolderManifest,
  seed: EditorSeed,
  input: FolderAssemblyInput,
  saved: ListingDraft | undefined,
): string[] {
  if (!saved) return ['Không tìm thấy bản nháp nguồn đã lưu. Chưa tạo bản mới thay thế.'];
  const differences: string[] = [];
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (
    saved.productKey !== manifest.product.productKey ||
    saved.revision !== manifest.product.sourceRevision
  )
    differences.push('Phiên bản hoặc định danh bản nháp đã thay đổi.');
  const currentHash = (key: string | undefined) =>
    key ? (input.files.find((f) => f.record?.id === key)?.record?.sha256 ?? null) : null;
  const savedHash = (key: string | undefined) =>
    key ? (saved.assets.find((a) => a.key === key)?.sha256 ?? null) : null;
  if (saved.title.value !== seed.title) differences.push('Tiêu đề khác bản đã lưu.');
  const projection = (
    blocks: ReturnType<typeof compileDescription>,
    hash: (key: string) => string | null,
  ) => blocks.map((b) =>
    b.type === 'text'
      ? { type: 'text', text: b.text }
      : { type: 'image', sha256: hash(b.assetKey) },
  );
  if (
    !same(
      projection(saved.description, savedHash),
      projection(
        compileDescription(seed.headline, seed.body, seed.descriptionImageIds),
        currentHash,
      ),
    )
  )
    differences.push('Nội dung hoặc ảnh mô tả khác bản đã lưu.');
  if (
    savedHash(saved.coverKey) !== currentHash(seed.coverId) ||
    !same(saved.galleryKeys.map(savedHash), seed.galleryIds.map(currentHash))
  )
    differences.push('Bìa, ảnh nội dung hoặc thứ tự ảnh khác bản đã lưu.');
  const desired = seed.variants.map((v) => {
    const row = input.priceSource.rows.find(
      (r) =>
        r.key === v.rowKey &&
        r.sheet === input.priceSource.sheet &&
        (r.priceProfile ?? null) === input.priceSource.priceProfile,
    );
    return {
      sku: row?.sku.value,
      optionLabels: v.optionLabels,
      price: row?.originalPrice?.value,
      image: currentHash(v.imageId),
      rowKey: v.rowKey,
    };
  });
  const actual = saved.variants.map((v) => ({
    sku: v.sku.value,
    optionLabels: v.optionLabels,
    price: v.originalPrice.value,
    image: savedHash(v.imageKey),
    rowKey: v.key,
  }));
  if (!same(saved.tierNames, seed.tierNames) || !same(actual, desired))
    differences.push('SKU, tên/thứ tự phân loại, giá nguồn hoặc ảnh phân loại khác bản đã lưu.');
  // An absent optional fact in legacy drafts has create intent, like an explicitly blank cell.
  // A nonempty item ID must never disappear when a prepared folder reopens its saved source.
  if ((manifest.sourceListingId?.value ?? null) !== (saved.sourceListingId?.value ?? null))
    differences.push(
      'ID listing nguồn khác hoặc chưa được ghi nhận trong bản đã lưu. Cần đối chiếu ô ID LISTING trước khi mở lại.',
    );
  return differences;
}
