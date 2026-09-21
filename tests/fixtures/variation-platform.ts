import assert from 'node:assert/strict';
import type { FieldSnapshot } from '../../packages/shopee/src/field-client.js';

type ObjectValue = Record<string, any>;
export type VariationSnapshot = {
  item: ObjectValue;
  models: {
    model: ObjectValue[];
    tier_variation: ObjectValue[];
    standardise_tier_variation?: ObjectValue[];
    [key: string]: any;
  };
};
const clone = <T>(value: T): T => structuredClone(value);
const imageUrl = (imageId: string) => `https://fixture.invalid/file/${imageId}`;

function stock(quantity: number, location = 'QA-W1') {
  return {
    seller_stock: [{ location_id: location, stock: quantity, if_saleable: true }],
    shopee_stock: [],
    summary_info: { total_reserved_stock: 0, total_available_stock: quantity },
    advance_stock: { sellable_advance_stock: 0, in_transit_advance_stock: 0 },
  };
}

export function variationRawFixture(tierCount: 0 | 1 | 2): VariationSnapshot {
  const names = ['Màu nguồn', 'Quy cách nguồn'].slice(0, tierCount);
  const options = [
    ['Cam', 'Xanh'],
    ['80 trang', '120 trang'],
  ].slice(0, tierCount);
  const standard = names.map((name, tier) => ({
    variation_id: 0,
    variation_name: name,
    variation_option_list: options[tier]!.map((option, index) => ({
      variation_option_id: 0,
      variation_option_name: option,
      ...(tier === 0
        ? { image_id: `option-source-${index}`, image_url: imageUrl(`option-source-${index}`) }
        : {}),
    })),
  }));
  const modelCount = tierCount === 0 ? 0 : 2 ** tierCount;
  return {
    item: {
      item_id: 970001,
      item_name: 'SANDBOX QA independently authored variant source',
      item_sku: tierCount ? 'QA-VARIATION-SOURCE' : 'QA-SOLE-SKU',
      item_status: 'UNLIST',
      category_id: 301378,
      has_model: tierCount > 0,
      has_promotion: false,
      is_fulfillment_by_shopee: false,
      create_time: 1789360000,
      update_time: 1789360010,
      description_type: 'normal',
      description: 'Exact source\n\nKeep all contents and prices outside this command.',
      brand: { brand_id: 0, original_brand_name: 'NoBrand' },
      image: {
        image_ratio: '3:4',
        image_id_list: ['gallery-source'],
        image_url_list: [imageUrl('gallery-source')],
      },
      promotion_image: {
        image_id_list: ['cover-source'],
        image_url_list: [imageUrl('cover-source')],
      },
      attribute_list: [
        {
          attribute_id: 200134,
          attribute_value_list: [
            { value_id: 101205, original_value_name: '[S]Paper', value_unit: '' },
          ],
        },
      ],
      weight: '0.2',
      dimension: { package_length: 21, package_width: 15, package_height: 2 },
      logistic_info: [
        {
          logistic_id: 50040,
          enabled: true,
          is_free: false,
          size_id: 0,
          estimated_shipping_fee: 50000,
        },
      ],
      pre_order: { is_pre_order: false, days_to_ship: 2 },
      condition: 'NEW',
      ...(tierCount === 0
        ? {
            price_info: [{ currency: 'VND', original_price: 20000, current_price: 20000 }],
            stock_info_v2: stock(3),
          }
        : {}),
      protected_fixture_value: { retain: [], do_not_drop: { fixed: 'item' } },
    },
    models: {
      model: Array.from({ length: modelCount }, (_, index) => {
        const tierIndex = tierCount === 1 ? [index] : [Math.floor(index / 2), index % 2];
        return {
          model_id: 880001 + index,
          model_sku: `QA-SKU-${index + 1}`,
          model_name: tierIndex.map((option, tier) => options[tier]![option]).join(','),
          tier_index: tierIndex,
          model_status: 'MODEL_NORMAL',
          has_promotion: false,
          is_fulfillment_by_shopee: false,
          price_info: [
            {
              currency: 'VND',
              original_price: 20100 + 100 * index,
              current_price: 20100 + 100 * index,
            },
          ],
          stock_info_v2: stock(4 + index),
          weight: '0.2',
          dimension: { package_length: 21, package_width: 15, package_height: 2 },
          pre_order: { is_pre_order: false, days_to_ship: 2 },
          protected_fixture_value: { retain: [], fixed_model_identity: `KEEP-${index}` },
        };
      }),
      tier_variation: names.map((name, tier) => ({
        name,
        option_list: options[tier]!.map((option, index) => ({
          option,
          ...(tier === 0
            ? {
                image: {
                  image_id: `option-source-${index}`,
                  image_url: imageUrl(`option-source-${index}`),
                },
              }
            : {}),
        })),
      })),
      ...(tierCount > 0 ? { standardise_tier_variation: standard } : {}),
    },
  };
}

