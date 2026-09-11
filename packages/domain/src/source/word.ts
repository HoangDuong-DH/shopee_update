import { unzipSync, strFromU8 } from 'fflate';
import { XMLParser } from 'fast-xml-parser';
import { createHash } from 'node:crypto';
import type { WordImport } from '../contracts.js';
import { checkOfficeArchive } from './archive.js';
type XmlNode = Record<string, unknown>;
function textIn(nodes: XmlNode[]): string {
  let out = '';
  for (const node of nodes)
    for (const [key, value] of Object.entries(node)) {
      if (key === 'w:br' || key === 'w:cr') out += '\n';
      else if (key === 'w:tab') out += '\t';
      else if (key === '#text') out += String(value);
      else if (
        ![':@', 'w:del', 'w:delText', 'w:instrText', 'w:drawing', 'w:pPr', 'w:rPr'].includes(key) &&
        Array.isArray(value)
      )
        out += textIn(value as XmlNode[]);
    }
  return out;
}
export async function readWord(bytes: Uint8Array, filename = 'document.docx'): Promise<WordImport> {
  checkOfficeArchive(bytes);
  const files = unzipSync(bytes, { filter: (file) => file.name === 'word/document.xml' });
  const content = files['word/document.xml'];
  if (!content) throw new Error('WORD_DOCUMENT_MISSING');
  const xml = strFromU8(content);
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('UNSUPPORTED_XML_DECLARATION');
  const nodes = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    trimValues: false,
    parseTagValue: false,
  }).parse(xml) as XmlNode[];
  const paragraphs: string[] = [];
  function visit(items: XmlNode[]) {
    for (const node of items)
      for (const [key, value] of Object.entries(node)) {
        if (key === 'w:p')
          paragraphs.push(textIn(Array.isArray(value) ? (value as XmlNode[]) : []));
        else if (Array.isArray(value) && !['w:del', 'w:drawing'].includes(key))
          visit(value as XmlNode[]);
      }
  }
  visit(nodes);
  return {
    paragraphs,
    source: {
      kind: 'product_file',
      fileSha256: createHash('sha256').update(bytes).digest('hex'),
      filename,
      locator: filename,
      observedAt: new Date().toISOString(),
    },
  };
}
