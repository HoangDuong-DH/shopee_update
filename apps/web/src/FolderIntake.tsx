import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronUp,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  Image,
  Upload,
  X,
} from 'lucide-react';
import type {
  InputBatchRecord,
  InputBatchState,
  ListingDraft,
  WorkbookImport,
  WordImport,
  StoredFolderManifest,
} from '@shopee/domain';
import { api, media, money, type ImportRecord } from './api.js';
import type { EditorSeed } from './Editor.js';
import {
  assembleFolderListing,
  groupDirectoryFiles,
  type FolderAssembly,
  type FolderMode,
  type FolderSourceRules,
  type UploadedFolderFile,
} from './folder-source.js';
import {
  createInputBatchSaver,
  verifyReselectedFiles,
  type BatchSaveStatus,
} from './input-batch-client.js';
import './folder-intake.css';
import { classifyFolderImage } from './folder-image-names.js';
import { FolderImageHints, imageRoleLabel, type ImageRoleFilter } from './FolderImageHints.js';
import { PendingSkuMapping, type PendingMappingFile } from './PendingSkuMapping.js';
import { isMissingPendingSku, type PendingListingMapping } from '../../../packages/domain/src/pending-listing-mapping.js';
import { pendingSlotSku } from './pending-listing-mapping.js';
import { folderBulkStateKey, folderBulkStorageKey, readFolderBulkRecovery, readyFolderBulkEntries, mergeFolderBulkEntries, runFolderBulkSave, type FolderBulkEntry } from './folder-bulk-save.js';

export type FolderManualContext = {
  productKey: string;
  sourceImportIds?: string[];
  priceSource: { importId: string; sheet: string; priceProfile: string | null };
  prepared: {
    title?: string;
    headline?: string;
    body?: string;
    coverId?: string;
    galleryIds?: string[];
    descriptionImageIds?: string[];
  };
};
export type FolderReadProgress = { completed: number; total: number; filename?: string };
type VisualMedia = {
  convention: 'explicit_selection';
  coverPath?: string;
  galleryPaths: string[];
  descriptionPaths: string[];
};
const emptyMedia = (): VisualMedia => ({
  convention: 'explicit_selection',
  galleryPaths: [],
  descriptionPaths: [],
});
const folderFilename = (relativePath: string) =>
  relativePath.split('/').at(-1) || 'Tệp trong thư mục';

