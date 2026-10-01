import { assembleFolderListing } from '../../apps/web/src/folder-source.js';
import { readyFolderBulkEntries } from '../../apps/web/src/folder-bulk-save.js';
import { describe, it, expect, vi } from 'vitest';
import ExcelJS from 'exceljs';
import { createHash, randomUUID } from 'node:crypto';
import { ContentWorkbookService } from '../../apps/api/src/content-workbook-service.js';
import type { ContentMapping } from '../../packages/domain/src/content-workbook.js';
import { matchContentRows } from '../../apps/web/src/content-workbook-match.js';
import { assembleProduct } from '../../apps/api/src/product-service.js';

async function fixture() {
  const book = new ExcelJS.Workbook(),
    sheet = book.addWorksheet('Nội dung');
  sheet.addRows([
    ['STT', 'Tiêu đề', 'Mở đầu', 'Bài đăng'],
    [222, 'Mũ bảo hiểm', 'Mở đầu\nnguyên văn', 'Nội dung\n\nhai đoạn'],
    [222, 'Một bộ khác', '', 'Nội dung khác'],
    [223, { formula: '1+1' }, '', 'Nội dung'],
  ]);
  book.addWorksheet('Sheet khác').addRows([
    ['Mã', 'Tên', 'Câu', 'Mô tả'],
    [222, 'Không phải dòng cũ', '', 'Sai'],
  ]);
  const bytes = Buffer.from(await book.xlsx.writeBuffer()),
    sha = createHash('sha256').update(bytes).digest('hex'),
    id = randomUUID();
  const record = {
    id,
    kind: 'xlsx',
    status: 'failed',
    filename: 'content.xlsx',
    bytes: bytes.length,
    sha256: sha,
    createdAt: '2026-09-23T00:00:00Z',
    body: {},
    message: 'Không có SKU',
  };
  const repo = { getImport: vi.fn(async () => record) } as any,
    blobs = { read: vi.fn(async () => bytes) };
  const service = new ContentWorkbookService(repo, blobs),
    mapping: ContentMapping = {
      importId: id,
      sha256: sha,
      sheet: 'Nội dung',
      headerRow: 1,
      columns: { stt: 'A', title: 'B', headline: 'C', body: 'D' },
      headers: { stt: 'STT', title: 'Tiêu đề', headline: 'Mở đầu', body: 'Bài đăng' },
    };
  return { service, mapping, blobs, repo, bytes, record };
}
describe('content workbook exact source', () => {
  it('reads immutable XLSX independently from failed price parsing and preserves text/cell provenance', async () => {
    const { service, mapping } = await fixture();
    const inventory = await service.inspect(mapping.importId);
    expect(inventory.priceParserStatus).toBe('failed');
    expect(inventory.sheets).toHaveLength(2);
    const result = await service.resolve({ mapping, row: 2, stt: '222' });
    expect(result.title).toBe('Mũ bảo hiểm');
    expect(result.body).toBe('Nội dung\n\nhai đoạn');
    expect(result.sources.map((s) => s.locator)).toEqual([
      'Nội dung!A2',
      'Nội dung!B2',
      'Nội dung!C2',
      'Nội dung!D2',
    ]);
    expect(result.sources.every((s) => s.fileSha256 === mapping.sha256)).toBe(true);
  });
  it('keeps duplicate STT unresolved for batch but permits explicit exact row selection', async () => {
    const { service, mapping } = await fixture();
    const { rows } = await service.rows(mapping);
    const matched = matchContentRows([{ key: 'lo/222', name: '222 Mũ bảo hiểm' }], rows);
    expect(matched.selections).toEqual({});
    expect(matched.issues.join(' ')).toContain('nhiều dòng');
    expect((await service.resolve({ mapping, row: 3, stt: '222' })).title).toBe('Một bộ khác');
  });
  it('blocks stale sheet/header, uncached formulas, invalid row identity and changed raw bytes', async () => {
    const { service, mapping, blobs } = await fixture();
    await expect(service.rows({ ...mapping, sheet: 'Sheet khác' })).rejects.toThrow(
      'CONTENT_HEADER_CHANGED',
    );
    await expect(service.rows({ ...mapping, sheet: 'Không có' })).rejects.toThrow(
      'CONTENT_SHEET_NOT_FOUND',
    );
    const { rows } = await service.rows(mapping);
    expect(rows[2]!.issues.join()).toContain('CONTENT_FORMULA_WITHOUT_VALUE');
    await expect(service.resolve({ mapping, row: 4, stt: '223' })).rejects.toThrow(
      'CONTENT_ROW_INVALID',
    );
    await expect(service.resolve({ mapping, row: 2, stt: '225' })).rejects.toThrow(
      'CONTENT_ROW_INVALID',
    );
    blobs.read.mockResolvedValue(Buffer.from('tampered'));
    await expect(service.rows(mapping)).rejects.toThrow('CONTENT_WORKBOOK_HASH_MISMATCH');
  });
  it('parses one workbook once for a batch of bindings and never accepts browser text as source', async () => {
    const { service, mapping, blobs, repo } = await fixture();
    const binding = { mapping, row: 2, stt: '222' };
    expect(await service.resolveMany([binding, { mapping, row: 3, stt: '222' }])).toHaveLength(2);
    expect(blobs.read).toHaveBeenCalledTimes(1);
    await expect(
      assembleProduct(
        repo,
        {
          expectedRevision: 0,
          title: 'Faked',
          headline: '',
          body: '',
          galleryIds: [],
          descriptionImageIds: [],
          tierNames: [],
          variants: [],
          contentBinding: binding,
        },
        blobs,
      ),
    ).rejects.toThrow('CONTENT_SELECTION_MISMATCH');
  });
});

