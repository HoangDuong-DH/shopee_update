import { useEffect, useRef, useState } from 'react';
import type { ListingDraft } from '@shopee/domain';
import { productChannelIssue, type ProductLogisticsChannel } from '../../../packages/domain/src/product-logistics.js';
import { z } from 'zod';
import { api, media, RequestError } from './api.js';
import './production-preparation.css';
import { DraftKnowledgeSuggestions } from './DraftKnowledgeSuggestions.js';
import { autofillResultSchema, mergeMissingChoices, type AutofillResult } from './preparation-autofill.js';
import { pendingRead } from './pending-read.js';

type Summary = {
  productKey: string;
  revision: number;
  title: string;
  skus: string[];
  categoryId?: string;
  brandId?: string;
  issues: { message: string }[];
  sourceSelection?: {folderBinding?:{groupKey:string;batchId:string}};
};
type Attribute = {
  id: string;
  label: string;
  mandatory: boolean;
  inputType: string;
  units: string[];
  maxValueCount: number | null;
  values: { id: string; label: string; unit: string | null; children: Attribute[] }[];
};
type Metadata = {
  shop: { id: string; name: string };
  categories: { id: string; label: string; path: string }[];
  attributes?: Attribute[];
  brands?: {
    items: { id: string; name: string; label: string }[];
    hasNextPage: boolean;
    nextOffset: number | null;
  };
  channels: ProductLogisticsChannel[];
  observedAt?: string;
  itemLimits?: { sizeChart: { mandatory: boolean | null } };
  inventory?: {
    items: { itemId: string; title: string }[];
    hasNextPage: boolean;
    nextOffset: number | null;
    status?: 'NORMAL' | 'UNLIST';
  };
  reference?: {
    itemId: string;
    title: string;
    writeMappingVerified: boolean;
    stockLocations: { id: string; saleable: boolean | null }[];
    stockLocation?: Record<string, unknown>;
    writeMapping?: {
      expectedLocationId: string;
      writeLocationId: string | null;
      verifiedOperationId: string;
      verificationFingerprint: string;
      referenceRequestId: string;
      warehouseRequestId: string;
    };
  };
};
type PriceSelection = { importId: string; sheet: string; priceProfile: string | null };
type Choices = {
  categoryId?: string;
  brandId?: string;
  brandName?: string;
  attributeList?: any[];
  logistics?: { channelId: string; enabled: boolean }[];
  weightGrams?: number;
  dimensionCm?: { length: number; width: number; height: number };
  condition?: 'NEW' | 'USED';
  preOrder?: { is_pre_order: boolean; days_to_ship?: number };
  stockLocation?: any;
};
type Editing = {
  draft: ListingDraft;
  choices: Choices;
  stocks: Record<string, string>;
  priceSelection?: PriceSelection;
  priceLabel?: string;
  priceOptions: { label: string; value: PriceSelection }[];
  metadata?: Metadata;
  metadataBusy?: boolean;
  issue?: string;
  metadataIssueCode?: string;
  brandSearch: string;
  referenceId: string;
  knowledgeAcceptanceId?: string;
};
type PublicationMode = 'hidden_for_review' | 'publish_after_verification';
type ImageQcPolicy = 'required' | 'defer_image_qc';
type Preview = {
  id: string;
  fingerprint: string;
  readyCount: number;
  blockedCount: number;
  publicationMode?: PublicationMode;
  imageQcPolicy?: ImageQcPolicy;
  entries: {
    productKey: string;
    title: string;
    kind: 'ready' | 'blocked';
    issues: { field: string; message: string; code?: string }[];
    document?: any;
    priceProof?: {
      sku: string;
      originalPrice: string;
      sheetName: string;
      priceProfile: string | null;
    }[];
  }[];
  registration?: unknown;
};
type Context = {
  scope: { shopId: string; partnerId?: string };
  products: Summary[];
  pricebooks: { id: string; filename: string }[];
  preparations: Preview[];
};
type PreparationRequest = { generation: number; controller: AbortController; kind?: 'autofill' };

function AutofillWait({ onCancel }: { onCancel: () => void }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);
  return <div className="notice" aria-label="Đang điền cả lô">
    <p role="status">Đang tra ngành, thương hiệu và vận chuyển của shop. Đã chờ {seconds} giây.</p>
    <p>Lần tra đầu có thể mất vài phút. Các ô tạm khóa để giữ lựa chọn; chưa gửi listing lên Shopee.</p>
    <button type="button" className="secondary" onClick={onCancel}>Dừng chờ, giữ phần đã nhập</button>
  </div>;
}
const workingChoices = z
  .object({
    categoryId: z.string().max(200).optional(),
    brandId: z.string().max(200).optional(),
    brandName: z.string().max(4000).optional(),
    attributeList: z
      .array(
        z
          .object({
            attribute_id: z.number().finite(),
            attribute_value_list: z
              .array(
                z
                  .object({
                    value_id: z.number().finite(),
                    original_value_name: z.string().max(4000).optional(),
                    value_unit: z.string().max(200).optional(),
                  })
                  .strict(),
              )
              .max(100),
          })
          .strict(),
      )
      .max(200)
      .optional(),
    logistics: z
      .array(z.object({ channelId: z.string().max(200), enabled: z.boolean() }).strict())
      .max(100)
      .optional(),
    weightGrams: z.number().finite().optional(),
    dimensionCm: z
      .object({
        length: z.number().finite().optional(),
        width: z.number().finite().optional(),
        height: z.number().finite().optional(),
      })
      .strict()
      .optional(),
    condition: z.enum(['NEW', 'USED']).optional(),
    preOrder: z
      .object({ is_pre_order: z.boolean(), days_to_ship: z.number().finite().optional() })
      .strict()
      .optional(),
  })
  .strict();
const workingEntry = z
  .object({
    productKey: z.string().min(1).max(200),
    revision: z.number().int().positive(),
    choices: workingChoices,
    stocks: z.record(z.string().max(200), z.string().max(30)),
    priceSelection: z
      .object({
        importId: z.string().max(200),
        sheet: z.string().max(255),
        priceProfile: z.string().max(255).nullable(),
      })
      .strict()
      .optional(),
    brandSearch: z.string().max(4000),
  })
  .strict();
const workingCopySchema = z
  .object({
    version: z.literal(1),
    scope: z.object({ shopId: z.string(), partnerId: z.string().optional() }).strict(),
    selected: z
      .array(
        z
          .object({ productKey: z.string().min(1).max(200), revision: z.number().int().positive() })
          .strict(),
      )
      .max(80),
    entries: z.array(workingEntry).max(80),
    stock: z.string().max(30),
    attributeMode:z.enum(['minimum_required','source_supported']).optional(),
    logisticsMode:z.enum(['source_supported','all_eligible']).optional(),
    opened: z.string().max(200).nullable(),
  })
  .strict();
type WorkingEntry = z.infer<typeof workingEntry>;
type IssueTarget =
  | 'categoryId'
  | 'brandId'
  | 'condition'
  | 'preOrder'
  | 'weightGrams'
  | 'dimensionCm'
  | 'logistics'
  | 'stockLocation'
  | 'stocks'
  | 'attributes'
  | 'priceSelection';
