import { fulfillPagedProducts } from './fixtures/product-paging.js';
import { test, expect, type Page } from '@playwright/test';
const sourceKey = 'saved-source-a',
  priceId = '252d91d1-93c7-429a-a4fc-1e719a0bbaf9',
  previewId = '1651c52c-4cc8-4b57-951a-6b9b4d6b2281',
  fp = 'a'.repeat(64);
async function fixture(
  page: Page,
  blocked = false,
  prior = false,
  effectivePolicy?: Record<string, unknown>,
) {
  const fact = (value: any) => ({
    value,
    confirmed: true,
    sources: [
      {
        kind: 'product_file',
        fileSha256: 'fixture',
        locator: 'source',
        observedAt: '2026-09-15T00:00:00.000Z',
      },
    ],
  });
  const selection = {
    title: 'Listing tinh dầu đã chuẩn bị',
    headline: 'Dòng đầu',
    body: ' Dòng 1\n\nDòng 2 ',
    coverId: 'cover',
    galleryIds: ['gallery'],
    descriptionImageIds: [],
    tierNames: ['Dung tích'],
    variants: [
      { importId: priceId, rowKey: 'row1', optionLabels: ['100ml'], imageId: 'variation' },
    ],
  };
  const draft = {
    productKey: sourceKey,
    revision: 4,
    sourceSelection: selection,
    title: fact(selection.title),
    description: [{ type: 'text', text: selection.body }],
    coverKey: 'cover',
    galleryKeys: ['gallery'],
    tierNames: selection.tierNames,
    variants: [
      {
        key: 'row1',
        sku: fact('SKU-A'),
        optionLabels: ['100ml'],
        originalPrice: fact('125000'),
        declaredWeightGrams: fact('130.9'),
        imageKey: 'variation',
      },
    ],
    assets: [],
    categoryId: fact('10'),
    brandId: fact('20'),
    attributes: {},
    logistics: { '50': fact(true) },
    issues: [],
  };
  const summary = {
    productKey: sourceKey,
    revision: 4,
    title: selection.title,
    skus: ['SKU-A'],
    categoryId: '10',
    brandId: '20',
    sourceSelection: selection,
    attributes: {},
    logistics: draft.logistics,
    issues: [],
  };
  const meta: any = {
    shop: { id: '1423724897', name: 'vuatinhdau.vn' },
    categories: [{ id: '10', label: 'Tinh dầu', path: 'Nhà cửa > Tinh dầu' }],
    attributes: [],
    brands: {
      items: [{ id: '20', name: 'VINA TƯƠI', label: 'VINA TƯƠI' }],
      hasNextPage: false,
      nextOffset: null,
    },
    channels: [
      {
        id: '50',
        name: 'Kênh vận chuyển của shop',
        enabled: true,
        forceEnabled: false,
        compulsory: false,
      },
    ],
    itemLimits: { sizeChart: { mandatory: false } },
  };
  let registered = prior,
    running = false;
  const requests: { path: string; body: any }[] = [];
  const preview: any = {
    id: previewId,
    fingerprint: fp,
    readyCount: blocked ? 0 : 1,
    blockedCount: blocked ? 1 : 0,
    entries: [
      {
        productKey: sourceKey,
        title: selection.title,
        kind: blocked ? 'blocked' : 'ready',
        issues: blocked
          ? [{ field: 'stockLocation', message: 'Chưa có bằng chứng đối chiếu kho.' }]
          : [],
        document: {
          title: selection.title,
          description: draft.description,
          weightGrams: 130.9,
          models: [
            {
              sku: 'SKU-A',
              optionLabels: ['100ml'],
              originalPrice: '125000',
              stock: 0,
              weightGrams: 130.9,
            },
          ],
        },
        priceProof: [
          { sku: 'SKU-A', originalPrice: '125000', sheetName: 'DORIS', priceProfile: 'SHOP MALL' },
        ],
      },
    ],
  };
  const appOrigin = new URL(String(test.info().project.use.baseURL)).origin;
  await page.route('**/*', (route) =>
    new URL(route.request().url()).origin === appOrigin ? route.continue() : route.abort(),
  );
  await page.route('**/v1/**', async (route) => {
    const url = new URL(route.request().url()),
      path = url.pathname;
    if (route.request().method() === 'POST') {
      requests.push({ path, body: route.request().postDataJSON() });
      if (path === '/v1/production-preparations/preview') {
        preview.publicationMode =
          route.request().postDataJSON().publicationMode ?? 'hidden_for_review';
        preview.imageQcPolicy = route.request().postDataJSON().imageQcPolicy ?? 'required';
        return fulfillPagedProducts(route,{ json: preview });
      }
      if (path === '/v1/production-preparations/' + previewId + '/register') {
        registered = true;
        return fulfillPagedProducts(route,{
          json: { batches: [{ batchId: 'fixture-only' }], readyCount: 1, blockedCount: 0 },
        });
      }
      if (path === '/v1/production-preparations/' + previewId + '/run') {
        running = true;
        return fulfillPagedProducts(route,{ json: { state: 'running', completedBatches: [], totalBatches: 1 } });
      }
      return route.abort();
    }
    if (path === '/v1/production-preparations/context')
      return fulfillPagedProducts(route,{
        json: {
          scope: { shopId: '1423724897', partnerId: '2010476' },
          products: [summary, { ...summary, productKey: 'saved-source-b', title: 'Bộ thứ hai — khăn cotton', skus: ['SKU-B'] }],
          pricebooks: [{ id: priceId, filename: 'DORIS.xlsx' }],
          preparations: registered ? [{ ...preview, registration: { batches: [] } }] : [],
        },
      });
    if (path === '/v1/production-preparations/metadata')
      return fulfillPagedProducts(route,{
        json: {
          ...meta,
          ...(url.searchParams.get('includeInventory') === 'true'
            ? {
                inventory: {
                  items: [{ itemId: '9001', title: 'Listing tham khảo kho' }],
                  hasNextPage: false,
                  nextOffset: null,
                },
              }
            : {}),
          ...(url.searchParams.has('referenceItemId')
            ? {
                reference: {
                  itemId: '9001',
                  title: 'Listing tham khảo kho',
                  writeMappingVerified: true,
                  stockLocations: [],
                  writeMapping: {
                    expectedLocationId: 'READ-TEST',
                    writeLocationId: 'WRITE-TEST',
                    verifiedOperationId: 'proof-only',
                    verificationFingerprint: 'b'.repeat(64),
                    referenceRequestId: 'read-1',
                    warehouseRequestId: 'warehouse-1',
                  },
                },
              }
            : {}),
        },
      });
    if (path === '/v1/products/' + sourceKey) return fulfillPagedProducts(route,{ json: draft });
    if (path === '/v1/products/saved-source-b') return fulfillPagedProducts(route,{ json: { ...draft, productKey: 'saved-source-b', title: fact('Bộ thứ hai — khăn cotton'), variants: [{ ...draft.variants[0], key: 'row2', sku: fact('SKU-B') }] } });
    if (path === '/v1/shops') return fulfillPagedProducts(route,{ json: [{ id: 'focus-shop', name: 'Shop kiểm thử UX', state: 'connected', revision: 1, scope: { environment: 'production', partnerId: '2010476', shopId: '1423724897' } }] });
    if (path === '/v1/products') return fulfillPagedProducts(route,{ json: [draft] });
    if (path === '/v1/imports/' + priceId)
      return fulfillPagedProducts(route,{
        json: {
          id: priceId,
          filename: 'DORIS.xlsx',
          body: { rows: [{ key: 'row1', sheet: 'DORIS', priceProfile: 'SHOP MALL' }] },
        },
      });
    if (path === '/v1/production-preparations/' + previewId + '/execution')
      return fulfillPagedProducts(route,{
        json: running
          ? { state: 'running', completedBatches: [], totalBatches: 1 }
          : prior
            ? { state: 'paused', completedBatches: [], totalBatches: 1, ...effectivePolicy }
            : null,
      });
    if (path === '/v1/production-batches') return fulfillPagedProducts(route,{ json: { batches: [] } });
    if (path.startsWith('/v1/media/')) return fulfillPagedProducts(route,{ status: 404, body: '' });
    if (path === '/v1/production-pilot/status')
      return fulfillPagedProducts(route,{ status: 503, json: { message: 'Old pilot not part of fixture' } });
    return fulfillPagedProducts(route,{ json: path === '/v1/status' ? { worker: 'online' } : [] });
  });
  await page.goto('/?page=prepared-batches&partnerId=2010476&shopId=1423724897&stage=prepare');
  await page
    .getByRole('navigation', { name: 'Điều hướng chính', exact: true })
    .getByRole('button', { name: 'Đăng hàng', exact: true })
    .click();
  await page.getByRole('tab', { name: 'Chuẩn bị lô mới', exact: true }).click();
  return { requests, preview, draft, meta };
}


