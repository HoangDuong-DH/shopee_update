import { test, expect, type Page } from '@playwright/test';
import type { CatalogRow, Fact, SourceRef, WorkbookImport } from '@shopee/domain';
import { openInputLibrary } from './workspace-navigation.js';

// UI fixtures only: all API reads are intercepted; any write is rejected.
// Prices/facts here are authored test data, not extracted business values.
const importId = '94bb43ae-7828-4444-b77a-0314de0200cb';
const sheetName = 'TINH DẦU';
const source: SourceRef = {
  kind: 'product_file',
  filename: 'DORIS · UI fixture.xlsx',
  fileSha256: 'd'.repeat(64),
  observedAt: '2026-09-14T10:00:00.000Z',
  locator: 'Workbook fixture',
};
function fact(value: string, cell: string): Fact<string> {
  return { value, confirmed: true, sources: [{ ...source, locator: `${sheetName}!${cell}` }] };
}
const rows: CatalogRow[] = [
  { name: 'SHOP MALL', original: '120000', target: '60000', col: 'J' },
  { name: 'SHOP THƯỜNG', original: undefined, target: undefined, col: 'L' },
  { name: 'SHOP THƯỜNG · GIÁ ĐẶC BIỆT', original: '0', target: '0', col: 'N' },
].map((profile, index) => ({
  key: 'same-sku-profile-' + index,
  sheet: sheetName,
  row: 8,
  headerRow: 2,
  priceProfile: profile.name,
  sku: fact('0007-TD', 'C8'),
  name: fact('Tinh dầu · giữ nguyên tên nguồn', 'D8'),
  brand: fact('DORIS\nNhãn từ bảng nguồn', 'A8'),
  category: fact('Tinh dầu thiên nhiên', 'E8'),
  unitOfMeasure: fact('Chai 10 ml', 'F8'),
  sourceHeaders: {
    originalPrice: fact('GIÁ GỐC\n' + profile.name, profile.col + '2'),
    promotionTarget: fact('GIÁ BÁN', profile.col + '3'),
    unitOfMeasure: fact('ĐVT', 'F2'),
  },
  physicalWeightGrams: fact('55', 'G8'),
  declaredWeightGrams: fact('100', 'H8'),
  originalPrice:
    profile.original === undefined ? undefined : fact(profile.original, profile.col + '8'),
  promotionTarget:
    profile.target === undefined ? undefined : fact(profile.target, profile.col + '9'),
  issues:
    profile.original === undefined
      ? [
          {
            code: 'MISSING_ORIGINAL_PRICE',
            severity: 'block',
            field: 'originalPrice',
            message: 'Bộ giá Shop thường để trống; chưa có giá nguồn.',
            sources: [{ ...source, locator: `${sheetName}!L8` }],
          },
        ]
      : [],
}));
const workbook: WorkbookImport = {
  source,
  rows,
  sheets: [{ name: sheetName, rowCount: 9, importedRows: 3, headerRows: [2] }],
  issues: [
    {
      code: 'HIDDEN_SHEET',
      severity: 'warn',
      field: 'sheet',
      message: 'Trang nguồn ẩn được giữ để đối chiếu; chưa xác nhận bộ giá đang áp dụng.',
      sources: [{ ...source, locator: 'Nguồn ẩn!A1' }],
    },
  ],
};
async function setup(page: Page) {
  const writes: string[] = [];
  const record = {
    id: importId,
    filename: source.filename!,
    sha256: source.fileSha256,
    kind: 'xlsx',
    status: 'ready',
    bytes: 1234,
    createdAt: source.observedAt,
    message: '',
    body: workbook,
  };
  await page.route('**/v1/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      writes.push(request.method() + ' ' + path);
      return route.fulfill({ status: 409, json: { code: 'FIXTURE_WRITE_FORBIDDEN' } });
    }
    if (path === '/v1/imports') return route.fulfill({ json: [record] });
    if (path === '/v1/imports/' + importId) return route.fulfill({ json: record });
    if (path === '/v1/input-library')
      return route.fulfill({
        json: {
          priceBooks: [
            {
              id: importId,
              filename: record.filename,
              status: 'ready',
              createdAt: source.observedAt,
              bytes: 1234,
              rowCount: 3,
              sheetCount: 1,
              issueCount: 2,
            },
          ],
          batches: [],
          unassigned: [],
        },
      });
    if (path === '/v1/status')
      return route.fulfill({ json: { worker: 'online', productionWrites: false } });
    return route.fulfill({ json: [] });
  });
  await page.goto('/');
  await openInputLibrary(page);
  await page.getByRole('tab', { name: /^Bảng giá chung/ }).click();
  await page
    .getByTestId('price-book-row')
    .getByRole('button', { name: 'Tra giá', exact: true })
    .click();
  await expect(page.getByRole('region', { name: 'Nội dung bảng giá' })).toBeVisible();
  return writes;
}