const operatingGuidance: Record<IssueTarget, { label: string; instruction: string }> = {
  categoryId: {
    label: 'Ngành hàng',
    instruction: 'Chọn ngành phù hợp với sản phẩm trong danh sách shop được phép dùng.',
  },
  brandId: {
    label: 'Thương hiệu',
    instruction:
      'Chọn đúng thương hiệu trong ngành đã chọn; dùng Tra thương hiệu nếu chưa thấy tên.',
  },
  condition: {
    label: 'Tình trạng sản phẩm',
    instruction: 'Chọn Hàng mới hoặc Đã qua sử dụng theo sản phẩm thực tế.',
  },
  preOrder: {
    label: 'Hàng đặt trước',
    instruction: 'Chọn có hoặc không; nếu có, bổ sung số ngày chuẩn bị.',
  },
  weightGrams: {
    label: 'Cân nặng đóng gói',
    instruction:
      'Bổ sung cân nặng khai báo theo gram. Cân nặng từng SKU đã có trong nguồn được giữ nguyên.',
  },
  dimensionCm: {
    label: 'Kích thước kiện hàng',
    instruction: 'Điền đủ dài, rộng và cao của kiện đóng gói, đơn vị cm.',
  },
  logistics: {
    label: 'Kênh vận chuyển',
    instruction: 'Chọn kênh vận chuyển phù hợp đang được bật cho shop.',
  },
  stockLocation: {
    label: 'Kho áp dụng',
    instruction:
      'Bấm Chọn listing tham khảo kho, rồi chọn listing đang có tại shop để đọc bằng chứng kho.',
  },
  stocks: {
    label: 'Tồn đăng bán',
    instruction:
      'Nhập mức tồn chung và bấm Áp dụng tồn cho SKU đã chọn, hoặc điền tồn riêng từng SKU.',
  },
  attributes: {
    label: 'Thuộc tính theo ngành',
    instruction: 'Kiểm tra các thuộc tính của ngành đã chọn và bổ sung giá trị có nguồn.',
  },
  priceSelection: {
    label: 'Bộ giá',
    instruction:
      'Chọn đúng trang tính và bộ giá. Nếu SKU hoặc giá nguồn chưa khớp, mở bộ nguồn để sửa.',
  },
};
function issueGuidance(issue: Preview['entries'][number]['issues'][number]) {
  const field = (
    typeof issue.field === 'string' && issue.field.trim() ? issue.field : 'source'
  ).replace(/^choices\./, '');
  const root = field.split(/[.\[]/, 1)[0]!;
  const target = root === 'brandName' ? 'brandId' : root === 'attributeList' ? 'attributes' : root;
  const sourceOnly =
    /CONFIRMED_FACT_CONFLICT|UNCONFIRMED_FACT|SOURCE_|SAVED_SOURCE|UNSUPPORTED_SOURCE/.test(
      issue.code ?? '',
    );
  const actionable = !sourceOnly && Object.hasOwn(operatingGuidance, target);
  const guidance = operatingGuidance[target as IssueTarget];
  const generic =
    issue.code === 'OPERATING_FIELD_REQUIRED' ||
    issue.message === 'Cần bổ sung thông tin vận hành có nguồn.';
  return {
    label:
      guidance?.label ??
      (
        {
          sourceRevision: 'Phiên bản nguồn',
          source: 'Bộ nguồn',
          title: 'Tên sản phẩm',
          description: 'Nội dung',
          cover: 'Ảnh bìa',
          variants: 'Phân loại',
        } as Record<string, string>
      )[root] ??
      field,
    message: generic && guidance ? guidance.instruction : issue.message,
    target: actionable ? (target as IssueTarget) : null,
    field,
  };
}
function groupedIssues(issues: Preview['entries'][number]['issues']) {
  const groups = new Map<string, ReturnType<typeof issueGuidance> & { fields: string[] }>();
  for (const issue of issues) {
    const guidance = issueGuidance(issue);
    const key = guidance.label + ':' + guidance.message;
    const previous = groups.get(key);
    if (previous) {
      if (!previous.fields.includes(guidance.field)) previous.fields.push(guidance.field);
    } else groups.set(key, { ...guidance, fields: [guidance.field] });
  }
  return [...groups.values()];
}
function message(error: unknown) {
  return error instanceof Error ? error.message : 'Chưa đọc được dữ liệu. Vui lòng đọc lại.';
}
function PreparationRun({ prepared, onChanged,targetScope }: { prepared: Preview; onChanged: () => void;targetScope:{environment:'production';partnerId:string;shopId:string} }) {
  const scoped=(path:string)=>path+(path.includes('?')?'&':'?')+new URLSearchParams({partnerId:targetScope.partnerId,shopId:targetScope.shopId});
  type Run = {
    state: 'running' | 'paused' | 'completed' | 'completed_with_exclusions';
    completedBatches: string[];
    totalBatches: number;
    code?: string | null;
    publicationMode?: PublicationMode;
    imageQcPolicy?: ImageQcPolicy;
    executionPolicyFingerprint?: string;
  };
  const [run, setRun] = useState<Run | null>(null),
    [busy, setBusy] = useState(false),
    [readReady, setReadReady] = useState(false),
    [uncertain, setUncertain] = useState(false),
    [error, setError] = useState('');
  const hidden = (run?.publicationMode ?? prepared.publicationMode) === 'hidden_for_review';
  const deferredImages =
    hidden && (run?.imageQcPolicy ?? prepared.imageQcPolicy) === 'defer_image_qc';
  const alive = useRef(true),
    locked = useRef(false),
    reading = useRef(false),
    previousState = useRef<string | undefined>(undefined);
  async function read() {
    if (reading.current) return;
    reading.current = true;
    try {
      const result = await api<Run | null>(
        scoped('/v1/production-preparations/' + encodeURIComponent(prepared.id) + '/execution'),
      );
      if (alive.current) {
        setRun(result);
        setReadReady(true);
        setError('');
        setUncertain(false);
        if (previousState.current === 'running' && result?.state !== 'running') onChanged();
        previousState.current = result?.state;
      }
    } catch (error) {
      if (alive.current) setError(message(error));
    } finally {
      reading.current = false;
    }
  }
  useEffect(() => {
    alive.current = true;
    setReadReady(false);
    void read();
    return () => {
      alive.current = false;
    };
  }, [prepared.id]);
  useEffect(() => {
    if (run?.state !== 'running') return;
    const interval = setInterval(() => {
      if (!document.hidden) void read();
    }, 2000);
    return () => clearInterval(interval);
  }, [run?.state, prepared.id]);
  async function start() {
    if (
      !readReady ||
      locked.current ||
      run?.state === 'running' ||
      ['completed', 'completed_with_exclusions'].includes(run?.state ?? '') ||
      uncertain
    )
      return;
    locked.current = true;
    setBusy(true);
    setUncertain(true);
    setError('');
    try {
      const result = await api<Run>(
        scoped('/v1/production-preparations/' + encodeURIComponent(prepared.id) + '/run'),
        { method: 'POST', body: JSON.stringify({ expectedFingerprint: prepared.fingerprint }) },
      );
      if (alive.current) {
        setRun(result);
        setUncertain(false);
        previousState.current = result.state;
        onChanged();
      }
    } catch (error) {
      if (alive.current)
        setError(
          'Chưa xác nhận được yêu cầu đăng. Đọc lại tiến độ trước khi thao tác tiếp. ' +
            message(error),
        );
    } finally {
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <div className="preparation-run" aria-label="Thực hiện các đợt đã chuẩn bị">
      <h4>
        Đăng{hidden ? ' ẩn' : ''} {prepared.readyCount} listing đã chuẩn bị vào vuatinhdau.vn
      </h4>
      {run?.executionPolicyFingerprint && (
        <p className="notice">Đã chuyển phần còn lại sang đăng ẩn và mở bán thủ công.</p>
      )}
      <p>
        {hidden
          ? 'Ứng dụng tạo listing ở trạng thái ẩn và đối chiếu dữ liệu. Sau đó bạn kiểm tra từng listing và chủ động mở bán tại Đăng theo đợt.'
          : 'Ứng dụng xử lý lần lượt các đợt, đối chiếu từng listing rồi tự mở bán. Listing còn vấn đề được giữ lại để xử lý.'}
      </p>
      {deferredImages && (
        <p>
          Đã chọn tạm hoãn kiểm tra ảnh. Listing có ảnh chưa QC sẽ được giữ ẩn; cần hoàn tất kiểm
          tra ảnh trước khi mở bán.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {run && (
        <p role="status">
          {run.state === 'running'
            ? 'Đang xử lý'
            : run.state === 'completed_with_exclusions'
              ? 'Đã xử lý xong phần giữ lại; có listing đã loại khỏi đợt và chưa gửi'
            : run.state === 'completed'
              ? hidden
                ? deferredImages
                  ? 'Đã xử lý xong các đợt đăng ẩn; kiểm tra mục Ảnh chưa QC trước khi mở bán'
                  : 'Đã tạo và đối chiếu xong; listing vẫn ẩn chờ bạn kiểm tra'
                : 'Đã hoàn tất các đợt'
              : 'Đang tạm dừng để kiểm tra'}{' '}
          · {run.completedBatches.length}/{run.totalBatches} đợt hoàn tất.
          {run.state === 'paused' ? ' Xem kết quả từng listing ở tab “Đợt đang làm”.' : ''}
        </p>
      )}
      {!['completed', 'completed_with_exclusions'].includes(run?.state ?? '') && (
        <button
          type="button"
          className="primary"
          disabled={!readReady || busy || uncertain || run?.state === 'running'}
          onClick={() => void start()}
        >
          {run?.state === 'paused'
            ? hidden
              ? 'Tiếp tục đăng ẩn các listing chưa hoàn tất'
              : 'Tiếp tục các listing chưa hoàn tất'
            : hidden
              ? 'Đăng ẩn các listing đã chuẩn bị'
              : 'Đăng các listing đã chuẩn bị'}
        </button>
      )}
      <button type="button" className="secondary" disabled={busy} onClick={() => void read()}>
        Đọc lại tiến độ đăng
      </button>
    </div>
  );
}
function chosenAttributes(attributes: Attribute[], selected: any[]): Attribute[] {
  const result: Attribute[] = [];
  for (const attribute of attributes) {
    result.push(attribute);
    const values =
      selected.find((row) => String(row.attribute_id) === attribute.id)?.attribute_value_list ?? [];
    for (const value of attribute.values)
      if (values.some((v: any) => String(v.value_id) === value.id))
        result.push(...chosenAttributes(value.children, selected));
  }
  return result;
}
function AttributeFields({
  metadata,
  values,
  onChange,
  requiredOnly=false,
}: {
  metadata: Attribute[];
  values: any[];
  onChange: (value: any[]) => void;
  requiredOnly?: boolean;
}) {
  const [resetLabels, setResetLabels] = useState<string[]>([]);
  useEffect(() => setResetLabels([]), [metadata]);
  function changeSelection(updated: any[]) {
    const known = new Map<string, Attribute>();
    function collect(attributes: Attribute[]) {
      for (const attribute of attributes) {
        known.set(attribute.id, attribute);
        for (const value of attribute.values) collect(value.children);
      }
    }
    collect(metadata);
    const active = new Set(chosenAttributes(metadata, updated).map((attribute) => attribute.id));
    const removed = updated.filter(
      (row) => known.has(String(row.attribute_id)) && !active.has(String(row.attribute_id)),
    );
    const removedIds = new Set(removed.map((row) => String(row.attribute_id)));
    setResetLabels([...removedIds].map((id) => known.get(id)!.label));
    // Only local preview choices are removed. Unknown fields remain visible to validation,
    // and the saved ListingDraft is never changed by this form.
    onChange(updated.filter((row) => !removedIds.has(String(row.attribute_id))));
  }
  return (
    <div className="preparation-fields">
      {resetLabels.length > 0 && (
        <p className="notice" role="status">
          Đã bỏ lựa chọn phụ thuộc không còn áp dụng khỏi bản xem trước: {resetLabels.join(', ')}.{' '}
          Chọn lại thông tin cần thiết ở nhánh mới.
        </p>
      )}
      {chosenAttributes(metadata, values).filter(attribute=>!requiredOnly || attribute.mandatory).map((attribute) => {
        const selected =
            values.find((row) => String(row.attribute_id) === attribute.id)?.attribute_value_list ??
            [],
          multi = attribute.inputType.startsWith('multi'),
          custom = attribute.inputType === 'free_text' || attribute.inputType.endsWith('combobox');
        function set(next: any[]) {
          changeSelection([
            ...values.filter((row) => String(row.attribute_id) !== attribute.id),
            ...(next.length
              ? [{ attribute_id: Number(attribute.id), attribute_value_list: next }]
              : []),
          ]);
        }
        return (
          <fieldset key={attribute.id}>
            <legend>
              {attribute.label}
              {attribute.mandatory ? ' *' : ''}
            </legend>
            {attribute.inputType === 'unsupported' ? (
              <p>Cách nhập thuộc tính này chưa được hỗ trợ. Giữ lại để kiểm tra.</p>
            ) : (
              <>
                {attribute.values.length > 0 &&
                  (multi ? (
                    <div className="preparation-checks">
                      {attribute.values.map((value) => (
                        <label key={value.id}>
                          <input
                            type="checkbox"
                            checked={selected.some((v: any) => String(v.value_id) === value.id)}
                            onChange={(event) =>
                              set(
                                event.target.checked
                                  ? [
                                      ...selected,
                                      {
                                        value_id: Number(value.id),
                                        original_value_name: value.label,
                                        value_unit: value.unit ?? '',
                                      },
                                    ]
                                  : selected.filter((v: any) => String(v.value_id) !== value.id),
                              )
                            }
                          />
                          {value.label}
                        </label>
                      ))}
                    </div>
                  ) : (
                    <select
                      aria-label={attribute.label}
                      value={selected.find((v: any) => v.value_id !== 0)?.value_id ?? ''}
                      onChange={(event) => {
                        const value = attribute.values.find((v) => v.id === event.target.value);
                        set(
                          value
                            ? [
                                {
                                  value_id: Number(value.id),
                                  original_value_name: value.label,
                                  value_unit: value.unit ?? '',
                                },
                              ]
                            : [],
                        );
                      }}
                    >
                      <option value="">Chọn {attribute.label.toLocaleLowerCase('vi-VN')}</option>
                      {attribute.values.map((value) => (
                        <option key={value.id} value={value.id}>
                          {value.label}
                        </option>
                      ))}
                    </select>
                  ))}
                {custom && (
                  <>
                    <label>
                      Giá trị theo nguồn
                      <input
                        value={
                          selected.find((v: any) => v.value_id === 0)?.original_value_name ?? ''
                        }
                        onChange={(event) =>
                          set(
                            event.target.value
                              ? [
                                  ...(multi ? selected.filter((v: any) => v.value_id !== 0) : []),
                                  {
                                    value_id: 0,
                                    original_value_name: event.target.value,
                                    value_unit:
                                      selected.find((v: any) => v.value_id === 0)?.value_unit ?? '',
                                  },
                                ]
                              : selected.filter((v: any) => v.value_id !== 0),
                          )
                        }
                      />
                    </label>
                    {attribute.units.length > 0 && (
                      <label>
                        Đơn vị
                        <select
                          value={selected.find((v: any) => v.value_id === 0)?.value_unit ?? ''}
                          onChange={(event) =>
                            set(
                              selected.map((v: any) =>
                                v.value_id === 0 ? { ...v, value_unit: event.target.value } : v,
                              ),
                            )
                          }
                        >
                          <option value="">Chọn đơn vị</option>
                          {attribute.units.map((unit) => (
                            <option key={unit}>{unit}</option>
                          ))}
                        </select>
                      </label>
                    )}
                  </>
                )}
                {attribute.maxValueCount !== null && multi && (
                  <small>Tối đa {attribute.maxValueCount} giá trị theo ngành.</small>
                )}
              </>
            )}
          </fieldset>
        );
      })}
    </div>
  );
}
/** All authoring decisions stay local to this preparation. Source documents are read-only. */
export function ProductionPreparation({
  targetScope,
  onSource,
  onFolders,
  onRegistered,
}: {
  targetScope:{environment:'production';partnerId:string;shopId:string};
  onSource: (productKey: string) => void;
  onFolders: () => void;
  onRegistered: () => void;
}) {
  const scoped=(path:string)=>path+(path.includes('?')?'&':'?')+new URLSearchParams({partnerId:targetScope.partnerId,shopId:targetScope.shopId});
  const workingCopyKey='production-preparation-working-copy-v1:'+targetScope.partnerId+':'+targetScope.shopId;
  const pendingKey='production-preparation-pending:'+targetScope.partnerId+':'+targetScope.shopId;
  const [context, setContext] = useState<Context | null>(null),
    [contextLoading, setContextLoading] = useState(true),
    [sourceErrors, setSourceErrors] = useState<Record<string, string>>({}),
    [selected, setSelected] = useState<string[]>([]),
    [editing, setEditing] = useState<Record<string, Editing>>({}),
    [opened, setOpened] = useState<string | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [search, setSearch] = useState(''),
    [sourceGroup, setSourceGroup] = useState(''),
    [stock, setStock] = useState(''),
    [publicationMode, setPublicationMode] = useState<PublicationMode>('hidden_for_review'),
    [imageQcPolicy, setImageQcPolicy] = useState<ImageQcPolicy>('defer_image_qc'),
    [preview, setPreview] = useState<Preview | null>(null),
    [saved, setSaved] = useState(false),
    [recoverable, setRecoverable] = useState(false),
    [needsRecheck, setNeedsRecheck] = useState(false),
    [focusField, setFocusField] = useState<{ key: string; target: IssueTarget } | null>(null),
    [announcement, setAnnouncement] = useState(''),
    [busyLabel, setBusyLabel] = useState(''),
    [workingCopyNotice, setWorkingCopyNotice] = useState(''),
    [autofillResult, setAutofillResult] = useState<AutofillResult | null>(null),
    [sharedCondition, setSharedCondition] = useState<'NEW' | 'USED' | ''>('NEW'),
    [attributeMode, setAttributeMode] = useState<'minimum_required' | 'source_supported'>('minimum_required'),
    [logisticsMode, setLogisticsMode] = useState<'source_supported' | 'all_eligible'>('all_eligible'),
    [sharedPreOrder, setSharedPreOrder] = useState<'no' | ''>('no'),
    [useTestDimensions, setUseTestDimensions] = useState(false),
    [allowSharedSkus, setAllowSharedSkus] = useState(false),
    [testDimensions, setTestDimensions] = useState({length:'12',width:'12',height:'28'}),
    [restoringWorkingCopy, setRestoringWorkingCopy] = useState(false);
  const alive = useRef(true),
    lock = useRef(false),
    generation = useRef(0),
    previewGeneration = useRef<number | null>(null),
    activeRequest = useRef<PreparationRequest | null>(null),
    files = useRef(new Map<string, any>()),
    pendingMetadata = useRef(new Map<string,Promise<Metadata>>()),
    pending = useRef<{
      id: string;
      entries: any[];
      publicationMode?: PublicationMode;
      imageQcPolicy?: ImageQcPolicy;
    } | null>(null),
    loading = useRef(new Set<string>()),
    metadataSequence = useRef(new Map<string, number>()),
    entryElements = useRef(new Map<string, HTMLDetailsElement>()),
    resultElement = useRef<HTMLElement | null>(null),
    focusResult = useRef(false),
    workingCopyInitialized = useRef(false),
    restoringSession = useRef(false),
    restoringInputs = useRef(new Map<string, WorkingEntry>());
  useEffect(() => {
    if (!context || workingCopyInitialized.current) return;
    workingCopyInitialized.current = true;
    // An uncertain preview owns its exact request; restoring form fields must not invalidate it.
    if (pending.current) return;
    let stored: z.infer<typeof workingCopySchema> | null = null;
    try {
      const value = sessionStorage.getItem(workingCopyKey);
      if (value) stored = workingCopySchema.parse(JSON.parse(value));
    } catch {
      setWorkingCopyNotice(
        'Không đọc được phần nhập tạm. Bộ nguồn đã lưu vẫn giữ nguyên; chọn lại listing để tiếp tục.',
      );
      return;
    }
    if (!stored) return;
    if (
      stored.scope.shopId !== context.scope.shopId ||
      stored.scope.partnerId !== context.scope.partnerId
    ) {
      sessionStorage.removeItem(workingCopyKey);
      setWorkingCopyNotice(
        'Phần nhập tạm thuộc shop khác nên chưa được áp dụng. Chọn listing của shop hiện tại.',
      );
      return;
    }
    const rows = stored.selected.flatMap((saved) => {
      const row = context.products.find(
        (item) => item.productKey === saved.productKey && item.revision === saved.revision,
      );
      return row ? [row] : [];
    });
    const skipped = stored.selected.length - rows.length;
    for (const entry of stored.entries)
      if (
        rows.some((row) => row.productKey === entry.productKey && row.revision === entry.revision)
      )
        restoringInputs.current.set(entry.productKey, entry);
    setSelected(rows.map((row) => row.productKey));
    setStock(stored.stock);
    setAttributeMode(stored.attributeMode ?? 'minimum_required');
    setLogisticsMode(stored.logisticsMode ?? 'all_eligible');
    setOpened(
      rows.some((row) => row.productKey === stored.opened)
        ? stored.opened
        : (rows[0]?.productKey ?? null),
    );
    setNeedsRecheck(true);
    restoringSession.current = true;
    setRestoringWorkingCopy(true);
    setWorkingCopyNotice(
      `Đã khôi phục phần đang nhập cho ${rows.length} listing; chưa kiểm tra lại. Đang đọc nguồn và thông tin shop hiện tại.${skipped ? ` ${skipped} listing đã đổi phiên bản hoặc không còn trong kho nên chưa được khôi phục.` : ''}`,
    );
    let cursor = 0;
    void Promise.all(
      Array.from({ length: Math.min(3, rows.length) }, async () => {
        while (cursor < rows.length && alive.current) {
          const row = rows[cursor++];
          if (row) await ensure(row);
        }
      }),
    ).finally(() => {
      restoringSession.current = false;
      if (alive.current) {
        setRestoringWorkingCopy(false);
        setWorkingCopyNotice(
          `Đã khôi phục phần đang nhập cho ${rows.length} listing; chưa kiểm tra lại. Kho và gợi ý đã xác nhận cần đọc lại; chế độ vẫn là Đăng ẩn để QC.${skipped ? ` ${skipped} listing đã đổi phiên bản hoặc không còn trong kho nên chưa được khôi phục.` : ''}`,
        );
      }
    });
  }, [context]);
  useEffect(() => {
    if (
      !context ||
      !workingCopyInitialized.current ||
      restoringSession.current ||
      restoringWorkingCopy ||
      pending.current ||
      preview ||
      recoverable ||
      busy
    )
      return;
    try {
      if (!selected.length && !stock) {
        sessionStorage.removeItem(workingCopyKey);
        return;
      }
      const entries = selected.flatMap((key) => {
        const entry = editing[key];
        if (!entry)
          return restoringInputs.current.has(key) ? [restoringInputs.current.get(key)!] : [];
        // Persist editable inputs only. Warehouse/knowledge receipts, metadata and write/QC permissions stay out.
        const { stockLocation: _warehouse, attributeList, ...choices } = entry.choices;
        return [
          {
            productKey: key,
            revision: entry.draft.revision,
            choices: {
              ...choices,
              ...(!entry.knowledgeAcceptanceId && attributeList ? { attributeList } : {}),
            },
            stocks: entry.stocks,
            ...(entry.priceSelection ? { priceSelection: entry.priceSelection } : {}),
            brandSearch: entry.brandSearch,
          },
        ];
      });
      const copy = workingCopySchema.parse({
        version: 1,
        scope: context.scope,
        selected: selected.flatMap((key) => {
          const row = context.products.find((item) => item.productKey === key);
          return row ? [{ productKey: key, revision: row.revision }] : [];
        }),
        entries,
        stock,
        attributeMode,
        logisticsMode,
        opened,
      });
      sessionStorage.setItem(workingCopyKey, JSON.stringify(copy));
    } catch {
      setWorkingCopyNotice(
        'Chưa lưu được phần nhập tạm trong tab này. Giữ trang đang mở và bấm Kiểm tra để lưu bản chuẩn bị.',
      );
    }
  }, [context, selected, editing, stock, attributeMode, logisticsMode, opened, preview, recoverable, busy, restoringWorkingCopy]);
  function discardWorkingCopy() {
    changed();
    restoringInputs.current.clear();
    setSelected([]);
    setEditing({});
    setStock('');
    setOpened(null);
    setSourceErrors({});
    sessionStorage.removeItem(workingCopyKey);
    setWorkingCopyNotice('Đã bỏ phần nhập tạm. Các listing và bộ nguồn đã lưu vẫn giữ nguyên.');
  }
  useEffect(() => {
    if (!preview || !focusResult.current) return;
    focusResult.current = false;
    resultElement.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    resultElement.current?.focus({ preventScroll: true });
  }, [preview]);
  useEffect(() => {
    if (!focusField || opened !== focusField.key || !editing[focusField.key]) return;
    const element = entryElements.current.get(focusField.key);
    if (!element) return;
    const field =
      element.querySelector<HTMLElement>('[data-preparation-field="' + focusField.target + '"]') ??
      (!editing[focusField.key]?.metadataBusy
        ? element.querySelector<HTMLElement>('summary')
        : null);
    if (!field) return;
    for (
      let parent = field.parentElement;
      parent && parent !== element;
      parent = parent.parentElement
    )
      if (parent instanceof HTMLDetailsElement) parent.open = true;
    if (field instanceof HTMLDetailsElement) field.open = true;
    const control = field.matches('input,select,button')
      ? field
      : field.querySelector<HTMLElement>(
          'input:not(:disabled):not([readonly]),select:not(:disabled),button:not(:disabled)',
        );
    field.scrollIntoView({ block: 'center', behavior: 'smooth' });
    (control ?? field).focus({ preventScroll: true });
    setFocusField(null);
  }, [focusField, opened, editing]);
  async function fixIssue(productKey: string, target: IssueTarget | null) {
    if (!target || (target === 'priceSelection' && editing[productKey]?.priceSelection)) {
      onSource(productKey);
      return;
    }
    const row = context?.products.find((item) => item.productKey === productKey);
    if (!row) {
      onSource(productKey);
      return;
    }
    setSelected((previous) => [...new Set([...previous, productKey])]);
    setOpened(productKey);
    setFocusField({ key: productKey, target });
    setAnnouncement(
      'Đang bổ sung ' +
        operatingGuidance[target].label.toLocaleLowerCase('vi-VN') +
        ' cho ' +
        row.title +
        '.',
    );
    await ensure(row);
  }
  async function reload() {
    setContextLoading(true);
    setError('');
    try {
      const response = await api<unknown>(scoped('/v1/production-preparations/context'));
      const parsed = z
        .object({
          scope: z.object({ shopId: z.string(), partnerId: z.string().optional() }),
          products: z.array(
            z
              .object({
                productKey: z.string(),
                revision: z.number().int().positive(),
                title: z.string(),
                skus: z.array(z.string()),
                issues: z.array(z.object({ message: z.string() })),
              })
              .passthrough(),
          ),
          pricebooks: z.array(z.object({ id: z.string(), filename: z.string() })),
          preparations: z.array(
            z
              .object({
                id: z.string(),
                fingerprint: z.string(),
                readyCount: z.number(),
                blockedCount: z.number(),
                entries: z.array(z.unknown()),
              })
              .passthrough(),
          ),
        })
        .safeParse(response);
      if (!parsed.success)
        throw Error('Chưa đọc được đầy đủ kho listing. Đọc lại danh sách để kiểm tra.');
      if(parsed.data.scope.shopId!==targetScope.shopId || parsed.data.scope.partnerId!==targetScope.partnerId)
        throw Error('Shop phản hồi không khớp shop đang chọn. Ứng dụng đã dừng để tránh đăng nhầm shop.');
      const value = parsed.data as Context;
      if (alive.current) {
        setContext(value);
        setError('');
      }
    } catch (error) {
      if (alive.current) setError(message(error));
    } finally {
      if (alive.current) setContextLoading(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    try {
      const stored = JSON.parse(sessionStorage.getItem(pendingKey) ?? 'null');
      if (
        stored &&
        typeof stored.id === 'string' &&
        Array.isArray(stored.entries) &&
        stored.entries.length > 0 &&
        stored.entries.length <= 80
      ) {
        pending.current = stored;
        setRecoverable(true);
      }
    } catch {
      /* An incomplete local marker is not a server receipt. */
    }
    void reload();
    return () => {
      alive.current = false;
      generation.current++;
      activeRequest.current?.controller.abort();
      activeRequest.current = null;
      lock.current = false;
    };
  }, []);
  function changed() {
    setAutofillResult(null);
    focusResult.current = false;
    setAnnouncement('');
    const hadSnapshot =
      !!pending.current || previewGeneration.current !== null || !!activeRequest.current;
    generation.current++;
    activeRequest.current?.controller.abort();
    activeRequest.current = null;
    lock.current = false;
    setBusy(false);
    previewGeneration.current = null;
    setPreview(null);
    setSaved(false);
    pending.current = null;
    setRecoverable(false);
    sessionStorage.removeItem(pendingKey);
    if (hadSnapshot) setNeedsRecheck(true);
  }
  function beginRequest(label: string, kind?: PreparationRequest['kind']): PreparationRequest {
    const request = { generation: generation.current, controller: new AbortController(), kind };
    activeRequest.current = request;
    lock.current = true;
    setBusy(true);
    setBusyLabel(label);
    setError('');
    return request;
  }
  function currentRequest(request: PreparationRequest) {
    return (
      alive.current &&
      activeRequest.current === request &&
      generation.current === request.generation
    );
  }
  function finishRequest(request: PreparationRequest) {
    if (activeRequest.current !== request) return;
    activeRequest.current = null;
    lock.current = false;
    if (alive.current) setBusy(false);
  }
  function update(key: string, patch: Partial<Editing>) {
    changed();
    setEditing((previous) => ({ ...previous, [key]: { ...previous[key]!, ...patch } }));
  }
  function choice(key: string, patch: Partial<Choices>) {
    changed();
    setEditing((previous) => ({
      ...previous,
      [key]: {
        ...previous[key]!,
        ...('categoryId' in patch || 'brandId' in patch || 'attributeList' in patch
          ? { knowledgeAcceptanceId: undefined }
          : {}),
        choices: { ...previous[key]!.choices, ...patch },
      },
    }));
  }
  async function imported(id: string) {
    if (files.current.has(id)) return files.current.get(id);
    const request = api<any>('/v1/imports/' + encodeURIComponent(id));
    files.current.set(id, request);
    try { return await request; }
    catch(error) { if(files.current.get(id)===request)files.current.delete(id); throw error; }
  }
  async function metadata(key: string, query: Record<string, string> = {}) {
    // A metadata response can also supply warehouse/brand choices used in the snapshot.
    changed();
    const sequence = (metadataSequence.current.get(key) ?? 0) + 1;
    metadataSequence.current.set(key, sequence);
    setEditing((previous) =>
      previous[key] ? { ...previous, [key]: { ...previous[key]!, metadataBusy: true } } : previous,
    );
    try {
      const params = new URLSearchParams({ includeInventory: 'false', ...query });
      params.sort();
      const url=scoped('/v1/production-preparations/metadata?' + params.toString());
      const scope=(context?.scope.partnerId ?? '')+':'+(context?.scope.shopId ?? '');
      const result = await pendingRead(pendingMetadata.current,scope+':'+url,()=>api<Metadata>(url));
      if (
        !result ||
        !Array.isArray(result.categories) ||
        !Array.isArray(result.channels) ||
        typeof result.shop?.name !== 'string'
      )
        throw Error('Chưa đọc được đầy đủ danh sách lựa chọn của shop.');
      if (alive.current && metadataSequence.current.get(key) === sequence)
        setEditing((previous) => {
          const current = previous[key];
          if (!current) return previous;
          const choices = { ...current.choices },
            brand = result.brands?.items.find((b) => b.id === choices.brandId);
          if (brand) choices.brandName = brand.name;
          if (
            result.attributes?.length === 0 &&
            Object.keys(current.draft.attributes).length === 0 &&
            choices.attributeList === undefined
          )
            choices.attributeList = [];
          const reference = result.reference,
            mapping = reference?.writeMapping;
          if (
            reference?.writeMappingVerified &&
            mapping &&
            typeof mapping.expectedLocationId === 'string' &&
            (typeof mapping.writeLocationId === 'string' || mapping.writeLocationId === null)
          )
            choices.stockLocation = {
              referenceItemId: reference.itemId,
              expectedLocationBySku: Object.fromEntries(
                current.draft.variants.map((v) => [v.sku.value, mapping.expectedLocationId]),
              ),
              writeLocationBySku: Object.fromEntries(
                current.draft.variants.map((v) => [v.sku.value, mapping.writeLocationId]),
              ),
            };
          const previousInventory = current.metadata?.inventory;
          let inventory = result.inventory ?? previousInventory;
          if (result.inventory) {
            const status =
              result.inventory.status ?? (query.inventoryStatus === 'UNLIST' ? 'UNLIST' : 'NORMAL');
            const append =
              Number(query.inventoryOffset ?? 0) > 0 && previousInventory?.status === status;
            inventory = {
              ...result.inventory,
              status,
              items: append
                ? [
                    ...new Map(
                      [...previousInventory!.items, ...result.inventory.items].map((item) => [
                        item.itemId,
                        item,
                      ]),
                    ).values(),
                  ]
                : result.inventory.items,
            };
          }
          return {
            ...previous,
            [key]: {
              ...current,
              choices,
              metadata: {
                ...result,
                ...(inventory ? { inventory } : {}),
                ...(!result.reference && current.metadata?.reference
                  ? { reference: current.metadata.reference }
                  : {}),
              },
              metadataBusy: false,
              issue: undefined,
              metadataIssueCode: undefined,
            },
          };
        });
      return result;
    } catch (error) {
      if (alive.current && metadataSequence.current.get(key) === sequence)
        setEditing((previous) =>
          previous[key]
            ? {
                ...previous,
                [key]: {
                  ...previous[key]!,
                  metadataBusy: false,
                  issue: message(error),
                  metadataIssueCode: error instanceof RequestError ? error.code : undefined,
                },
              }
            : previous,
        );
      return null;
    }
  }
  async function loadInventory(key: string, status: 'NORMAL' | 'UNLIST', offset = 0) {
    const marker = 'inventory:' + key;
    if (loading.current.has(marker)) return;
    loading.current.add(marker);
    try {
      await metadata(key, {
        ...(editing[key]?.choices.categoryId
          ? { categoryId: editing[key]!.choices.categoryId! }
          : {}),
        includeInventory: 'true',
        inventoryStatus: status,
        inventoryOffset: String(offset),
      });
    } finally {
      loading.current.delete(marker);
    }
  }
  async function ensure(row: Summary) {
    if (editing[row.productKey] || loading.current.has(row.productKey)) return;
    loading.current.add(row.productKey);
    setSourceErrors((previous) => {
      const next = { ...previous };
      delete next[row.productKey];
      return next;
    });
    try {
      const draft = await api<ListingDraft>('/v1/products/' + encodeURIComponent(row.productKey));
      if (draft.revision !== row.revision)
        throw Error('Nguồn đã có bản mới. Đọc lại danh sách trước khi chọn.');
      const selection = draft.sourceSelection,
        imports = [...new Set(selection?.variants.map((v) => v.importId) ?? [])],
        rows: any[] = [];
      let filename = '';
      for (const id of imports) {
        const file = await imported(id);
        filename = file.filename;
        rows.push(...(file.body?.rows ?? []).map((r: any) => ({ ...r, importId: id })));
      }
      const mapped =
          selection?.variants.map((v) =>
            rows.filter((r) => r.importId === v.importId && r.key === v.rowKey),
          ) ?? [],
        only =
          mapped.length > 0 && mapped.every((matches) => matches.length === 1)
            ? mapped.map((matches) => matches[0])
            : [];
      const groups = new Map<string, { label: string; value: PriceSelection }>();
      for (const row of rows) {
        const value = {
          importId: row.importId,
          sheet: row.sheet,
          priceProfile: row.priceProfile ?? null,
        };
        groups.set(JSON.stringify(value), {
          value,
          label: row.sheet + ' · ' + (row.priceProfile ?? 'Giá theo nguồn'),
        });
      }
      const signatures = new Set(
          only.map((r) =>
            JSON.stringify({
              importId: r.importId,
              sheet: r.sheet,
              priceProfile: r.priceProfile ?? null,
            }),
          ),
        ),
        priceSelection = signatures.size === 1 ? JSON.parse([...signatures][0]!) : undefined;
      const weights = draft.variants.map((v) =>
          v.declaredWeightGrams?.confirmed ? Number(v.declaredWeightGrams.value) : NaN,
        ),
        maxWeight =
          weights.length && weights.every((v) => Number.isFinite(v) && v > 0)
            ? Math.max(...weights)
            : undefined;
      const savedLogistics = Object.entries(draft.logistics)
        .filter(([, f]) => f.confirmed && typeof f.value === 'boolean')
        .map(([channelId, f]) => ({ channelId, enabled: f.value as boolean }));
      const choices: Choices = {
        ...(draft.categoryId?.confirmed ? { categoryId: draft.categoryId.value } : {}),
        ...(draft.brandId?.confirmed ? { brandId: draft.brandId.value } : {}),
        ...(maxWeight ? { weightGrams: maxWeight } : {}),
        ...(savedLogistics.length ? { logistics: savedLogistics } : {}),
      };
      const restored = restoringInputs.current.get(row.productKey);
      const matching = restored?.revision === draft.revision ? restored : undefined;
      if (matching) Object.assign(choices, { ...matching.choices, ...choices });
      // Shipping is editable even when the source supplies a default; retain the operator's choice.
      if (matching?.choices.logistics !== undefined) choices.logistics = matching.choices.logistics;
      const matchingPrice =
        matching?.priceSelection &&
        [...groups.values()].find(
          (option) =>
            option.value.importId === matching.priceSelection!.importId &&
            option.value.sheet === matching.priceSelection!.sheet &&
            option.value.priceProfile === matching.priceSelection!.priceProfile,
        );
      const form: Editing = {
        draft,
        choices,
        stocks: matching
          ? Object.fromEntries(
              draft.variants.flatMap((variant) => {
                const value = matching.stocks[variant.sku.value];
                return value === undefined ? [] : [[variant.sku.value, value]];
              }),
            )
          : {},
        priceSelection: matchingPrice?.value ?? priceSelection,
        priceLabel: filename,
        priceOptions: [...groups.values()],
        brandSearch: matching?.brandSearch ?? '',
        referenceId: '',
      };
      if (!alive.current) return;
      restoringInputs.current.delete(row.productKey);
      setEditing((previous) => ({ ...previous, [row.productKey]: form }));
      await metadata(row.productKey, {
        ...(choices.categoryId ? { categoryId: choices.categoryId } : {}),
        ...(matching && (choices.brandName || matching.brandSearch)
          ? { brandName: choices.brandName || matching.brandSearch }
          : {}),
      });
    } catch (error) {
      if (alive.current)
        setSourceErrors((previous) => ({ ...previous, [row.productKey]: message(error) }));
    } finally {
      loading.current.delete(row.productKey);
    }
  }
  function toggle(row: Summary, checked: boolean) {
    changed();
    setSelected((previous) =>
      checked
        ? [...new Set([...previous, row.productKey])]
        : previous.filter((key) => key !== row.productKey),
    );
    if (checked) {
      setOpened(row.productKey);
      void ensure(row);
    }
  }
  async function selectVisible() {
    const rows = visible.slice(0, 80);
    changed();
    setSelected(rows.map((row) => row.productKey));
    if (rows[0]) setOpened(rows[0].productKey);
    // Bound local source reads; each listing retains its own mapping and exceptions.
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(3, rows.length) }, async () => {
        while (cursor < rows.length) {
          const row = rows[cursor++];
          if (row) await ensure(row);
        }
      }),
    );
  }
  function applyStock() {
    if (!/^(0|[1-9]\d*)$/.test(stock) || !Number.isSafeInteger(Number(stock))) {
      setError('Nhập tồn đăng bán là số nguyên từ 0 trở lên.');
      return;
    }
    changed();
    setEditing((previous) =>
      Object.fromEntries(
        Object.entries(previous).map(([key, value]) => [
          key,
          selected.includes(key)
            ? {
                ...value,
                stocks: Object.fromEntries(value.draft.variants.map((v) => [v.sku.value, stock])),
              }
            : value,
        ]),
      ),
    );
    setError('');
  }
  async function autofill() {
    if(lock.current || !selected.length || selected.some(key=>!editing[key] || editing[key]?.metadataBusy)) return;
    const dimensionCm=Object.fromEntries(Object.entries(testDimensions).map(([key,value])=>[key,Number(value)]));
    if(useTestDimensions && Object.values(dimensionCm).some(value=>!Number.isFinite(value)||value<=0)) {
      setError('Điền đủ ba kích thước kiện thử, mỗi số lớn hơn 0 cm.'); return;
    }
    changed();
    const request=beginRequest(attributeMode==='minimum_required' ? 'Đang điền nhanh điều kiện đăng cho cả lô; thông tin chi tiết tùy chọn sẽ để QC bổ sung…' : 'Đang tìm dữ liệu phù hợp trong nguồn, listing cũ và lựa chọn hiện tại của shop…', 'autofill');
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; request.controller.abort(); }, 360_000);
    const entries=selected.map(key=>({productKey:key,sourceRevision:editing[key]!.draft.revision,
      ...(editing[key]!.choices.dimensionCm ? {dimensionCm:editing[key]!.choices.dimensionCm} : {}),
      ...(editing[key]!.choices.categoryId ? {categoryId:editing[key]!.choices.categoryId} : {}),
      ...(editing[key]!.choices.brandId ? {brandId:editing[key]!.choices.brandId} : {}),
    }));
    try {
      const result=autofillResultSchema.parse(await api<unknown>(scoped('/v1/production-preparations/autofill'),{
        method:'POST',signal:request.controller.signal,
        body:JSON.stringify({entries,attributeMode,logisticsMode,shared:{
          ...(sharedCondition ? {condition:sharedCondition} : {}),
          ...(sharedPreOrder==='no' ? {preOrder:{is_pre_order:false}} : {}),
          ...(useTestDimensions ? {dimensionCm} : {}),
        }}),
      }));
      if(result.scope.shopId!==context?.scope.shopId || (context?.scope.partnerId && result.scope.partnerId!==context.scope.partnerId)
        || result.entries.length!==entries.length || new Set(result.entries.map(entry=>entry.productKey)).size!==entries.length
        || result.entries.some(entry=>!entries.some(expected=>expected.productKey===entry.productKey && expected.sourceRevision===entry.sourceRevision)))
        throw Error('Kết quả đề xuất không khớp shop hoặc phiên bản nguồn. Đọc lại trước khi áp dụng.');
      if(!currentRequest(request)) return;
      setEditing(previous=>{
        const next={...previous};
        for(const entry of result.entries) {
          const current=next[entry.productKey];
          if(!current || current.draft.revision!==entry.sourceRevision) continue;
          const choices=mergeMissingChoices(current.choices,entry.choices);
          // Explicit bulk shipping choice replaces old shipping choices only, after validating
          // the same package values that will actually remain in the editor.
          if(logisticsMode==='all_eligible' && entry.choices.logistics &&
            choices.weightGrams===entry.choices.weightGrams &&
            (['length','width','height'] as const).every(k=>choices.dimensionCm?.[k]===entry.choices.dimensionCm?.[k]))
            choices.logistics=entry.choices.logistics;
          const meta=entry.metadata as Metadata | undefined;
          const validMeta=meta?.shop?.id===context?.scope.shopId && Array.isArray(meta.categories) && Array.isArray(meta.channels);
          next[entry.productKey]={...current,choices,
            ...(validMeta ? {metadata:meta} : {}),
            ...(choices.brandName && !current.brandSearch ? {brandSearch:choices.brandName} : {}),
            ...(choices.stockLocation ? {referenceId:choices.stockLocation.referenceItemId} : {}),
          };
        }
        return next;
      });
      setAutofillResult(result);
      setAnnouncement('Đã điền cho '+result.entries.length+' listing trong một lần. Bấm Kiểm tra nguồn để chuẩn bị lô. Thông tin chi tiết tùy chọn có thể bổ sung trực tiếp trên link ẩn. Chưa gửi Shopee.');
    } catch(error) { if(currentRequest(request)) setError(timedOut ? 'Tra cứu quá 6 phút nên đã dừng chờ. Các lựa chọn vẫn được giữ; kiểm tra kết nối shop rồi thử lại. Chưa gửi listing.' : error instanceof z.ZodError ? 'Chưa đọc được đầy đủ kết quả đề xuất. Các lựa chọn trước đó vẫn được giữ.' : message(error)); }
    finally { window.clearTimeout(timeout); finishRequest(request); }
  }
  async function inspect() {
    if (lock.current || !selected.length) return;
    const request = beginRequest(
      'Đang kiểm tra ' + selected.length + ' listing với nguồn và thông tin shop…',
    );
    setAnnouncement(
      'Đang kiểm tra ' +
        selected.length +
        ' listing. Chờ kết quả tại bước 3; chưa đăng lên Shopee.',
    );
    try {
      const entries = selected.map((key) => {
        const e = editing[key];
        if (!e) throw Error('Chờ đọc xong các bộ nguồn đã chọn.');
        const stocks = Object.fromEntries(
          Object.entries(e.stocks)
            .filter(([, value]) => value !== '')
            .map(([sku, value]) => {
              if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)))
                throw Error('Tồn đăng bán phải là số nguyên từ 0 trở lên.');
              return [sku, Number(value)];
            }),
        );
        const choices = { ...e.choices };
        if (choices.logistics && !choices.logistics.length) delete choices.logistics;
        if (choices.attributeList)
          choices.attributeList = choices.attributeList.map((row) => ({
            ...row,
            attribute_value_list: row.attribute_value_list.map((value: any) =>
              Object.fromEntries(
                Object.entries(value).filter(
                  ([key, item]) =>
                    !['value_unit', 'original_value_name'].includes(key) || item !== '',
                ),
              ),
            ),
          }));
        return {
          productKey: key,
          sourceRevision: e.draft.revision,
          ...(e.knowledgeAcceptanceId ? { knowledgeAcceptanceId: e.knowledgeAcceptanceId } : {}),
          ...(allowSharedSkus && publicationMode==='hidden_for_review' ? {existingListingAuthorization:{reason:'distinct_prepared_listing_test',authorizationReference:'Operator selected distinct hidden test listing: '+context?.scope.shopId+':'+key+':'+e.draft.revision}} : {}),
          ...(e.priceSelection ? { priceSelection: e.priceSelection } : {}),
          stocks,
          choices,
        };
      });
      pending.current ??= { id: crypto.randomUUID(), publicationMode, imageQcPolicy, entries };
      sessionStorage.setItem(pendingKey, JSON.stringify(pending.current));
      const result = await api<Preview>(scoped('/v1/production-preparations/preview'), {
        method: 'POST',
        body: JSON.stringify(pending.current),
        signal: request.controller.signal,
      });
      if (!currentRequest(request)) return;
      previewGeneration.current = request.generation;
      focusResult.current = true;
      setPreview(result);
      setAnnouncement(
        'Kiểm tra xong: ' +
          result.readyCount +
          ' listing đủ nguồn, ' +
          result.blockedCount +
          ' cần bổ sung.',
      );
      setSaved(false);
      setNeedsRecheck(false);
      sessionStorage.removeItem(pendingKey);
      setRecoverable(false);
    } catch (error) {
      if (currentRequest(request)) {
        setError(message(error));
        setAnnouncement('Chưa kiểm tra xong. ' + message(error));
      }
    } finally {
      finishRequest(request);
    }
  }
  async function recover() {
    if (!pending.current || lock.current) return;
    const request = beginRequest('Đang lấy lại kết quả kiểm tra trước…');
    try {
      const result = await api<Preview>(scoped('/v1/production-preparations/preview'), {
        method: 'POST',
        body: JSON.stringify(pending.current),
        signal: request.controller.signal,
      });
      if (!currentRequest(request)) return;
      previewGeneration.current = request.generation;
      setPreview(result);
      setSaved(!!result.registration);
      setRecoverable(false);
      setNeedsRecheck(false);
      sessionStorage.removeItem(pendingKey);
    } catch (error) {
      if (currentRequest(request)) setError(message(error));
    } finally {
      finishRequest(request);
    }
  }
  async function register() {
    if (
      !preview ||
      previewGeneration.current !== generation.current ||
      lock.current ||
      saved ||
      !preview.readyCount
    )
      return;
    const request = beginRequest('Đang chuẩn bị các đợt đủ nguồn tại ứng dụng…');
    try {
      await api(scoped('/v1/production-preparations/' + encodeURIComponent(preview.id) + '/register'), {
        method: 'POST',
        body: JSON.stringify({ expectedFingerprint: preview.fingerprint }),
        signal: request.controller.signal,
      });
      if (currentRequest(request)) {
        setSaved(true);
        try {
          const value = sessionStorage.getItem(workingCopyKey);
          if (value) {
            const copy = workingCopySchema.parse(JSON.parse(value));
            const registered = new Set(
              preview.entries
                .filter((entry) => entry.kind === 'ready')
                .map((entry) => entry.productKey),
            );
            copy.selected = copy.selected.filter((entry) => !registered.has(entry.productKey));
            copy.entries = copy.entries.filter((entry) => !registered.has(entry.productKey));
            if (copy.selected.length)
              sessionStorage.setItem(
                workingCopyKey,
                JSON.stringify({ ...copy, opened: copy.selected[0]!.productKey }),
              );
            else sessionStorage.removeItem(workingCopyKey);
          }
        } catch {
          /* A temporary form is never an execution receipt. */
        }
        onRegistered();
        void reload();
      }
    } catch (error) {
      if (currentRequest(request)) setError(message(error));
    } finally {
      finishRequest(request);
    }
  }
  const sourceGroups=[...new Set(context?.products.flatMap(row=>row.sourceSelection?.folderBinding?.groupKey.split('/').slice(0,1) ?? []) ?? [])].sort();
  const visible =
      context?.products.filter((row) =>
        (!sourceGroup || (sourceGroup==='__folders' ? !!row.sourceSelection?.folderBinding : row.sourceSelection?.folderBinding?.groupKey.split('/')[0]===sourceGroup)) && [row.title, ...row.skus].some((text) =>
          text.toLocaleLowerCase('vi-VN').includes(search.toLocaleLowerCase('vi-VN')),
        ),
      ) ?? [],
    selectedRows = context?.products.filter((row) => selected.includes(row.productKey)) ?? [];
  return (
    <section className="production-preparation" aria-label="Chuẩn bị đợt từ listing đã lưu">
      <header>
        <div>
          <span className="production-pilot-eyebrow">CHUẨN BỊ NGUỒN</span>
          <h2>Từ listing đã lưu đến đợt đăng</h2>
          <p>Dùng lại Word, ảnh, phân loại và dòng giá đã ghép. Chỉ bổ sung phần còn thiếu.</p>
        </div>
        <div className="production-batch-actions">
          <button
            type="button"
            className="secondary"
            disabled={contextLoading || busy}
            onClick={() => void reload()}
          >
            {contextLoading ? 'Đang đọc kho listing…' : 'Đọc lại kho listing'}
          </button>
          <button type="button" className="secondary" onClick={onFolders}>
            Nhập thư mục listing
          </button>
        </div>
      </header>
      <ol className="preparation-step-guide" aria-label="Các bước đăng hàng loạt">
        {[
          ['Chọn listing', selected.length ? selected.length + ' đã chọn' : 'Dùng bộ nguồn đã lưu'],
          ['Bổ sung phần thiếu', 'Giữ nội dung, ảnh, SKU và giá đã có'],
          [
            'Kiểm tra nguồn',
            preview
              ? preview.readyCount + ' đủ nguồn · ' + preview.blockedCount + ' cần bổ sung'
              : 'Ứng dụng chỉ rõ phần cần sửa',
          ],
          ['Đăng qua API', 'Chuẩn bị đợt rồi tự bấm đăng'],
        ].map(([label, detail], index) => (
          <li
            key={label}
            aria-current={
              (saved ? 3 : preview ? 2 : selected.length ? 1 : 0) === index ? 'step' : undefined
            }
          >
            <span>{index + 1}</span>
            <div>
              <strong>{label}</strong>
              <small>{detail}</small>
            </div>
          </li>
        ))}
      </ol>
      <p className="preparation-announcement" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
      {busy && (
        <p className="preparation-progress" role="status">
          {busyLabel} Kết quả sẽ hiện tại bước 3. Chưa có lệnh đăng Shopee.
        </p>
      )}
      {error && (
        <p role="alert" className="notice warning">
          {error}
        </p>
      )}
      {!context && contextLoading && <p role="status">Đang đọc kho listing…</p>}
      {needsRecheck && (
        <p role="status" className="notice warning">
          Thông tin đã thay đổi. Kiểm tra lại các listing trước khi chuẩn bị đợt.
        </p>
      )}
      {context &&
        !recoverable &&
        !preview &&
        (selected.length > 0 || stock || workingCopyNotice) && (
          <div className="notice" aria-label="Phần nhập tạm">
            <p role="status">
              {workingCopyNotice ||
                'Phần đang nhập được giữ trong tab này khi tải lại trang. Chưa đăng hoặc mở bán listing.'}
            </p>
            <button
              type="button"
              className="secondary"
              disabled={
                busy ||
                restoringWorkingCopy ||
                selected.some((key) => editing[key]?.metadataBusy || loading.current.has(key))
              }
              onClick={discardWorkingCopy}
            >
              Bỏ phần nhập tạm
            </button>
          </div>
        )}
      {recoverable && (
        <p role="status" className="notice">
          Có lần kiểm tra nguồn chưa nhận được kết quả.{' '}
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => void recover()}
          >
            Lấy lại kết quả kiểm tra trước
          </button>
        </p>
      )}
      {context && (
        <>
          <p className="preparation-target">
            Shop đích: <strong>vuatinhdau.vn</strong> · Chuẩn bị tại ứng dụng, chưa đăng Shopee.
          </p>
          <details className="preparation-history">
            <summary>Bản kiểm tra đã lưu ({context.preparations.length})</summary>
            {context.preparations.map((item) => (
              <button
                type="button"
                className="secondary"
                key={item.id}
                onClick={() => {
                  changed();
                  previewGeneration.current = generation.current;
                  setPreview(item);
                  setSaved(!!item.registration);
                  setNeedsRecheck(false);
                }}
              >
                {item.entries[0]?.title ?? 'Bộ nguồn'} · {item.readyCount} đủ nguồn,{' '}
                {item.blockedCount} cần bổ sung
              </button>
            ))}
          </details>
          <h3>1. Chọn các listing cần chuẩn bị</h3>
          {!!sourceGroups.length && <label>Lọc theo đợt nhập<select value={sourceGroup} disabled={busy} onChange={event=>setSourceGroup(event.target.value)}><option value="">Tất cả bộ đã lưu</option><option value="__folders">Các bộ từ thư mục đã nhập</option>{sourceGroups.map(group=><option key={group} value={group}>{group}</option>)}</select></label>}
          <label>
            Tìm theo tên hoặc SKU
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Tìm listing đã lưu"
            />
          </label>
          {!visible.length && (
            <p>Chưa có listing phù hợp. Nhập thư mục hoặc mở bộ đã lưu để hoàn tất nguồn.</p>
          )}
          {visible.length > 1 && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => void selectVisible()}
            >
              Chọn {Math.min(visible.length, 80)} listing trong kết quả
            </button>
          )}
          <div className="preparation-source-list">
            {visible.map((row) => (
              <div key={row.productKey}>
                <label>
                  <input
                    type="checkbox"
                    checked={selected.includes(row.productKey)}
                    disabled={busy}
                    onChange={(e) => toggle(row, e.target.checked)}
                  />
                  <span>
                    <strong>{row.title}</strong>
                    <small>
                      {row.skus.length} SKU
                      {row.issues.length ? ' · ' + row.issues.length + ' điểm cần kiểm tra' : ''}
                    </small>
                  </span>
                </label>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => onSource(row.productKey)}
                >
                  Mở bộ nguồn
                </button>
              </div>
            ))}
          </div>
          {selected.length > 0 && (
            <>
              <h3>2. Bổ sung thông tin cho {selected.length} listing</h3>
              <p>
                Chỉ điền phần ứng dụng báo thiếu. Nội dung, ảnh, phân loại và giá đã ghép được dùng
                lại.
              </p>
              <section className="preparation-autofill" aria-label="Điền theo nguồn và kiến thức của shop">
                <h4>Điền một lần cho cả lô</h4>
                <p>Ưu tiên tạo link ẩn với ảnh, nội dung, SKU và giá đã ghép. Điền điều kiện đăng cho cả lô; chỉ bổ sung ô trống, giữ lựa chọn bạn đã sửa.</p>
                <label>Thông tin chi tiết<select value={attributeMode} disabled={busy} onChange={event=>{changed();setAttributeMode(event.target.value as typeof attributeMode);}}>
                  <option value="minimum_required">Điền nhanh phần cần để đăng — QC bổ sung sau</option>
                  <option value="source_supported">Bổ sung thêm từ nguồn và listing cũ của shop</option>
                </select></label>
                <label>Vận chuyển cho cả lô<select value={logisticsMode} disabled={busy} onChange={event=>{changed();setLogisticsMode(event.target.value as typeof logisticsMode);}}>
                  <option value="all_eligible">Bật tất cả kênh vận chuyển phù hợp</option>
                  <option value="source_supported">Giữ lựa chọn hiện tại, chỉ bổ sung từ nguồn</option>
                </select></label>
                <p>Bật tất cả sẽ thay lựa chọn vận chuyển của các listing đã chọn bằng những nhóm shop đang bật, đủ điều kiện theo kiện hàng. Không bật kênh đang tắt trên Shopee; nhóm không phù hợp được ghi rõ trong kết quả.</p>
                <div className="preparation-autofill-options">
                  <label>Tình trạng chung<select value={sharedCondition} disabled={busy} onChange={event=>setSharedCondition(event.target.value as typeof sharedCondition)}>
                    <option value="NEW">Hàng mới</option><option value="USED">Đã qua sử dụng</option><option value="">Để riêng từng listing</option>
                  </select></label>
                  <label>Chuẩn bị hàng<select value={sharedPreOrder} disabled={busy} onChange={event=>setSharedPreOrder(event.target.value as typeof sharedPreOrder)}>
                    <option value="no">Hàng có sẵn, không đặt trước</option><option value="">Để riêng từng listing</option>
                  </select></label>
                </div>
                <label className="preparation-autofill-check"><input type="checkbox" checked={useTestDimensions} disabled={busy} onChange={event=>setUseTestDimensions(event.target.checked)}/>Dùng kích thước kiện ước tính cho lô thử</label>
                {useTestDimensions && <div className="preparation-autofill-options">{(['length','width','height'] as const).map((field,index)=><label key={field}>{['Dài kiện thử (cm)','Rộng kiện thử (cm)','Cao kiện thử (cm)'][index]}<input type="number" min="0.1" step="any" value={testDimensions[field]} disabled={busy} onChange={event=>setTestDimensions(previous=>({...previous,[field]:event.target.value}))}/></label>)}</div>}
                {useTestDimensions && <p>Kích thước này là số ước tính do bạn chọn cho lô thử; người QC cần thay bằng số đo trước khi mở bán. Cân nặng vẫn lấy từ từng SKU trong nguồn.</p>}
                <button type="button" disabled={busy || selected.some(key=>!editing[key] || editing[key]?.metadataBusy)} onClick={()=>void autofill()}>{attributeMode==='minimum_required' ? 'Điền nhanh cả lô' : 'Điền thêm từ nguồn'} · {selected.length} listing</button>
                {busy && activeRequest.current?.kind === 'autofill' && <AutofillWait onCancel={() => {
                  const request = activeRequest.current;
                  if (request?.kind !== 'autofill') return;
                  request.controller.abort();
                  finishRequest(request);
                  setAnnouncement('Đã dừng chờ tra cứu. Giữ nguyên listing và phần đã nhập; chưa gửi listing lên Shopee.');
                }} />}
                {autofillResult && <div role="status" className="preparation-autofill-result">
                  <p>Đã đối chiếu lúc {new Date(autofillResult.observedAt).toLocaleTimeString('vi-VN')}. Đây là phần chuẩn bị; kết quả đăng sẽ được kiểm riêng.</p>
                  {autofillResult.entries.map(entry=><details key={entry.productKey}><summary>{editing[entry.productKey]?.draft.title.value ?? entry.productKey} · {entry.explanations.length} căn cứ{entry.unresolved.length ? ' · '+entry.unresolved.length+' mục cần xem' : ''}</summary>
                    <ul>{entry.explanations.map((explanation,index)=><li key={'e'+index}>{explanation.message}{explanation.source && <small>Nguồn: {explanation.source}</small>}</li>)}{entry.unresolved.map((issue,index)=><li key={'u'+index}>Cần xem thêm: {issue.message}</li>)}{entry.issues.map((issue,index)=><li key={'i'+index}>{issue.message}</li>)}</ul>
                    {!!entry.knowledgeSuggestions?.length && <details><summary>Tham khảo từ listing cũ của shop ({entry.knowledgeSuggestions.length} thuộc tính)</summary><ul>{entry.knowledgeSuggestions.map((suggestion,index)=><li key={index}>{suggestion.name} · {suggestion.applied ? 'Có căn cứ để đề xuất điền' : 'Giữ để người QC đối chiếu thêm'}{suggestion.references.map(reference=><small key={reference.evidenceId}><a href={'https://banhang.shopee.vn/portal/product/'+encodeURIComponent(reference.itemId)} target="_blank" rel="noreferrer">{reference.title}</a></small>)}</li>)}</ul></details>}
                    {!!entry.knowledgeIssues?.length && <details><summary>Thông tin tham khảo chưa dùng ({entry.knowledgeIssues.length})</summary><ul>{entry.knowledgeIssues.map((issue,index)=><li key={index}>{issue.detail}</li>)}</ul></details>}
                  </details>)}
                  <p>Thuộc tính tùy chọn còn thiếu có thể bổ sung khi QC. Các yêu cầu bắt buộc sẽ được chỉ rõ khi kiểm tra nguồn.</p>
                </div>}
              </section>
              {selected.some(
                (key) => !sourceErrors[key] && (!editing[key] || editing[key]?.metadataBusy),
              ) && (
                <p role="status" className="preparation-progress">
                  Đang đọc nguồn và lựa chọn của shop ·{' '}
                  {selected.filter((key) => editing[key] && !editing[key]?.metadataBusy).length}/
                  {selected.length} listing đã sẵn sàng kiểm tra.
                </p>
              )}
              <div className="preparation-stock">
                <label>
                  Tồn đăng bán chung cho các SKU đã chọn
                  <input
                    inputMode="numeric"
                    value={stock}
                    onChange={(e) => setStock(e.target.value)}
                    placeholder="Bạn quyết định mức tồn"
                  />
                </label>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy || selected.some((key) => !editing[key])}
                  onClick={applyStock}
                >
                  Áp dụng tồn cho SKU đã chọn
                </button>
              </div>
              {selectedRows.map((row) => {
                const e = editing[row.productKey],
                  key = row.productKey,
                  meta = e?.metadata;
                return (
                  <details
                    className="preparation-entry"
                    key={key}
                    ref={(element) => {
                      if (element) entryElements.current.set(key, element);
                      else entryElements.current.delete(key);
                    }}
                    open={opened === key}
                    onToggle={(event) => {
                      if (event.currentTarget.open) setOpened(key);
                      else setOpened((previous) => (previous === key ? null : previous));
                    }}
                  >
                    <summary>
                      {row.title} · {row.skus.length} SKU
                    </summary>
                    {!e ? (
                      sourceErrors[key] ? (
                        <div>
                          <p role="alert" className="notice warning">
                            {sourceErrors[key]}
                          </p>
                          <button
                            type="button"
                            className="secondary"
                            disabled={busy}
                            onClick={() => void ensure(row)}
                          >
                            Đọc lại nguồn listing này
                          </button>
                        </div>
                      ) : (
                        <p>Đang đọc nguồn và dòng giá…</p>
                      )
                    ) : (
                      <>
                        {e.issue && (
                          <div role="status" className="notice warning">
                            <p>{e.issue}</p>
                            {[
                              'PRODUCTION_PREPARATION_AUTH_REQUIRED',
                              'PRODUCTION_PREPARATION_CONNECTION_CHANGED',
                            ].includes(e.metadataIssueCode ?? '') && (
                              <p>
                                Vào Công cụ → Kết nối shop để kiểm tra hoặc cấp quyền lại. Sau đó
                                quay lại đây và đọc lại lựa chọn của shop.
                              </p>
                            )}
                            <button
                              type="button"
                              className="secondary"
                              disabled={busy || e.metadataBusy}
                              onClick={() =>
                                void metadata(key, {
                                  ...(e.choices.categoryId
                                    ? { categoryId: e.choices.categoryId }
                                    : {}),
                                  ...(e.choices.categoryId && e.brandSearch.trim()
                                    ? { brandName: e.brandSearch.trim() }
                                    : {}),
                                })
                              }
                            >
                              Đọc lại lựa chọn của shop
                            </button>
                          </div>
                        )}
                        <div className="preparation-source-summary">
                          <img src={media(e.draft.coverKey)} alt={'Bìa nguồn ' + row.title} />
                          <div>
                            <p>Nội dung, thứ tự ảnh và phân loại giữ theo bộ đã lưu.</p>
                            <p>
                              Bảng giá: {e.priceLabel ?? 'Chưa ghép'}
                              {e.priceSelection
                                ? ' · ' +
                                  e.priceSelection.sheet +
                                  ' · ' +
                                  (e.priceSelection.priceProfile ?? 'Giá theo nguồn')
                                : ''}
                            </p>
                            <button
                              type="button"
                              className="secondary"
                              onClick={() => onSource(key)}
                            >
                              Xem nội dung và ảnh gốc
                            </button>
                          </div>
                        </div>
                        {!e.priceSelection && (
                          <label data-preparation-field="priceSelection" tabIndex={-1}>
                            Bộ giá của listing
                            <select
                              value=""
                              onChange={(event) => {
                                const option = e.priceOptions.find(
                                  (o) => JSON.stringify(o.value) === event.target.value,
                                );
                                if (option) update(key, { priceSelection: option.value });
                              }}
                            >
                              <option value="">Chọn đúng trang tính và bộ giá</option>
                              {e.priceOptions.map((o) => (
                                <option
                                  key={JSON.stringify(o.value)}
                                  value={JSON.stringify(o.value)}
                                >
                                  {o.label}
                                </option>
                              ))}
                            </select>
                            <small>
                              Nếu chưa có dòng giá đã ghép, mở bộ nguồn để đối chiếu SKU trước.
                            </small>
                          </label>
                        )}
                        <div className="preparation-fields">
                          <label data-preparation-field="categoryId" tabIndex={-1}>
                            Ngành hàng
                            <select
                              disabled={!!e.draft.categoryId?.confirmed}
                              value={e.choices.categoryId ?? ''}
                              onChange={(event) => {
                                choice(key, {
                                  categoryId: event.target.value,
                                  brandId: undefined,
                                  brandName: undefined,
                                  attributeList: undefined,
                                });
                                void metadata(key, { categoryId: event.target.value });
                              }}
                            >
                              <option value="">Chọn ngành đúng với sản phẩm</option>
                              {e.choices.categoryId &&
                                !meta?.categories.some((c) => c.id === e.choices.categoryId) && (
                                  <option value={e.choices.categoryId}>
                                    Ngành đã lưu — cần đối chiếu tên
                                  </option>
                                )}
                              {meta?.categories.map((category) => (
                                <option key={category.id} value={category.id}>
                                  {category.path}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label data-preparation-field="brandId" tabIndex={-1}>
                            Thương hiệu
                            <select
                              value={e.choices.brandId ?? ''}
                              disabled={!e.choices.categoryId}
                              onChange={(event) => {
                                const brand = meta?.brands?.items.find(
                                  (b) => b.id === event.target.value,
                                );
                                if (brand)
                                  choice(key, { brandId: brand.id, brandName: brand.name });
                              }}
                            >
                              <option value="">Chọn thương hiệu theo nguồn</option>
                              {e.choices.brandId &&
                                !meta?.brands?.items.some((b) => b.id === e.choices.brandId) && (
                                  <option value={e.choices.brandId}>
                                    Thương hiệu đã lưu — cần đối chiếu tên
                                  </option>
                                )}
                              {meta?.brands?.items.map((brand) => (
                                <option key={brand.id} value={brand.id}>
                                  {brand.label}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            Tìm đúng tên thương hiệu
                            <input
                              value={e.brandSearch}
                              onChange={(event) => update(key, { brandSearch: event.target.value })}
                            />
                            <button
                              type="button"
                              className="secondary"
                              disabled={!e.choices.categoryId || !e.brandSearch}
                              onClick={() =>
                                void metadata(key, {
                                  categoryId: e.choices.categoryId!,
                                  brandName: e.brandSearch,
                                })
                              }
                            >
                              Tra thương hiệu
                            </button>
                          </label>
                          <label data-preparation-field="condition" tabIndex={-1}>
                            Tình trạng sản phẩm
                            <select
                              value={e.choices.condition ?? ''}
                              onChange={(event) =>
                                choice(key, { condition: event.target.value as 'NEW' | 'USED' })
                              }
                            >
                              <option value="">Chọn theo nguồn</option>
                              <option value="NEW">Hàng mới</option>
                              <option value="USED">Đã qua sử dụng</option>
                            </select>
                          </label>
                          <label data-preparation-field="preOrder" tabIndex={-1}>
                            Hàng đặt trước
                            <select
                              aria-label="Hàng đặt trước"
                              value={
                                e.choices.preOrder === undefined
                                  ? ''
                                  : e.choices.preOrder.is_pre_order
                                    ? 'yes'
                                    : 'no'
                              }
                              onChange={(event) =>
                                choice(key, {
                                  preOrder: event.target.value
                                    ? { is_pre_order: event.target.value === 'yes' }
                                    : undefined,
                                })
                              }
                            >
                              <option value="">Chọn cách chuẩn bị hàng</option>
                              <option value="no">Không phải hàng đặt trước</option>
                              <option value="yes">Hàng đặt trước</option>
                            </select>
                          </label>
                          {e.choices.preOrder?.is_pre_order && (
                            <label>
                              Số ngày chuẩn bị
                              <input
                                type="number"
                                min="1"
                                value={e.choices.preOrder.days_to_ship ?? ''}
                                onChange={(event) =>
                                  choice(key, {
                                    preOrder: {
                                      is_pre_order: true,
                                      days_to_ship: Number(event.target.value),
                                    },
                                  })
                                }
                              />
                            </label>
                          )}
                          <label data-preparation-field="weightGrams" tabIndex={-1}>
                            Cân nặng đóng gói (g)
                            <input
                              type="number"
                              min="0"
                              step="any"
                              value={e.choices.weightGrams ?? ''}
                              readOnly={e.draft.variants.every(
                                (v) => v.declaredWeightGrams?.confirmed,
                              )}
                              onChange={(event) =>
                                choice(key, {
                                  weightGrams: event.target.value
                                    ? Number(event.target.value)
                                    : undefined,
                                })
                              }
                            />
                            <small>
                              Nếu có cân nặng từng SKU, dùng đúng nguồn và lấy mức lớn nhất cho
                              listing.
                            </small>
                          </label>
                          {(['length', 'width', 'height'] as const).map((field, i) => (
                            <label
                              key={field}
                              data-preparation-field={i === 0 ? 'dimensionCm' : undefined}
                              tabIndex={-1}
                            >
                              {['Dài', 'Rộng', 'Cao'][i]} kiện hàng (cm)
                              <input
                                aria-label={['Dài', 'Rộng', 'Cao'][i] + ' kiện hàng (cm)'}
                                aria-describedby={'dimension-help-' + key + '-' + field}
                                type="number"
                                min="1"
                                step="1"
                                value={e.choices.dimensionCm?.[field] ?? ''}
                                onChange={(event) =>
                                  choice(key, {
                                    dimensionCm: {
                                      ...e.choices.dimensionCm!,
                                      [field]: event.target.value
                                        ? Number(event.target.value)
                                        : undefined,
                                    } as Choices['dimensionCm'],
                                  })
                                }
                              />
                              <small id={'dimension-help-' + key + '-' + field}>
                                Số nguyên từ 1 cm; theo số đo kiện đóng gói.
                              </small>
                            </label>
                          ))}
                        </div>
                        {meta?.itemLimits?.sizeChart.mandatory && (
                          <p className="notice warning">
                            Ngành này yêu cầu bảng kích thước. Cần bổ sung bảng đúng sản phẩm; bộ
                            thiếu sẽ được giữ lại.
                          </p>
                        )}
                        {meta?.attributes && (
                          <section data-preparation-field="attributes" tabIndex={-1}>
                            <h4>{attributeMode==='minimum_required' ? 'Thông tin chi tiết bắt buộc' : 'Thuộc tính theo ngành'}</h4>
                            {attributeMode==='minimum_required' && !chosenAttributes(meta.attributes,e.choices.attributeList ?? []).some(a=>a.mandatory) && <p>Ngành này chưa yêu cầu thêm thuộc tính bắt buộc. Người QC có thể bổ sung thông tin chi tiết trực tiếp trên link ẩn.</p>}
                            <AttributeFields
                              metadata={meta.attributes}
                              values={e.choices.attributeList ?? []}
                              requiredOnly={attributeMode==='minimum_required'}
                              onChange={(values) => choice(key, { attributeList: values })}
                            />
                          </section>
                        )}
                        {attributeMode==='source_supported' && <DraftKnowledgeSuggestions
                          key={`${key}:${e.draft.revision}:${e.choices.categoryId}:${e.choices.brandId}`}
                          productKey={key}
                          expectedRevision={e.draft.revision}
                          shopId={context.scope.shopId}
                          partnerId={context.scope.partnerId}
                          categoryId={e.choices.categoryId}
                          brandId={e.choices.brandId}
                          acceptedId={e.knowledgeAcceptanceId}
                          onAccepted={(receipt) => {
                            changed();
                            setEditing((previous) => {
                              const current = previous[key];
                              if (
                                !current ||
                                current.draft.revision !== receipt.target.expectedRevision ||
                                current.choices.categoryId !== String(receipt.target.categoryId) ||
                                current.choices.brandId !== String(receipt.target.brandId)
                              )
                                return previous;
                              return {
                                ...previous,
                                [key]: {
                                  ...current,
                                  knowledgeAcceptanceId: receipt.id,
                                  choices: {
                                    ...current.choices,
                                    attributeList: [
                                      ...(current.choices.attributeList ?? []).filter(
                                        (row) =>
                                          !receipt.attributeList.some(
                                            (accepted) =>
                                              accepted.attribute_id === row.attribute_id,
                                          ),
                                      ),
                                      ...receipt.attributeList,
                                    ],
                                  },
                                },
                              };
                            });
                          }}
                        />}
                        <h4>Vận chuyển</h4>
                        <p>Nhóm vận chuyển từ Shopee · {meta?.shop.name} · Shop {meta?.shop.id}
                          {meta?.observedAt ? ' · Đọc lúc ' + new Date(meta.observedAt).toLocaleString('vi-VN') : ''}.
                          Chọn nhóm như trên Kênh Người Bán; đơn vị trực thuộc không gửi riêng khi đăng.</p>
                        <div className="preparation-checks" data-preparation-field="logistics" tabIndex={-1}>
                          {meta?.channels.filter(c=>c.parentId==='0').map(channel=>{
                            const checked=e.choices.logistics?.some(c=>c.channelId===channel.id && c.enabled) ?? false;
                            const reason=productChannelIssue(channel,e.choices.weightGrams,e.choices.dimensionCm);
                            return <label key={channel.id} style={{display:'flex',alignItems:'flex-start',gap:8,flexBasis:'100%'}}>
                              <input type="checkbox" disabled={busy || (!!reason && !checked)} checked={checked}
                                onChange={event=>choice(key,{logistics:[...(e.choices.logistics ?? []).filter(c=>c.channelId!==channel.id),{channelId:channel.id,enabled:event.target.checked}]})}/>
                              <span>{channel.name}{channel.forceEnabled ? ' · Bắt buộc bật' : channel.compulsory ? ' · Chọn ít nhất một nhóm bắt buộc' : ''}
                                {reason && <small style={{display:'block'}}>{checked ? 'Cần sửa lựa chọn: ' : ''}{reason}</small>}
                              </span>
                            </label>;
                          })}
                        </div>
                        {!!e.choices.logistics?.some(c=>c.enabled && meta && !meta.channels.some(m=>m.id===c.channelId && m.parentId==='0')) &&
                          <p role="alert">Lựa chọn cũ có mã đơn vị trực thuộc hoặc mã không còn trong danh sách. Dùng “Bật tất cả kênh vận chuyển phù hợp” ở Điền nhanh, hoặc
                            <button type="button" className="secondary" disabled={busy} onClick={()=>choice(key,{logistics:e.choices.logistics?.filter(c=>meta?.channels.some(m=>m.id===c.channelId && m.parentId==='0'))})}>Bỏ mã không dùng để đăng</button>.
                          </p>}
                        <h4>Kho áp dụng</h4>
                        {e.choices.stockLocation ? (
                          <p>Đã có đối chiếu kho cho đúng shop và các SKU đã chọn.</p>
                        ) : (
                          <p>
                            Cần đối chiếu cách nhận tồn từ một listing hiện có. Ứng dụng chưa tự gán
                            kho.
                          </p>
                        )}
                        <button
                          type="button"
                          className="secondary"
                          data-preparation-field="stockLocation"
                          disabled={e.metadataBusy}
                          onClick={() =>
                            void loadInventory(key, meta?.inventory?.status ?? 'NORMAL')
                          }
                        >
                          Chọn listing tham khảo kho
                        </button>
                        {meta?.inventory && (
                          <div className="preparation-inventory">
                            <label>
                              Trạng thái listing tham khảo kho
                              <select
                                value={meta.inventory.status ?? 'NORMAL'}
                                disabled={e.metadataBusy}
                                onChange={(event) =>
                                  void loadInventory(key, event.target.value as 'NORMAL' | 'UNLIST')
                                }
                              >
                                <option value="NORMAL">Đang mở bán</option>
                                <option value="UNLIST">Đang ẩn</option>
                              </select>
                            </label>
                            <label>
                              Listing đang có tại shop
                              <select
                                value={e.referenceId}
                                disabled={e.metadataBusy}
                                onChange={(event) => {
                                  const referenceId = event.target.value;
                                  metadataSequence.current.set(
                                    key,
                                    (metadataSequence.current.get(key) ?? 0) + 1,
                                  );
                                  update(key, {
                                    referenceId,
                                    choices: { ...e.choices, stockLocation: undefined },
                                    metadata: e.metadata
                                      ? { ...e.metadata, reference: undefined }
                                      : undefined,
                                    metadataBusy: false,
                                  });
                                  if (referenceId)
                                    void metadata(key, {
                                      ...(e.choices.categoryId
                                        ? { categoryId: e.choices.categoryId }
                                        : {}),
                                      referenceItemId: referenceId,
                                    });
                                }}
                              >
                                <option value="">Chọn listing để đọc thông tin kho</option>
                                {e.referenceId &&
                                  !meta.inventory.items.some(
                                    (item) => item.itemId === e.referenceId,
                                  ) && (
                                    <option value={e.referenceId}>
                                      {meta.reference?.itemId === e.referenceId
                                        ? meta.reference.title
                                        : 'Listing tham khảo đã chọn'}{' '}
                                      · Đã chọn
                                    </option>
                                  )}
                                {meta.inventory.items.map((item) => (
                                  <option key={item.itemId} value={item.itemId}>
                                    {item.title}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <p className="caption">
                              Đã tải {meta.inventory.items.length} listing{' '}
                              {meta.inventory.status === 'UNLIST' ? 'đang ẩn' : 'đang mở bán'}. Danh
                              sách này chỉ để đọc thông tin kho.
                            </p>
                            {!meta.inventory.items.length && (
                              <p>
                                Chưa có listing trong nhóm này. Thử đổi trạng thái sang{' '}
                                {meta.inventory.status === 'UNLIST' ? 'Đang mở bán' : 'Đang ẩn'}.
                              </p>
                            )}
                            {meta.inventory.hasNextPage && meta.inventory.nextOffset !== null && (
                              <button
                                type="button"
                                className="secondary"
                                disabled={e.metadataBusy}
                                onClick={() =>
                                  void loadInventory(
                                    key,
                                    meta.inventory!.status ?? 'NORMAL',
                                    meta.inventory!.nextOffset!,
                                  )
                                }
                              >
                                Tải thêm listing tham khảo kho
                              </button>
                            )}
                            {e.metadataBusy && (
                              <p role="status">Đang đọc listing và thông tin kho…</p>
                            )}
                          </div>
                        )}
                        {meta?.reference && (
                          <p>
                            {meta.reference.title}:{' '}
                            {meta.reference.writeMappingVerified
                              ? 'Đã đối chiếu cấu hình kho.'
                              : 'Đã đọc thông tin; chưa đủ bằng chứng để gán kho ghi cho bộ mới.'}
                          </p>
                        )}
                        <details data-preparation-field="stocks" tabIndex={-1}>
                          <summary>Tồn riêng cho {e.draft.variants.length} SKU</summary>
                          <div className="preparation-stock-rows">
                            {e.draft.variants.map((variant) => (
                              <label key={variant.key}>
                                {variant.sku.value} · {variant.optionLabels.join(' / ')}
                                <input
                                  inputMode="numeric"
                                  value={e.stocks[variant.sku.value] ?? ''}
                                  onChange={(event) =>
                                    update(key, {
                                      stocks: {
                                        ...e.stocks,
                                        [variant.sku.value]: event.target.value,
                                      },
                                    })
                                  }
                                  placeholder="Chưa đặt tồn"
                                />
                              </label>
                            ))}
                          </div>
                        </details>
                      </>
                    )}
                  </details>
                );
              })}
              <fieldset className="preparation-publication-mode" disabled={busy}>
                <legend>Sau khi tạo listing</legend>
                <label>
                  <input
                    type="radio"
                    name="publication-mode"
                    aria-label="Đăng ẩn để QC"
                    checked={publicationMode === 'hidden_for_review'}
                    onChange={() => {
                      changed();
                      setPublicationMode('hidden_for_review');
                      setImageQcPolicy('defer_image_qc');
                    }}
                  />
                  <span>
                    <strong>Đăng ẩn để QC</strong>
                    <small>
                      Tạo link ẩn trước. Người QC mở link trên Shopee, bổ sung thông tin rồi tự mở bán.
                    </small>
                  </span>
                </label>
                <label>
                  <input
                    type="radio"
                    name="publication-mode"
                    aria-label="Mở bán sau kiểm tra"
                    checked={publicationMode === 'publish_after_verification'}
                    onChange={() => {
                      changed();
                      setPublicationMode('publish_after_verification');
                      setImageQcPolicy('required');
                    }}
                  />
                  <span>
                    <strong>Mở bán sau kiểm tra</strong>
                    <small>Ứng dụng tự mở bán từng listing sau khi đối chiếu dữ liệu đạt.</small>
                  </span>
                </label>
                <label>
                  <input
                    type="checkbox"
                    aria-label="Tạm hoãn kiểm tra ảnh để thử đăng ẩn"
                    disabled={publicationMode !== 'hidden_for_review'}
                    checked={imageQcPolicy === 'defer_image_qc'}
                    onChange={(event) => {
                      changed();
                      setImageQcPolicy(event.target.checked ? 'defer_image_qc' : 'required');
                    }}
                  />
                  <span>
                    <strong>Người QC kiểm tra ảnh trên link Shopee sau khi đăng ẩn</strong>
                    <small>
                      Link được giữ ẩn, ảnh ghi “chưa QC”. Người phụ trách sửa và bổ sung ngay trên
                      Shopee rồi mở bán; không cần tạo lại listing. Giá, SKU, tồn và dữ liệu bắt buộc vẫn được kiểm trước khi gửi.
                    </small>
                  </span>
                </label>
                {publicationMode === 'hidden_for_review' && <label><input type="checkbox" checked={allowSharedSkus} onChange={event=>{changed();setAllowSharedSkus(event.target.checked);}}/><span><strong>Tạo link thử riêng dù SKU đã có ở link khác</strong><small>Dùng khi chủ ý đăng nhiều bộ nội dung cho cùng SKU. Bộ nguồn có ID listing vẫn phải đi luồng cập nhật; lần gửi chưa rõ kết quả không được gửi lại.</small></span></label>}
              </fieldset>
              <div className="preparation-footer">
                <p>Kiểm tra tạo bản xem trước tại ứng dụng, chưa gửi lên Shopee.</p>
                <button
                  type="button"
                  className="primary"
                  disabled={
                    busy || selected.some((key) => !editing[key] || editing[key]?.metadataBusy)
                  }
                  onClick={() => void inspect()}
                >
                  {busy ? 'Đang xử lý…' : 'Kiểm tra ' + selected.length + ' listing đã chọn'}
                </button>
              </div>
            </>
          )}
          {preview && (
            <section
              className="preparation-preview"
              aria-label="Kết quả kiểm tra nguồn"
              ref={resultElement}
              tabIndex={-1}
            >
              <span className="production-pilot-eyebrow">BƯỚC 3 · KẾT QUẢ KIỂM TRA</span>
              <h3>
                {preview.readyCount} listing đủ nguồn · {preview.blockedCount} cần bổ sung
              </h3>
              {!saved && preview.readyCount > 0 && <div className="preparation-next-step">
                <p>Kiểm tra xong. Bấm chuẩn bị đợt bên dưới; nút đăng ẩn qua API sẽ hiện ngay tại đây. Chưa gửi Shopee.</p>
                <button type="button" className="primary" disabled={busy} onClick={() => void register()}>
                  Chuẩn bị đợt cho {preview.readyCount} listing đủ nguồn
                </button>
              </div>}
              {preview.blockedCount > 0 && (
                <div className="preparation-next-step">
                  <strong>
                    {preview.readyCount === 0
                      ? 'Chưa có listing đủ điều kiện tạo đợt.'
                      : 'Có thể chuẩn bị phần đủ nguồn; phần còn thiếu được giữ lại.'}
                  </strong>
                  <p>
                    Mở từng mục bên dưới và bấm “Bổ sung…” để đến đúng ô cần điền. Sửa xong, bấm
                    Kiểm tra lại; không phải nhập lại nội dung, ảnh hay SKU.
                  </p>
                  {preview.entries.find((entry) => entry.kind === 'blocked' && entry.issues.length)
                    ?.issues[0] &&
                    (() => {
                      const first = preview.entries.find(
                        (entry) => entry.kind === 'blocked' && entry.issues.length,
                      )!;
                      const guidance = issueGuidance(first.issues[0]!);
                      return (
                        <button
                          type="button"
                          className="primary"
                          disabled={busy}
                          onClick={() => void fixIssue(first.productKey, guidance.target)}
                        >
                          Xử lý phần thiếu đầu tiên
                        </button>
                      );
                    })()}
                </div>
              )}
              <p className="preparation-target">
                <strong>
                  {preview.publicationMode === 'hidden_for_review'
                    ? 'Đăng ẩn để QC'
                    : preview.publicationMode === 'publish_after_verification'
                      ? 'Mở bán sau kiểm tra'
                      : 'Lô cũ · Tự mở bán sau đối chiếu'}
                </strong>
                <br />
                {preview.publicationMode === 'hidden_for_review'
                  ? 'Listing sẽ được giữ ẩn để bạn kiểm tra và mở bán riêng từng sản phẩm.'
                  : 'Listing sẽ tự mở bán sau khi đối chiếu dữ liệu đạt.'}{' '}
                Chế độ này được giữ cố định trong bản kiểm tra đã lưu.
              </p>
              {preview.imageQcPolicy === 'defer_image_qc' && (
                <p className="notice warning">
                  <strong>Ảnh chưa QC</strong> · Đã chọn tạm hoãn kiểm tra ảnh cho đợt đăng ẩn này.
                  Cần kiểm tra ảnh trước khi mở bán từng listing.
                </p>
              )}
              {preview.entries.map((entry) => (
                <details
                  key={entry.productKey}
                  open={
                    entry.kind === 'blocked' &&
                    (preview.entries.length <= 3 ||
                      entry === preview.entries.find((item) => item.kind === 'blocked'))
                  }
                >
                  <summary>
                    {entry.title} ·{' '}
                    {entry.kind === 'ready'
                      ? 'Đủ nguồn để chuẩn bị đợt'
                      : 'Cần bổ sung · ' + groupedIssues(entry.issues).length + ' mục'}
                  </summary>
                  {entry.issues?.length > 0 && (
                    <ul className="preparation-issue-list">
                      {groupedIssues(entry.issues).map((issue) => (
                        <li key={issue.label + ':' + issue.message}>
                          <div>
                            <strong>{issue.label}</strong>
                            <p>{issue.message}</p>
                            {issue.fields.length > 1 && (
                              <small>
                                {issue.fields.length} vị trí cần kiểm tra trong mục này.
                              </small>
                            )}
                          </div>
                          <button
                            type="button"
                            className="secondary"
                            disabled={busy}
                            onClick={() => void fixIssue(entry.productKey, issue.target)}
                          >
                            {issue.target
                              ? 'Bổ sung ' + issue.label.toLocaleLowerCase('vi-VN')
                              : 'Đối chiếu bộ nguồn'}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {entry.kind === 'ready' && (
                    <>
                      <p className="preparation-source-text">{entry.document.title}</p>
                      {entry.document.description.map((block: any, index: number) =>
                        block.type === 'text' ? (
                          <p className="preparation-source-text" key={index}>
                            {block.text}
                          </p>
                        ) : (
                          <img
                            key={index}
                            className="preparation-preview-image"
                            src={media(block.image.importId)}
                            alt={'Ảnh mô tả ' + (index + 1)}
                          />
                        ),
                      )}
                      <div className="preparation-table">
                        <table>
                          <thead>
                            <tr>
                              <th>SKU / Phân loại</th>
                              <th>Giá gốc</th>
                              <th>Tồn đăng bán</th>
                              <th>Cân nặng</th>
                            </tr>
                          </thead>
                          <tbody>
                            {entry.document.models.map((model: any) => (
                              <tr key={model.sku}>
                                <td>
                                  {model.sku}
                                  <small>{model.optionLabels.join(' / ')}</small>
                                </td>
                                <td>{Number(model.originalPrice).toLocaleString('vi-VN')} đ</td>
                                <td>{model.stock}</td>
                                <td>{model.weightGrams ?? entry.document.weightGrams} g</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <p>Giá lấy từ đúng ô nguồn; giá khuyến mại không tự được áp dụng.</p>
                    </>
                  )}
                  {entry.kind === 'ready' && (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => onSource(entry.productKey)}
                    >
                      Mở bộ nguồn
                    </button>
                  )}
                </details>
              ))}
              {saved ? (
                <p role="status" className="notice">
                  Đã chuẩn bị đợt. Bấm nút đăng qua API ngay bên dưới để gửi các listing đủ nguồn.
                  Bạn cũng có thể theo dõi lại tại “Đợt đang làm”. Chưa gửi Shopee.
                </p>
              ) : (
                <div className="preparation-result-actions">
                  {selected.length > 0 && (
                    <button
                      type="button"
                      className="secondary"
                      disabled={
                        busy || selected.some((key) => !editing[key] || editing[key]?.metadataBusy)
                      }
                      onClick={() => void inspect()}
                    >
                      Kiểm tra lại {selected.length} listing đã chọn
                    </button>
                  )}
                </div>
              )}
              {saved && (
                <PreparationRun key={preview.id} prepared={preview} targetScope={targetScope} onChanged={onRegistered} />
              )}
            </section>
          )}
        </>
      )}
    </section>
  );
}
