import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { expandListingZips, fileAtPath, planSeparateCovers, sourceSequence } from '../../apps/web/src/listing-zip.js';
import { groupDirectoryFiles } from '../../apps/web/src/folder-source.js';

const zip = (name: string, files: Record<string, Uint8Array>) => new File([new Uint8Array(zipSync(files))], name);
const image = (name: string) => new File([strToU8('original-' + name)], name, { type: 'image/jpeg' });
function groups(files: File[]) {
  return groupDirectoryFiles(files.map(file => ({ name: file.name, relativePath: file.webkitRelativePath, size: file.size })), 'parent_with_listing_folders');
}

describe('listing ZIP intake', () => {
  it('keeps each ZIP in its own listing and preserves original bytes for the existing folder reader', async () => {
    const files = await expandListingZips([zip('698 Xịt phòng.zip', { 'g1.jpg': strToU8('photo-698') }),
      zip('699 Xịt tủ.zip', { 'g1.jpg': strToU8('photo-699') })], { layout: 'one_listing_per_zip' });
    expect(groups(files).issues).toEqual([]);
    expect(groups(files).bundles.map(group => group.name)).toEqual(['698 Xịt phòng', '699 Xịt tủ']);
    expect(await files[0]!.text()).toBe('photo-698'); expect(await files[1]!.text()).toBe('photo-699');
  });
  it('opens nested ZIPs as listing folders without mixing equal image names', async () => {
    const nested = zip('batch.zip', { '698.zip': zipSync({ 'g1.jpg': strToU8('a') }), '699.zip': zipSync({ 'g1.jpg': strToU8('b') }) });
    const files = await expandListingZips([nested], { layout: 'listing_folders' });
    expect(files.map(file => file.webkitRelativePath)).toEqual(['NguonZIP/698/g1.jpg', 'NguonZIP/699/g1.jpg']);
    expect(groups(files).bundles).toHaveLength(2);
  });
  it('removes an outer wrapper only by explicit selection and rejects an ambiguous wrapper', async () => {
    const wrapped = zip('download.zip', { 'download/698/g1.jpg': strToU8('a'), 'download/699/g1.jpg': strToU8('b') });
    const kept = await expandListingZips([wrapped], { layout: 'listing_folders' });
    expect(groups(kept).bundles.map(group => group.name)).toEqual(['download']);
    const removed = await expandListingZips([wrapped], { layout: 'listing_folders', stripOuterFolder: true });
    expect(groups(removed).bundles.map(group => group.name)).toEqual(['698', '699']);
    await expect(expandListingZips([zip('two.zip', { '698/a.jpg': strToU8('a'), '699/b.jpg': strToU8('b') })],
      { layout: 'listing_folders', stripOuterFolder: true })).rejects.toThrow('không có đúng một thư mục');
  });
  it('rejects traversal, duplicate paths across archives and flat content in multi-folder mode', async () => {
    await expect(expandListingZips([zip('bad.zip', { '../outside.jpg': strToU8('a') })], { layout: 'one_listing_per_zip' })).rejects.toThrow('đường dẫn không hợp lệ');
    const a = zip('a.zip', { '698/g1.jpg': strToU8('a') }), b = zip('b.zip', { '698/g1.jpg': strToU8('b') });
    await expect(expandListingZips([a, b], { layout: 'listing_folders' })).rejects.toThrow('đường dẫn trùng');
    await expect(expandListingZips([zip('flat.zip', { 'g1.jpg': strToU8('a') })], { layout: 'listing_folders' })).rejects.toThrow('nằm ngoài thư mục');
  });
  it('enforces expansion size, entry count and nesting limits before accepting a batch', async () => {
    const big = zip('big.zip', { 'g1.jpg': strToU8('a'.repeat(100)), 'g2.jpg': strToU8('b') });
    await expect(expandListingZips([big], { layout: 'one_listing_per_zip', limits: { fileBytes: 10 } })).rejects.toThrow('vượt giới hạn');
    await expect(expandListingZips([big], { layout: 'one_listing_per_zip', limits: { entries: 1 } })).rejects.toThrow('vượt giới hạn');
    const nested = zip('outer.zip', { 'inside.zip': zipSync({ 'g1.jpg': strToU8('a') }) });
    await expect(expandListingZips([nested], { layout: 'listing_folders', limits: { depth: 1 } })).rejects.toThrow('lồng quá');
  });
  it('honors cancellation without handing partial files to the importer', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(expandListingZips([zip('698.zip', { 'g1.jpg': strToU8('a') })], { layout: 'one_listing_per_zip', signal: controller.signal })).rejects.toThrow();
  });
});

describe('separate cover folder', () => {
  it('only maps a unique explicit leading STT and keeps source cover bytes', async () => {
    const plan = planSeparateCovers([{ key: 'input/222 Mũ', name: '222 Mũ' }], [image('7_222 Bạc Hà.jpg'), image('sản phẩm 222.jpg')]);
    expect(plan.assignments).toHaveLength(1);
    expect(plan.assignments[0]!.file.webkitRelativePath).toBe('input/222 Mũ/__bia_bo_sung__/7_222 Bạc Hà.jpg');
    expect(await plan.assignments[0]!.file.text()).toBe('original-7_222 Bạc Hà.jpg');
    expect(plan.issues).toHaveLength(1); expect(sourceSequence('Xịt 300ml.jpg')).toBeNull();
  });
  it('holds duplicate STT groups and duplicate cover options instead of fuzzy matching across brands', () => {
    const duplicateGroups = [{ key: 'input/a', name: '698 ABURA' }, { key: 'input/b', name: '698 VTD' }];
    expect(planSeparateCovers(duplicateGroups, [image('698 VTD.jpg')]).assignments).toHaveLength(0);
    const plan = planSeparateCovers([duplicateGroups[0]!], [image('698 C01.jpg'), image('698 C02.jpg')]);
    expect(plan.assignments).toHaveLength(0); expect(plan.issues.every(issue => issue.includes('nhiều ảnh bìa'))).toBe(true);
    expect(planSeparateCovers([duplicateGroups[0]!], [image('698 VTD.jpg')]).assignments).toHaveLength(0);
    expect(sourceSequence('698_300.jpg')).toBe('698');
    expect(() => fileAtPath(image('a.jpg'), '../a.jpg')).toThrow();
  });
});
