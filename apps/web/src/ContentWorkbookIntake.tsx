import { useEffect, useRef, useState } from 'react';
import type {
  ContentWorkbookInventory,
  ContentMapping,
  ContentRow,
  ContentSelection,
} from '../../../packages/domain/src/content-workbook.js';
import { api, post, type ImportRecord } from './api.js';
import { matchContentRows } from './content-workbook-match.js';
const roles = ['stt', 'title', 'headline', 'body'] as const;
const labels = {
  stt: 'STT',
  title: 'Tiêu đề',
  headline: 'Câu mở đầu (tùy chọn)',
  body: 'Nội dung sau ảnh',
};
export function ContentWorkbookIntake({
  groups,
  value,
  onChange,
  locked,
}: {
  groups: { key: string; name: string }[];
  value: Record<string, ContentSelection>;
  onChange: (v: Record<string, ContentSelection>) => void;
  locked: boolean;
}) {
  const [importId, setImportId] = useState(
    () => Object.values(value)[0]?.binding.mapping.importId ?? '',
  );
  const [inventory, setInventory] = useState<ContentWorkbookInventory | null>(null);
  const [headerRow, setHeaderRow] = useState('1'),
    [sheet, setSheet] = useState('');
  const [columns, setColumns] = useState<Record<string, string>>({});
  const [rows, setRows] = useState<ContentRow[]>([]),
    [choices, setChoices] = useState<Record<string, string>>({});
  const [issues, setIssues] = useState<string[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  useEffect(() => {
    generation.current++;
    setRows([]);
    setChoices({});
    setBusy(false);
  }, [JSON.stringify(groups.map((g) => g.key))]);
  function invalidate() {
    generation.current++;
    setRows([]);
    setChoices({});
    setIssues([]);
    setError('');
  }
  async function inspect(id = importId) {
    if (!id) return;
    const run = ++generation.current;
    setBusy(true);
    setError('');
    setRows([]);
    setChoices({});
    try {
      const result = await api<ContentWorkbookInventory>(
        `/v1/content-workbooks/${id}?headerRow=${Number(headerRow)}`,
      );
      if (run !== generation.current) return;
      setInventory(result);
      setSheet('');
      setColumns({});
    } catch (e) {
      if (run === generation.current)
        setError(e instanceof Error ? e.message : 'Chưa đọc được Excel.');
    } finally {
      if (run === generation.current) setBusy(false);
    }
  }
  async function upload(file?: File) {
    if (!file) return;
    if (!/\.xlsx$/i.test(file.name) || file.size > 16 * 1024 * 1024) {
      setError('Chọn Excel .xlsx tối đa 16 MB.');
      return;
    }
    const run = ++generation.current;
    setBusy(true);
    setError('');
    setRows([]);
    setChoices({});
    try {
      const item = await api<ImportRecord>('/v1/imports', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-File-Name': encodeURIComponent(file.name),
        },
        body: file,
      });
      if (run !== generation.current) return;
      setImportId(item.id);
      await inspect(item.id);
    } catch (e) {
      if (run === generation.current) {
        setError(e instanceof Error ? e.message : 'Chưa nhập được Excel.');
        setBusy(false);
      }
    }
  }
  const selected = inventory?.sheets.find((s) => s.name === sheet),
    headers = selected?.preview.find((r) => r.row === Number(headerRow))?.cells ?? [];
  async function readRows() {
    if (!inventory) return;
    const mapping = {
      importId: inventory.importId,
      sha256: inventory.sha256,
      sheet,
      headerRow: Number(headerRow),
      columns: Object.fromEntries(Object.entries(columns).filter(([, v]) => v)),
      headers: Object.fromEntries(
        Object.entries(columns)
          .filter(([, v]) => v)
          .map(([role, col]) => [role, headers.find((c) => c.column === col)?.text ?? '']),
      ),
    } as ContentMapping;
    const run = ++generation.current;
    setBusy(true);
    setError('');
    setRows([]);
    setChoices({});
    try {
      const result = await post<{ rows: ContentRow[] }>('/v1/content-workbooks/rows', mapping);
      if (run !== generation.current) return;
      setRows(result.rows);
      const matched = matchContentRows(groups, result.rows);
      setChoices(
        Object.fromEntries(
          Object.entries(matched.selections).map(([key, row]) => [key, String(row.binding.row)]),
        ),
      );
      setIssues(matched.issues);
    } catch (e) {
      if (run === generation.current)
        setError(e instanceof Error ? e.message : 'Chưa đọc được dòng.');
    } finally {
      if (run === generation.current) setBusy(false);
    }
  }
  function apply() {
    const next = { ...value };
    for (const group of groups) {
      const row = rows.find((r) => String(r.binding.row) === choices[group.key]);
      if (row && !row.issues.length) {
        const { issues: _, ...selection } = row;
        next[group.key] = selection;
      }
    }
    onChange(next);
  }
  const disabled = locked || busy;
  return (
    <details className="folder-exceptions">
      <summary>Nội dung từ Excel — ghép cùng lúc theo STT</summary>
      <p>
        Chọn chính xác sheet, dòng tiêu đề và cột. Bảng này chỉ lấy nội dung; SKU và giá vẫn lấy từ
        bảng giá riêng. Công thức chỉ đọc giá trị Excel đã lưu, không tính lại.
      </p>
      <label>
        Excel nội dung
        <input
          aria-label="Chọn Excel nội dung"
          type="file"
          accept=".xlsx"
          disabled={disabled}
          onChange={(e) => {
            void upload(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </label>
      <label>
        Dòng tiêu đề
        <input
          aria-label="Dòng tiêu đề Excel nội dung"
          type="number"
          min="1"
          max="100"
          value={headerRow}
          disabled={disabled}
          onChange={(e) => {
            invalidate();
            setInventory(null);
            setHeaderRow(e.target.value);
          }}
        />
      </label>
      <button disabled={disabled || !importId} onClick={() => void inspect()}>
        Đọc bảng nội dung
      </button>
      {inventory && (
        <>
          <p>
            {inventory.filename} · Tệp nội dung đã đọc. Trạng thái bộ đọc giá riêng:{' '}
            {inventory.priceParserStatus}.
          </p>
          <label>
            Sheet nội dung
            <select
              aria-label="Sheet nội dung"
              disabled={disabled}
              value={sheet}
              onChange={(e) => {
                invalidate();
                setSheet(e.target.value);
                setColumns({});
              }}
            >
              <option value="">Chọn sheet</option>
              {inventory.sheets.map((s) => (
                <option key={s.name}>{s.name}</option>
              ))}
            </select>
          </label>
          {sheet && (
            <>
              <table>
                <caption>Các dòng đầu từ đúng sheet đã chọn</caption>
                <tbody>
                  {selected?.preview.map((r) => (
                    <tr key={r.row}>
                      <th>Dòng {r.row}</th>
                      {r.cells.map((c) => (
                        <td key={c.column}>
                          {c.column}: {c.issue ?? c.text}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {roles.map((role) => (
                <label key={role}>
                  {labels[role]}
                  <select
                    aria-label={'Cột ' + labels[role]}
                    disabled={disabled}
                    value={columns[role] ?? ''}
                    onChange={(e) => {
                      invalidate();
                      setColumns({ ...columns, [role]: e.target.value });
                    }}
                  >
                    <option value="">{role === 'headline' ? 'Không dùng' : 'Chọn cột'}</option>
                    {headers
                      .filter((c) => c.text && !c.issue)
                      .map((c) => (
                        <option key={c.column} value={c.column}>
                          {c.column} — {c.text}
                        </option>
                      ))}
                  </select>
                </label>
              ))}
              <button
                disabled={disabled || !columns.stt || !columns.title || !columns.body}
                onClick={() => void readRows()}
              >
                Xem ghép nội dung cho cả lô
              </button>
            </>
          )}
        </>
      )}
      {rows.length > 0 && (
        <>
          <p>
            Đối chiếu tên sản phẩm trước khi áp dụng. STT trùng hoặc thiếu không tự chọn; có thể
            chọn dòng riêng từng bộ. Bộ có hồ sơ nguồn riêng không bị thay đổi.
          </p>
          {issues.map((issue, i) => (
            <p key={i}>{issue}</p>
          ))}
          {groups.map((group) => (
            <label key={group.key}>
              {group.name}
              <select
                aria-label={'Dòng nội dung ' + group.name}
                value={choices[group.key] ?? ''}
                disabled={disabled}
                onChange={(e) => setChoices({ ...choices, [group.key]: e.target.value })}
              >
                <option value="">Chưa gán — giữ lựa chọn đã lưu nếu có</option>
                {rows.map((row) => (
                  <option
                    key={row.binding.row}
                    value={row.binding.row}
                    disabled={!!row.issues.length}
                  >
                    Dòng {row.binding.row} · STT {row.binding.stt}: {row.title.slice(0, 150)}
                    {row.issues.length ? ' — ' + row.issues.join('; ') : ''}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <button disabled={disabled || !Object.values(choices).some(Boolean)} onClick={apply}>
            Áp dụng nội dung các bộ đã chọn
          </button>
        </>
      )}
      {Object.keys(value).length > 0 && (
        <p>
          Đã gắn nội dung: {Object.keys(value).length} bộ.{' '}
          {groups
            .filter((g) => value[g.key])
            .map((g) => (
              <span key={g.key}>
                {g.name}: {value[g.key]!.binding.mapping.sheet}, dòng {value[g.key]!.binding.row}{' '}
                <button
                  disabled={disabled}
                  onClick={() => {
                    const next = { ...value };
                    delete next[g.key];
                    onChange(next);
                  }}
                >
                  Bỏ gán nội dung Excel
                </button>{' '}
              </span>
            ))}
        </p>
      )}
      {busy && <p role="status">Đang đọc nội dung…</p>}
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
