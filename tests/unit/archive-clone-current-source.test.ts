import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ArchiveManifest } from '../../packages/domain/src/archive-clone.js';
import { compareCurrentArchiveSource } from '../../apps/api/src/archive-clone-current-source.js';

const manifest = JSON.parse(readFileSync(
  '.local/haby-archive-20260930/clone-manifest-9411abc005e25b4185bbd41ea3a07d126fda2a4e624376f18bd4ddeef817c306.json',
  'utf8')) as ArchiveManifest;
const item = manifest.items.find((row) => row.sourceItemId === '43534008943')!;

function snapshot() {
  return {
    shopId: manifest.sourceShopId, itemId: item.sourceItemId,
    observedAt: new Date().toISOString(), requestIds: ['base', 'models'],
    rawItem: structuredClone(item.rawItem), rawModels: structuredClone(item.rawModels),
  };
}
describe('current archive source comparison', () => {
  it('ignores order of ID-keyed collections and reserved-stock drift only', () => {
    const current = snapshot();
    current.rawItem.logistic_info.reverse();
    current.rawItem.attribute_list.reverse();
    current.rawModels!.model.reverse();
    for (const model of current.rawModels!.model)
      model.stock_info_v2.summary_info.total_reserved_stock += 110;
    expect(compareCurrentArchiveSource(item, current, manifest.sourceShopId)).toEqual({
      equal: true, changedPaths: [],
    });
  });
  it('accepts null model response only for a no-tier archived item', () => {
    const zero=manifest.items.find(row=>row.tierProjection.length===0)!;
    const current={shopId:manifest.sourceShopId,itemId:zero.sourceItemId,
      observedAt:new Date().toISOString(),requestIds:['base','models'],
      rawItem:structuredClone(zero.rawItem),rawModels:null};
    expect(compareCurrentArchiveSource(zero,current,manifest.sourceShopId).equal).toBe(true);
    expect(compareCurrentArchiveSource(zero,{...current,rawModels:{model:[],tier_variation:[],standardise_tier_variation:[]}},manifest.sourceShopId).equal).toBe(true);
    expect(compareCurrentArchiveSource(item,{...snapshot(),rawModels:null},manifest.sourceShopId)
      .changedPaths).toContain('models.model');
  });  it('blocks changed available stock, SKU, shipping flag and image sequence', () => {
    const current = snapshot();
    current.rawModels!.model[0].stock_info_v2.summary_info.total_available_stock += 1;
    current.rawModels!.model[0].model_sku = 'CHANGED';
    current.rawItem.logistic_info[0].is_free = !current.rawItem.logistic_info[0].is_free;
    current.rawItem.image.image_id_list.reverse();
    const result = compareCurrentArchiveSource(item, current, manifest.sourceShopId);
    expect(result.equal).toBe(false);
    expect(result.changedPaths).toContain('models.model');
    expect(result.changedPaths).toContain('item.logistic_info');
    expect(result.changedPaths).toContain('item.image');
  });
});
