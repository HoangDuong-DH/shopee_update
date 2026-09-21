import { preparedWeightKilograms } from './prepared-batch.js';
/** Shopee Product Guide 209: product channels require enabled=true, mask_channel_id=0. */
export type ProductLogisticsChannel = {
  id: string; name: string; enabled: boolean; parentId: string | null;
  forceEnabled: boolean | null; compulsory: boolean | null; feeType: string | null;
  relationsKnown: boolean; relatedEnabledChannelIds: string[];
  dependentBlockChannelIds: string[]; relatedDisabledChannelIds?: string[];
  weightKg: { min: number | null; max: number | null };
  maxDimension: { height: number | null; width: number | null; length: number | null; sum: number | null; unit: string | null };
  volume: { min: number | null; max: number | null };
};
export function productChannelIssue(c: ProductLogisticsChannel, grams?: number,
  dimensions?: { length: number; width: number; height: number }): string | undefined {
  if (c.parentId !== '0') return 'Đơn vị trực thuộc; không gửi mã này khi đăng sản phẩm.';
  if (!c.enabled) return 'Shop chưa bật kênh này.';
  if (!c.relationsKnown) return 'Chưa xác minh quy tắc liên kết kênh.';
  if (!['SIZE_INPUT', 'FIXED_DEFAULT_PRICE'].includes(c.feeType ?? '')) return 'Cần cấu hình cỡ hoặc phí riêng trước khi chọn.';
  if (!grams || !Number.isFinite(grams) || grams <= 0 || !dimensions ||
    Object.values(dimensions).some(v => !Number.isFinite(v) || v <= 0)) return 'Cần cân nặng và đủ ba kích thước kiện.';
  const positive = (v: number | null): v is number => v !== null && v > 0;
  const kg = preparedWeightKilograms(grams);
  if ((positive(c.weightKg.min) && kg < c.weightKg.min) || (positive(c.weightKg.max) && kg > c.weightKg.max)) return 'Cân nặng ngoài giới hạn của kênh.';
  const d = c.maxDimension;
  if (d.unit !== 'cm' && ![d.height,d.width,d.length,d.sum].every(v => v === 0)) return 'Chưa xác minh đơn vị giới hạn kích thước.';
  if ((['height','width','length'] as const).some(k => positive(d[k]) && dimensions[k] > d[k]!)) return 'Kiện vượt giới hạn một chiều của kênh.';
  if (positive(d.sum) && dimensions.height + dimensions.width + dimensions.length > d.sum) return 'Tổng ba chiều vượt giới hạn của kênh.';
  if (positive(c.volume.min) || positive(c.volume.max)) return 'Chưa xác minh đơn vị giới hạn thể tích.';
  return undefined;
}

/** All eligible checkout channels, with dependency closure and conflict removal. */
export function eligibleProductChannels(channels: ProductLogisticsChannel[], grams?: number,
  dimensions?: { length: number; width: number; height: number }, allowedIds?: Set<string>) {
  let selected = channels.filter(c => (!allowedIds || allowedIds.has(c.id)) && !productChannelIssue(c, grams, dimensions));
  // A disabling dependency is not a conflict between two enabled channels.
  const conflicts = new Set(selected.flatMap(c => (c.relatedDisabledChannelIds ?? [])
    .filter(id => selected.some(s => s.id === id)).flatMap(id => [c.id,id])));
  selected = selected.filter(c => !conflicts.has(c.id));
  for (;;) {
    const next = selected.filter(c => c.relatedEnabledChannelIds.every(id => selected.some(s => s.id === id)));
    if (next.length === selected.length) break;
    selected = next;
  }
  const roots = channels.filter(c => c.parentId === '0' && c.enabled);
  const missingForced = roots.some(c => c.forceEnabled && !selected.some(s => s.id === c.id));
  const compulsory = roots.filter(c => c.compulsory);
  const missingCompulsory = compulsory.length > 0 && !selected.some(c => compulsory.some(s => s.id === c.id));
  return { selected, requiredMissing: missingForced || missingCompulsory };
}
