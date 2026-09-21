import { test, expect, type Page } from '@playwright/test';

// Mount the real component without the workspace or any main API/DB calls.
// Every API request is intercepted; the only live requests load local Vite modules.
const harness = `<!doctype html><html lang="vi"><meta charset="utf-8"><div id="root"></div>
<script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => (type) => type;
window.__vite_plugin_react_preamble_installed__ = true;
const [{default: React}, {default: ReactDOM}, {DraftKnowledgeSuggestions}] = await Promise.all([
  import('/node_modules/.vite/deps/react.js'),
  import('/node_modules/.vite/deps/react-dom_client.js'),
  import('/src/DraftKnowledgeSuggestions.tsx'),
]);
function Harness() {
  const [shopId, setShopId] = React.useState('1001');
  const [accepted, setAccepted] = React.useState([]);
  return React.createElement('main', null,
    React.createElement('button', {onClick: () => setShopId('1001')}, 'Chọn shop A'),
    React.createElement('button', {onClick: () => setShopId('1002')}, 'Chọn shop B'),
    React.createElement('p', {'data-testid': 'current-shop'}, shopId),
    React.createElement('p', {'data-testid': 'accepted'}, accepted.length ? accepted.map(row => row.id).join(',') : 'Chưa lưu lựa chọn.'),
    React.createElement(DraftKnowledgeSuggestions, {
      productKey: 'race-draft', expectedRevision: 1, shopId, partnerId: '2001', categoryId: '10', brandId: '20',
      onAccepted: receipt => setAccepted(rows => [...rows, receipt]),
    }),
  );
}
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Harness));
</script></html>`;
const connections = [
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
];
const target = {
  productKey: 'race-draft',
  expectedRevision: 1,
  connectionId: connections[0],
  categoryId: 10,
  brandId: 20,
};
const metadata = () => ({
  observedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 600000).toISOString(),
});
const recommendation = (name: string) => ({
  target,
  fingerprint: 'a'.repeat(64),
  metadata: metadata(),
  sourceFacts: [],
  recommendations: {
    issues: [],
    suggestions: [
      {
        attributeId: 7,
        name,
        sourceClass: 'product_source',
        canPrefill: true,
        reasons: [],
        evidenceIds: [],
        values: [{ valueId: 8, displayName: '100', valueUnit: 'ml' }],
      },
    ],
  },
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function mount(
  page: Page,
  handler: (route: import('@playwright/test').Route, path: string) => Promise<void>,
) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // Use the same optimized module identities as the real component, including Vite's version.
  // Importing an unversioned second copy of React would create an invalid-hook-call fixture.
  const [componentModule, mainModule] = await Promise.all([
    page.request.get('/src/DraftKnowledgeSuggestions.tsx').then((response) => response.text()),
    page.request.get('/src/main.tsx').then((response) => response.text()),
  ]);
  const reactUrl = componentModule.match(
    /from "(\/node_modules\/\.vite\/deps\/react\.js[^"\s]*)"/,
  )?.[1];
  const domUrl = mainModule.match(
    /from "(\/node_modules\/\.vite\/deps\/react-dom_client\.js[^"\s]*)"/,
  )?.[1];
  expect(reactUrl).toBeTruthy();
  expect(domUrl).toBeTruthy();
  const pageHtml = harness
    .replace('/node_modules/.vite/deps/react.js', reactUrl!)
    .replace('/node_modules/.vite/deps/react-dom_client.js', domUrl!);
  await page.route('**/__draft-knowledge-race', (route) =>
    route.fulfill({ contentType: 'text/html', body: pageHtml }),
  );
  await page.route('**/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/v1/seller-knowledge/shops')
      return route.fulfill({
        json: {
          shops: connections.map((id, index) => ({
            id,
            state: 'connected',
            scope: { environment: 'production', partnerId: '2001', shopId: String(1001 + index) },
          })),
        },
      });
    return handler(route, path);
  });
  await page.goto('/__draft-knowledge-race');
  await expect
    .poll(async () =>
      errors.length
        ? errors.join('; ')
        : (await page.getByRole('button', { name: 'Đọc gợi ý có nguồn', exact: true }).count())
          ? 'ready'
          : 'loading',
    )
    .toBe('ready');
  await expect(page.getByRole('button', { name: 'Đọc gợi ý có nguồn', exact: true })).toBeEnabled();
  return errors;
}
const paint = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );

