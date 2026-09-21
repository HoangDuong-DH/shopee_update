import { createHash, createHmac } from 'node:crypto';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PreparedWirePlatform, type WireObject } from '../fixtures/prepared-wire-platform.js';
import { SandboxProductClient } from '../../packages/shopee/src/product-client.js';
import { readShopInfo } from '../../packages/shopee/src/shop-info.js';

const origin = 'https://openplatform.sandbox.test-stable.shopee.sg';
const path = (name: string) => '/api/v2/' + name;
const firstShop = '910000001';
const make = () => new PreparedWirePlatform({ now: () => 1_800_000_000_000 });
function signed(
  platform: PreparedWirePlatform,
  endpoint: string,
  shopId = firstShop,
  query: Record<string, string> = {},
) {
  const c = platform.credentials(shopId),
    p = path(endpoint),
    timestamp = String(Math.floor(platform.now() / 1000));
  const publicApi = endpoint === 'media_space/upload_image';
  const url = new URL(p, origin);
  const sign = createHmac('sha256', c.partnerKey)
    .update(c.partnerId + p + timestamp + (publicApi ? '' : c.accessToken + c.shopId))
    .digest('hex');
  for (const [key, value] of Object.entries({
    partner_id: c.partnerId,
    timestamp,
    sign,
    ...(publicApi ? {} : { access_token: c.accessToken, shop_id: c.shopId }),
    ...query,
  }))
    url.searchParams.set(key, value);
  return url;
}
async function send(
  platform: PreparedWirePlatform,
  endpoint: string,
  body?: WireObject,
  shopId = firstShop,
  query: Record<string, string> = {},
) {
  const response = await platform.fetch(
    signed(platform, endpoint, shopId, query),
    body
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {},
  );
  expect(response.status).toBe(200);
  return response.json() as Promise<WireObject>;
}
async function upload(platform: PreparedWirePlatform, shopId = firstShop, portrait = false) {
  const bytes = await sharp({
    create: {
      width: 12,
      height: portrait ? 16 : 12,
      channels: 3,
      background: portrait ? '#253c79' : '#b84c1f',
    },
  })
    .png()
    .toBuffer();
  const form = new FormData();
  form.set('image', new Blob([bytes], { type: 'image/png' }), 'QA.png');
  form.set('scene', 'desc');
  form.set('ratio', portrait ? '3:4' : '1:1');
  const response = await platform.fetch(signed(platform, 'media_space/upload_image', shopId), {
    method: 'POST',
    body: form,
  });
  const raw = (await response.json()) as WireObject;
  expect(raw.error).toBe('');
  return { imageId: raw.response.image_info.image_id as string, bytes };
}
async function create(
  platform: PreparedWirePlatform,
  shopId = firstShop,
  changes: WireObject = {},
) {
  const profile = platform.shops.find((shop) => shop.profile.shopId === shopId)!.profile;
  const category = profile.categories[0]!,
    cover = await upload(platform, shopId),
    gallery = await upload(platform, shopId, true);
  const body: WireObject = {
    item_name: '  QA exact  title & punctuation  ',
    description_type: 'extended',
    description_info: {
      extended_description: {
        field_list: [
          { field_type: 'text', text: 'QA đầu\n\n' },
          { field_type: 'image', image_info: { image_id: gallery.imageId } },
          { field_type: 'text', text: '\n\nGiữ nguyên chữ  và dấu.' },
        ],
      },
    },
    category_id: Number(category.categoryId),
    brand: { brand_id: Number(category.brandId), original_brand_name: category.brandName },
    attribute_list: [
      {
        attribute_id: Number(category.requiredAttribute.attributeId),
        attribute_value_list: [{ value_id: Number(category.requiredAttribute.values[0]!.valueId) }],
      },
    ],
    logistic_info: [
      { logistic_id: Number(profile.logisticsChannelId), enabled: true, is_free: false },
    ],
    weight: 0.125,
    dimension: { package_height: 4, package_length: 12, package_width: 8 },
    original_price: 51000,
    seller_stock: [{ stock: 31 }],
    item_sku: 'SAME-SKU-ALL-SHOPS',
    item_status: 'UNLIST',
    condition: 'NEW',
    pre_order: { is_pre_order: false },
    gtin_code: '00',
    image: { image_id_list: [gallery.imageId], image_ratio: '3:4' },
    promotion_images: { image_id_list: [cover.imageId] },
    ...changes,
  };
  const raw = await send(platform, 'product/add_item', body, shopId);
  expect(raw.error).toBe('');
  return { itemId: raw.response.item_id as number, body, cover, gallery };
}
function tierPayload(itemId: number, imageId: string, tierCount = 2) {
  const tiers = [
    {
      variation_id: 0,
      variation_name: 'Màu  sắc',
      variation_option_list: [
        { variation_option_id: 0, variation_option_name: 'Đỏ', image_id: imageId },
        { variation_option_id: 0, variation_option_name: 'Xanh', image_id: imageId },
      ],
    },
    ...(tierCount === 2
      ? [
          {
            variation_id: 0,
            variation_name: 'Cỡ',
            variation_option_list: [
              { variation_option_id: 0, variation_option_name: 'S' },
              { variation_option_id: 0, variation_option_name: 'L' },
            ],
          },
        ]
      : []),
  ];
  return {
    item_id: itemId,
    standardise_tier_variation: tiers,
    model: Array.from({ length: tierCount === 2 ? 4 : 2 }, (_, index) => ({
      tier_index: tierCount === 2 ? [Math.floor(index / 2), index % 2] : [index],
      model_sku: 'QA-MODEL-' + index,
      original_price: 52000 + index * 3000,
      seller_stock: [{ stock: 20 + index }],
      gtin_code: '00',
    })),
  };
}
async function withTiers(platform: PreparedWirePlatform, tierCount = 2) {
  const created = await create(platform);
  platform.advance(5000);
  const body = tierPayload(created.itemId, created.gallery.imageId, tierCount);
  const raw = await send(platform, 'product/init_tier_variation', body);
  expect(raw.error).toBe('');
  return { ...created, tierBody: body, models: raw.response.model as WireObject[] };
}
async function readBase(platform: PreparedWirePlatform, itemId: number, shopId = firstShop) {
  const raw = await send(platform, 'product/get_item_base_info', undefined, shopId, {
    item_id_list: String(itemId),
  });
  expect(raw.error).toBe('');
  return raw.response.item_list[0] as WireObject;
}
afterEach(() => vi.restoreAllMocks());