/** Endpoint interpreter independent of mutation planner/checker. No outbound network. */
export class VariationPlatform {
  state: VariationSnapshot;
  readonly calls: { method: string; path: string; payload?: ObjectValue }[] = [];
  readonly writes: {
    path: string;
    payload: ObjectValue;
    before: FieldSnapshot;
    after: FieldSnapshot;
  }[] = [];
  fault?: { path: string; kind: 'partial_add' | 'lose_after_commit' | 'reject_before_commit' };
  promotions: ObjectValue[] = [];
  beforeWrite?: (path: string, payload: ObjectValue) => Promise<void>;
  private nextModelId = 990001;
  constructor(baseline: FieldSnapshot) {
    this.state = clone(baseline) as VariationSnapshot;
  }
  read() {
    return clone(this.state);
  }
  private response(response?: ObjectValue, error = '') {
    return new Response(
      JSON.stringify({
        error,
        message: error ? 'Explicit fixture outcome' : '',
        request_id: `independent-variant-fixture-${this.calls.length}`,
        ...(response === undefined ? {} : { response }),
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  private setTiers(standard: ObjectValue[]) {
    this.state.models.standardise_tier_variation = standard.map((tier) => ({
      ...clone(tier),
      variation_option_list: tier.variation_option_list.map((option: ObjectValue) => ({
        ...clone(option),
        ...(option.image_id ? { image_url: imageUrl(option.image_id) } : {}),
      })),
    }));
    this.state.models.tier_variation = standard.map((tier) => ({
      name: tier.variation_name,
      option_list: tier.variation_option_list.map((option: ObjectValue) => ({
        option: option.variation_option_name,
        ...(option.image_id
          ? { image: { image_id: option.image_id, image_url: imageUrl(option.image_id) } }
          : {}),
      })),
    }));
  }
  private name(indices: number[]) {
    return indices
      .map((option, tier) => {
        const row = this.state.models.tier_variation[tier]?.option_list?.[option];
        assert(row, 'request addresses a nonexistent tier option');
        return row.option;
      })
      .join(',');
  }
  private add(input: ObjectValue) {
    assert(
      !this.state.models.model.some(
        (row) => JSON.stringify(row.tier_index) === JSON.stringify(input.tier_index),
      ),
      'request adds an occupied tier index',
    );
    assert(Number.isSafeInteger(input.original_price) && input.original_price > 0);
    assert(Array.isArray(input.seller_stock) && input.seller_stock.length === 1);
    assert(Number.isSafeInteger(input.seller_stock[0].stock) && input.seller_stock[0].stock >= 0);
    assert.equal(input.seller_stock[0].location_id, 'QA-W1');
    const value = {
      model_id: this.nextModelId++,
      model_sku: input.model_sku,
      tier_index: clone(input.tier_index),
      model_name: this.name(input.tier_index),
      model_status: 'MODEL_NORMAL',
      has_promotion: false,
      is_fulfillment_by_shopee: false,
      price_info: [
        {
          currency: 'VND',
          original_price: input.original_price,
          current_price: input.original_price,
        },
      ],
      stock_info_v2: stock(input.seller_stock[0].stock),
      weight: this.state.item.weight,
      dimension: clone(this.state.item.dimension),
      pre_order: clone(this.state.item.pre_order),
      ...(input.gtin_code === undefined ? {} : { gtin_code: input.gtin_code }),
    };
    this.state.models.model.push(value);
    return {
      model_id: value.model_id,
      model_sku: value.model_sku,
      tier_index: clone(value.tier_index),
      price_info: [{ original_price: input.original_price }],
      seller_stock: clone(input.seller_stock),
    };
  }
  readonly fetch: typeof fetch = async (urlInput, init) => {
    const url = new URL(String(urlInput));
    assert.equal(url.hostname, 'openplatform.sandbox.test-stable.shopee.sg');
    const method = init?.method ?? 'GET';
    const payload = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.calls.push({
      method,
      path: url.pathname,
      ...(payload ? { payload: clone(payload) } : {}),
    });
    if (method === 'GET') {
      if (url.pathname.endsWith('/get_item_base_info'))
        return this.response({ item_list: [clone(this.state.item)] });
      if (url.pathname.endsWith('/get_model_list')) return this.response(clone(this.state.models));
      if (url.pathname.endsWith('/get_item_limit'))
        return this.response({ item_name_length_limit: { min_limit: 1, max_limit: 200 } });
      if (url.pathname.endsWith('/get_item_promotion'))
        return this.response({
          success_list: [{ item_id: this.state.item.item_id, promotion: clone(this.promotions) }],
          failure_list: [],
        });
      throw new Error(`Unexpected fixture read endpoint ${url.pathname}`);
    }
    assert.equal(method, 'POST');
    assert.equal(payload.item_id, this.state.item.item_id);
    await this.beforeWrite?.(url.pathname, clone(payload));
    const fault = this.fault?.path === url.pathname ? this.fault : undefined;
    if (fault?.kind === 'reject_before_commit')
      return this.response(undefined, 'product.error_busi');
    const before = this.read();
    let response: ObjectValue | undefined;
    if (url.pathname.endsWith('/update_tier_variation')) {
      const old = new Map(this.state.models.model.map((model) => [model.model_id, clone(model)]));
      this.setTiers(payload.standardise_tier_variation);
      const selectedIds = payload.model_list.map((model: ObjectValue) => model.model_id);
      assert.equal(new Set(selectedIds).size, selectedIds.length);
      this.state.models.model = payload.model_list.map((selection: ObjectValue) => {
        const model = old.get(selection.model_id);
        assert(model, 'unknown keeper model ID');
        return {
          ...model,
          tier_index: clone(selection.tier_index),
          model_name: this.name(selection.tier_index),
        };
      });
    } else if (url.pathname.endsWith('/add_model')) {
      const adds =
        fault?.kind === 'partial_add' ? payload.model_list.slice(0, 1) : payload.model_list;
      response = { model: adds.map((source: ObjectValue) => this.add(source)) };
    } else if (url.pathname.endsWith('/delete_model')) {
      assert(this.state.models.model.some((model) => model.model_id === payload.model_id));
      assert(
        this.state.models.model.length > 1,
        'fixture does not infer collapse from deleting last model',
      );
      this.state.models.model = this.state.models.model.filter(
        (model) => model.model_id !== payload.model_id,
      );
    } else if (url.pathname.endsWith('/init_tier_variation')) {
      this.setTiers(payload.standardise_tier_variation);
      this.state.models.model = [];
      this.state.item.has_model = payload.standardise_tier_variation.length > 0;
      if (this.state.item.has_model) {
        delete this.state.item.price_info;
        delete this.state.item.stock_info_v2;
        delete this.state.item.gtin_code;
        response = {
          item_id: this.state.item.item_id,
          model: payload.model.map((source: ObjectValue) => this.add(source)),
        };
      } else {
        delete this.state.models.standardise_tier_variation;
        assert.equal(payload.model.length, 1);
        const source = payload.model[0];
        assert.deepEqual(source.tier_index, []);
        assert.equal(source.model_sku, this.state.item.item_sku);
        this.state.item.price_info = [
          {
            currency: 'VND',
            original_price: source.original_price,
            current_price: source.original_price,
          },
        ];
        this.state.item.stock_info_v2 = stock(
          source.seller_stock[0].stock,
          source.seller_stock[0].location_id,
        );
        if (source.gtin_code !== undefined) this.state.item.gtin_code = source.gtin_code;
        response = {
          item_id: this.state.item.item_id,
          model: [
            {
              model_id: 0,
              model_sku: source.model_sku,
              tier_index: [],
              price_info: [{ original_price: source.original_price }],
              seller_stock: clone(source.seller_stock),
            },
          ],
        };
      }
    } else if (url.pathname.endsWith('/update_item')) {
      assert.deepEqual(Object.keys(payload).sort(), ['item_id', 'item_name']);
      this.state.item.item_name = payload.item_name;
      response = { item_id: this.state.item.item_id };
    } else if (url.pathname.endsWith('/update_model')) {
      for (const update of payload.model) {
        const model = this.state.models.model.find((row) => row.model_id === update.model_id);
        assert(model);
        model.model_sku = update.model_sku;
      }
    } else throw new Error(`Unexpected fixture mutation endpoint ${url.pathname}`);
    this.writes.push({ path: url.pathname, payload: clone(payload), before, after: this.read() });
    if (fault?.kind === 'lose_after_commit')
      throw new Error('Intentional lost response after fixture commit');
    return this.response(response);
  };
}
