import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
const caseName = process.argv.includes('--restored') ? 'cover-restore' : 'gallery-portrait';
const folder = '.local/acceptance-20260914/patch-matrix/live/' + caseName;
const intent = JSON.parse(await readFile(folder + '/intent.json', 'utf8'));
const result = JSON.parse(await readFile(folder + '/result.json', 'utf8'));
if (intent.itemId !== '803935036' || result.operationId !== intent.id)
  throw new Error('EVIDENCE_SCOPE_REQUIRED');
const originalIntent = JSON.parse(
  await readFile(
    '.local/acceptance-20260914/patch-matrix/live/gallery-portrait/intent.json',
    'utf8',
  ),
);
const before = originalIntent.before.snapshot.item.promotion_image;
const after = result.readback.observations.at(-1).snapshot.item.promotion_image;
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const output: any[] = [];
for (const [name, image] of [
  ['before', before],
  ['after', after],
] as const) {
  const url = new URL(image.image_url_list[0]);
  if (
    url.origin !== 'https://cf.shopee.vn' ||
    url.pathname !== '/file/' + image.image_id_list[0] ||
    url.search
  )
    throw new Error('OBSERVED_IMAGE_URL_REQUIRED');
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error('IMAGE_READ_FAILED_' + response.status);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 20_000_000) throw new Error('IMAGE_TOO_LARGE');
  const metadata = await sharp(bytes).metadata();
  const decoded = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  await writeFile(folder + '/cover-' + name + '.png', await sharp(bytes).png().toBuffer());
  output.push({
    name,
    imageId: image.image_id_list[0],
    url: url.toString(),
    mime: response.headers.get('content-type'),
    bytes: bytes.length,
    sha256: hash(bytes),
    format: metadata.format,
    width: metadata.width,
    height: metadata.height,
    pixelSha256: hash(decoded.data),
    decodedInfo: decoded.info,
  });
}
const report = {
  observedAt: new Date().toISOString(),
  mode: 'readonly-image-comparison',
  itemId: intent.itemId,
  operationId: intent.id,
  images: output,
  bytesEqual: output[0].sha256 === output[1].sha256,
  decodedPixelsEqual:
    output[0].width === output[1].width &&
    output[0].height === output[1].height &&
    output[0].pixelSha256 === output[1].pixelSha256,
  noMutations: true,
};
await writeFile(folder + '/cover-identity.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
