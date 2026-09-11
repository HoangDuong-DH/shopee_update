import { test, expect, type Page } from '@playwright/test';
import type { CatalogRow, WorkbookImport } from '@shopee/domain';

// Browser-only operational fixtures. These routes intercept every local API write;
// no fixture product, import, plan, job, or media reaches the database or Shopee.
const sourceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const source = {
  kind: 'product_file' as const,
  fileSha256: 'a'.repeat(64),
  locator: 'Browser fixture workbook',
  observedAt: '2026-09-11T00:00:00.000Z',
};
const fact = (value: string) => ({ value, confirmed: true, sources: [source] });
const catalogRows: CatalogRow[] = ['SKU-A', 'SKU-B'].map((sku, index) => ({
  key: sku + '-row',
  sheet: 'Bảng giá mẫu',
  row: index + 3,
  headerRow: 1,
  sku: fact(sku),
  name: fact('Tên trong bảng giá, không thay nhãn phân loại'),
  originalPrice: fact(index ? '24000' : '12000'),
  promotionTarget: fact(index ? '20000' : '10000'),
  issues: [],
}));
const workbook: WorkbookImport = {
  source,
  rows: catalogRows,
  issues: [],
  sheets: [{ name: 'Bảng giá mẫu', rowCount: 4, importedRows: 2, headerRows: [1] }],
};
const workbookRecord = {
  id: sourceId,
  filename: 'TEST FIXTURE · Giá đã chuẩn bị.xlsx',
  kind: 'xlsx',
  status: 'ready',
  sha256: source.fileSha256,
  bytes: 2048,
  createdAt: source.observedAt,
  message: '',
  body: workbook,
};

async function useIntakeFixture(page: Page) {
  const unexpectedWrites: string[] = [];
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      unexpectedWrites.push(request.method() + ' ' + pathname);
      await route.fulfill({ status: 503, json: { message: 'Fixture không gửi dữ liệu.' } });
      return;
    }
    if (pathname === '/v1/imports') return route.fulfill({ json: [workbookRecord] });
    if (pathname === '/v1/imports/' + sourceId) return route.fulfill({ json: workbookRecord });
    if (['/v1/products', '/v1/shops', '/v1/plans', '/v1/jobs'].includes(pathname))
      return route.fulfill({ json: [] });
    if (pathname === '/v1/status')
      return route.fulfill({ json: { worker: 'online', productionWrites: false } });
    return route.fulfill({ status: 404, json: { message: 'Ngoài phạm vi fixture.' } });
  });
  return unexpectedWrites;
}

async function openSourceStep(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Nhập listing có sẵn', exact: true }).click();
  await page.getByRole('button', { name: 'Nhập thủ công khi cần', exact: true }).click();
  await page.getByRole('combobox', { name: 'File bảng giá', exact: true }).selectOption(sourceId);
  await page
    .getByRole('combobox', { name: 'Trang tính chứa giá', exact: true })
    .selectOption('Bảng giá mẫu');
  await page.getByRole('combobox', { name: 'Bộ giá áp dụng', exact: true }).selectOption('null');
}

