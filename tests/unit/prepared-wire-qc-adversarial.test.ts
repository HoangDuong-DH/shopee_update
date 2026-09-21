import { randomUUID, createHash } from 'node:crypto';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PreparedDocument, PreparedMedia } from '../../packages/domain/src/index.js';
import type { FieldSnapshot } from '../../packages/shopee/src/field-client.js';
import { SandboxPreparedTransport } from '../../packages/shopee/src/prepared-transport.js';
import {
  bindPreparedWireItem,
  planPreparedWireCreate,
  type PreparedWireContext,
  type PreparedWireStep,
} from '../../packages/shopee/src/prepared-wire.js';
import {
  checkPreparedWireCreate,
  checkPreparedWireUpdate,
} from '../../packages/shopee/src/prepared-wire-qc.js';
import { PreparedWirePlatform } from '../fixtures/prepared-wire-platform.js';

type Sample = { document: PreparedDocument; context: PreparedWireContext; raw: FieldSnapshot };
const samples: Sample[] = [];
async function sourceSample(tierCount: number): Promise<Sample> {
  const platform = new PreparedWirePlatform(),
    shop = platform.shops[0]!,
    c = shop.credentials;
  const client = new SandboxPreparedTransport(
    c,
    [{ partnerId: c.partnerId, shopId: c.shopId }],
    platform.fetch,
  );
  const success = (raw: any) => {
    expect(raw.kind, JSON.stringify(raw)).toBe('success');
    return raw.response as Record<string, any>;
  };
  const images: PreparedWireContext['images'] = [];
  async function media(
    square: boolean,
    role: 'cover' | 'gallery' | 'description' | 'variation',
  ): Promise<PreparedMedia> {
    const bytes = await sharp({
      create: { width: 12, height: square ? 12 : 16, channels: 3, background: '#394D73' },
    })
      .png()
      .toBuffer();
    const source = {
      importId: randomUUID(),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      width: 12,
      height: square ? 12 : 16,
      mime: 'image/png',
    };
    const response = success(
      await client.upload(
        bytes,
        'image/png',
        role === 'description'
          ? { scene: 'desc' }
          : { scene: 'normal', ratio: square ? '1:1' : '3:4' },
      ),
    );
    images.push({
      importId: source.importId,
      sha256: source.sha256,
      role,
      imageId: response.image_info.image_id,
    });
    return source;
  }
  const cover = await media(true, 'cover'),
    gallery = await media(false, 'gallery'),
    description = await media(false, 'description'),
    variation = tierCount ? await media(true, 'variation') : undefined;
  const category = shop.profile.categories[0]!,
    attr = category.requiredAttribute,
    value = attr.values[0]!;
  const document: PreparedDocument = {
    sourceKey: 'QA-QC-SOURCE',
    title: 'QA independent source title',
    cover,
    gallery: [gallery],
    description: [
      { type: 'text', text: 'Source head\n\n' },
      { type: 'image', image: description },
      { type: 'text', text: '\n\nSource tail' },
    ],
    categoryId: category.categoryId,
    brandId: category.brandId,
    attributes: { [attr.attributeId]: [value.valueId] },
    logistics: [{ channelId: shop.profile.logisticsChannelId, enabled: true }],
    weightGrams: 125,
    dimensionCm: { length: 12, width: 8, height: 4 },
    publication: 'unlisted',
    tierNames: ['Màu', 'Cỡ'].slice(0, tierCount),
    models: Array.from({ length: tierCount ? 2 ** tierCount : 1 }, (_, index) => ({
      sku: 'QA-SKU-' + index,
      tierIndex: tierCount === 2 ? [Math.floor(index / 2), index % 2] : tierCount ? [index] : [],
      optionLabels:
        tierCount === 2
          ? ['Màu' + Math.floor(index / 2), 'Cỡ' + (index % 2)]
          : tierCount
            ? ['Màu' + index]
            : [],
      originalPrice: String(15000 + index * 100),
      stock: 10 + index,
      ...(variation ? { image: variation } : {}),
    })),
  };
  const context: PreparedWireContext = {
    images,
    brandName: category.brandName,
    condition: 'NEW',
    preOrder: { is_pre_order: false },
    gtinBySku: Object.fromEntries(document.models.map((model) => [model.sku, '00'])),
    stockLocationBySku: Object.fromEntries(document.models.map((model) => [model.sku, null])),
    attributeList: [
      {
        attribute_id: Number(attr.attributeId),
        attribute_value_list: [
          { value_id: Number(value.valueId), original_value_name: value.name },
        ],
      },
    ],
    capabilities: { gallery34: true, extendedDescription: true },
    limits: success(
      await client.read('/api/v2/product/get_item_limit', { category_id: document.categoryId }),
    ),
    channelInfoById: Object.fromEntries(
      success(await client.read('/api/v2/logistics/get_channel_list')).logistics_channel_list.map(
        (channel: any) => [String(channel.logistics_channel_id), channel],
      ),
    ),
  };
  const plan = planPreparedWireCreate(document, context);
  expect(plan.kind).toBe('ready');
  if (plan.kind !== 'ready') throw new Error(JSON.stringify(plan));
  const added = success(await client.write(plan.steps[0]!.path, plan.steps[0]!.payload)),
    itemId = String(added.item_id);
  if (plan.steps[1]) {
    platform.advance(5000);
    const step = bindPreparedWireItem(plan.steps[1], itemId);
    success(await client.write(step.path, step.payload));
  }
  const item = success(
    await client.read('/api/v2/product/get_item_base_info', { item_id_list: itemId }),
  ).item_list[0];
  const models = success(
    await client.read('/api/v2/product/get_model_list', { item_id: itemId }),
  ) as FieldSnapshot['models'];
  return { document, context, raw: { item, models } };
}
beforeAll(async () => {
  for (const count of [0, 1, 2]) samples.push(await sourceSample(count));
});
const sample = (tierCount = 2) => structuredClone(samples[tierCount]!);
function titleStep(raw: FieldSnapshot): PreparedWireStep {
  return {
    path: '/api/v2/product/update_item',
    method: 'POST',
    group: 'title',
    payload: { item_id: raw.item.item_id, item_name: 'QA new exact title' },
  };
}

