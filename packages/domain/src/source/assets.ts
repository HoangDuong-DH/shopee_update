import sharp from 'sharp';
import { createHash } from 'node:crypto';
import type { AssetRef } from '../contracts.js';
export async function inspectAssets(
  files: { key: string; bytes: Uint8Array }[],
): Promise<AssetRef[]> {
  const assets: AssetRef[] = [];
  for (const file of files) {
    if (file.bytes.byteLength > 32 * 1024 * 1024) throw new Error('ASSET_FILE_TOO_LARGE');
    const meta = await sharp(Buffer.from(file.bytes), { limitInputPixels: 100_000_000 }).metadata();
    if (
      !meta.format ||
      !['png', 'jpeg', 'webp'].includes(meta.format) ||
      !meta.width ||
      !meta.height
    )
      throw new Error('UNSUPPORTED_IMAGE');
    const sha256 = createHash('sha256').update(file.bytes).digest('hex');
    assets.push({
      key: file.key,
      sha256,
      bytes: file.bytes.byteLength,
      mime: `image/${meta.format}`,
      width: meta.width,
      height: meta.height,
      source: {
        kind: 'product_file',
        fileSha256: sha256,
        filename: file.key,
        locator: file.key,
        observedAt: new Date().toISOString(),
      },
    });
  }
  return assets;
}
