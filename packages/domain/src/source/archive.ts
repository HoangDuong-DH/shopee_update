import { unzipSync } from 'fflate';
export function checkOfficeArchive(bytes: Uint8Array): void {
  if (bytes.byteLength > 64 * 1024 * 1024) throw new Error('SOURCE_FILE_TOO_LARGE');
  let total = 0;
  unzipSync(bytes, {
    filter(file) {
      total += file.originalSize;
      if (total > 128 * 1024 * 1024) throw new Error('SOURCE_ARCHIVE_TOO_LARGE');
      return false;
    },
  });
}