it('feeds explicit confirmed membership into a ready batch seed without fabricating Word', async () => {
  const {service,mapping}=await fixture(),content=await service.resolve({mapping,row:2,stt:'222'});
  const id=randomUUID(),source=content.sources[0]!,fact=(value:string)=>({value,confirmed:true,sources:[source]});
  const record:any={id,filename:'bia.jpg',kind:'image',bytes:1,sha256:'a'.repeat(64),status:'ready',createdAt:source.observedAt,message:'',body:{key:id,mime:'image/jpeg',width:1000,height:1000,bytes:1,sha256:'a'.repeat(64),source}};
  const group={key:'Lo/222',name:'222',files:[{name:'bia.jpg',relativePath:'Lo/222/bia.jpg',size:1}]};
  const assembly=await assembleFolderListing({group,files:[{relativePath:group.files[0]!.relativePath,record}],productKey:'product-222',priceSource:{importId:randomUUID(),sheet:'Giá',priceProfile:null,rows:[{key:'real-row',sheet:'Giá',row:2,headerRow:1,sku:fact('REAL-SKU'),name:fact('Mũ'),originalPrice:fact('99000'),issues:[]}]},rules:{content,media:{convention:'explicit_selection',coverPath:'Lo/222/bia.jpg',galleryPaths:['Lo/222/bia.jpg'],descriptionPaths:['Lo/222/bia.jpg']},membership:{tierNames:['Dung tích'],variants:[{sku:'REAL-SKU',rowKey:'real-row',optionLabels:['300ml'],imagePath:'Lo/222/bia.jpg'}]}}});
  expect(assembly.issues.filter(i=>i.severity==='block')).toEqual([]);expect(assembly.seed?.contentBinding).toEqual(content.binding);expect(assembly.candidates.wordFiles).toEqual([]);
  const entries=readyFolderBulkEntries([assembly],{id:randomUUID(),revision:2,state:{} as any,createdAt:source.observedAt,updatedAt:source.observedAt},[]);
  expect(entries).toHaveLength(1);expect(entries[0]!.request.contentBinding).toEqual(content.binding);
});