const regionOf = (page: Page) => page.getByRole('region', { name: 'Chuẩn bị đợt từ listing đã lưu', exact: true });

test('preparation shows one step at a time and preserves choices without sending when navigating', async ({page}) => {
  const f=await fixture(page), region=regionOf(page);
  const steps=region.getByRole('navigation',{name:'Các bước chuẩn bị',exact:true});
  await expect(steps.getByRole('button')).toHaveCount(3);
  await expect(region.getByRole('combobox',{name:'Tình trạng sản phẩm',exact:true})).toBeHidden();
  await region.getByRole('checkbox',{name:/Listing tinh dầu đã chuẩn bị/}).check();
  await region.getByRole('checkbox',{name:/Bộ thứ hai/}).check();
  await region.getByRole('button',{name:'Tiếp tục · Bổ sung thông tin',exact:true}).click();
  await expect(region.getByRole('searchbox',{name:'Tìm theo tên hoặc SKU',exact:true})).toBeHidden();
  await expect(region.getByRole('group',{name:'Cấu hình điền nhanh',exact:true})).toBeHidden();
  await expect(region.locator('.preparation-entry:visible')).toHaveCount(1);
  await region.getByRole('button',{name:/Sửa Listing tinh dầu/}).click();
  await region.getByRole('combobox',{name:'Tình trạng sản phẩm',exact:true}).selectOption('USED');
  await region.getByText('Vận chuyển & kiện hàng',{exact:true}).click();
  await region.getByLabel('Dài kiện hàng (cm)',{exact:true}).fill('19');
  await steps.getByRole('button',{name:/3.*Kiểm tra/}).click();
  await expect(region.getByRole('combobox',{name:'Tình trạng sản phẩm',exact:true})).toBeHidden();
  await expect(region.getByRole('radio',{name:'Đăng ẩn để QC',exact:true})).toBeVisible();
  await steps.getByRole('button',{name:/2.*Bổ sung/}).click();
  await expect(region.getByRole('combobox',{name:'Tình trạng sản phẩm',exact:true})).toHaveValue('USED');
  await expect(region.getByLabel('Dài kiện hàng (cm)',{exact:true})).toHaveValue('19');
  expect(f.requests).toEqual([]);
  await page.reload();
  await expect(region.getByRole('combobox',{name:'Tình trạng sản phẩm',exact:true})).toHaveValue('USED');
  await expect(region.getByLabel('Dài kiện hàng (cm)',{exact:true})).toHaveValue('19');
  expect(f.requests).toEqual([]);
});