export function FolderIntake({
  imports,
  products,
  onRead,
  onContinue,
  onOpenExisting,
  onManual,
  onDirty,
  onBusy,
  externalBusy = false,
  active = true,
  initialBatch,
  initialPriceImportId,
  onBatchSaved,
  onOpenLibrary,
}: {
  imports: ImportRecord[];
  products: ListingDraft[];
  onRead: (
    files: File[],
    onProgress?: (progress: FolderReadProgress) => void,
  ) => Promise<UploadedFolderFile[]>;
  onContinue: (
    seed: EditorSeed,
    variantSummaries?: { sku: string; originalPrice?: string }[],
  ) => void;
  onOpenExisting: (draft: ListingDraft) => void;
  onManual: (context?: FolderManualContext) => void;
  onDirty?: (dirty: boolean) => void;
  onBusy?: (busy: boolean) => void;
  externalBusy?: boolean;
  active?: boolean;
  initialBatch?: InputBatchRecord & { imports: ImportRecord[] };
  initialPriceImportId?: string;
  onBatchSaved?: (record: InputBatchRecord) => void;
  onOpenLibrary?: () => void;
}) {
  const initial = initialBatch?.state;
  const [batchId] = useState(() => initialBatch?.id ?? crypto.randomUUID());
  const [bulkRecovery] = useState(() => {
    try { return { entries: readFolderBulkRecovery(sessionStorage.getItem(folderBulkStorageKey(batchId)), batchId), error: '' }; }
    catch { return { entries: [] as FolderBulkEntry[], error: 'Chưa đọc được biên nhận lưu hàng loạt. Giữ đợt này và kiểm tra quyền lưu trữ của trình duyệt trước khi thử lại.' }; }
  });
  const [bulkEntries, setBulkEntries] = useState(bulkRecovery.entries);
  const [bulkError, setBulkError] = useState(bulkRecovery.error);
  const [bulkBusy, setBulkBusy] = useState(false);
  const bulkGuard = useRef(false);
  const [bulkSavedProducts, setBulkSavedProducts] = useState<ListingDraft[]>([]);
  const allProducts = useMemo(() => {
    const merged = new Map(products.map(product => [product.productKey, product]));
    for (const product of bulkSavedProducts)
      if ((merged.get(product.productKey)?.revision ?? 0) <= product.revision) merged.set(product.productKey, product);
    return [...merged.values()];
  }, [products, bulkSavedProducts]);
  const savedBatch = useRef<InputBatchRecord | undefined>(initialBatch);
  const [batchName, setBatchName] = useState(initial?.name ?? 'Đợt listing mới');
  const [chosenFiles, setChosenFiles] = useState<File[]>([]);
  const [descriptors, setDescriptors] = useState<InputBatchState['files']>(initial?.files ?? []);
  const [productKeys, setProductKeys] = useState<Record<string, string>>(
    initial?.productKeys ?? {},
  );
  const [manifests, setManifests] = useState<Record<string, StoredFolderManifest>>(
    initial?.manifests ?? {},
  );
  const [mode, setMode] = useState<FolderMode>(initial?.mode ?? 'single_listing');
  const [pendingMappings, setPendingMappings] = useState<Record<string, PendingListingMapping>>(
    initial?.pendingMappings ?? {},
  );
  const [uploaded, setUploaded] = useState<UploadedFolderFile[]>(() =>
    (initial?.files ?? []).map((file) => ({
      relativePath: file.relativePath,
      sha256: file.sha256,
      record: initialBatch?.imports.find((record) => record.id === file.importId) ?? null,
      pendingMapping: Object.values(initial?.pendingMappings ?? {}).find(
        (m) => m.relativePath === file.relativePath,
      ),
      ...(Object.values(initial?.manifests ?? {}).find((m) => m.relativePath === file.relativePath)
        ? {
            manifest: Object.values(initial!.manifests!).find(
              (m) => m.relativePath === file.relativePath,
            )!.document,
          }
        : {}),
      ...(file.error ? { error: file.error } : {}),
    })),
  );
  const [setupCollapsed, setSetupCollapsed] = useState(!!initial?.files.length);
  const [sourceId, setSourceId] = useState(
      initial?.priceSelection?.importId ?? initialPriceImportId ?? '',
    ),
    [sheet, setSheet] = useState(initial?.priceSelection?.sheet ?? ''),
    [profileChoice, setProfileChoice] = useState(
      initial?.priceSelection ? JSON.stringify(initial.priceSelection.priceProfile) : '',
    );
  const [catalog, setCatalog] = useState<WorkbookImport | null>(null),
    [sourceLoading, setSourceLoading] = useState(false);
  const [localSources, setLocalSources] = useState<ImportRecord[]>(initialBatch?.imports ?? []);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [progress, setProgress] = useState<FolderReadProgress | null>(null);
  const [selectedFolder, setSelectedFolder] = useState('');
  const [panel, setPanel] = useState<'images' | 'word' | 'sku'>('images');
  const [visual, setVisual] = useState<Record<string, VisualMedia>>(() =>
    Object.fromEntries(
      Object.entries(initial?.visual ?? {}).map(([key, value]) => [
        key,
        { ...value, convention: 'explicit_selection' },
      ]),
    ),
  );
  const [imageRoleFilter, setImageRoleFilter] = useState<ImageRoleFilter>('all');
  const [selectedImages, setSelectedImages] = useState<Record<string, string[]>>({});
  const [wordPaths, setWordPaths] = useState<Record<string, string>>(initial?.wordPaths ?? {});
  const [wordConfirmed, setWordConfirmed] = useState(!!initial?.wordRule);
  const [titleHeader, setTitleHeader] = useState(initial?.wordRule?.titleHeader ?? 'TIÊU ĐỀ'),
    [descriptionHeader, setDescriptionHeader] = useState(
      initial?.wordRule?.descriptionHeader ?? 'BÀI MÔ TẢ ĐĂNG BÁN',
    );
  const [headlineMode, setHeadlineMode] = useState<'first_line' | 'none'>(
    initial?.wordRule?.headline ?? 'first_line',
  );
  const [paragraphSeparator, setParagraphSeparator] = useState<'\n' | '\n\n'>(
    initial?.wordRule?.paragraphSeparator ?? '\n\n',
  );
  const [saveStatus, setSaveStatus] = useState<BatchSaveStatus>('saved');
  const [saveError, setSaveError] = useState('');
  const [hasSaved, setHasSaved] = useState(!!initialBatch);
  const saver = useRef<ReturnType<typeof createInputBatchSaver> | null>(null);
  const callbacks = useRef({ onBatchSaved });
  callbacks.current = { onBatchSaved };
  const [assemblyState, setAssemblyState] = useState<{ context: string; values: FolderAssembly[] }>(
    { context: '', values: [] },
  );
  const [assembling, setAssembling] = useState(false);
  const pipelineGuard = useRef(false),
    sourceGeneration = useRef(0),
    assemblyGeneration = useRef(0),
    mounted = useRef(true);
  const locked = busy || externalBusy || bulkBusy;
  const grouped = useMemo(() => groupDirectoryFiles(descriptors, mode), [descriptors, mode]);
  const workbooks = useMemo(
    () =>
      Array.from(
        new Map(
          [...imports, ...localSources]
            .filter((item) => item.kind === 'xlsx' && item.status === 'ready')
            .map((item) => [item.id, item]),
        ).values(),
      ),
    [imports, localSources],
  );
  const profiles = useMemo(
    () =>
      Array.from(
        new Set(
          (catalog?.rows ?? [])
            .filter((row) => row.sheet === sheet)
            .map((row) => row.priceProfile ?? null),
        ),
      ),
    [catalog, sheet],
  );
  const profile = profiles.find((value) => JSON.stringify(value) === profileChoice);
  const priceReady = !!sourceId && !!catalog && !!sheet && profile !== undefined;
  const group = grouped.bundles.find((item) => item.key === selectedFolder) ?? grouped.bundles[0];
  const groupFiles = group
    ? uploaded.filter((item) => group.files.some((file) => file.relativePath === item.relativePath))
    : [];
  const readableGroupFiles = groupFiles.filter(
    (item): item is UploadedFolderFile & { record: ImportRecord } => item.record !== null,
  );
  const groupImages = readableGroupFiles.filter(
    (item) => item.record.kind === 'image' && item.record.status === 'ready',
  );
  const visibleGroupImages = [...groupImages]
    .filter((item) => imageRoleFilter === 'all' || classifyFolderImage(item.relativePath).role === imageRoleFilter)
    .sort((a, b) => folderFilename(a.relativePath).localeCompare(folderFilename(b.relativePath), 'vi', { numeric: true }) || a.relativePath.localeCompare(b.relativePath));
  useEffect(() => setImageRoleFilter('all'), [group?.key]);
  const groupWords = readableGroupFiles.filter(
    (item) => item.record.kind === 'docx' && item.record.status === 'ready',
  );
  const groupManifest = group ? manifests[group.key]?.document : undefined;
  const groupMedia: VisualMedia =
    group && groupManifest
      ? {
          convention: 'explicit_selection',
          ...(groupManifest.media.cover
            ? { coverPath: group.key + '/' + groupManifest.media.cover.path }
            : {}),
          galleryPaths: groupManifest.media.gallery.map((f) => group.key + '/' + f.path),
          descriptionPaths: groupManifest.media.description.map((f) => group.key + '/' + f.path),
        }
      : group
        ? (visual[group.key] ?? emptyMedia())
        : emptyMedia();
  const imageSelection = group ? (selectedImages[group.key] ?? []) : [];
  const effectiveRules = useMemo(
    () =>
      Object.fromEntries(
        grouped.bundles.map((item) => [
          item.key,
          {
            media: visual[item.key] ?? emptyMedia(),
            ...(wordConfirmed
              ? {
                  word: {
                    kind: 'labeled_sections' as const,
                    titleHeader,
                    descriptionHeader,
                    headline: headlineMode,
                    paragraphSeparator,
                  },
                }
              : {}),
            ...(wordPaths[item.key] ? { wordPath: wordPaths[item.key] } : {}),
          } satisfies FolderSourceRules,
        ]),
      ),
    [
      grouped.bundles,
      visual,
      wordConfirmed,
      titleHeader,
      descriptionHeader,
      headlineMode,
      paragraphSeparator,
      wordPaths,
    ],
  );
  const context = JSON.stringify({
    sourceId,
    sheet,
    profileChoice,
    files: uploaded.map((item) => [
      item.relativePath,
      item.record?.id,
      item.record?.status,
      item.record?.sha256,
    ]),
    groups: grouped.bundles.map((item) => item.key),
    rules: effectiveRules,
    productKeys,
    manifests,
    pendingMappings,
  });
  const assemblies = assemblyState.context === context ? assemblyState.values : [];
  const selectedAssembly = assemblies.find((item) => item.key === group?.key);
  const selectedPending = group ? pendingMappings[group.key] : undefined;
  const selectedMissingSku = selectedPending
    ? selectedPending.document.slots.filter((slot) => isMissingPendingSku(pendingSlotSku(selectedPending, slot.slotId))).length
    : 0;
  // A loaded pending worksheet supplies membership through its own review flow.
  // Keep real media/Word/price exceptions; do not display the generic absent-membership message.
  const selectedIssues = (selectedAssembly?.issues ?? []).filter((issue) =>
    !selectedPending || issue.code !== 'MEMBERSHIP_NOT_MAPPED');
  const namedVariantCount = groupImages.filter((image) => classifyFolderImage(image.relativePath).role === 'variant').length;

  const wordNeedsSelection =
    selectedAssembly?.issues.some((issue) => issue.code.startsWith('WORD_')) ?? false;
  const selectedExisting =
    selectedAssembly &&
    allProducts.find(
      (product) =>
        product.productKey ===
        (selectedAssembly.existingProductKey ??
          (!selectedAssembly.manifest ? selectedAssembly.productKey : undefined)),
    );
  const selectedWordPath = group ? wordPaths[group.key] : undefined;
  const visibleWord =
    groupWords.find((item) => item.relativePath === selectedWordPath) ??
    (groupWords.length === 1 ? groupWords[0] : undefined);
  const wordBody = visibleWord?.record.body as WordImport | undefined;
  const pendingImportIds = [
    ...new Set(
      uploaded
        .filter(
          (item) =>
            item.record &&
            item.record.status !== 'failed' &&
            (item.record.status !== 'ready' || item.record.body === undefined),
        )
        .map((item) => item.record!.id),
    ),
  ];
  const pendingImportKey = JSON.stringify(pendingImportIds);
  const persistenceState: InputBatchState = {
    version: 1,
    name: batchName,
    mode,
    files: descriptors,
    priceSelection:
      sourceId && sheet && profileChoice !== ''
        ? { importId: sourceId, sheet, priceProfile: JSON.parse(profileChoice) as string | null }
        : null,
    visual: Object.fromEntries(
      Object.entries(visual).map(([key, value]) => [
        key,
        {
          ...(value.coverPath ? { coverPath: value.coverPath } : {}),
          galleryPaths: value.galleryPaths,
          descriptionPaths: value.descriptionPaths,
        },
      ]),
    ),
    wordPaths,
    wordRule: wordConfirmed
      ? { titleHeader, descriptionHeader, headline: headlineMode, paragraphSeparator }
      : null,
    productKeys,
    ...(Object.keys(manifests).length ? { manifests } : {}),
    ...(Object.keys(pendingMappings).length ? { pendingMappings } : {}),
  };
  const persistenceKey = JSON.stringify(persistenceState);
  const wordRuleIncomplete = wordConfirmed && (!titleHeader.trim() || !descriptionHeader.trim());
  const unsaved =
    saveStatus !== 'saved' || (!!descriptors.length && !hasSaved) || wordRuleIncomplete;
  const bulkCandidates = readyFolderBulkEntries(assemblies, savedBatch.current, allProducts);
  const bulkUnfinished = bulkEntries.filter(entry => entry.status !== 'saved');
  const bulkHasUncertain = bulkEntries.some(entry => entry.status === 'uncertain' || entry.status === 'saving');

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    saver.current = createInputBatchSaver({
      id: batchId,
      initial: initialBatch,
      onStatus: (status, cause) => {
        setSaveStatus(status);
        setSaveError(
          status === 'conflict'
            ? 'Bộ đầu vào đã có thay đổi ở nơi khác. Phần đang chọn được giữ trên màn hình; mở bản mới nhất để đối chiếu.'
            : cause instanceof Error
              ? cause.message
              : status === 'error'
                ? 'Chưa lưu được bộ đầu vào. Phần đang chọn vẫn được giữ để thử lại.'
                : '',
        );
      },
      onSaved: (record) => {
        savedBatch.current = record;
        setHasSaved(true);
        callbacks.current.onBatchSaved?.(record);
      },
    });
    return () => saver.current?.dispose();
  }, [batchId]);
  useEffect(() => {
    if (
      (uploaded.length || initialBatch) &&
      !wordRuleIncomplete &&
      grouped.issues.length === 0 &&
      grouped.bundles.every((item) => productKeys[item.key])
    ) {
      saver.current?.schedule(persistenceState);
    }
  }, [persistenceKey, uploaded.length]);
  useEffect(() => {
    onDirty?.(unsaved);
  }, [unsaved, onDirty]);
  useEffect(() => {
    onBusy?.(busy || bulkBusy || saveStatus === 'saving');
  }, [busy, bulkBusy, saveStatus, onBusy]);
  useEffect(() => {
    if (!active || busy || !pendingImportIds.length) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let cursor = 0;
    async function checkReceived() {
      const ids = Array.from(
        { length: Math.min(4, pendingImportIds.length) },
        () => pendingImportIds[cursor++ % pendingImportIds.length],
      );
      const results = await Promise.allSettled(
        ids.map((id) =>
          api<ImportRecord>('/v1/imports/' + encodeURIComponent(id), { signal: controller.signal }),
        ),
      );
      if (controller.signal.aborted) return;
      const records = results.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : [],
      );
      setUploaded((all) =>
        all.map((item) => {
          const record = records.find((value) => value.id === item.record?.id);
          if (
            !record ||
            record.sha256 !== item.record?.sha256 ||
            record.bytes !== item.record?.bytes ||
            record.kind !== item.record?.kind
          )
            return item;
          return { ...item, record };
        }),
      );
      timer = setTimeout(() => void checkReceived(), 2000);
    }
    timer = setTimeout(() => void checkReceived(), 1000);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [active, busy, pendingImportKey]);
  useEffect(() => {
    const generation = ++sourceGeneration.current;
    if (!sourceId) {
      setCatalog(null);
      setSourceLoading(false);
      return;
    }
    const controller = new AbortController();
    setSourceLoading(true);
    const loaded = localSources.find((item) => item.id === sourceId);
    const read = loaded?.body
      ? Promise.resolve(loaded)
      : api<ImportRecord>('/v1/imports/' + encodeURIComponent(sourceId), {
          signal: controller.signal,
        });
    void read
      .then((record) => {
        if (controller.signal.aborted || generation !== sourceGeneration.current) return;
        const body = record.body as WorkbookImport | undefined;
        if (
          record.kind !== 'xlsx' ||
          record.status !== 'ready' ||
          !body ||
          !Array.isArray(body.rows) ||
          !Array.isArray(body.sheets)
        )
          throw new Error('Bảng giá chưa đọc xong. Hãy kiểm tra lại tệp nguồn.');
        setCatalog(body);
      })
      .catch((cause) => {
        if (!controller.signal.aborted && generation === sourceGeneration.current) {
          setCatalog(null);
          setError(cause instanceof Error ? cause.message : 'Chưa đọc được bảng giá.');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted && generation === sourceGeneration.current)
          setSourceLoading(false);
      });
    return () => controller.abort();
  }, [sourceId, localSources]);
  useEffect(() => {
    const sources = Object.values(manifests).map((m) => m.document.priceSource);
    if (!sources.length || new Set(sources.map((s) => JSON.stringify(s))).size !== 1) return;
    const desired = sources[0],
      matches = workbooks.filter((w) => w.sha256 === desired.sha256);
    if (matches.length !== 1) return;
    if (!sourceId) setSourceId(matches[0].id);
    if ((!sourceId || sourceId === matches[0].id) && !sheet && profileChoice === '') {
      setSheet(desired.sheet);
      if (desired.selectionMode !== 'operator_choice')
        setProfileChoice(JSON.stringify(desired.priceProfile));
    }
  }, [manifests, workbooks, sourceId, sheet, profileChoice]);
  useEffect(() => {
    const generation = ++assemblyGeneration.current;
    if (!priceReady || !catalog || profile === undefined || !uploaded.length) {
      setAssembling(false);
      return;
    }
    setAssembling(true);
    void Promise.all(
      grouped.bundles.map((item) =>
        assembleFolderListing({
          group: item,
          files: uploaded,
          priceSource: {
            importId: sourceId,
            sheet,
            priceProfile: profile,
            rows: catalog.rows,
            sha256: catalog.source.fileSha256,
          },
          rules: effectiveRules[item.key],
          productKey: productKeys[item.key],
          manifest: manifests[item.key]?.document,
          savedProducts: allProducts,
        }),
      ),
    )
      .then((values) => {
        if (mounted.current && generation === assemblyGeneration.current)
          setAssemblyState({ context, values });
      })
      .catch((cause) => {
        if (mounted.current && generation === assemblyGeneration.current)
          setError(cause instanceof Error ? cause.message : 'Chưa đối chiếu được các thư mục.');
      })
      .finally(() => {
        if (mounted.current && generation === assemblyGeneration.current) setAssembling(false);
      });
  }, [context, priceReady, catalog, profile, allProducts]);

  function choosePrice(id: string) {
    if (locked) return;
    sourceGeneration.current += 1;
    setSourceId(id);
    setCatalog(null);
    setSheet('');
    setProfileChoice('');
    setError('');
  }
  async function readFiles(files: File[], isPrice = false) {
    if (!files.length || locked || pipelineGuard.current) return;
    pipelineGuard.current = true;
    setBusy(true);
    setError('');
    setProgress({ completed: 0, total: files.length });
    try {
      const result = await onRead(files, (next) => {
        if (mounted.current) setProgress(next);
      });
      if (!mounted.current) return;
      if (isPrice) {
        const ready = result
          .map((item) => item.record)
          .find(
            (record): record is ImportRecord =>
              record !== null && record.kind === 'xlsx' && record.status === 'ready',
          );
        if (!ready) throw new Error('Bảng giá chưa đọc được. Xem kết quả tệp và thử lại.');
        setLocalSources((all) => [...all.filter((item) => item.id !== ready.id), ready]);
        setSourceId(ready.id);
        setSheet('');
        setProfileChoice('');
        setCatalog(null);
      } else {
        const nextManifests: Record<string, StoredFolderManifest> = {};
        const nextPending: Record<string, PendingListingMapping> = {};
        for (const received of result) {
          if (!received.pendingMapping) continue;
          const key = received.relativePath
            .split('/')
            .slice(0, mode === 'single_listing' ? 1 : 2)
            .join('/');
          if (received.relativePath !== key + '/listing-mapping.pending.json' || nextPending[key])
            throw new Error('Mỗi thư mục chỉ nhận một bảng phân loại chờ hoàn thiện.');
          const prior = pendingMappings[key];
          if (prior && prior.sha256 !== received.pendingMapping.sha256)
            throw new Error(
              'Hồ sơ phân loại đã khác bản đang bổ sung. Giữ nguyên các ô SKU đã nhập và mở đúng bộ nguồn.',
            );
          nextPending[key] = prior ?? received.pendingMapping;
        }
        for (const received of result) {
          if (!received.manifest || !received.sha256) continue;
          const groupKey = received.relativePath
            .split('/')
            .slice(0, mode === 'single_listing' ? 1 : 2)
            .join('/');
          if (
            received.relativePath !== groupKey + '/listing-source.json' ||
            nextManifests[groupKey]
          )
            throw new Error(
              'Mỗi thư mục listing cần đúng một listing-source.json ở ngay trong thư mục đó.',
            );
          nextManifests[groupKey] = {
            relativePath: received.relativePath,
            sha256: received.sha256,
            document: received.manifest,
          };
        }
        if (Object.keys(nextPending).some((key) => nextManifests[key]))
          throw new Error(
            'Một thư mục có cả hồ sơ hoàn chỉnh và bảng chờ bổ sung. Chọn đúng bộ nguồn để đối chiếu.',
          );
        setUploaded(result);
        setManifests(nextManifests);
        setPendingMappings(nextPending);
        setDescriptors((all) =>
          all.map((file) => {
            const received = result.find((item) => item.relativePath === file.relativePath);
            if (!received) return file;
            return {
              relativePath: file.relativePath,
              name: file.name,
              size: file.size,
              ...(received.record ? { importId: received.record.id } : {}),
              ...(received.sha256 || received.record?.sha256
                ? { sha256: received.sha256 ?? received.record!.sha256 }
                : {}),
              ...(received.error ? { error: received.error } : {}),
            };
          }),
        );
        setSetupCollapsed(true);
      }
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error
            ? cause.message
            : 'Chưa đọc được các tệp. Thư mục đã chọn vẫn được giữ để thử lại.',
        );
    } finally {
      pipelineGuard.current = false;
      if (mounted.current) {
        setBusy(false);
        setProgress(null);
      }
    }
  }
  async function stage(files: FileList | null) {
    if (!files?.length || locked || pipelineGuard.current) return;
    const selected = Array.from(files);
    if (hasSaved || uploaded.length) {
      pipelineGuard.current = true;
      setBusy(true);
      try {
        if (!(await verifyReselectedFiles(descriptors, selected))) {
          setError(
            'Thư mục này khác bộ đầu vào đang mở. Chọn lại đúng thư mục gốc để đọc tiếp; vào Kho đầu vào để nhận một bộ mới.',
          );
          return;
        }
        setChosenFiles(selected);
        setSetupCollapsed(false);
        setError('');
      } catch {
        setError('Chưa đối chiếu được tệp đã chọn với bản gốc. Chọn lại đúng thư mục và thử lại.');
      } finally {
        pipelineGuard.current = false;
        setBusy(false);
      }
      return;
    }
    const nextDescriptors = selected.map((file) => ({
      name: file.name,
      relativePath: file.webkitRelativePath || file.name,
      size: file.size,
    }));
    const nextGroups = groupDirectoryFiles(nextDescriptors, mode);
    setChosenFiles(selected);
    setDescriptors(nextDescriptors);
    setProductKeys(
      Object.fromEntries(
        nextGroups.bundles.map((item) => [item.key, `input-${crypto.randomUUID()}`]),
      ),
    );
    setBatchName(selected[0]?.webkitRelativePath.split('/')[0] || 'Đợt listing mới');
    setSetupCollapsed(false);
    setUploaded([]);
    setManifests({});
    setPendingMappings({});
    setAssemblyState({ context: '', values: [] });
    setVisual({});
    setSelectedImages({});
    setWordPaths({});
    setSelectedFolder('');
    setError('');
  }
  function changeMode(next: FolderMode) {
    if (locked || uploaded.length || hasSaved) return;
    setMode(next);
    setProductKeys(
      Object.fromEntries(
        groupDirectoryFiles(descriptors, next).bundles.map((item) => [
          item.key,
          `input-${crypto.randomUUID()}`,
        ]),
      ),
    );
    setSelectedFolder('');
    setVisual({});
    setSelectedImages({});
    setWordPaths({});
  }
  function chooseImage(path: string) {
    if (!group || locked || groupManifest) return;
    setSelectedImages((all) => {
      const current = all[group.key] ?? [];
      return {
        ...all,
        [group.key]: current.includes(path)
          ? current.filter((value) => value !== path)
          : [...current, path],
      };
    });
  }
  function assignImages(role: 'cover' | 'gallery' | 'description' | 'both') {
    if (
      !group ||
      !!groupManifest ||
      locked ||
      !imageSelection.length ||
      (role === 'cover' && imageSelection.length !== 1)
    )
      return;
    setVisual((all) => {
      const current = all[group.key] ?? emptyMedia();
      return {
        ...all,
        [group.key]: {
          ...current,
          ...(role === 'cover' ? { coverPath: imageSelection[0] } : {}),
          ...(role === 'gallery' || role === 'both'
            ? { galleryPaths: [...new Set([...current.galleryPaths, ...imageSelection])] }
            : {}),
          ...(role === 'description' || role === 'both'
            ? { descriptionPaths: [...new Set([...current.descriptionPaths, ...imageSelection])] }
            : {}),
        },
      };
    });
    setSelectedImages((all) => ({ ...all, [group.key]: [] }));
  }
  function adjustImage(
    role: 'galleryPaths' | 'descriptionPaths',
    path: string,
    direction: -1 | 0 | 1,
  ) {
    if (!group || locked || groupManifest) return;
    setVisual((all) => {
      const current = all[group.key] ?? emptyMedia(),
        ids = [...current[role]],
        index = ids.indexOf(path);
      if (index < 0) return all;
      if (direction === 0) ids.splice(index, 1);
      else {
        const target = index + direction;
        if (target < 0 || target >= ids.length) return all;
        [ids[index], ids[target]] = [ids[target], ids[index]];
      }
      return { ...all, [group.key]: { ...current, [role]: ids } };
    });
  }
  function manual() {
    if (
      !selectedAssembly ||
      !priceReady ||
      profile === undefined ||
      locked ||
      unsaved ||
      groupManifest
    )
      return;
    const candidates = selectedAssembly.candidates;
    onManual({
      productKey: selectedAssembly.productKey,
      sourceImportIds: [
        ...new Set(
          readableGroupFiles
            .filter(
              (item) =>
                item.record.status === 'ready' &&
                (item.record.kind === 'docx' || item.record.kind === 'image'),
            )
            .map((item) => item.record.id),
        ),
      ],
      priceSource: { importId: sourceId, sheet, priceProfile: profile },
      prepared: {
        ...(!wordNeedsSelection && candidates.title !== undefined
          ? { title: candidates.title }
          : {}),
        ...(!wordNeedsSelection && candidates.headline !== undefined
          ? { headline: candidates.headline }
          : {}),
        ...(!wordNeedsSelection && candidates.body !== undefined ? { body: candidates.body } : {}),
        ...(candidates.cover ? { coverId: candidates.cover.importId } : {}),
        galleryIds: candidates.gallery.map((item) => item.importId),
        descriptionImageIds: candidates.descriptionImages.map((item) => item.importId),
      },
    });
  }
  function continueAssembly(assembly: FolderAssembly) {
    if (locked || unsaved) return;
    if (pendingMappings[assembly.key]) {
      setSelectedFolder(assembly.key);
      setPanel('sku');
      return;
    }
    const existing = allProducts.find(
      (product) =>
        product.productKey ===
        (assembly.existingProductKey ?? (!assembly.manifest ? assembly.productKey : undefined)),
    );
    if (existing) {
      onOpenExisting(existing);
      return;
    }
    if (!assembly.seed) return;
    onContinue(
      assembly.manifest?.product.sourceRevision === 0 && savedBatch.current
        ? {
            ...assembly.seed,
            folderBinding: {
              batchId,
              revision: savedBatch.current.revision,
              groupKey: assembly.key,
            },
          }
        : assembly.seed,
      assembly.seed.variants.map((variant) => {
        const row = catalog?.rows.find((value) => value.key === variant.rowKey);
        return { sku: row?.sku.value ?? '', originalPrice: row?.originalPrice?.value };
      }),
    );
  }

  function importPending(mapping: PendingListingMapping, file: PendingMappingFile) {
    if (!group || locked || manifests[group.key]) return;
    const previous = pendingMappings[group.key];
    if (previous && previous.sha256 !== mapping.sha256) {
      setError('Hồ sơ này khác bảng đang bổ sung. Giữ nguyên các ô đã nhập và mở đúng bộ nguồn.');
      return;
    }
    const value = previous ?? mapping;
    setPendingMappings((all) => ({ ...all, [group.key]: value }));
    setDescriptors((all) => [...all.filter((f) => f.relativePath !== file.relativePath), file]);
    setUploaded((all) => [
      ...all.filter((f) => f.relativePath !== file.relativePath),
      { relativePath: file.relativePath, sha256: file.sha256, record: null, pendingMapping: value },
    ]);
    setProductKeys((all) =>
      all[group.key] ? all : { ...all, [group.key]: `input-${crypto.randomUUID()}` },
    );
    setError('');
  }

  function continuePending(seed: EditorSeed, variants: { sku: string; originalPrice?: string }[]) {
    if (!group || locked || unsaved || !savedBatch.current || !pendingMappings[group.key]) return;
    const candidates = selectedAssembly?.candidates,
      document = pendingMappings[group.key].document;
    onContinue(
      {
        ...seed,
        productKey: document.product.productKey,
        sourceListingId: document.sourceListingId,
        title: document.title,
        headline: candidates?.headline ?? '',
        body: candidates?.body ?? '',
        coverId: candidates?.cover?.importId,
        galleryIds: candidates?.gallery.map((i) => i.importId) ?? [],
        descriptionImageIds: candidates?.descriptionImages.map((i) => i.importId) ?? [],
        folderBinding: { batchId, revision: savedBatch.current.revision, groupKey: group.key },
      },
      variants,
    );
  }

  async function saveReadyFolders() {
    if (locked || bulkGuard.current || bulkRecovery.error || unsaved || assembling || !savedBatch.current) return;
    if (folderBulkStateKey(savedBatch.current.state) !== folderBulkStateKey(persistenceState)) {
      setBulkError('Đợi các lựa chọn hiện tại lưu xong vào đợt nhập rồi thử lại.');
      return;
    }
    const entries = mergeFolderBulkEntries(bulkEntries, bulkCandidates);
    if (!entries.some(entry => entry.status !== 'saved')) return;
    bulkGuard.current = true;
    setBulkBusy(true);
    setBulkError('');
    try {
      await runFolderBulkSave(entries, {
        readBatch: id => api<InputBatchRecord>('/v1/input-batches/' + encodeURIComponent(id)),
        readProduct: key => api<ListingDraft>('/v1/products/' + encodeURIComponent(key)),
        save: request => api<ListingDraft>('/v1/products', { method: 'POST', body: JSON.stringify(request) }),
        checkpoint: next => {
          sessionStorage.setItem(folderBulkStorageKey(batchId), JSON.stringify({ version: 1, batchId, entries: next }));
          if (mounted.current) setBulkEntries(next);
        },
        onSaved: draft => { if (mounted.current) setBulkSavedProducts(current => [...current.filter(item => item.productKey !== draft.productKey), draft]); },
      });
    } catch (cause) {
      if (mounted.current) setBulkError(cause instanceof Error ? cause.message : 'Chưa lưu được biên nhận. Giữ trang này và thử lại.');
    } finally {
      bulkGuard.current = false;
      if (mounted.current) setBulkBusy(false);
    }
  }

  return (
    <div className="folder-intake">
      {onOpenLibrary && (
        <button
          className="folder-library-back"
          disabled={locked || saveStatus === 'saving'}
          onClick={onOpenLibrary}
        >
          ← Kho đầu vào
        </button>
      )}
      <div className="page-heading">
        <div>
          <p className="eyebrow">BỘ LISTING ĐÃ CHUẨN BỊ</p>
          <h1>Nhập listing theo thư mục</h1>
          <p>
            Mỗi thư mục là một listing, gồm Word và ảnh của bộ đó. Bảng giá dùng chung cho cả đợt.
          </p>
        </div>
        <button
          disabled={locked || unsaved}
          onClick={() => {
            if (!locked && !unsaved) onManual();
          }}
        >
          Nhập thủ công khi cần
        </button>
      </div>
      <div className="folder-scope">
        <Check size={17} aria-hidden="true" />
        <span>Bộ đầu vào được lưu riêng để làm tiếp · Chưa gửi lên Shopee</span>
      </div>
      {(uploaded.length > 0 || hasSaved) && (
        <div className={`folder-save-status ${saveStatus}`}>
          <p role="status">
            {saveStatus === 'saving'
              ? 'Đang lưu bộ đầu vào…'
              : saveStatus === 'saved' && hasSaved && !unsaved
                ? 'Đã lưu vào Kho đầu vào'
                : 'Có thay đổi chưa lưu'}
          </p>
          {saveError && (
            <div role="alert">
              <p>{saveError}</p>
              {saveStatus === 'error' && (
                <button disabled={locked} onClick={() => saver.current?.retry()}>
                  Thử lưu lại
                </button>
              )}
              {saveStatus === 'conflict' && onOpenLibrary && (
                <button disabled={locked} onClick={onOpenLibrary}>
                  Mở bản đã lưu
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {error && (
        <div className="error banner" role="alert">
          {error}
        </div>
      )}
      {uploaded.length > 0 && (
        <section className="folder-setup-summary panel" aria-label="Nguồn đã chọn">
          <div className="folder-setup-identity">
            <FolderOpen size={24} aria-hidden="true" />
            <div>
              <strong>
                {grouped.bundles.length} thư mục · {descriptors.length} tệp
              </strong>
              <p>
                {workbooks.find((item) => item.id === sourceId)?.filename ?? 'Chưa chọn bảng giá'} ·{' '}
                {sheet || 'Chưa chọn sheet'} ·{' '}
                {profile === undefined ? 'Chưa chọn bộ giá' : (profile ?? 'Giá của sheet đã chọn')}
              </p>
              <p className="caption">
                {
                  uploaded.filter((item) => item.record?.status === 'ready' || !!item.manifest || !!item.pendingMapping)
                    .length
                }
                /{uploaded.length} tệp đã đọc được. Word và ảnh vẫn được giữ trong từng thư mục.
              </p>
            </div>
          </div>
          <div className="actions">
            <button
              disabled={locked}
              aria-expanded={!setupCollapsed}
              onClick={() => setSetupCollapsed((value) => !value)}
            >
              {setupCollapsed ? 'Bảng giá & tệp nguồn' : 'Thu gọn phần chọn nguồn'}
            </button>
            <button
              disabled={locked || !chosenFiles.length}
              onClick={() => void readFiles(chosenFiles)}
            >
              {busy ? 'Đang đọc lại…' : 'Đọc lại tệp'}
            </button>
          </div>
          {progress && (
            <p className="folder-compact-progress" role="status">
              Đang đọc {progress.completed}/{progress.total} tệp
              {progress.filename ? ` · ${progress.filename}` : ''}
            </p>
          )}
          {setupCollapsed && !priceReady && (
            <p className="folder-compact-progress">
              Cần chọn bảng giá, sheet và bộ giá trước khi hoàn thiện SKU. Mở “Bảng giá & tệp nguồn”
              để bổ sung.
            </p>
          )}
          {setupCollapsed && grouped.issues.length > 0 && (
            <div className="folder-compact-progress folder-exceptions">
              {grouped.issues.map((issue, index) => (
                <p key={index}>
                  {issue.relativePath ? `${issue.relativePath}: ` : ''}
                  {issue.message}
                </p>
              ))}
            </div>
          )}
        </section>
      )}
      <div className="folder-setup-controls" hidden={setupCollapsed}>
        <section className="panel folder-price-source" aria-label="Bảng giá dùng chung">
          <div className="section-heading">
            <div>
              <h2>
                <FileSpreadsheet size={19} aria-hidden="true" /> Bảng giá dùng chung
              </h2>
              <p className="caption">
                Chọn một lần. Ứng dụng chỉ lấy giá của đúng SKU trong sheet và bộ giá này.
              </p>
            </div>
            <label className={`upload-button${locked ? ' disabled' : ''}`}>
              <Upload size={16} aria-hidden="true" /> Tải bảng giá chung
              <input
                type="file"
                accept=".xlsx"
                aria-label="Tải bảng giá chung"
                disabled={locked}
                onChange={(event) => {
                  const files = Array.from(event.currentTarget.files ?? []);
                  void readFiles(files, true);
                  event.currentTarget.value = '';
                }}
              />
            </label>
          </div>
          <div className="folder-price-fields">
            <label>
              Bảng giá chung
              <select
                disabled={locked}
                value={sourceId}
                onChange={(event) => choosePrice(event.target.value)}
              >
                <option value="">Chọn bảng giá đã nhập</option>
                {workbooks.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.filename}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Sheet chứa giá
              <select
                disabled={locked || sourceLoading || !catalog}
                value={sheet}
                onChange={(event) => {
                  setSheet(event.target.value);
                  setProfileChoice('');
                }}
              >
                <option value="">{sourceLoading ? 'Đang đọc bảng giá…' : 'Chọn sheet'}</option>
                {catalog?.sheets.map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Bộ giá áp dụng
              <select
                disabled={locked || !sheet}
                value={profileChoice}
                onChange={(event) => setProfileChoice(event.target.value)}
              >
                <option value="">Chọn bộ giá</option>
                {profiles.map((value) => (
                  <option key={JSON.stringify(value)} value={JSON.stringify(value)}>
                    {value ?? 'Giá của sheet đã chọn'}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {priceReady && (
            <p className="caption">
              GIÁ GỐC dùng cho đăng mới. GIÁ BÁN được giữ riêng làm giá mục tiêu khuyến mại.
            </p>
          )}
        </section>
        <section className="folder-picker panel" aria-label="Thư mục nguồn">
          <div className="folder-picker-main">
            <FolderOpen size={34} aria-hidden="true" />
            <div>
              <h2>
                {descriptors.length
                  ? `${grouped.bundles.length} thư mục · ${descriptors.length} tệp đã chọn`
                  : 'Chọn thư mục listing của bạn'}
              </h2>
              <p>
                Giữ Word và ảnh trong cùng thư mục. Chọn một listing hoặc một thư mục chứa nhiều
                listing.
              </p>
            </div>
            <label className={`upload-button${locked ? ' disabled' : ''}`}>
              <FolderOpen size={17} aria-hidden="true" />{' '}
              {hasSaved || uploaded.length
                ? 'Chọn lại thư mục gốc'
                : descriptors.length
                  ? 'Chọn thư mục khác'
                  : 'Chọn thư mục'}
              <input
                type="file"
                multiple
                {...{ webkitdirectory: '' }}
                aria-label="Chọn thư mục listing"
                disabled={locked}
                onChange={(event) => {
                  void stage(event.currentTarget.files);
                  event.currentTarget.value = '';
                }}
              />
            </label>
          </div>
          <div className="folder-batch-mode">
            <label>
              <input
                type="radio"
                name="folder-mode"
                checked={mode === 'single_listing'}
                disabled={locked || uploaded.length > 0 || hasSaved}
                onChange={() => changeMode('single_listing')}
              />{' '}
              Thư mục này là một listing
            </label>
            <label>
              <input
                type="radio"
                name="folder-mode"
                checked={mode === 'parent_with_listing_folders'}
                disabled={locked || uploaded.length > 0 || hasSaved}
                onChange={() => changeMode('parent_with_listing_folders')}
              />{' '}
              Mỗi thư mục con là một listing
            </label>
          </div>
          {hasSaved && !chosenFiles.length && (
            <p className="caption">
              Các tệp đã nhận và cách chọn ảnh được khôi phục từ Kho đầu vào. Chỉ cần chọn lại thư
              mục gốc nếu muốn đọc tiếp tệp chưa nhận được.
            </p>
          )}
          <div className="folder-read-row">
            <p className="caption">
              Tệp được giữ nguyên. Sau khi đọc, chọn ảnh theo hình và đối chiếu những phần chưa rõ.
            </p>
            <button
              className="primary"
              disabled={locked || !grouped.bundles.length || !chosenFiles.length}
              onClick={() => void readFiles(chosenFiles)}
            >
              {busy ? 'Đang đọc tệp…' : 'Đọc các thư mục'}{' '}
              <ArrowRight size={17} aria-hidden="true" />
            </button>
          </div>
          {progress && (
            <p role="status">
              Đã xử lý {progress.completed}/{progress.total} tệp
              {progress.filename ? ` · ${progress.filename}` : ''}
            </p>
          )}
          {grouped.issues.map((issue, index) => (
            <p className="error" key={index}>
              {issue.message}
            </p>
          ))}
        </section>
      </div>
      {grouped.bundles.length > 0 && (
        <section className="panel" aria-label="Lưu các bộ đã sẵn sàng">
          <div className="section-heading">
            <div>
              <h2>Lưu bộ listing vào kho</h2>
              <p>{bulkCandidates.length} bộ đã có hồ sơ ghép đầy đủ · Giữ nguyên nội dung, ảnh, phân loại và bảng giá đã chọn.</p>
            </div>
            <button type="button" className="primary" disabled={locked || unsaved || assembling || !!bulkRecovery.error || (!bulkCandidates.length && !bulkUnfinished.length)} onClick={() => void saveReadyFolders()}>
              {bulkBusy ? 'Đang lưu các bộ…' : bulkHasUncertain ? 'Đọc lại kết quả và tiếp tục lưu' : bulkUnfinished.length ? 'Thử lưu các bộ còn lại' : `Lưu tất cả ${bulkCandidates.length} bộ đã sẵn sàng`}
            </button>
          </div>
          <p className="caption">Chỉ lưu bản nháp trong ứng dụng. Sau đó vào Đăng hàng để chuẩn bị lô và tự bấm đăng qua API. Bộ còn thiếu thông tin vẫn được giữ để bổ sung.</p>
          {unsaved && <p className="caption">Đợi đợt nhập lưu xong trước khi lưu các bộ listing.</p>}
          {bulkError && <p role="alert" className="error">{bulkError}</p>}
          {!!bulkEntries.length && <>
            <p role="status">Đã lưu {bulkEntries.filter(entry => entry.status === 'saved').length}/{bulkEntries.length} bộ{bulkBusy ? ' · Đang xử lý' : ''}.</p>
            <details open={bulkEntries.some(entry => entry.status === 'failed' || entry.status === 'uncertain')}>
              <summary>Kết quả lưu từng bộ</summary>
              <ul>{bulkEntries.map(entry => <li key={entry.request.productKey}>
                <strong>{entry.title}</strong> — {entry.status === 'saved' ? 'Đã lưu vào kho' : entry.status === 'saving' ? 'Đang lưu' : entry.status === 'queued' ? 'Chờ lưu' : entry.status === 'uncertain' ? 'Cần đọc lại kết quả' : 'Cần xử lý'}
                {entry.message && <p>{entry.message}</p>}
              </li>)}</ul>
            </details>
          </>}
        </section>
      )}
      {grouped.bundles.length > 0 && (
        <div className="folder-batch-layout">
          <section className="panel folder-queue" aria-label="Danh sách thư mục">
            <div className="section-heading">
              <h2>Các listing trong đợt</h2>
              <span className="tag neutral">{grouped.bundles.length} bộ</span>
            </div>
            <div className="folder-queue-list">
              {grouped.bundles.map((item) => {
                const assembly = assemblies.find((value) => value.key === item.key),
                  existing =
                    assembly &&
                    allProducts.find(
                      (product) =>
                        product.productKey ===
                        (assembly.existingProductKey ??
                          (!assembly.manifest ? assembly.productKey : undefined)),
                    );
                const readCount = uploaded.filter(
                  (value) =>
                    (value.record?.status === 'ready' ||
                      !!value.manifest ||
                      !!value.pendingMapping) &&
                    item.files.some((file) => file.relativePath === value.relativePath),
                ).length;
                const attemptedCount = uploaded.filter((value) =>
                  item.files.some((file) => file.relativePath === value.relativePath),
                ).length;
                return (
                  <article
                    className={`folder-queue-row${group?.key === item.key ? ' active' : ''}`}
                    key={item.key}
                    data-testid="folder-row"
                  >
                    <button
                      className="folder-row-name"
                      aria-pressed={group?.key === item.key}
                      onClick={() => {
                        setSelectedFolder(item.key);
                        setPanel('images');
                      }}
                    >
                      <FolderOpen size={22} aria-hidden="true" />
                      <span>
                        <strong>{item.name}</strong>
                        <small>
                          {
                            item.files.filter((file) => /\.(png|jpe?g|webp)$/i.test(file.name))
                              .length
                          }{' '}
                          ảnh · {item.files.filter((file) => /\.docx$/i.test(file.name)).length}{' '}
                          Word · {item.files.length} tệp
                        </small>
                      </span>
                    </button>
                    <div className="folder-row-status">
                      <span className={`tag ${assembly?.seed || existing ? 'neutral' : 'warning'}`}>
                        {existing
                          ? 'Bộ này đã lưu'
                          : attemptedCount > readCount
                            ? `${attemptedCount - readCount} tệp cần kiểm tra`
                            : !readCount
                              ? 'Chờ đọc tệp'
                              : !priceReady
                                ? 'Chọn bảng giá chung'
                                : assembling
                                  ? 'Đang đối chiếu'
                                  : pendingMappings[item.key]
                                    ? `Đã đọc ${pendingMappings[item.key].document.slots.length} phân loại`
                                  : assembly?.seed
                                    ? 'Có thể xem bản nháp'
                                    : 'Cần bạn đối chiếu'}
                      </span>
                      {assembly && (assembly.seed || existing) ? (
                        <button
                          disabled={locked || unsaved}
                          onClick={() => continueAssembly(assembly)}
                        >
                          {existing ? 'Mở bộ đã lưu' : 'Xem & hoàn thiện'}{' '}
                          <ArrowRight size={15} aria-hidden="true" />
                        </button>
                      ) : (
                        <button onClick={() => {
                          setSelectedFolder(item.key);
                          if (pendingMappings[item.key]) setPanel('sku');
                        }}>{pendingMappings[item.key] ? 'Xem bảng phân loại' : 'Xem nguồn'}</button>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
          {group && (
            <section
              className="panel folder-candidate"
              data-testid="folder-candidate"
              aria-label={`Nguồn của ${group.name}`}
            >
              <div className="section-heading">
                <div>
                  <p className="eyebrow">ĐANG ĐỐI CHIẾU</p>
                  <h2>{group.name}</h2>
                </div>
                <span className="tag neutral">{group.files.length} tệp</span>
              </div>
              {selectedPending && (
                <section className="folder-pending-status" aria-label="Trạng thái phân loại đã nhập">
                  <strong>Đã đọc {selectedPending.document.slots.length} phân loại từ hồ sơ đi kèm.</strong>
                  <p>{selectedMissingSku
                    ? `Còn ${selectedMissingSku} phân loại chưa có SKU; giữ các mã đã có để bổ sung tiếp.`
                    : 'Đã có mã SKU cho mọi phân loại; không cần nhập lại bảng.'}</p>
                  <p className="caption">{selectedPending.structureConfirmed
                    ? 'Bạn đã xác nhận cấu trúc. Mở bảng để xem kết quả đối chiếu với giá đang chọn và tiếp tục.'
                    : 'Mở bảng để đối chiếu giá và xác nhận các lựa chọn trước khi tiếp tục.'}</p>
                  {panel !== 'sku' && <button type="button" onClick={() => setPanel('sku')}>Xem bảng phân loại</button>}
                </section>
              )}
              {selectedIssues.length > 0 && (
                <div className="folder-exceptions">
                  {selectedIssues.slice(0, 3).map((issue, index) => (
                    <p key={index}>{issue.message}</p>
                  ))}
                  {selectedIssues.length > 3 && (
                    <details>
                      <summary>
                        Xem thêm {selectedIssues.length - 3} phần cần đối chiếu
                      </summary>
                      {selectedIssues.slice(3).map((issue, index) => (
                        <p key={index}>{issue.message}</p>
                      ))}
                    </details>
                  )}
                </div>
              )}
              {!groupManifest && panel === 'sku' && (
                <PendingSkuMapping
                  groupKey={group.key}
                  value={pendingMappings[group.key]}
                  onImport={importPending}
                  onChange={(mapping) =>
                    setPendingMappings((all) => ({ ...all, [group.key]: mapping }))
                  }
                  priceSource={
                    priceReady && catalog && profile !== undefined
                      ? { importId: sourceId, sheet, priceProfile: profile, rows: catalog.rows }
                      : undefined
                  }
                  imageContext={{ group, files: uploaded }}
                  onContinue={continuePending}
                  disabled={locked}
                  saved={!unsaved}
                />
              )}
              {groupManifest && (
                <p className="caption">
                  Đã đọc hồ sơ đi kèm: {groupManifest.variants.length} SKU, đúng thứ tự phân loại và
                  vai trò ảnh. Các lựa chọn trong hồ sơ được giữ nguyên; mở bản nháp để kiểm tra nội
                  dung.
                </p>
              )}
              <div className="editor-tabs" role="tablist" aria-label="Nguồn trong thư mục">
                <button
                  role="tab"
                  aria-selected={panel === 'images'}
                  onClick={() => setPanel('images')}
                >
                  <Image size={16} aria-hidden="true" /> Ảnh trong thư mục
                </button>
                <button
                  role="tab"
                  aria-selected={panel === 'word'}
                  onClick={() => setPanel('word')}
                >
                  <FileText size={16} aria-hidden="true" /> Word & nội dung
                </button>
                <button role="tab" aria-selected={panel === 'sku'} onClick={() => setPanel('sku')}>
                  <FileSpreadsheet size={16} aria-hidden="true" /> SKU & giá
                </button>
              </div>
              {!groupFiles.length ? (
                <div className="empty">
                  <FolderOpen size={32} aria-hidden="true" />
                  <h3>Thư mục đã được chọn</h3>
                  <p>Bấm “Đọc các thư mục” để xem ảnh và nội dung tại đây.</p>
                  <ul className="folder-file-names">
                    {group.files.map((file) => (
                      <li key={file.relativePath}>{file.name}</li>
                    ))}
                  </ul>
                </div>
              ) : (
                <>
                  {panel === 'images' && (
                    <fieldset
                      className="folder-visual-assignment"
                      disabled={!!groupManifest}
                      style={{ border: 0, padding: 0, minWidth: 0 }}
                    >
                      <p>
                        {groupManifest
                          ? 'Vai trò và thứ tự ảnh đã được ghi trong hồ sơ. Các ảnh còn lại được giữ để đối chiếu.'
                          : 'Chọn ảnh bằng hình bên dưới, rồi chọn vị trí sử dụng. Không cần đổi tên tệp thành SKU.'}
                      </p>
                      {!groupManifest && <FolderImageHints
                        paths={groupImages.map((item) => item.relativePath)}
                        selection={groupMedia}
                        disabled={locked}
                        filter={imageRoleFilter}
                        onFilter={setImageRoleFilter}
                        onApply={(next) => {
                          if (locked || groupManifest) return;
                          setVisual((all) => ({ ...all, [group.key]: { ...next, convention: 'explicit_selection' } }));
                        }}
                      />}
                      <div className="folder-role-toolbar">
                        <strong>{imageSelection.length} ảnh đang chọn</strong>
                        <button
                          disabled={locked || imageSelection.length !== 1}
                          onClick={() => assignImages('cover')}
                        >
                          Dùng làm ảnh bìa
                        </button>
                        <button
                          disabled={locked || !imageSelection.length}
                          onClick={() => assignImages('gallery')}
                        >
                          Thêm vào bộ ảnh đầu trang
                        </button>
                        <button
                          disabled={locked || !imageSelection.length}
                          onClick={() => assignImages('description')}
                        >
                          Thêm vào ảnh mô tả
                        </button>
                        <button
                          disabled={locked || !imageSelection.length}
                          onClick={() => assignImages('both')}
                        >
                          Thêm vào cả hai
                        </button>
                      </div>
                      <div className="folder-image-grid">
                        {visibleGroupImages.map((item) => (
                          <label
                            className={`folder-image-option${imageSelection.includes(item.relativePath) ? ' chosen' : ''}`}
                            key={item.relativePath}
                          >
                            <input
                              type="checkbox"
                              aria-label={`Chọn ảnh ${folderFilename(item.relativePath)}`}
                              disabled={locked}
                              checked={imageSelection.includes(item.relativePath)}
                              onChange={() => chooseImage(item.relativePath)}
                            />
                            <img
                              src={media(item.record.id)}
                              alt={folderFilename(item.relativePath)}
                              loading="lazy"
                            />
                            <span className="folder-image-name">
                              {folderFilename(item.relativePath)}
                            </span>
                            {!groupManifest && <span className="folder-image-hint" title={classifyFolderImage(item.relativePath).reason}>
                              {imageRoleLabel[classifyFolderImage(item.relativePath).role]}
                              {classifyFolderImage(item.relativePath).ordinal !== undefined ? ` · ${classifyFolderImage(item.relativePath).ordinal}` : ''}
                            </span>}
                            <span className="folder-image-roles">
                              {groupMedia.coverPath === item.relativePath && <b>Bìa</b>}
                              {groupMedia.galleryPaths.includes(item.relativePath) && (
                                <b>
                                  Đầu trang {groupMedia.galleryPaths.indexOf(item.relativePath) + 1}
                                </b>
                              )}
                              {groupMedia.descriptionPaths.includes(item.relativePath) && (
                                <b>
                                  Mô tả {groupMedia.descriptionPaths.indexOf(item.relativePath) + 1}
                                </b>
                              )}
                            </span>
                          </label>
                        ))}
                      </div>
                      {!!groupImages.length && !visibleGroupImages.length && <p className="caption">Không có ảnh thuộc nhóm này. Chọn Tất cả để xem các ảnh còn lại.</p>}
                      {!groupImages.length && (
                        <p className="empty">
                          Chưa có ảnh đọc được trong thư mục này. Xem trạng thái tệp bên dưới.
                        </p>
                      )}
                      <div className="folder-assigned-summary">
                        <h3>Ảnh đã phân vào vị trí</h3>
                        {!groupManifest && !groupMedia.coverPath && !groupMedia.galleryPaths.length &&
                          <p className="caption">Tên ảnh đã được nhận diện nhưng chưa được áp dụng. Bấm “Điền vị trí trống theo tên” ở trên để dùng bìa và ảnh g, hoặc chọn từng ảnh bằng tay.</p>}

                        <p>
                          Ảnh bìa: {groupMedia.coverPath?.split('/').at(-1) ?? 'Chưa chọn'}{' '}
                          {groupMedia.coverPath && (
                            <button
                              disabled={locked}
                              aria-label="Bỏ ảnh bìa đã chọn"
                              onClick={() =>
                                setVisual((all) => ({
                                  ...all,
                                  [group.key]: {
                                    ...(all[group.key] ?? emptyMedia()),
                                    coverPath: undefined,
                                  },
                                }))
                              }
                            >
                              <X size={14} />
                            </button>
                          )}
                        </p>
                        {(['galleryPaths', 'descriptionPaths'] as const).map((role) => (
                          <details key={role} open={groupMedia[role].length > 0}>
                            <summary>
                              {role === 'galleryPaths' ? 'Bộ ảnh đầu trang' : 'Ảnh mô tả'} ·{' '}
                              {groupMedia[role].length} ảnh
                            </summary>
                            <ol>
                              {groupMedia[role].map((path, index) => (
                                <li key={path}>
                                  <span>{path.split('/').at(-1)}</span>
                                  <div className="actions">
                                    <button
                                      disabled={locked || index === 0}
                                      aria-label={`Đưa ${role === 'galleryPaths' ? 'bộ ảnh đầu trang' : 'ảnh mô tả'} ${index + 1} lên trước`}
                                      onClick={() => adjustImage(role, path, -1)}
                                    >
                                      <ChevronUp size={14} />
                                    </button>
                                    <button
                                      disabled={locked || index === groupMedia[role].length - 1}
                                      aria-label={`Đưa ${role === 'galleryPaths' ? 'bộ ảnh đầu trang' : 'ảnh mô tả'} ${index + 1} về sau`}
                                      onClick={() => adjustImage(role, path, 1)}
                                    >
                                      <ChevronDown size={14} />
                                    </button>
                                    <button
                                      disabled={locked}
                                      aria-label={`Bỏ ${path.split('/').at(-1)} khỏi ${role === 'galleryPaths' ? 'bộ ảnh đầu trang' : 'ảnh mô tả'}`}
                                      onClick={() => adjustImage(role, path, 0)}
                                    >
                                      <X size={14} />
                                    </button>
                                  </div>
                                </li>
                              ))}
                            </ol>
                          </details>
                        ))}
                        <section className="folder-variant-location" aria-label="Vị trí ảnh phân loại">
                          <strong>Ảnh phân loại · {groupManifest
                            ? `${groupManifest.variants.filter((variant) => variant.image).length} SKU đã có ảnh trong hồ sơ`
                            : `${namedVariantCount} ảnh nhận diện theo tên`}</strong>
                          <p className="caption">Ảnh này gắn riêng với từng mùi/dung tích. Trong “Xem và hoàn thiện nội dung”, mở “SKU & phân loại” để chọn ảnh cho từng SKU. Số thứ tự tên ảnh không phải thứ tự SKU.</p>
                          {!groupManifest && <button type="button" onClick={() => setPanel('sku')}>Đến bảng SKU để gắn ảnh phân loại</button>}
                        </section>
                      </div>
                    </fieldset>
                  )}
                  {panel === 'word' && (
                    <div className="folder-word-panel">
                      {groupWords.length > 1 && (
                        <label>
                          Tệp Word của listing
                          <select
                            disabled={locked}
                            value={selectedWordPath ?? ''}
                            onChange={(event) => {
                              const path = event.target.value;
                              setWordPaths((all) => {
                                const next = { ...all };
                                if (path) next[group.key] = path;
                                else delete next[group.key];
                                return next;
                              });
                            }}
                          >
                            <option value="">Chọn đúng tệp nội dung</option>
                            {groupWords.map((item) => (
                              <option key={item.relativePath} value={item.relativePath}>
                                {folderFilename(item.relativePath)}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                      {visibleWord && Array.isArray(wordBody?.paragraphs) ? (
                        <>
                          <h3>{folderFilename(visibleWord.relativePath)}</h3>
                          <div className="folder-word-text">{wordBody.paragraphs.join('\n')}</div>
                        </>
                      ) : (
                        <p className="empty">
                          {groupWords.length
                            ? 'Chọn tệp Word để xem nguyên văn.'
                            : 'Chưa có tệp Word đọc được trong thư mục.'}
                        </p>
                      )}
                      <details className="folder-word-rules">
                        <summary>Cách đọc Word trong bộ nguồn</summary>
                        <p>
                          Chỉ áp dụng khi các tệp Word của đợt này có cùng cấu trúc như bên dưới.
                          Các đoạn chữ được lấy nguyên văn.
                        </p>
                        <label className="inline">
                          <input
                            type="checkbox"
                            disabled={locked}
                            checked={wordConfirmed}
                            onChange={(event) => setWordConfirmed(event.target.checked)}
                          />{' '}
                          Dùng cấu trúc Word này cho cả đợt
                        </label>
                        {wordRuleIncomplete && (
                          <p className="folder-exceptions">
                            Điền đủ dòng đánh dấu tiêu đề và nội dung để lưu cách đọc Word.
                          </p>
                        )}
                        <div className="folder-rule-fields">
                          <label>
                            Dòng đánh dấu tiêu đề
                            <input
                              disabled={locked}
                              value={titleHeader}
                              onChange={(event) => setTitleHeader(event.target.value)}
                            />
                          </label>
                          <label>
                            Dòng đánh dấu nội dung
                            <input
                              disabled={locked}
                              value={descriptionHeader}
                              onChange={(event) => setDescriptionHeader(event.target.value)}
                            />
                          </label>
                          <label>
                            Câu mở đầu
                            <select
                              disabled={locked}
                              value={headlineMode}
                              onChange={(event) =>
                                setHeadlineMode(event.target.value as 'first_line' | 'none')
                              }
                            >
                              <option value="first_line">
                                Dòng đầu của phần nội dung, đặt trước ảnh
                              </option>
                              <option value="none">Không có câu mở đầu trước ảnh</option>
                            </select>
                          </label>
                          <label>
                            Giữa các đoạn Word
                            <select
                              disabled={locked}
                              value={paragraphSeparator}
                              onChange={(event) =>
                                setParagraphSeparator(event.target.value as '\n' | '\n\n')
                              }
                            >
                              <option value={'\n\n'}>Giữ một dòng trống giữa các đoạn</option>
                              <option value={'\n'}>Xuống dòng giữa các đoạn</option>
                            </select>
                          </label>
                        </div>
                      </details>
                      {selectedAssembly?.candidates.title !== undefined && (
                        <div className="folder-extracted-content">
                          <h3>Nội dung đã nhận diện</h3>
                          <strong>Tiêu đề</strong>
                          <p>{selectedAssembly.candidates.title}</p>
                          <strong>Câu mở đầu</strong>
                          <p>{selectedAssembly.candidates.headline ?? 'Chưa nhận diện'}</p>
                          <strong>Phần chữ sau ảnh</strong>
                          <pre>{selectedAssembly.candidates.body ?? 'Chưa nhận diện'}</pre>
                        </div>
                      )}
                    </div>
                  )}
                  {panel === 'sku' && !selectedPending && (
                    <div className="folder-sku-panel">
                      <p>
                        SKU cần khớp chính xác bảng giá chung. Ảnh và tên phân loại được giữ theo bộ
                        bên bạn đã chuẩn bị.
                      </p>
                      {selectedAssembly?.candidates.variants.length ? (
                        <div className="table-scroll">
                          <table>
                            <thead>
                              <tr>
                                <th>SKU nhận diện từ nguồn</th>
                                <th>Giá nguồn</th>
                                <th>Phân loại</th>
                              </tr>
                            </thead>
                            <tbody>
                              {selectedAssembly.candidates.variants.map((variant, index) => (
                                <tr key={variant.sku + index}>
                                  <td>{variant.sku}</td>
                                  <td>
                                    {variant.sourceRows.length === 1 &&
                                    /^[1-9]\d*$/.test(
                                      variant.sourceRows[0].originalPrice?.value ?? '',
                                    )
                                      ? money(variant.sourceRows[0].originalPrice?.value)
                                      : 'Cần đối chiếu'}
                                  </td>
                                  <td>
                                    {variant.optionLabels?.join(' / ') ??
                                      'Cần xác định từ bộ listing'}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <p className="folder-exceptions">
                          Ảnh trong thư mục chưa xác định được mã SKU và tên phân loại. Bổ sung đúng
                          danh sách của listing; ứng dụng giữ phần Word và ảnh bạn vừa chọn.
                        </p>
                      )}
                    </div>
                  )}
                  {groupFiles.some(
                    (item) =>
                      item.record?.status !== 'ready' && !item.manifest && !item.pendingMapping,
                  ) && (
                    <div className="folder-exceptions">
                      {groupFiles
                        .filter(
                          (item) =>
                            item.record?.status !== 'ready' &&
                            !item.manifest &&
                            !item.pendingMapping,
                        )
                        .map((item) => (
                          <div key={item.relativePath}>
                            <p>
                              <strong>{folderFilename(item.relativePath)}</strong>: Tệp chưa đọc
                              được đầy đủ. Kiểm tra tệp gốc rồi thử đọc lại; nếu vẫn lỗi, báo người
                              phụ trách ứng dụng.
                            </p>
                            {(item.error || item.record?.message) && (
                              <details>
                                <summary>Chi tiết gửi người hỗ trợ</summary>
                                <p>{item.error || item.record?.message}</p>
                              </details>
                            )}
                          </div>
                        ))}
                    </div>
                  )}
                  {!pendingMappings[group.key] && (
                    <div className="folder-candidate-action">
                      {selectedAssembly && (selectedAssembly.seed || selectedExisting) ? (
                        <button
                          className="primary"
                          disabled={locked || assembling || unsaved}
                          onClick={() => continueAssembly(selectedAssembly)}
                        >
                          {selectedExisting ? 'Mở bộ đã lưu' : 'Xem & hoàn thiện'}{' '}
                          <ArrowRight size={16} />
                        </button>
                      ) : (
                        <>
                          <p className="caption">
                            {priceReady
                              ? wordNeedsSelection
                                ? 'Word chưa xác định rõ tiêu đề và mô tả. Tệp gốc và ảnh đã chọn được giữ lại; bạn cần chọn nội dung đúng từ Word ở màn hoàn thiện.'
                                : 'Phần đã đọc và ảnh đã chọn sẽ được giữ lại khi bổ sung danh sách phân loại.'
                              : 'Chọn bảng giá chung, sheet và bộ giá để tiếp tục đối chiếu SKU.'}
                          </p>
                          <button
                            className="primary"
                            disabled={
                              locked ||
                              assembling ||
                              unsaved ||
                              !selectedAssembly ||
                              !priceReady ||
                              !!manifests[group.key] ||
                              group.files.some((f) => f.name === 'listing-source.json')
                            }
                            onClick={manual}
                          >
                            Bổ sung SKU/phân loại <ArrowRight size={16} />
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}
