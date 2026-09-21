import { test, expect, type Page } from '@playwright/test';
import { fork, type ChildProcess, type ForkOptions } from 'node:child_process';
import { resolve } from 'node:path';
import ExcelJS from 'exceljs';
import sharp from 'sharp';
import { strToU8, zipSync } from 'fflate';

let server: ChildProcess, baseURL: string;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  let ready = false;
  const options: ForkOptions & { windowsHide: boolean } = {
    execArgv: ['--conditions=development', '--import', 'tsx'],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
    env: { ...process.env, TSX_TSCONFIG_PATH: resolve('apps/api/tsconfig.json') },
  };
  server = fork(resolve('tests/e2e/import-patch-server.mts'), [], options);
  baseURL = await new Promise<string>((done, fail) => {
    const timer = setTimeout(() => fail(new Error('Isolated browser server did not start')), 60000);
    server.on('message', (message: any) => {
      if (message.ready) {
        ready = true;
        clearTimeout(timer);
        done(message.baseURL);
      } else if (message.error) {
        clearTimeout(timer);
        fail(new Error(message.error));
      }
    });
    server.on('exit', (code, signal) => {
      if (!ready) {
        clearTimeout(timer);
        fail(
          new Error(`Isolated browser server exited before ready: code=${code}, signal=${signal}`),
        );
      }
    });
    server.stderr?.on('data', (data) => process.stderr.write(data));
  });
});
test.afterAll(async () => {
  if (!server) return;
  if (server.exitCode !== null || server.signalCode !== null)
    throw new Error(
      `Isolated browser server exited unexpectedly before cleanup: code=${server.exitCode}, signal=${server.signalCode}`,
    );
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => {
      server.kill();
      fail(new Error('Isolated fixture shutdown exceeded 25 seconds.'));
    }, 25000);
    server.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && signal === null) done();
      else fail(new Error(`Isolated fixture cleanup failed: code=${code}, signal=${signal}`));
    });
    server.send('stop');
  });
});
async function openIntake(page: Page) {
  await page.goto(baseURL);
  await page.getByRole('button', { name: 'Nhập bộ cập nhật', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Nhập bộ cập nhật', exact: true })).toBeVisible();
  await page.getByLabel('Chọn công việc Bộ mẫu nhập cập nhật').check();
}
async function excel(name: string, headers: string[], rows: unknown[][]) {
  const book = new ExcelJS.Workbook(),
    sheet = book.addWorksheet('Cập nhật');
  sheet.addRow(headers);
  rows.forEach((row) => sheet.addRow(row));
  return {
    name,
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from(await book.xlsx.writeBuffer()),
  };
}
async function preview(page: Page) {
  await page.getByRole('button', { name: 'Xem thay đổi', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Kiểm tra thay đổi', exact: true })).toBeVisible();
}
function word(name: string) {
  const document =
    '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Mở đầu theo Word.</w:t></w:r></w:p><w:p><w:r><w:t>Nội dung theo Word.</w:t></w:r></w:p></w:body></w:document>';
  return {
    name,
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: Buffer.from(zipSync({ 'word/document.xml': strToU8(document) })),
  };
}
async function mapDescription(page: Page, filename: string) {
  await page.getByLabel(`Công việc cho ${filename}`).selectOption({
    label: 'Bộ mẫu nhập cập nhật · Shop QA nội bộ · 900001',
  });
  await page.getByLabel(`Mô tả: đoạn 1 của ${filename}`).check();
  await page.getByLabel(`Mô tả: đoạn 2 của ${filename}`).check();
}

// Catches input flows that require full source re-entry, omit selection, or lose the persisted receipt.
test('imports price-only Excel, selects a subset and reopens the actual saved proposal', async ({
  page,
}) => {
  await openIntake(page);
  await page.getByLabel('Tên bộ cập nhật', { exact: true }).fill('Giá thử được nhập đầy đủ');
  await page.getByLabel('Chọn tệp cập nhật').setInputFiles(
    await excel(
      'Giá mới.xlsx',
      ['SKU', 'GIÁ GỐC'],
      [
        ['A', 12000],
        ['B', 13000],
        ['C', 12000],
      ],
    ),
  );
  await expect(page.getByText('Giá mới.xlsx', { exact: true }).first()).toBeVisible();
  await page.getByLabel('Khối dữ liệu Giá mới.xlsx').selectOption({ index: 1 });
  await preview(page);
  await expect(page.locator('[data-testid="patch-operation"]')).toHaveCount(2);
  await expect(page.getByText('Bản nguồn đã lưu', { exact: true }).first()).toBeVisible();
  await page.getByLabel('Chọn thay đổi Giá gốc · B').uncheck();
  await expect(page.getByRole('spinbutton')).toHaveCount(0);
  await page.getByRole('button', { name: /Lưu 1 thay đổi/ }).click();
  await expect(
    page.getByRole('heading', { name: 'Đã lưu bộ cập nhật', exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: '.local/import-patch-review/price-saved-desktop.png',
    fullPage: true,
  });
  await page.reload();
  await page.getByRole('button', { name: 'Nhập bộ cập nhật', exact: true }).first().click();
  await page
    .getByRole('button', { name: /Mở bộ cập nhật/ })
    .first()
    .click();
  await expect(page.locator('[data-testid="patch-operation"]')).toHaveCount(1);
  await expect(page.getByText('Giá gốc · A', { exact: true })).toBeVisible();
  await expect(page.getByText('Chưa gửi lên Shopee', { exact: true }).first()).toBeVisible();
});

test('recovers an uncertain local save with the same request after reload', async ({ page }) => {
  await openIntake(page);
  await page
    .getByLabel('Chọn tệp cập nhật')
    .setInputFiles(await excel('Lưu phục hồi.xlsx', ['SKU', 'GIÁ GỐC'], [['A', 15001]]));
  await page.getByLabel('Khối dữ liệu Lưu phục hồi.xlsx').selectOption({ index: 1 });
  await preview(page);
  let drop = true;
  await page.route('**/v1/import-patches', async (route) => {
    if (drop && route.request().method() === 'POST') {
      drop = false;
      await route.fetch();
      await route.abort('connectionfailed');
    } else await route.continue();
  });
  await page.getByRole('button', { name: /Lưu 1 thay đổi/ }).click();
  await expect(page.getByRole('button', { name: 'Xác nhận lại lần lưu trước' })).toBeVisible();
  await expect(page.getByLabel('Chọn thay đổi Giá gốc · A')).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Bỏ chọn 1 thay đổi đang hiển thị' }),
  ).toBeDisabled();
  page.on('dialog', (dialog) => dialog.accept());
  await page.reload();
  await page.getByRole('button', { name: 'Nhập bộ cập nhật', exact: true }).first().click();
  await page.getByRole('button', { name: 'Xác nhận lại lần lưu trước' }).click();
  await expect(page.getByRole('heading', { name: 'Đã lưu bộ cập nhật' })).toBeVisible();
  await expect(page.locator('[data-testid="patch-operation"]')).toHaveCount(1);
});

test('reviews 80 imported SKU rows in a compact table and saves a selected subset', async ({
  page,
}) => {
  await page.goto(baseURL);
  await page.getByRole('button', { name: 'Nhập bộ cập nhật', exact: true }).first().click();
  await page.getByLabel('Chọn công việc Bộ 80 SKU đối chiếu').check();
  await page.getByLabel('Chọn tệp cập nhật').setInputFiles(
    await excel(
      '80 SKU.xlsx',
      ['SKU', 'GIÁ GỐC'],
      Array.from({ length: 80 }, (_, index) => [
        'QA' + String(index + 1).padStart(3, '0'),
        20000 + index,
      ]),
    ),
  );
  await page.getByLabel('Khối dữ liệu 80 SKU.xlsx').selectOption({ index: 1 });
  await preview(page);
  await expect(page.locator('[data-testid="patch-operation"]')).toHaveCount(80);
  await expect(page.getByRole('table', { name: 'Thay đổi giá, tồn và tiêu đề' })).toBeVisible();
  const row = page.locator('[data-testid="patch-operation"]').first();
  expect((await row.boundingBox())!.height).toBeLessThan(125);
  await page.getByLabel('Chọn thay đổi Giá gốc · QA001').uncheck();
  await expect(page.getByRole('button', { name: /Lưu 79 thay đổi/ })).toBeVisible();
  await page.screenshot({
    path: '.local/import-patch-review/80-sku-preview-desktop.png',
    fullPage: false,
  });
  await page.getByRole('button', { name: /Lưu 79 thay đổi/ }).click();
  await expect(page.getByRole('heading', { name: 'Đã lưu bộ cập nhật' })).toBeVisible();
  await expect(page.locator('[data-testid="patch-operation"]')).toHaveCount(79);
  await expect(page.getByText('Giá gốc · QA001', { exact: true })).toHaveCount(0);
});

test('selects imported price changes as a group while keeping stock excluded', async ({ page }) => {
  await page.goto(baseURL);
  await page.getByRole('button', { name: 'Nhập bộ cập nhật', exact: true }).first().click();
  await page.getByLabel('Chọn công việc Bộ 80 SKU đối chiếu').check();
  await page.getByLabel('Tên bộ cập nhật', { exact: true }).fill('Chỉ giá trong 80 giá và tồn');
  await page.getByLabel('Chọn tệp cập nhật').setInputFiles(
    await excel(
      '80 giá và tồn.xlsx',
      ['SKU', 'GIÁ GỐC', 'TỒN ĐĂNG BÁN'],
      Array.from({ length: 80 }, (_, index) => [
        'QA' + String(index + 1).padStart(3, '0'),
        30000 + index,
        50,
      ]),
    ),
  );
  await page.getByLabel('Khối dữ liệu 80 giá và tồn.xlsx').selectOption({ index: 1 });
  await preview(page);
  await expect(page.locator('[data-testid="patch-operation"]')).toHaveCount(160);
  await page.getByLabel('Lọc trường').selectOption('stock');
  await page.getByRole('button', { name: 'Bỏ chọn 80 thay đổi đang hiển thị' }).click();
  await page.getByLabel('Lọc trường').selectOption('price');
  await expect(page.getByLabel('Chọn thay đổi Giá gốc · QA001')).toBeChecked();
  await page.getByRole('button', { name: 'Bỏ chọn 80 thay đổi đang hiển thị' }).click();
  await expect(page.getByRole('button', { name: /Lưu 0 thay đổi/ })).toBeDisabled();
  await page.getByRole('button', { name: 'Chọn 80 thay đổi đang hiển thị' }).click();
  await page.getByRole('button', { name: /Lưu 80 thay đổi/ }).click();
  await expect(page.getByRole('heading', { name: 'Đã lưu bộ cập nhật' })).toBeVisible();
  const saved = (await (await page.request.get(baseURL + '/v1/import-patches')).json()).find(
    (row: any) => row.name === 'Chỉ giá trong 80 giá và tồn',
  );
  expect(saved.selectedOperationIds).toHaveLength(80);
  expect(
    saved.preview.operations
      .filter((op: any) => saved.selectedOperationIds.includes(op.id))
      .every((op: any) => op.field === 'price'),
  ).toBe(true);
});

test('imports stock zero and blank without creating a reset for the blank row', async ({
  page,
}) => {
  await openIntake(page);
  await page.getByLabel('Chọn tệp cập nhật').setInputFiles(
    await excel(
      'Tồn mới.xlsx',
      ['SKU', 'TỒN ĐĂNG BÁN'],
      [
        ['A', 0],
        ['B', null],
      ],
    ),
  );
  await page.getByLabel('Khối dữ liệu Tồn mới.xlsx').selectOption({ index: 1 });
  await preview(page);
  await expect(page.locator('[data-testid="patch-operation"]')).toHaveCount(1);
  await expect(page.getByText('Tồn đăng bán · A', { exact: true })).toBeVisible();
  await expect(page.getByRole('spinbutton')).toHaveCount(0);
  await page.getByRole('button', { name: /Lưu 1 thay đổi/ }).click();
  await expect(page.getByRole('heading', { name: 'Đã lưu bộ cập nhật' })).toBeVisible();
});

test('imports only a cover image, explicitly maps its role and preserves all other fields', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openIntake(page);
  const image = await sharp({
    create: { width: 100, height: 100, channels: 3, background: '#a25342' },
  })
    .png()
    .toBuffer();
  await page
    .getByLabel('Chọn tệp cập nhật')
    .setInputFiles({ name: 'bìa mới.png', mimeType: 'image/png', buffer: image });
  await page
    .getByLabel('Công việc cho bìa mới.png')
    .selectOption({ label: 'Bộ mẫu nhập cập nhật · Shop QA nội bộ · 900001' });
  await page.getByLabel('Vai trò bìa mới.png').selectOption('cover');
  await preview(page);
  await expect(page.locator('[data-testid="patch-operation"]')).toHaveCount(1);
  await expect(page.getByText('Ảnh bìa', { exact: true }).last()).toBeVisible();
  await page.screenshot({
    path: '.local/import-patch-review/cover-preview-mobile.png',
    fullPage: true,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole('button', { name: /Lưu 1 thay đổi/ }).click();
  await expect(page.getByRole('heading', { name: 'Đã lưu bộ cập nhật' })).toBeVisible();
});

test('selects original Word paragraphs without retyping or requiring a complete listing', async ({
  page,
}) => {
  await openIntake(page);
  const document =
    '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t xml:space="preserve">  Nội dung mới  </w:t></w:r></w:p><w:p><w:r><w:t>Dòng thứ hai.</w:t></w:r></w:p></w:body></w:document>';
  await page.getByLabel('Chọn tệp cập nhật').setInputFiles({
    name: 'Mô tả mới.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: Buffer.from(zipSync({ 'word/document.xml': strToU8(document) })),
  });
  await page
    .getByLabel('Công việc cho Mô tả mới.docx')
    .selectOption({ label: 'Bộ mẫu nhập cập nhật · Shop QA nội bộ · 900001' });
  await page.getByLabel('Mô tả: đoạn 1 của Mô tả mới.docx').check();
  await page.getByLabel('Mô tả: đoạn 2 của Mô tả mới.docx').check();
  await preview(page);
  await expect(page.locator('[data-testid="patch-operation"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="patch-after"]')).toHaveText(
    '  Nội dung mới  \nDòng thứ hai.',
    { useInnerText: false },
  );
  await page.getByRole('button', { name: /Lưu 1 thay đổi/ }).click();
  await expect(page.getByRole('heading', { name: 'Đã lưu bộ cập nhật' })).toBeVisible();
});

test('assigns a group of imported images once and preserves their selected order', async ({
  page,
}) => {
  await openIntake(page);
  const pictures = await Promise.all(
    ['#2b536b', '#628047'].map(async (background, index) => ({
      name: `ảnh-${index + 1}.png`,
      mimeType: 'image/png',
      buffer: await sharp({ create: { width: 90, height: 120, channels: 3, background } })
        .png()
        .toBuffer(),
    })),
  );
  await page.getByLabel('Chọn tệp cập nhật').setInputFiles(pictures);
  await page.getByLabel('Chọn ảnh ảnh-1.png').check();
  await page.getByLabel('Chọn ảnh ảnh-2.png').check();
  await page
    .getByLabel('Công việc cho nhóm ảnh')
    .selectOption({ label: 'Bộ mẫu nhập cập nhật · Shop QA nội bộ · 900001' });
  await page.getByLabel('Vai trò cho nhóm ảnh').selectOption('gallery');
  await page.getByRole('button', { name: 'Gán cho 2 ảnh đã chọn' }).click();
  const second = await page.getByAltText('ảnh-2.png', { exact: true }).getAttribute('src');
  await page
    .getByRole('button', {
      name: 'Đưa ảnh-2.png lên trước trong Bộ ảnh sản phẩm của Bộ mẫu nhập cập nhật',
    })
    .click();
  await preview(page);
  await expect(page.locator('[data-testid="patch-operation"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="patch-after"] img').first()).toHaveAttribute(
    'src',
    second!,
  );
  await page.getByRole('button', { name: /Lưu 1 thay đổi/ }).click();
  await expect(page.getByRole('heading', { name: 'Đã lưu bộ cập nhật' })).toBeVisible();
});

test('maps different price blocks in one Excel to explicit shops with the same SKU', async ({
  page,
}) => {
  await openIntake(page);
  await page.getByLabel('Chọn công việc Bộ mẫu shop thứ hai').check();
  await page.getByLabel('Tên bộ cập nhật', { exact: true }).fill('Hai shop giá riêng');
  const book = new ExcelJS.Workbook(),
    sheet = book.addWorksheet('Giá theo kênh');
  sheet.addRow(['', 'Bộ A', 'Bộ B']);
  sheet.addRow(['SKU', 'GIÁ GỐC', 'GIÁ GỐC']);
  sheet.addRow(['A', 21000, 31000]);
  await page.getByLabel('Chọn tệp cập nhật').setInputFiles({
    name: 'Hai bộ giá.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from(await book.xlsx.writeBuffer()),
  });
  await page
    .getByLabel('Khối dữ liệu Hai bộ giá.xlsx', { exact: true })
    .selectOption({ label: 'Giá theo kênh · Bộ A · tiêu đề dòng 2' });
  await page.getByLabel('Áp dụng Bộ A cho Bộ mẫu nhập cập nhật · Shop QA nội bộ · 900001').check();
  await page.getByRole('button', { name: 'Thêm sheet hoặc bộ giá từ Hai bộ giá.xlsx' }).click();
  await page
    .getByLabel('Khối dữ liệu Hai bộ giá.xlsx 2', { exact: true })
    .selectOption({ label: 'Giá theo kênh · Bộ B · tiêu đề dòng 2' });
  await page.getByLabel('Áp dụng Bộ B cho Bộ mẫu shop thứ hai · Shop QA thứ hai · 900003').check();
  await preview(page);
  await expect(page.locator('[data-testid="patch-operation"]')).toHaveCount(2);
  await page.getByRole('button', { name: /Lưu 2 thay đổi cho 2 công việc/ }).click();
  await expect(page.getByRole('heading', { name: 'Đã lưu bộ cập nhật' })).toBeVisible();
  const saved = (await (await page.request.get(baseURL + '/v1/import-patches')).json()).find(
    (value: any) => value.name === 'Hai shop giá riêng',
  );
  expect(
    saved.preview.operations
      .map((op: any) => ({
        shop: saved.preview.targets.find((target: any) => target.workOrderId === op.workOrderId)
          .shopName,
        price: op.after,
      }))
      .sort((a: any, b: any) => a.shop.localeCompare(b.shop)),
  ).toEqual(
    [
      { shop: 'Shop QA nội bộ', price: '21000' },
      { shop: 'Shop QA thứ hai', price: '31000' },
    ].sort((a, b) => a.shop.localeCompare(b.shop)),
  );
});

test('uses one imported image in both gallery and description without uploading it twice', async ({
  page,
}) => {
  await openIntake(page);
  const bytes = await sharp({
    create: { width: 90, height: 120, channels: 3, background: '#574e78' },
  })
    .png()
    .toBuffer();
  let imageUploads = 0;
  page.on('request', (request) => {
    if (
      new URL(request.url()).pathname === '/v1/imports' &&
      request.method() === 'POST' &&
      request.headers()['x-file-name']?.endsWith('.png')
    )
      imageUploads++;
  });
  await page
    .getByLabel('Chọn tệp cập nhật')
    .setInputFiles([
      { name: 'ảnh-hai-vai-trò.png', mimeType: 'image/png', buffer: bytes },
      word('Bố cục hai vai trò.docx'),
    ]);
  await mapDescription(page, 'Bố cục hai vai trò.docx');
  await page
    .getByLabel('Công việc cho ảnh-hai-vai-trò.png')
    .selectOption({ label: 'Bộ mẫu nhập cập nhật · Shop QA nội bộ · 900001' });
  await page.getByLabel('Vai trò ảnh-hai-vai-trò.png').selectOption('gallery');
  await page.getByLabel('Vai trò ảnh-hai-vai-trò.png').selectOption('descriptionImages');
  await page.getByLabel(/Với Bộ mẫu nhập cập nhật: đặt bộ ảnh mô tả/).check();
  await preview(page);
  await expect(page.locator('[data-testid="patch-operation"]')).toHaveCount(2);
  await expect(page.locator('[data-testid="patch-after"] img')).toHaveCount(2);
  expect(imageUploads).toBe(1);
  const sources = await page
    .locator('[data-testid="patch-after"] img')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('src')));
  expect(new Set(sources).size).toBe(1);
  await page.getByRole('button', { name: /Lưu 2 thay đổi/ }).click();
  await expect(page.getByRole('heading', { name: 'Đã lưu bộ cập nhật' })).toBeVisible();
});

test('keeps an image-only description change blocked when the saved layout is unknown', async ({
  page,
}) => {
  await openIntake(page);
  const buffer = await sharp({
    create: { width: 90, height: 120, channels: 3, background: '#345b63' },
  })
    .png()
    .toBuffer();
  await page
    .getByLabel('Chọn tệp cập nhật')
    .setInputFiles({ name: 'ảnh-chưa-biết-bố-cục.png', mimeType: 'image/png', buffer });
  await page
    .getByLabel('Công việc cho ảnh-chưa-biết-bố-cục.png')
    .selectOption({ label: 'Bộ mẫu nhập cập nhật · Shop QA nội bộ · 900001' });
  await page.getByLabel('Vai trò ảnh-chưa-biết-bố-cục.png').selectOption('descriptionImages');
  await expect(page.getByLabel(/Với Bộ mẫu nhập cập nhật: đặt bộ ảnh mô tả/)).toHaveCount(0);
  await preview(page);
  await expect(page.getByLabel('Chọn thay đổi Mô tả', { exact: true })).toBeDisabled();
  await expect(
    page.getByTestId('patch-operation').getByText(/Chưa có bố cục mô tả được xác nhận/),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /Lưu 0 thay đổi/ })).toBeDisabled();
});

test('adding a bulk image role preserves the confirmed SKU for the same target', async ({
  page,
}) => {
  await openIntake(page);
  await page.getByLabel('Chọn công việc Bộ mẫu shop thứ hai').check();
  const buffer = await sharp({
    create: { width: 90, height: 120, channels: 3, background: '#385f4c' },
  })
    .png()
    .toBuffer();
  await page
    .getByLabel('Chọn tệp cập nhật')
    .setInputFiles({ name: 'ảnh-SKU-A.png', mimeType: 'image/png', buffer });
  await page
    .getByLabel('Công việc cho ảnh-SKU-A.png')
    .selectOption({ label: 'Bộ mẫu nhập cập nhật · Shop QA nội bộ · 900001' });
  await page.getByLabel('Vai trò ảnh-SKU-A.png').selectOption('variantImage');
  await page.getByLabel('SKU cho ảnh-SKU-A.png').selectOption('A');
  await page.getByLabel('Chọn ảnh ảnh-SKU-A.png').check();
  await page
    .getByLabel('Công việc cho nhóm ảnh')
    .selectOption({ label: 'Bộ mẫu nhập cập nhật · Shop QA nội bộ · 900001' });
  await page.getByLabel('Vai trò cho nhóm ảnh').selectOption('gallery');
  await page.getByRole('button', { name: 'Gán cho 1 ảnh đã chọn' }).click();
  await expect(page.getByLabel('SKU cho ảnh-SKU-A.png')).toHaveValue('A');
  await preview(page);
  await expect(page.locator('[data-testid="patch-operation"]')).toHaveCount(2);
  await expect(page.getByRole('button', { name: /Lưu 2 thay đổi/ })).toBeEnabled();
  await page.getByRole('button', { name: 'Điều chỉnh nguồn hoặc đích' }).click();
  await page.getByLabel('Chọn ảnh ảnh-SKU-A.png').check();
  await page
    .getByLabel('Công việc cho nhóm ảnh')
    .selectOption({ label: 'Bộ mẫu shop thứ hai · Shop QA thứ hai · 900003' });
  await page.getByRole('button', { name: 'Gán cho 1 ảnh đã chọn' }).click();
  await expect(page.getByLabel('SKU cho ảnh-SKU-A.png')).toHaveCount(0);
  await preview(page);
  await expect(page.locator('[data-testid="patch-operation"]')).toHaveCount(1);
  await expect(page.getByTestId('patch-operation')).toContainText('Shop QA thứ hai · Link 900003');
});

test('preserves independent gallery and description orders for the same imported images', async ({
  page,
}) => {
  await openIntake(page);
  await page.getByLabel('Tên bộ cập nhật', { exact: true }).fill('Hai vai trò có thứ tự riêng');
  const pictures = await Promise.all(
    ['#425b80', '#964e42'].map(async (background, index) => ({
      name: `dùng-chung-${index + 1}.png`,
      mimeType: 'image/png',
      buffer: await sharp({ create: { width: 90, height: 120, channels: 3, background } })
        .png()
        .toBuffer(),
    })),
  );
  await page
    .getByLabel('Chọn tệp cập nhật')
    .setInputFiles([...pictures, word('Thứ tự riêng.docx')]);
  await mapDescription(page, 'Thứ tự riêng.docx');
  for (const picture of pictures) {
    await page
      .getByLabel(`Công việc cho ${picture.name}`)
      .selectOption({ label: 'Bộ mẫu nhập cập nhật · Shop QA nội bộ · 900001' });
    await page.getByLabel(`Vai trò ${picture.name}`).selectOption('gallery');
    await page.getByLabel(`Vai trò ${picture.name}`).selectOption('descriptionImages');
  }
  await page.getByLabel(/Với Bộ mẫu nhập cập nhật: đặt bộ ảnh mô tả/).check();
  await page
    .getByRole('button', {
      name: 'Đưa dùng-chung-2.png lên trước trong Ảnh trong mô tả của Bộ mẫu nhập cập nhật',
    })
    .click();
  await preview(page);
  await page.getByRole('button', { name: /Lưu 2 thay đổi/ }).click();
  await expect(page.getByRole('heading', { name: 'Đã lưu bộ cập nhật' })).toBeVisible();
  const saved = (await (await page.request.get(baseURL + '/v1/import-patches')).json()).find(
    (row: any) => row.name === 'Hai vai trò có thứ tự riêng',
  );
  const gallery = saved.preview.operations
    .find((op: any) => op.field === 'gallery')
    .after.map((image: any) => image.sha256);
  const description = saved.preview.operations
    .find((op: any) => op.field === 'description')
    .after.filter((block: any) => block.type === 'image')
    .map((block: any) => block.assetKey);
  expect(description).toEqual(saved.preview.selection.contents[0].gallery.importIds.toReversed());
  expect(gallery).toHaveLength(2);
  expect(new Set(gallery).size).toBe(2);
  await page.screenshot({
    path: '.local/import-patch-review/independent-media-orders-saved.png',
    fullPage: true,
  });
});