test('checking source moves to results and fixing a missing field opens its editor without replaying', async ({page}) => {
  const f=await fixture(page,true), region=regionOf(page);
  await region.getByRole('checkbox',{name:/Listing tinh dầu đã chuẩn bị/}).check();
  await region.getByRole('button',{name:'Tiếp tục · Bổ sung thông tin',exact:true}).click();
  await region.getByRole('button',{name:'Tiếp tục · Kiểm tra',exact:true}).click();
  await region.getByRole('button',{name:'Kiểm tra 1 listing đã chọn',exact:true}).click();
  await expect(region.getByRole('region',{name:'Kết quả kiểm tra nguồn',exact:true})).toBeVisible();
  await expect(region.getByRole('navigation',{name:'Các bước chuẩn bị'}).getByRole('button',{name:/3.*Kiểm tra/})).toHaveAttribute('aria-current','step');
  await region.getByRole('button',{name:'Bổ sung kho áp dụng',exact:true}).click();
  await expect(region.getByRole('button',{name:'Chọn listing tham khảo kho',exact:true})).toBeFocused();
  expect(f.requests.map(r=>r.path)).toEqual(['/v1/production-preparations/preview']);
});

test('preparation remains usable at narrow widths with detailed shipping collapsed and no clipped controls', async ({page}) => {
  const f=await fixture(page), region=regionOf(page);
  await region.getByRole('checkbox',{name:/Listing tinh dầu đã chuẩn bị/}).check();
  await region.getByRole('button',{name:'Tiếp tục · Bổ sung thông tin',exact:true}).click();
  for(const theme of ['Sáng','Tối']) {
    await page.getByRole('combobox',{name:'Giao diện',exact:true}).selectOption({label:theme});
    for(const width of [1440,768,620,390,320]) {
      await page.setViewportSize({width,height:900});
      await expect(region.getByLabel('Dài kiện hàng (cm)',{exact:true})).toBeHidden();
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
      await expect(region.getByRole('button',{name:'Tiếp tục · Kiểm tra',exact:true})).toBeVisible();
    }
  }
  expect(f.requests).toEqual([]);
  await page.screenshot({path:'.local/preparation-focus-20261002/preparation-mobile-fixture.png',fullPage:true});
});



test('category search handles a large metadata set without changing the selected category on text filtering', async ({page}) => {
  const f=await fixture(page), region=regionOf(page);
  f.draft.categoryId.confirmed=false;
  f.meta.categories=Array.from({length:1800},(_,i)=>({id:String(i),label:'Ngành '+i,path:'Danh mục > Ngành '+i}));
  f.meta.categories.push({id:'cotton',label:'Khăn cotton',path:'Nhà cửa > Khăn cotton'});
  await region.getByRole('checkbox',{name:/Listing tinh dầu đã chuẩn bị/}).check();
  await region.getByRole('button',{name:'Tiếp tục · Bổ sung thông tin',exact:true}).click();
  const category=region.getByRole('combobox',{name:'Ngành hàng',exact:true});
  await category.selectOption('10');
  await expect(category).toHaveValue('10');
  await region.getByRole('searchbox',{name:'Tìm ngành hàng',exact:true}).fill('khan cotton');
  await expect(category.locator('option')).toHaveCount(3);
  await expect(category).toHaveValue('10');
  await category.selectOption('cotton');
  await expect(category).toHaveValue('cotton');
  await region.getByRole('searchbox',{name:'Tìm ngành hàng',exact:true}).fill('không tồn tại');
  await expect(category).toHaveValue('cotton');
  await expect(region.getByText('Không có ngành khớp.',{exact:false})).toBeVisible();
  expect(f.requests).toEqual([]);
});
