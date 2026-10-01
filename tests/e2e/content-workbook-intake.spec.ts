import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { openInputLibrary } from './workspace-navigation.js';
test('Excel content maps a batch explicitly, keeps duplicate STT unresolved and survives reopening', async ({
  page,
}) => {
  const stamp = '2026-09-23T00:00:00Z',
    batchId = randomUUID(),
    contentId = randomUUID(),
    imageId = randomUUID(),
    sha = 'c'.repeat(64);
  const imports: any[] = [
    {
      id: imageId,
      kind: 'image',
      filename: 'bia.jpg',
      sha256: 'a'.repeat(64),
      bytes: 13,
      status: 'ready',
      createdAt: stamp,
      body: {
        key: imageId,
        sha256: 'a'.repeat(64),
        mime: 'image/jpeg',
        width: 1000,
        height: 1000,
        bytes: 13,
      },
    },
  ];
  const groups = ['222 Mũ', '224 Nhà'];
  let batch: any = {
    id: batchId,
    revision: 1,
    createdAt: stamp,
    updatedAt: stamp,
    state: {
      version: 1,
      name: 'Lô Excel',
      mode: 'parent_with_listing_folders',
      files: groups.map((name) => ({
        name: 'bia.jpg',
        relativePath: 'Lo/' + name + '/bia.jpg',
        size: 13,
        importId: imageId,
        sha256: 'a'.repeat(64),
      })),
      priceSelection: null,
      visual: {},
      wordPaths: {},
      wordRule: null,
      productKeys: Object.fromEntries(
        groups.map((name) => ['Lo/' + name, 'content-' + name.split(' ')[0]]),
      ),
    },
  };
  const mappings: any[] = [],
    writes: any[] = [];
  const headers = [
    { column: 'A', text: 'STT' },
    { column: 'B', text: 'Tiêu đề' },
    { column: 'C', text: 'Nội dung' },
  ];
  await page.route('**/v1/**', async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname;
    if (req.method() === 'POST' && path === '/v1/imports')
      return route.fulfill({
        json: {
          id: contentId,
          kind: 'xlsx',
          status: 'failed',
          filename: 'content.xlsx',
          sha256: sha,
          bytes: 7,
          createdAt: stamp,
        },
      });
    if (req.method() === 'GET' && path === '/v1/content-workbooks/' + contentId)
      return route.fulfill({
        json: {
          importId: contentId,
          sha256: sha,
          filename: 'content.xlsx',
          priceParserStatus: 'failed',
          sheets: [
            { name: 'Nội dung', rows: 4, preview: [{ row: 1, cells: headers }] },
            { name: 'Khác', rows: 1, preview: [{ row: 1, cells: headers }] },
          ],
        },
      });
    if (req.method() === 'POST' && path === '/v1/content-workbooks/rows') {
      const mapping = req.postDataJSON();
      mappings.push(mapping);
      return route.fulfill({
        json: {
          mapping,
          rows: [
            ['222', 'Mũ đúng'],
            ['222', 'Mũ cần xem'],
            ['224', 'Nhà đúng'],
          ].map(([stt, title], i) => ({
            binding: { mapping, row: i + 2, stt },
            title,
            headline: '',
            body: 'Nội dung thật',
            issues: [],
            sources: [
              {
                kind: 'product_file',
                fileSha256: sha,
                filename: 'content.xlsx',
                locator: 'Nội dung!B' + (i + 2),
                observedAt: stamp,
              },
            ],
          })),
        },
      });
    }
    if (req.method() === 'POST' && path === '/v1/input-batches') {
      const input = req.postDataJSON();
      writes.push(input);
      batch = { ...batch, revision: input.expectedRevision + 1, state: input.state };
      return route.fulfill({ json: batch });
    }
    if (req.method() !== 'GET') throw Error('Unexpected mutation ' + path);
    let json: any = [];
    if (path === '/v1/status') json = { worker: 'online' };
    else if (path === '/v1/input-library')
      json = {
        batches: [
          {
            id: batchId,
            name: 'Lô Excel',
            folderCount: 2,
            fileCount: 2,
            completedCount: 0,
            updatedAt: stamp,
          },
        ],
        priceBooks: [],
        unassigned: [],
      };
    else if (path === '/v1/input-batches/' + batchId) json = { ...batch, imports };
    else if (path === '/v1/imports') json = imports;
    else if (path.startsWith('/v1/imports/'))
      json = imports.find((i) => i.id === path.split('/').at(-1));
    else if (path.startsWith('/v1/media/')) return route.fulfill({ status: 204 });
    return route.fulfill({ json });
  });
  async function open() {
    await openInputLibrary(page);
    await page.getByRole('button', { name: 'Tiếp tục xử lý', exact: true }).click();
    await page.getByText('Nội dung từ Excel — ghép cùng lúc theo STT', { exact: true }).click();
  }
  await page.goto('/');
  await open();
  await page
    .getByLabel('Chọn Excel nội dung', { exact: true })
    .setInputFiles({
      name: 'content.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: Buffer.from('fixture'),
    });
  await page.getByLabel('Sheet nội dung', { exact: true }).selectOption('Nội dung');
  await page.getByLabel('Cột STT', { exact: true }).selectOption('A');
  await page.getByLabel('Cột Tiêu đề', { exact: true }).selectOption('B');
  await page.getByLabel('Cột Nội dung sau ảnh', { exact: true }).selectOption('C');
  await page.getByRole('button', { name: 'Xem ghép nội dung cho cả lô', exact: true }).click();
  await expect(page.getByLabel('Dòng nội dung 222 Mũ', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Dòng nội dung 224 Nhà', { exact: true })).toHaveValue('4');
  await page.getByLabel('Dòng nội dung 222 Mũ', { exact: true }).selectOption('2');
  await page.getByRole('button', { name: 'Áp dụng nội dung các bộ đã chọn', exact: true }).click();
  await expect.poll(() => Object.keys(batch.state.contentSelections ?? {}).length).toBe(2);
  expect(batch.state.contentSelections['Lo/222 Mũ'].binding.row).toBe(2);
  expect(mappings[0].headers).toEqual({ stt: 'STT', title: 'Tiêu đề', body: 'Nội dung' });
  await page.getByLabel('Sheet nội dung', { exact: true }).selectOption('Khác');
  await expect(
    page.getByRole('button', { name: 'Áp dụng nội dung các bộ đã chọn', exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await open();
  await expect(page.getByText('Đã gắn nội dung: 2 bộ.', { exact: false })).toBeVisible();
  expect(writes.length).toBeGreaterThan(0);
});