describe('prepared wire fixture: actual HTTP contracts', () => {
  it('uses the real signed shop/media clients without any outbound fetch', async () => {
    const external = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Outbound forbidden'));
    const platform = new PreparedWirePlatform(),
      c = platform.credentials(firstShop);
    const shop = await readShopInfo(c, platform.fetch);
    expect(shop).toMatchObject({
      kind: 'success',
      info: { shopName: platform.shops[0]!.profile.name, region: 'VN' },
    });
    const bytes = await sharp({
      create: { width: 12, height: 16, channels: 3, background: '#186394' },
    })
      .png()
      .toBuffer();
    const result = await new SandboxProductClient(c, platform.fetch).upload(
      bytes,
      'image/png',
      'desc',
      '3:4',
    );
    expect(result.kind).toBe('success');
    expect(platform.snapshot().images[0]).toMatchObject({
      sha256: createHash('sha256').update(bytes).digest('hex'),
      width: 12,
      height: 16,
      bytes: bytes.length,
      scene: 'desc',
      ratio: '3:4',
    });
    expect(external).not.toHaveBeenCalled();
    expect(platform.calls[1]!.query).not.toHaveProperty('shop_id');
    expect(platform.calls[1]!.query.sign).toBe('[REDACTED]');
  });

  it.each(['signature', 'timestamp', 'token', 'wrong_shop', 'duplicate_auth', 'host', 'method'])(
    'rejects %s before any mutation',
    async (fault) => {
      const platform = make(),
        url = signed(platform, 'shop/get_shop_info');
      if (fault === 'signature') url.searchParams.set('sign', '0'.repeat(64));
      if (fault === 'timestamp') {
        platform.advance(301000);
      }
      if (fault === 'token') url.searchParams.set('access_token', 'invalid');
      if (fault === 'wrong_shop') url.searchParams.set('shop_id', '910000002');
      if (fault === 'duplicate_auth') url.searchParams.append('shop_id', firstShop);
      if (fault === 'host') url.hostname = 'partner.shopeemobile.com';
      const result = await platform.fetch(url, fault === 'method' ? { method: 'POST' } : {});
      expect(((await result.json()) as WireObject).error).not.toBe('');
      expect(platform.snapshot().items).toHaveLength(0);
    },
  );

  it('returns real snake_case category/tree/brand/channel/limits shapes for each shop', async () => {
    const platform = make();
    for (const shop of platform.shops) {
      const c = shop.profile.categories[0]!,
        id = shop.profile.shopId;
      expect(
        (await send(platform, 'product/get_category', undefined, id)).response.category_list,
      ).toHaveLength(4);
      const tree = (
        await send(platform, 'product/get_attribute_tree', undefined, id, {
          category_id_list: c.categoryId,
        })
      ).response.list[0];
      expect(tree).toMatchObject({
        category_id: Number(c.categoryId),
        attribute_tree: [
          {
            mandatory: true,
            attribute_id: Number(c.requiredAttribute.attributeId),
            attribute_info: { input_type: 1 },
          },
        ],
      });
      expect(
        (
          await send(platform, 'product/get_brand_list', undefined, id, {
            category_id: c.categoryId,
            offset: '0',
            page_size: '100',
            status: '1',
          })
        ).response.brand_list[0].original_brand_name,
      ).toBe(c.brandName);
      expect(
        (await send(platform, 'logistics/get_channel_list', undefined, id)).response
          .logistics_channel_list[0].logistics_channel_id,
      ).toBe(Number(shop.profile.logisticsChannelId));
      expect(
        (
          await send(platform, 'product/get_item_limit', undefined, id, {
            category_id: c.categoryId,
          })
        ).response,
      ).toMatchObject({
        gtin_limit: { gtin_validation_rule: 'Optional' },
        price_limit: { min_limit: 1000 },
      });
    }
    expect((await send(platform, 'product/get_model_limit')).error).toBe('error_param');
    expect((await send(platform, 'product/get_attributes')).error).toBe('error_param');
  });

  it('persists zero-tier raw data, exact text and roles, isolates same SKU across three shops', async () => {
    const platform = make(),
      ids: number[] = [];
    for (const [index, shop] of platform.shops.entries()) {
      const created = await create(platform, shop.profile.shopId, {
        original_price: 51000 + index * 7000,
      });
      ids.push(created.itemId);
      const base = await readBase(platform, created.itemId, shop.profile.shopId);
      expect(base).toMatchObject({
        item_name: created.body.item_name,
        description_info: created.body.description_info,
        has_model: false,
        image: created.body.image,
        promotion_image: { image_id_list: created.body.promotion_images.image_id_list },
        price_info: [{ original_price: 51000 + index * 7000 }],
        stock_info_v2: { summary_info: { total_available_stock: 31, total_reserved_stock: 0 } },
      });
      expect(base).not.toHaveProperty('original_price');
      const models = await send(
        platform,
        'product/get_model_list',
        undefined,
        shop.profile.shopId,
        { item_id: String(created.itemId) },
      );
      expect(models.response.model).toEqual([]);
    }
    expect(new Set(ids).size).toBe(3);
    expect(
      (
        await send(platform, 'product/get_item_base_info', undefined, firstShop, {
          item_id_list: String(ids[1]),
        })
      ).error,
    ).toBe('product.error_item_not_belong_shop');
    expect(
      (
        await send(platform, 'product/get_item_list', undefined, firstShop, {
          offset: '0',
          page_size: '100',
          item_status: 'UNLIST',
        })
      ).response.total_count,
    ).toBe(1);
    const snapshot = platform.snapshot();
    snapshot.items[0]!.base.item_name = 'changed outside';
    expect((await readBase(platform, ids[0]!)).item_name).not.toBe('changed outside');
  });

  it.each([1, 2])(
    'initializes %i tier(s) only after five seconds and reverses model read order',
    async (count) => {
      const platform = make(),
        created = await create(platform),
        body = tierPayload(created.itemId, created.gallery.imageId, count);
      platform.advance(4999);
      expect((await send(platform, 'product/init_tier_variation', body)).error).toBe(
        'product.error_busi',
      );
      expect(platform.snapshot().items[0]!.models).toEqual([]);
      platform.advance(1);
      const raw = await send(platform, 'product/init_tier_variation', body);
      expect(raw.error).toBe('');
      expect(raw.response.model.map((model: WireObject) => model.model_sku)).toEqual(
        body.model.map((model) => model.model_sku).reverse(),
      );
      expect(raw.response.tier_variation[0].option_list[0]).toMatchObject({
        option: 'Đỏ',
        image: { image_id: created.gallery.imageId },
      });
      const base = await readBase(platform, created.itemId);
      expect(base.has_model).toBe(true);
      expect(base).not.toHaveProperty('price_info');
      expect(base).not.toHaveProperty('stock_info_v2');
    },
  );

  it.each([
    'partial_images',
    'second_tier_images',
    'missing_combination',
    'duplicate_index',
    'unknown_image',
  ])('rejects invalid tier contract: %s atomically', async (kind) => {
    const platform = make(),
      created = await create(platform),
      body: WireObject = tierPayload(created.itemId, created.gallery.imageId);
    platform.advance(5000);
    if (kind === 'partial_images')
      delete body.standardise_tier_variation[0].variation_option_list[1].image_id;
    if (kind === 'second_tier_images')
      body.standardise_tier_variation[1].variation_option_list.forEach(
        (option: WireObject) => (option.image_id = created.gallery.imageId),
      );
    if (kind === 'missing_combination') body.model.pop();
    if (kind === 'duplicate_index') body.model[1].tier_index = body.model[0].tier_index;
    if (kind === 'unknown_image')
      body.standardise_tier_variation[0].variation_option_list[0].image_id = 'missing';
    expect((await send(platform, 'product/init_tier_variation', body)).error).not.toBe('');
    expect(platform.snapshot().items[0]!.models).toEqual([]);
    expect((await readBase(platform, created.itemId)).has_model).toBe(false);
  });

  it('uploads by partner scope and rejects cross-partner image references', async () => {
    const platform = make(),
      first = await create(platform),
      other = await create(platform, '910000002');
    const before = platform.snapshot().items;
    const response = await send(platform, 'product/update_item', {
      item_id: first.itemId,
      image: { image_id_list: [other.gallery.imageId], image_ratio: '3:4' },
    });
    expect(response.error).not.toBe('');
    expect(platform.snapshot().items).toEqual(before);
    const shops = platform.shops.map((shop) => ({
      ...shop,
      credentials: { ...shop.credentials, partnerId: '999001', partnerKey: 'QA-SHARED-KEY' },
    }));
    const shared = new PreparedWirePlatform({ shops, now: platform.now });
    const one = await create(shared),
      two = await create(shared, '910000002');
    expect(
      (
        await send(
          shared,
          'product/update_item',
          {
            item_id: two.itemId,
            image: { image_id_list: [one.gallery.imageId], image_ratio: '3:4' },
          },
          '910000002',
        )
      ).error,
    ).toBe('');
  });

  it('mutates only explicit item fields, models/SKUs and stock; tier/model updates have envelope-only acknowledgements', async () => {
    const platform = make(),
      created = await withTiers(platform),
      before = platform.snapshot().items[0]!;
    const title = 'QA new title';
    expect(
      (await send(platform, 'product/update_item', { item_id: created.itemId, item_name: title }))
        .response.item_id,
    ).toBe(created.itemId);
    const selected = created.models[1]!,
      price = selected.price_info[0].original_price + 9000;
    expect(
      (
        await send(platform, 'product/update_price', {
          item_id: created.itemId,
          price_list: [{ model_id: selected.model_id, original_price: price }],
        })
      ).response.success_list,
    ).toEqual([{ model_id: selected.model_id, original_price: price }]);
    const stock = await send(platform, 'product/update_stock', {
      item_id: created.itemId,
      stock_list: [{ model_id: selected.model_id, seller_stock: [{ stock: 57 }] }],
    });
    expect(stock.response.success_list).toEqual([{ model_id: selected.model_id, stock: 57 }]);
    const image = await upload(platform, firstShop, true),
      tiers: WireObject[] = structuredClone(created.tierBody.standardise_tier_variation);
    tiers[0]!.variation_option_list[0]!.image_id = image.imageId;
    const tierAck = await send(platform, 'product/update_tier_variation', {
      item_id: created.itemId,
      standardise_tier_variation: tiers,
      model_list: created.models.map((model) => ({
        model_id: model.model_id,
        tier_index: model.tier_index,
      })),
    });
    expect(tierAck.error).toBe('');
    expect(tierAck).not.toHaveProperty('response');
    const modelAck = await send(platform, 'product/update_model', {
      item_id: created.itemId,
      model: [{ model_id: selected.model_id, model_sku: 'QA-changed-sku' }],
    });
    expect(modelAck.error).toBe('');
    expect(modelAck).not.toHaveProperty('response');
    const after = platform.snapshot().items[0]!,
      expected = structuredClone(before);
    expected.base.item_name = title;
    expected.base.update_time = Math.floor(platform.now() / 1000);
    expected.tiers = tiers;
    const model = expected.models.find((entry) => entry.model_id === selected.model_id)!;
    model.model_sku = 'QA-changed-sku';
    model.price_info = [{ currency: 'VND', original_price: price, current_price: price }];
    model.stock_info_v2 = {
      summary_info: { total_available_stock: 57, total_reserved_stock: 0 },
      seller_stock: [{ stock: 57, if_saleable: true }],
      shopee_stock: [],
    };
    expect(after).toEqual(expected);
  });

  it('uses model_id=0 only for zero-tier writes, never a placeholder for a tiered item', async () => {
    const platform = make(),
      zero = await create(platform);
    expect(
      (
        await send(platform, 'product/update_price', {
          item_id: zero.itemId,
          price_list: [{ model_id: 0, original_price: 74000 }],
        })
      ).response.success_list,
    ).toEqual([{ model_id: 0, original_price: 74000 }]);
    expect((await readBase(platform, zero.itemId)).price_info[0].original_price).toBe(74000);
    const tiered = await withTiers(platform);
    expect(
      (
        await send(platform, 'product/update_stock', {
          item_id: tiered.itemId,
          stock_list: [{ model_id: 0, seller_stock: [{ stock: 1 }] }],
        })
      ).error,
    ).not.toBe('');
  });

  it('exposes HTTP200 business failure, partial commit and lost acknowledgement without auto-retry', async () => {
    const platform = make(),
      created = await withTiers(platform),
      body = {
        item_id: created.itemId,
        stock_list: created.models.map((model) => ({
          model_id: model.model_id,
          seller_stock: [{ stock: 90 }],
        })),
      };
    const before = platform.snapshot().items;
    platform.faults.push({ path: path('product/update_stock'), kind: 'business_error' });
    expect((await send(platform, 'product/update_stock', body)).error).toBe('product.error_busi');
    expect(platform.snapshot().items).toEqual(before);
    platform.faults.push({ path: path('product/update_stock'), kind: 'partial', successCount: 1 });
    const partial = await send(platform, 'product/update_stock', body);
    expect(partial.error).toBe('');
    expect(partial.response.success_list).toHaveLength(1);
    expect(partial.response.failure_list).toHaveLength(3);
    expect(
      platform
        .snapshot()
        .items[0]!.models.filter(
          (model) => model.stock_info_v2.summary_info.total_available_stock === 90,
        ),
    ).toHaveLength(1);
    platform.faults.push({
      path: path('product/update_item'),
      itemId: String(created.itemId),
      kind: 'drop_response',
    });
    await expect(
      send(platform, 'product/update_item', {
        item_id: created.itemId,
        item_name: 'QA committed but response lost',
      }),
    ).rejects.toThrow('response lost');
    expect((await readBase(platform, created.itemId)).item_name).toBe(
      'QA committed but response lost',
    );
    expect(platform.calls.filter((call) => call.path === path('product/update_item'))).toHaveLength(
      1,
    );
    expect(platform.calls.find((call) => call.dropped)).toMatchObject({
      committed: true,
      dropped: true,
    });
  });

  it('loses an add response after commit and can find that exact remote via paginated reads', async () => {
    const platform = make();
    await create(platform);
    platform.faults.push({ path: path('product/add_item'), kind: 'drop_response' });
    await expect(create(platform, firstShop, { item_sku: 'QA-lost-create' })).rejects.toThrow(
      'response lost',
    );
    const first = await send(platform, 'product/get_item_list', undefined, firstShop, {
      offset: '0',
      page_size: '1',
    });
    expect(first.response).toMatchObject({ has_next_page: true, next_offset: 1, total_count: 2 });
    const second = await send(platform, 'product/get_item_list', undefined, firstShop, {
      offset: String(first.response.next_offset),
      page_size: '1',
    });
    expect((await readBase(platform, second.response.item[0].item_id)).item_sku).toBe(
      'QA-lost-create',
    );
    expect(platform.calls.filter((call) => call.path.endsWith('/add_item'))).toHaveLength(2);
  });

  it('injects unselected-field drift into independent readback', async () => {
    const platform = make(),
      created = await create(platform),
      before = await readBase(platform, created.itemId);
    platform.faults.push({
      path: path('product/update_item'),
      kind: 'alter_unselected',
      field: 'weight',
      value: '9.999',
    });
    expect(
      (
        await send(platform, 'product/update_item', {
          item_id: created.itemId,
          item_name: 'QA selected title',
        })
      ).error,
    ).toBe('');
    const after = await readBase(platform, created.itemId);
    expect(after.item_name).toBe('QA selected title');
    expect(after.weight).toBe('9.999');
    expect(after.weight).not.toBe(before.weight);
    expect(after.image).toEqual(before.image);
  });

  it('preserves upcoming, ongoing and missing promotion evidence independently from base flag', async () => {
    const platform = make(),
      created = await create(platform);
    const promotions = [
      {
        promotion_id: '18446744073709551615',
        model_id: 0,
        promotion_type: 'Campaign',
        promotion_staging: 'upcoming',
        start_time: 1800000090,
        end_time: 1800001090,
        promotion_price_info: [{ promotion_price: 12000 }],
        promotion_stock_info_v2: { total_reserved_stock: 4 },
      },
      { promotion_id: 125, model_id: 0, promotion_type: 'Discount', promotion_staging: 'ongoing' },
    ];
    platform.setPromotions(firstShop, String(created.itemId), promotions, false);
    const result = await send(platform, 'product/get_item_promotion', undefined, firstShop, {
      item_id_list: String(created.itemId),
    });
    expect(result.response.success_list).toEqual([
      { item_id: created.itemId, promotion: promotions },
    ]);
    expect((await readBase(platform, created.itemId)).has_promotion).toBe(false);
    expect(
      (
        await send(platform, 'product/update_price', {
          item_id: created.itemId,
          price_list: [{ model_id: 0, original_price: 56000 }],
        })
      ).response.failure_list,
    ).toHaveLength(1);
    platform.setPromotions(firstShop, String(created.itemId), [], true);
    expect(
      (
        await send(platform, 'product/get_item_promotion', undefined, firstShop, {
          item_id_list: String(created.itemId),
        })
      ).response.success_list[0].promotion,
    ).toEqual([]);
    expect((await readBase(platform, created.itemId)).has_promotion).toBe(true);
    platform.setPromotions(firstShop, String(created.itemId), undefined);
    expect(
      (
        await send(platform, 'product/get_item_promotion', undefined, firstShop, {
          item_id_list: String(created.itemId),
        })
      ).response.success_list[0],
    ).not.toHaveProperty('promotion');
    expect(
      (
        await send(platform, 'product/get_item_promotion', undefined, '910000002', {
          item_id_list: String(created.itemId),
        })
      ).response.failure_list,
    ).toHaveLength(1);
  });

  it('rejects corrupt files, JSON media, nonwhitelisted portrait and unknown request keys', async () => {
    const platform = make(),
      form = new FormData();
    form.set('image', new Blob(['broken PNG'], { type: 'image/png' }), 'bad.png');
    const raw = await platform.fetch(signed(platform, 'media_space/upload_image'), {
      method: 'POST',
      body: form,
    });
    expect(((await raw.json()) as WireObject).error).not.toBe('');
    expect(platform.snapshot().images).toEqual([]);
    expect((await send(platform, 'media_space/upload_image', { image: 'fake' })).error).not.toBe(
      '',
    );
    const restricted = new PreparedWirePlatform({
      now: platform.now,
      shops: platform.shops.map((shop) => ({ ...shop, allowPortrait: false })),
    });
    await expect(upload(restricted, firstShop, true)).rejects.toThrow();
    const created = await create(platform),
      before = platform.snapshot().items;
    expect(
      (
        await send(platform, 'product/update_item', {
          item_id: created.itemId,
          original_price: 70000,
        })
      ).error,
    ).not.toBe('');
    expect(platform.snapshot().items).toEqual(before);
  });

  it('records redacted auth and echoed configured secrets, supports malformed-response faults', async () => {
    const platform = make(),
      created = await create(platform),
      c = platform.credentials(firstShop);
    await send(platform, 'product/update_item', {
      item_id: created.itemId,
      item_name: 'QA ' + c.accessToken,
    });
    const audit = JSON.stringify(platform.calls);
    expect(audit).not.toContain(c.accessToken);
    expect(audit).not.toContain(c.partnerKey);
    expect(audit).toContain('[REDACTED]');
    platform.faults.push({
      path: path('product/get_item_base_info'),
      kind: 'response',
      status: 503,
      body: { error: 'error_server' },
    });
    const response = await platform.fetch(
      signed(platform, 'product/get_item_base_info', firstShop, {
        item_id_list: String(created.itemId),
      }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'error_server' });
  });
});
