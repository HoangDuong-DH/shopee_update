import { useEffect, useRef, useState } from 'react';
import type { PendingListingMapping } from '../../../packages/domain/src/pending-listing-mapping.js';
import {
  isMissingPendingSku,
  pendingSelectedVariationImage,
} from '../../../packages/domain/src/pending-listing-mapping.js';
import type { EditorSeed } from './Editor.js';
import { media } from './api.js';
import {
  applyPendingImageChoices,
  pendingImageChoices,
  pendingImageDesign,
  selectPendingImage,
  type PendingImageContext,
  pendingSlotSku,
  readPendingListingMapping,
  resolvePendingListingMapping,
  updatePendingSku,
  type PendingPriceSource,
} from './pending-listing-mapping.js';

export type PendingMappingFile = {
  relativePath: string;
  name: string;
  size: number;
  sha256: string;
};
export function PendingSkuMapping({
  groupKey,
  value,
  onImport,
  onChange,
  priceSource,
  imageContext,
  onContinue,
  disabled = false,
  saved = true,
}: {
  groupKey: string;
  value?: PendingListingMapping;
  onImport: (mapping: PendingListingMapping, file: PendingMappingFile) => void;
  onChange: (mapping: PendingListingMapping) => void;
  priceSource?: PendingPriceSource;
  imageContext?: PendingImageContext;
  onContinue?: (seed: EditorSeed, variants: { sku: string; originalPrice?: string }[]) => void;
  disabled?: boolean;
  saved?: boolean;
}) {
  const [error, setError] = useState(''),
    [reading, setReading] = useState(false),
    [design, setDesign] = useState('');
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    setReading(false);
    setError('');
    setDesign('');
    return () => {
      generation.current += 1;
    };
  }, [groupKey]);
  async function read(file?: File) {
    if (!file || disabled || reading) return;
    const request = ++generation.current;
    setReading(true);
    setError('');
    try {
      if (file.name !== 'listing-mapping.pending.json' || file.size > 5_000_000)
        throw new Error('Chọn đúng hồ sơ listing-mapping.pending.json, tối đa 5 MB.');
      const bytes = await file.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const sha256 = Array.from(new Uint8Array(digest), (b) =>
        b.toString(16).padStart(2, '0'),
      ).join('');
      const relativePath = groupKey + '/' + file.name;
      const mapping = readPendingListingMapping(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        { relativePath, sha256 },
      );
      if (request !== generation.current) return;
      if (
        value &&
        (value.sha256 !== sha256 || value.document.sourceKey !== mapping.document.sourceKey)
      )
        throw new Error(
          'Hồ sơ khác bản đang bổ sung. Giữ nguyên các ô đã nhập; mở đúng bộ nguồn để đối chiếu.',
        );
      onImport(value ?? mapping, { relativePath, name: file.name, size: file.size, sha256 });
    } catch (cause) {
      if (request === generation.current)
        setError(
          cause instanceof Error && !cause.message.startsWith('PENDING_')
            ? cause.message
            : 'Hồ sơ phân loại chưa hợp lệ. Kiểm tra bản nguồn; chưa thay phần đang nhập.',
        );
    } finally {
      if (request === generation.current) setReading(false);
    }
  }
  const result = value ? resolvePendingListingMapping(value, priceSource, imageContext) : undefined;
  const missing =
    value?.document.slots.filter((s) => isMissingPendingSku(pendingSlotSku(value, s.slotId)))
      .length ?? 0;
  const imageRows =
    value?.document.slots.map((slot) => ({
      slot,
      selected: pendingSelectedVariationImage(value, slot.slotId),
      choices: pendingImageChoices(value, slot.slotId, imageContext),
    })) ?? [];
  const hasImageHints = imageRows.some((row) => row.choices.length);
  const selectedImages = imageRows.filter(
    (row) =>
      row.selected &&
      row.choices.some(
        (choice) =>
          choice.importId &&
          !choice.issue &&
          choice.candidate.path === row.selected?.path &&
          choice.candidate.sha256 === row.selected?.sha256,
      ),
  ).length;
  const designs = [
    ...new Set(
      imageRows.flatMap((row) =>
        row.choices
          .map((choice) => pendingImageDesign(choice.candidate))
          .filter((entry): entry is string => !!entry),
      ),
    ),
  ];
  const fillable = imageRows.filter(
    (row) =>
      !row.selected &&
      row.choices.filter(
        (choice) =>
          choice.importId &&
          !choice.issue &&
          (!design || pendingImageDesign(choice.candidate) === design),
      ).length === 1,
  ).length;
  return (
    <section className="panel pending-sku-mapping" aria-label="Bảng phân loại chờ hoàn thiện">
      <h3>Bảng phân loại chờ hoàn thiện</h3>
      {!value ? (
        <>
          <p>Nhận hồ sơ để giữ tên phân loại và bổ sung SKU vào đúng từng ô.</p>
          <label>
            Chọn hồ sơ phân loại
            <input
              type="file"
              accept=".json,application/json"
              disabled={disabled || reading}
              onChange={(event) => {
                void read(event.currentTarget.files?.[0]);
                event.currentTarget.value = '';
              }}
            />
          </label>
        </>
      ) : (
        <>
          <p>
            <strong>{value.document.title}</strong>
          </p>
          <p>
            {value.document.slots.length} phân loại ·{' '}
            {missing ? `Còn ${missing} ô CHƯA CÓ SKU` : 'Đã điền SKU, cần đối chiếu bảng giá'}
          </p>
          <p>
            Nhãn và thứ tự được giữ theo hồ sơ. Bạn có thể để trống và bổ sung dần; phần này chưa
            gửi lên Shopee.
          </p>
          {!hasImageHints && (
            <p className="caption">
              Hồ sơ chưa có ảnh phân loại đã khớp. Bạn có thể bổ sung ảnh trong màn hoàn thiện; ứng
              dụng không ghép ảnh theo số thứ tự.
            </p>
          )}
          {hasImageHints && (
            <section aria-label="Ảnh phân loại từ hồ sơ">
              <h4>Ảnh phân loại</h4>
              <p role="status">
                Đã gắn {selectedImages}/{imageRows.length} ảnh theo SKU trong hồ sơ.
              </p>
              <p className="caption">
                Ảnh đi theo đúng mùi và dung tích đã khớp, không theo số thứ tự tên tệp. Giữ nguyên
                ảnh bạn đã chọn.
              </p>
              {designs.length > 1 && (
                <label>
                  Bộ thiết kế dùng để điền ảnh
                  <select
                    value={design}
                    disabled={disabled || reading}
                    onChange={(event) => setDesign(event.currentTarget.value)}
                  >
                    <option value="">Chỉ điền các ảnh khớp duy nhất</option>
                    {designs.map((entry) => (
                      <option key={entry} value={entry}>
                        {entry}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <button
                type="button"
                disabled={disabled || reading || !fillable || !imageContext}
                onClick={() => {
                  if (imageContext && !disabled && !reading) {
                    onChange(applyPendingImageChoices(value, imageContext, design || undefined));
                    setError('');
                  }
                }}
              >
                Dùng ảnh đã khớp{fillable ? ` cho ${fillable} phân loại` : ''}
              </button>
              {selectedImages < imageRows.length && (
                <p className="caption">
                  Còn {imageRows.length - selectedImages} phân loại chưa có ảnh hợp lệ. Xem từng
                  dòng: chọn bộ thiết kế nếu có nhiều ảnh; ảnh thiếu cần bổ sung trong màn hoàn
                  thiện.
                </p>
              )}
            </section>
          )}
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  {value.document.tiers.map((t) => (
                    <th key={t.ordinal}>{t.literalHeading}</th>
                  ))}
                  <th>SKU thật</th>
                  <th>Trạng thái</th>
                  {hasImageHints && <th>Ảnh phân loại</th>}
                </tr>
              </thead>
              <tbody>
                {value.document.slots.map((slot, i) => {
                  const sku = pendingSlotSku(value, slot.slotId);
                  const row = result?.rows.find((r) => r.line === i + 1);
                  const imageRow = imageRows[i]!;
                  const selectedChoice = imageRow.choices.find(
                    (choice) => choice.candidate.path === imageRow.selected?.path,
                  );
                  return (
                    <tr key={slot.slotId}>
                      {slot.optionLabels.map((label, index) => (
                        <td key={index}>{label}</td>
                      ))}
                      <td>
                        <input
                          aria-label={`SKU ${slot.optionLabels.join(' / ') || 'sản phẩm'}`}
                          value={sku ?? ''}
                          placeholder="CHƯA CÓ SKU"
                          disabled={disabled || reading}
                          maxLength={500}
                          onChange={(event) => {
                            try {
                              onChange(
                                updatePendingSku(value, slot.slotId, event.currentTarget.value),
                              );
                              setError('');
                            } catch {
                              setError('Mỗi ô nhận một mã SKU; không dán nhiều dòng vào một ô.');
                            }
                          }}
                        />
                      </td>
                      <td>
                        {isMissingPendingSku(sku)
                          ? 'CHƯA CÓ SKU'
                          : row
                            ? 'Đã khớp dòng giá'
                            : 'Chờ đối chiếu'}
                      </td>
                      {hasImageHints && (
                        <td>
                          {selectedChoice?.importId && !selectedChoice.issue && (
                            <img
                              src={media(selectedChoice.importId)}
                              alt={`Ảnh ${slot.optionLabels.join(' / ')}`}
                              width={56}
                              height={56}
                              style={{ objectFit: 'contain' }}
                            />
                          )}
                          <select
                            aria-label={`Ảnh phân loại ${slot.optionLabels.join(' / ') || 'sản phẩm'}`}
                            value={imageRow.selected?.path ?? ''}
                            disabled={disabled || reading}
                            style={{ maxWidth: '18rem' }}
                            onChange={(event) => {
                              try {
                                onChange(
                                  selectPendingImage(
                                    value,
                                    slot.slotId,
                                    event.currentTarget.value,
                                    imageContext,
                                  ),
                                );
                                setError('');
                              } catch {
                                setError(
                                  'Ảnh chưa khớp đúng tệp và SKU nguồn. Kiểm tra lại trước khi chọn.',
                                );
                              }
                            }}
                          >
                            <option value="">Chưa chọn ảnh</option>
                            {imageRow.choices.map((choice) => (
                              <option
                                key={choice.candidate.path}
                                value={choice.candidate.path}
                                disabled={!!choice.issue}
                              >
                                {choice.candidate.path}
                                {choice.issue ? ' · Cần đối chiếu' : ''}
                              </option>
                            ))}
                          </select>
                          <p className="caption">
                            {selectedChoice?.issue ??
                              (imageRow.selected
                                ? 'Đã khớp tệp và SKU nguồn'
                                : !imageRow.choices.length
                                  ? 'Hồ sơ chưa có ảnh khớp; bổ sung trong màn hoàn thiện.'
                                  : imageRow.choices.every((choice) => choice.issue)
                                    ? imageRow.choices[0]!.issue
                                    : imageRow.choices.filter((choice) => !choice.issue).length > 1
                                      ? 'Có nhiều ảnh: chọn bộ thiết kế hoặc một ảnh.'
                                      : 'Có ảnh khớp: bấm “Dùng ảnh đã khớp”.')}
                          </p>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <label>
            <input
              type="checkbox"
              checked={value.structureConfirmed}
              disabled={disabled || reading}
              onChange={(event) =>
                onChange({ ...value, structureConfirmed: event.currentTarget.checked })
              }
            />
            Dùng đủ {value.document.slots.length} phân loại trong bảng này
          </label>
          {result?.issues.length ? (
            <p role="status">
              {result.issues[0].message}
              {result.issues.length > 1
                ? ` Còn ${result.issues.length - 1} điểm cần hoàn thiện.`
                : ''}
            </p>
          ) : (
            <p role="status">SKU và giá đã khớp bảng giá đang chọn.</p>
          )}
          {!saved && <p role="status">Đang lưu phần bổ sung; chờ lưu xong trước khi tiếp tục.</p>}
          {onContinue && (
            <button
              disabled={disabled || reading || !saved || !result?.seed}
              onClick={() => {
                if (!disabled && !reading && saved && result?.seed)
                  onContinue(
                    result.seed,
                    result.rows.map((r) => ({
                      sku: r.sku,
                      originalPrice: r.row.originalPrice?.value,
                    })),
                  );
              }}
            >
              Xem và hoàn thiện nội dung
            </button>
          )}
        </>
      )}
      {reading && <p role="status">Đang đọc hồ sơ…</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