test('fixture: guides a two-tier listing through three steps and keeps exact supplied membership', async ({
  page,
}) => {
  const unexpectedWrites = await useIntakeFixture(page);
  await openSourceStep(page);
  await expect(page.getByRole('list', { name: 'Các bước nhập listing' })).toBeVisible();
  await expect(page.getByLabel('SKU dòng 1', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Tiếp tục: phân loại', exact: true }).click();
  await page.getByRole('radio', { name: /^Hai nhóm/ }).check();
  await page.getByLabel('Tên nhóm phân loại 1', { exact: true }).fill('Màu nguyên bản');
  await page.getByLabel('Tên nhóm phân loại 2', { exact: true }).fill('Quy cách');
  await page.getByLabel('SKU dòng 1', { exact: true }).fill('SKU-B');
  await page.getByLabel('Nhãn nhóm 1 dòng 1', { exact: true }).fill(' Đen  nguyên bản ');
  await page.getByLabel('Nhãn nhóm 2 dòng 1', { exact: true }).fill('  Gói 24 cái  ');
  await page.getByRole('button', { name: 'Thêm dòng SKU', exact: true }).click();
  await page.getByLabel('SKU dòng 2', { exact: true }).fill('SKU-A');
  await page.getByLabel('Nhãn nhóm 1 dòng 2', { exact: true }).fill('Trắng');
  await page.getByLabel('Nhãn nhóm 2 dòng 2', { exact: true }).fill('Gói 12 cái');
  await page.getByRole('button', { name: 'Quay lại', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'File bảng giá', exact: true })).toHaveValue(
    sourceId,
  );
  await expect(page.getByRole('combobox', { name: 'Bộ giá áp dụng', exact: true })).toHaveValue(
    'null',
  );
  await page.getByRole('button', { name: 'Tiếp tục: phân loại', exact: true }).click();
  await expect(page.getByLabel('SKU dòng 1', { exact: true })).toHaveValue('SKU-B');
  await expect(page.getByLabel('Nhãn nhóm 1 dòng 1', { exact: true })).toHaveValue(
    ' Đen  nguyên bản ',
  );
  await page.getByRole('button', { name: 'Tiếp tục: kiểm tra', exact: true }).click();
  const rows = page.getByRole('row').filter({ has: page.getByRole('cell') });
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('SKU-B');
  await expect(rows.nth(0)).toContainText('24.000');
  await expect(rows.nth(1)).toContainText('SKU-A');
  const continueButton = page.getByRole('button', {
    name: 'Tiếp tục: nội dung & ảnh',
    exact: true,
  });
  await expect(continueButton).toBeDisabled();
  await page
    .getByRole('checkbox', {
      name: 'Tôi đã kiểm tra đủ SKU, đúng tên và thứ tự phân loại của bộ listing này.',
      exact: true,
    })
    .check();
  await continueButton.click();
  await page.getByRole('tab', { name: /^SKU & phân loại/ }).click();
  await expect(page.locator('.variant-editor').first()).toContainText('SKU-B');
  await expect(page.locator('.variant-editor').first()).toContainText('24.000');
  await expect(page.getByLabel('Phân loại 1', { exact: true })).toHaveValue(' Đen  nguyên bản ');
  await expect(page.getByLabel('Phân loại 1 tầng 2', { exact: true })).toHaveValue(
    '  Gói 24 cái  ',
  );
  await expect(page.getByLabel('Phân loại 1', { exact: true })).not.toBeEditable();
  expect(unexpectedWrites).toEqual([]);
});

test('fixture: offers explicit recovery after refresh without silently restoring or discarding an intake', async ({
  page,
}) => {
  const unexpectedWrites = await useIntakeFixture(page);
  page.on('dialog', (dialog) => void dialog.accept());
  await openSourceStep(page);
  await page.getByRole('button', { name: 'Tiếp tục: phân loại', exact: true }).click();
  await page.getByRole('radio', { name: /^Một nhóm/ }).check();
  await page.getByLabel('Tên nhóm phân loại 1', { exact: true }).fill('Quy cách từ nguồn');
  await page.getByLabel('SKU dòng 1', { exact: true }).fill('SKU-A');
  await page.getByLabel('Nhãn nhóm 1 dòng 1', { exact: true }).fill('  Gói 12  cái ');
  await page.reload();
  await page.getByRole('button', { name: 'Nhập listing có sẵn', exact: true }).click();
  await page.getByRole('button', { name: 'Nhập thủ công khi cần', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Bạn có một bộ đang nhập dở', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('SKU dòng 1', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Tiếp tục phần đang nhập', exact: true }).click();
  await expect(page.getByLabel('SKU dòng 1', { exact: true })).toHaveValue('SKU-A');
  await expect(page.getByLabel('Nhãn nhóm 1 dòng 1', { exact: true })).toHaveValue(
    '  Gói 12  cái ',
  );
  await expect(page.getByLabel('Tên nhóm phân loại 1', { exact: true })).toHaveValue(
    'Quy cách từ nguồn',
  );
  expect(unexpectedWrites).toEqual([]);
});

test('fixture: Excel paste is optional and replacing already entered rows requires an explicit choice', async ({
  page,
}) => {
  const unexpectedWrites = await useIntakeFixture(page);
  await openSourceStep(page);
  await page.getByRole('button', { name: 'Tiếp tục: phân loại', exact: true }).click();
  await page.getByRole('radio', { name: /^Một nhóm/ }).check();
  await page.getByLabel('Tên nhóm phân loại 1', { exact: true }).fill('Quy cách');
  await page.getByLabel('SKU dòng 1', { exact: true }).fill('SKU-B');
  await page.getByLabel('Nhãn nhóm 1 dòng 1', { exact: true }).fill('Dữ liệu đang nhập');
  await page.getByText('Đã có bảng phân loại trong Excel? Dán nhiều dòng', { exact: true }).click();
  await page
    .getByLabel('Bảng SKU và phân loại đã chuẩn bị', { exact: true })
    .fill('SKU-A\t Gói  12 cái \nSKU-B\tGói 24 cái');
  await page.getByRole('button', { name: 'Đưa dữ liệu vào bảng', exact: true }).click();
  await expect(page.getByLabel('SKU dòng 1', { exact: true })).toHaveValue('SKU-B');
  await page.getByRole('button', { name: 'Thay bảng bằng dữ liệu đã dán', exact: true }).click();
  await expect(page.getByLabel('SKU dòng 1', { exact: true })).toHaveValue('SKU-A');
  await expect(page.getByLabel('Nhãn nhóm 1 dòng 1', { exact: true })).toHaveValue(' Gói  12 cái ');
  await expect(page.getByLabel('SKU dòng 2', { exact: true })).toHaveValue('SKU-B');
  expect(unexpectedWrites).toEqual([]);
});

test('fixture: retries only failed uploads and preserves the exact selected file bytes', async ({
  page,
}) => {
  const unexpectedWrites = await useIntakeFixture(page);
  const attempts: { name: string; bytes: string }[] = [];
  let rejectedOnce = false;
  await page.route('**/v1/imports', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const name = decodeURIComponent(route.request().headers()['x-file-name'] ?? '');
    attempts.push({ name, bytes: route.request().postDataBuffer()?.toString('base64') ?? '' });
    if (name === 'fixture-content.docx' && !rejectedOnce) {
      rejectedOnce = true;
      return route.fulfill({ status: 503, json: { code: 'SERVICE_UNAVAILABLE' } });
    }
    return route.fulfill({ status: 201, json: { id: sourceId, status: 'queued' } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Tệp nguồn', exact: true }).click();
  await page.getByLabel('Thêm tệp nguồn', { exact: true }).setInputFiles([
    { name: 'fixture-cover.png', mimeType: 'image/png', buffer: Buffer.from('cover-fixture') },
    {
      name: 'fixture-content.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: Buffer.from('original-word-fixture'),
    },
    { name: 'fixture-gallery.png', mimeType: 'image/png', buffer: Buffer.from('gallery-fixture') },
  ]);
  const rows = page.getByTestId('upload-file-row');
  await expect(rows).toHaveCount(3);
  await expect(rows.filter({ hasText: 'fixture-cover.png' })).toContainText('Đã nhận');
  await expect(rows.filter({ hasText: 'fixture-content.docx' })).toContainText('Chưa nhận');
  await expect(rows.filter({ hasText: 'fixture-gallery.png' })).toContainText('Đã nhận');
  expect(attempts.map((attempt) => attempt.name)).toEqual([
    'fixture-cover.png',
    'fixture-content.docx',
    'fixture-gallery.png',
  ]);
  await page.getByRole('button', { name: 'Thử lại 1 tệp chưa nhận', exact: true }).click();
  await expect(rows.filter({ hasText: 'fixture-content.docx' })).toContainText('Đã nhận');
  expect(attempts.map((attempt) => attempt.name)).toEqual([
    'fixture-cover.png',
    'fixture-content.docx',
    'fixture-gallery.png',
    'fixture-content.docx',
  ]);
  expect(attempts[3].bytes).toBe(attempts[1].bytes);
  expect(unexpectedWrites).toEqual([]);
});

test('fixture: returning from new content preserves supplied SKU membership while discarding only unsaved content', async ({
  page,
}) => {
  const unexpectedWrites = await useIntakeFixture(page);
  await openSourceStep(page);
  await page.getByRole('button', { name: 'Tiếp tục: phân loại', exact: true }).click();
  await page.getByRole('radio', { name: /^Không có phân loại/ }).check();
  await page.getByLabel('SKU dòng 1', { exact: true }).fill('SKU-A');
  await page.getByRole('button', { name: 'Tiếp tục: kiểm tra', exact: true }).click();
  await page
    .getByRole('checkbox', {
      name: 'Tôi đã kiểm tra đủ SKU, đúng tên và thứ tự phân loại của bộ listing này.',
      exact: true,
    })
    .check();
  await page.getByRole('button', { name: 'Tiếp tục: nội dung & ảnh', exact: true }).click();
  await page
    .getByLabel('Tiêu đề listing', { exact: true })
    .fill('TEST FIXTURE · Phần nội dung sẽ bỏ');
  await page.getByRole('button', { name: 'Quay lại', exact: true }).first().click();
  const dialog = page.getByRole('alertdialog', { name: 'Thay đổi chưa lưu', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Bỏ thay đổi và rời đi', exact: true }).click();
  await page.getByRole('button', { name: 'Tiếp tục phần đang nhập', exact: true }).click();
  await expect(page.getByLabel('SKU dòng 1', { exact: true })).toHaveValue('SKU-A');
  await expect(page.getByRole('radio', { name: /^Không có phân loại/ })).toBeChecked();
  await page.getByRole('button', { name: 'Tiếp tục: kiểm tra', exact: true }).click();
  await page
    .getByRole('checkbox', {
      name: 'Tôi đã kiểm tra đủ SKU, đúng tên và thứ tự phân loại của bộ listing này.',
      exact: true,
    })
    .check();
  await page.getByRole('button', { name: 'Tiếp tục: nội dung & ảnh', exact: true }).click();
  await expect(page.getByLabel('Tiêu đề listing', { exact: true })).toHaveValue('');
  expect(unexpectedWrites).toEqual([]);
});