describe('wire QC adversarial evidence from the actual HTTP fixture', () => {
  it.each([0, 1, 2])('accepts untouched complete %i-tier HTTP source evidence', (tiers) => {
    const { document, context, raw } = sample(tiers);
    expect(checkPreparedWireCreate(document, context, raw)).toEqual({
      verified: true,
      mismatchedPaths: [],
    });
  });

  it.each(['weight', 'dimension', 'pre_order'])(
    'rejects create model-level %s overriding the sourced inherited item value',
    (field) => {
      const { document, context, raw } = sample();
      const model = raw.models.model[0]!;
      if (field === 'weight') model.weight = '9.999';
      if (field === 'dimension')
        model.dimension = { package_length: 99, package_width: 88, package_height: 77 };
      if (field === 'pre_order') model.pre_order = { is_pre_order: true, days_to_ship: 15 };
      expect(checkPreparedWireCreate(document, context, raw).verified).toBe(false);
    },
  );

  it('rejects extra standard tiers contradicting the source and legacy tier response', () => {
    const { document, context, raw } = sample();
    (raw.models.standardise_tier_variation as any[]).push({
      variation_id: 0,
      variation_name: 'UNREQUESTED TIER',
      variation_option_list: [{ variation_option_id: 0, variation_option_name: 'extra' }],
    });
    expect(checkPreparedWireCreate(document, context, raw).verified).toBe(false);
  });

  it('rejects a request field outside the declared title group even when readback matches that accidental write', () => {
    const { raw } = sample(),
      step = titleStep(raw),
      after = structuredClone(raw);
    step.payload.weight = 9.999;
    after.item.item_name = step.payload.item_name;
    after.item.weight = '9.999';
    expect(checkPreparedWireUpdate(raw, after, [step]).verified).toBe(false);
  });

  it.each([
    'item-extra',
    'model-extra',
    'missing-field',
    'duplicate-model',
    'duplicate-attribute',
    'unsupported-path',
    'unknown-payload',
    'unselected-url',
  ])('rejects %s during a title update', (kind) => {
    const { raw } = sample(),
      after = structuredClone(raw),
      step = titleStep(raw);
    after.item.item_name = step.payload.item_name;
    if (kind === 'item-extra') {
      raw.item.unknown = { array: [] };
      after.item.unknown = { array: {} };
    }
    if (kind === 'model-extra') after.models.model[0]!.new_behavior = { enabled: true };
    if (kind === 'missing-field') delete after.item.pre_order;
    if (kind === 'duplicate-model')
      after.models.model[0]!.model_id = after.models.model[1]!.model_id;
    if (kind === 'duplicate-attribute')
      (after.item.attribute_list as any[]).push(
        structuredClone((after.item.attribute_list as any[])[0]),
      );
    if (kind === 'unsupported-path')
      step.path = '/api/v2/product/update_model' as PreparedWireStep['path'];
    if (kind === 'unknown-payload') step.payload.unsupported_property = 'data';
    if (kind === 'unselected-url') {
      raw.item.source_reference_url = 'https://reference.invalid/old';
      after.item.source_reference_url = 'https://reference.invalid/new';
    }
    expect(checkPreparedWireUpdate(raw, after, [step]).verified).toBe(false);
  });

  it('permits only known rotating image URLs/time and model order while preserving raw inputs', () => {
    const { raw } = sample(),
      original = structuredClone(raw),
      after = structuredClone(raw),
      step = titleStep(raw);
    after.item.item_name = step.payload.item_name;
    after.item.update_time = 999;
    (after.item.image as any).image_url_list = ['https://cdn.invalid/rotated'];
    for (const tier of after.models.tier_variation as any[])
      for (const option of tier.option_list)
        if (option.image) option.image.image_url = 'https://cdn.invalid/rotated';
    after.models.model.reverse();
    expect(checkPreparedWireUpdate(raw, after, [step])).toEqual({
      verified: true,
      mismatchedPaths: [],
    });
    expect(raw).toEqual(original);
  });
});