test('A to B to A discards the old recommendation and cannot unlock a newer pending request', async ({
  page,
}) => {
  const old = deferred(),
    latest = deferred(),
    oldDone = deferred();
  const requests: unknown[] = [];
  const errors = await mount(page, async (route, path) => {
    if (path !== '/v1/seller-knowledge/draft-recommendations')
      return route.fulfill({ status: 503, json: { code: 'UNEXPECTED_FIXTURE_REQUEST' } });
    requests.push(route.request().postDataJSON());
    const first = requests.length === 1;
    await (first ? old.promise : latest.promise);
    await route.fulfill({ json: recommendation(first ? 'Kết quả A cũ' : 'Kết quả A mới') });
    if (first) oldDone.resolve();
  });
  await page.getByRole('button', { name: 'Đọc gợi ý có nguồn', exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  await page.getByRole('button', { name: 'Chọn shop B', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Đọc gợi ý có nguồn', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Chọn shop A', exact: true }).click();
  await page.getByRole('button', { name: 'Đọc gợi ý có nguồn', exact: true }).click();
  await expect.poll(() => requests.length).toBe(2);
  old.resolve();
  await oldDone.promise;
  await paint(page);
  await expect(page.getByLabel('Chọn Kết quả A cũ', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Đang đối chiếu…', exact: true })).toBeDisabled();
  latest.resolve();
  await expect(page.getByLabel('Chọn Kết quả A mới', { exact: true })).toBeVisible();
  await expect(page.getByText('Kết quả A mới: 100 ml', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Chọn Kết quả A cũ', { exact: true })).toHaveCount(0);
  expect(requests).toEqual([target, target]);
  expect(errors).toEqual([]);
});

test('a delayed acceptance from the first A visit is never applied after switching A to B to A', async ({
  page,
}) => {
  const hold = deferred(),
    started = deferred(),
    delivered = deferred();
  const accepts: any[] = [];
  const errors = await mount(page, async (route, path) => {
    if (path === '/v1/seller-knowledge/draft-recommendations')
      return route.fulfill({ json: recommendation('Xuất xứ từ nguồn') });
    if (path === '/v1/seller-knowledge/draft-acceptances') {
      accepts.push(route.request().postDataJSON());
      started.resolve();
      await hold.promise;
      await route.fulfill({
        json: {
          id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          target,
          attributeList: [{ attribute_id: 7, attribute_value_list: [{ value_id: 8 }] }],
          metadata: metadata(),
        },
      });
      delivered.resolve();
      return;
    }
    return route.fulfill({ status: 503, json: { code: 'UNEXPECTED_FIXTURE_REQUEST' } });
  });
  await page.getByRole('button', { name: 'Đọc gợi ý có nguồn', exact: true }).click();
  await page.getByLabel('Chọn Xuất xứ từ nguồn', { exact: true }).check();
  await page
    .getByRole('button', { name: 'Dùng thông tin đã chọn trong bản xem trước', exact: true })
    .click();
  await started.promise;
  await page.getByRole('button', { name: 'Chọn shop B', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Đọc gợi ý có nguồn', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Chọn shop A', exact: true }).click();
  hold.resolve();
  await delivered.promise;
  await paint(page);
  await expect(page.getByTestId('accepted')).toHaveText('Chưa lưu lựa chọn.');
  await expect(page.getByRole('button', { name: 'Đọc gợi ý có nguồn', exact: true })).toBeEnabled();
  await expect(page.getByLabel('Chọn Xuất xứ từ nguồn', { exact: true })).toHaveCount(0);
  expect(accepts).toHaveLength(1);
  expect(accepts[0]).toMatchObject({ ...target, attributeIds: [7] });
  expect(errors).toEqual([]);
});

test('a slow first evidence cannot replace the second reference selected for the same draft', async ({
  page,
}) => {
  const first = deferred(),
    delivered = deferred();
  const evidenceIds = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
  ];
  const requests: string[] = [];
  const errors = await mount(page, async (route, path) => {
    if (path === '/v1/seller-knowledge/draft-recommendations') {
      const value = recommendation('Xuất xứ tham khảo');
      Object.assign(value.recommendations.suggestions[0]!, {
        sourceClass: 'same_shop_history',
        canPrefill: false,
        evidenceIds,
      });
      return route.fulfill({ json: value });
    }
    if (path.startsWith('/v1/seller-knowledge/evidence/')) {
      expect(route.request().method()).toBe('GET');
      requests.push(path);
      const old = path.endsWith(evidenceIds[0]!);
      if (old) await first.promise;
      await route.fulfill({
        json: {
          id: old ? evidenceIds[0] : evidenceIds[1],
          observedAt: new Date().toISOString(),
          body: { title: old ? 'Nguồn cũ trả chậm' : 'Nguồn thứ hai đang chọn', attributes: [] },
        },
      });
      if (old) delivered.resolve();
      return;
    }
    throw Error('Unexpected fixture request: ' + path);
  });
  // Ignore cancellation to verify the response identity guard, independently of AbortController.
  await page.evaluate(() => {
    const original = window.fetch.bind(window);
    window.fetch = (input, init) =>
      String(input).includes('/seller-knowledge/evidence/')
        ? original(input, { ...init, signal: undefined })
        : original(input, init);
  });
  await page.getByRole('button', { name: 'Đọc gợi ý có nguồn', exact: true }).click();
  await page.getByRole('button', { name: 'Xem nguồn tham khảo 1', exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  await expect(page.getByText('Đang đọc nguồn đã chọn…', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Xem nguồn tham khảo 2', exact: true }).click();
  await expect(page.getByText('Nguồn thứ hai đang chọn', { exact: false })).toBeVisible();
  first.resolve();
  await delivered.promise;
  await paint(page);
  await expect(
    page.getByText('Nguồn tham khảo 2 · Xuất xứ tham khảo', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Nguồn thứ hai đang chọn', { exact: false })).toBeVisible();
  await expect(page.getByText('Nguồn cũ trả chậm', { exact: false })).toHaveCount(0);
  expect(requests).toHaveLength(2);
  expect(errors).toEqual([]);
});

test('evidence from the previous target is discarded when the shop changes', async ({ page }) => {
  const old = deferred(),
    delivered = deferred(),
    started = deferred();
  const evidenceId = '11111111-1111-4111-8111-111111111111';
  const errors = await mount(page, async (route, path) => {
    if (path === '/v1/seller-knowledge/draft-recommendations') {
      const value = recommendation('Xuất xứ tham khảo');
      Object.assign(value.recommendations.suggestions[0]!, {
        sourceClass: 'same_shop_history',
        canPrefill: false,
        evidenceIds: [evidenceId],
      });
      return route.fulfill({ json: value });
    }
    if (path.endsWith('/evidence/' + evidenceId)) {
      started.resolve();
      await old.promise;
      await route.fulfill({
        json: {
          id: evidenceId,
          observedAt: new Date().toISOString(),
          body: { title: 'Nguồn của shop A đã rời', attributes: [] },
        },
      });
      delivered.resolve();
      return;
    }
    throw Error('Unexpected fixture request: ' + path);
  });
  await page.evaluate(() => {
    const original = window.fetch.bind(window);
    window.fetch = (input, init) =>
      String(input).includes('/seller-knowledge/evidence/')
        ? original(input, { ...init, signal: undefined })
        : original(input, init);
  });
  await page.getByRole('button', { name: 'Đọc gợi ý có nguồn', exact: true }).click();
  await page.getByRole('button', { name: 'Xem nguồn tham khảo 1', exact: true }).click();
  await started.promise;
  await page.getByRole('button', { name: 'Chọn shop B', exact: true }).click();
  old.resolve();
  await delivered.promise;
  await paint(page);
  await expect(page.getByText('Nguồn của shop A đã rời', { exact: false })).toHaveCount(0);
  await expect(page.getByText('Đang đọc nguồn đã chọn…', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('accepted')).toHaveText('Chưa lưu lựa chọn.');
  expect(errors).toEqual([]);
});
