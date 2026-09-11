import { expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { readWord } from '../../packages/domain/src/source/word.js';
it('preserves Word runs, blank paragraphs, line breaks, spaces and literal text', async () => {
  const bytes = zipSync({
    'word/document.xml': strToU8(
      '<w:document xmlns:w="urn:test"><w:body><w:p><w:r><w:t xml:space="preserve"> A </w:t></w:r><w:r><w:t>&amp; B</w:t><w:br/><w:t>C</w:t></w:r></w:p><w:p/><w:p><w:r><w:t>Cuối</w:t></w:r></w:p></w:body></w:document>',
    ),
  });
  expect((await readWord(bytes, 'input.docx')).paragraphs).toEqual([' A & B\nC', '', 'Cuối']);
});
it('rejects a document with entity declarations rather than evaluating external content', async () => {
  const bytes = zipSync({
    'word/document.xml': strToU8(
      '<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///etc/passwd">]><w:document/>',
    ),
  });
  await expect(readWord(bytes, 'input.docx')).rejects.toThrow('UNSUPPORTED_XML_DECLARATION');
});
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { inspectAssets } from '../../packages/domain/src/source/assets.js';
it('inspects original bytes and aspect ratio without re-encoding', async () => {
  const bytes = await sharp({ create: { width: 12, height: 16, channels: 3, background: 'white' } })
    .png()
    .toBuffer();
  const copy = Buffer.from(bytes);
  const [asset] = await inspectAssets([{ key: 'g1', bytes }]);
  expect([asset.width, asset.height, asset.sha256]).toEqual([
    12,
    16,
    createHash('sha256').update(copy).digest('hex'),
  ]);
  expect(bytes.equals(copy)).toBe(true);
});