test('UI fixture: keeps three price profiles separate; missing ordinary price stays blank and explicit zero stays zero', async ({
  page,
}) => {
  const writes = await setup(page);
  await expect(page.getByTestId('price-book-row')).toContainText(
    'Có mục cần đối chiếu theo bộ giá',
  );
  const table = page.getByRole('region', { name: 'Nội dung bảng giá' }).locator('tbody');
  await expect(table.locator('tr')).toHaveCount(3);
  const profile = page.getByLabel('Bộ giá để tra', { exact: true });
  await expect(profile.locator('option')).toHaveText([
    'Tất cả bộ giá',
    'SHOP MALL',
    'SHOP THƯỜNG',
    'SHOP THƯỜNG · GIÁ ĐẶC BIỆT',
  ]);
  await profile.selectOption(JSON.stringify('SHOP THƯỜNG'));
  await expect(table.locator('tr')).toHaveCount(1);
  await expect(table.locator('td').nth(2)).toHaveText('—');
  await expect(table.locator('td').nth(3)).toHaveText('—');
  await expect(table).not.toContainText('120.000');
  await profile.selectOption(JSON.stringify('SHOP THƯỜNG · GIÁ ĐẶC BIỆT'));
  await expect(table.locator('td').nth(2)).toHaveText('0 ₫');
  await expect(table.locator('td').nth(3)).toHaveText('0 ₫');
  await profile.selectOption(JSON.stringify('SHOP MALL'));
  await expect(table.locator('td').nth(2)).toHaveText('120.000 ₫');
  await expect(page.getByText(workbook.issues[0]!.message, { exact: true })).toBeVisible();
  expect(writes).toEqual([]);
});

test('UI fixture: source facts stay verbatim, weights remain separate and exact evidence is available by keyboard', async ({
  page,
}, info) => {
  const writes = await setup(page);
  await page.getByLabel('Bộ giá để tra', { exact: true }).selectOption(JSON.stringify('SHOP MALL'));
  const detail = page.getByTestId('price-source-details');
  const summary = detail.locator('summary');
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(detail).toHaveAttribute('open', '');
  expect(await detail.getByTestId('source-fact-brand').textContent()).toBe(
    'DORIS\nNhãn từ bảng nguồn',
  );
  await expect(detail).toContainText('Tinh dầu thiên nhiên');
  await expect(detail).toContainText('Chai 10 ml');
  await expect(detail.getByTestId('source-fact-physicalWeightGrams')).toHaveText('55');
  await expect(detail.getByTestId('source-fact-declaredWeightGrams')).toHaveText('100');
  for (const cell of ['A8', 'E8', 'F8', 'G8', 'H8', 'J8'])
    await expect(detail).toContainText(`${sheetName}!${cell}`);
  await expect(detail).toContainText(source.filename!);
  expect(await detail.getByTestId('source-header-originalPrice').textContent()).toBe(
    'GIÁ GỐC\nSHOP MALL',
  );
  await expect(detail).toContainText('TINH DẦU!J2');
  await expect(detail).toContainText('TINH DẦU!F2');
  await expect(detail.getByRole('textbox')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('source-facts-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('source-facts-mobile.png'), fullPage: true });
  await detail.getByTestId('source-fact-declaredWeightGrams').scrollIntoViewIfNeeded();
  await expect(detail.getByTestId('source-fact-physicalWeightGrams')).toBeVisible();
  await expect(detail.getByTestId('source-fact-declaredWeightGrams')).toBeVisible();
  await detail.getByTestId('source-header-originalPrice').scrollIntoViewIfNeeded();
  await expect(detail.getByTestId('source-header-originalPrice')).toBeVisible();
  await page.screenshot({
    path: info.outputPath('source-price-provenance-mobile.png'),
    fullPage: true,
  });
  expect(writes).toEqual([]);
});
