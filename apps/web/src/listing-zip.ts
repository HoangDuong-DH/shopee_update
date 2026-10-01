import { unzip, unzipSync } from 'fflate';

export type ListingZipLayout = 'one_listing_per_zip' | 'listing_folders';
export type ListingZipLimits = { compressedBytes: number; expandedBytes: number; fileBytes: number; entries: number; depth: number };
const defaults: ListingZipLimits = { compressedBytes: 512 * 1024 * 1024, expandedBytes: 1024 * 1024 * 1024,
  fileBytes: 64 * 1024 * 1024, entries: 5000, depth: 3 };
export type ListingZipProgress = { archive: string; extractedFiles: number };
const ignored = (path: string) => path.startsWith('__MACOSX/') || path.split('/').at(-1) === '.DS_Store';

function checkedPath(value: string): string {
  if (!value || value.length > 1024 || value.startsWith('/') || /[\\:\u0000-\u001f]/.test(value)
    || value.split('/').some(part => !part || part === '.' || part === '..' || part.length > 255))
    throw Error('ZIP có đường dẫn không hợp lệ. Kiểm tra lại tệp nguồn; chưa nhập dữ liệu.');
  return value.normalize('NFC');
}
export function fileAtPath(bytes: Uint8Array | File, path: string): File {
  checkedPath(path);
  const name = path.split('/').at(-1)!;
  const type = /\.png$/i.test(name) ? 'image/png' : /\.jpe?g$/i.test(name) ? 'image/jpeg'
    : /\.webp$/i.test(name) ? 'image/webp' : 'application/octet-stream';
  // The archive is only a container: extracted bytes enter the existing immutable importer.
  const file = new File([bytes instanceof File ? bytes : new Uint8Array(bytes)], name, { type, lastModified: 0 });
  Object.defineProperty(file, 'webkitRelativePath', { value: path });
  return file;
}

export async function expandListingZips(archives: File[], options: {
  layout: ListingZipLayout; stripOuterFolder?: boolean; limits?: Partial<ListingZipLimits>;
  signal?: AbortSignal; onProgress?: (value: ListingZipProgress) => void;
}): Promise<File[]> {
  const limits = { ...defaults, ...options.limits };
  if (!archives.length || archives.some(file => !/\.zip$/i.test(file.name))
    || archives.reduce((sum, file) => sum + file.size, 0) > limits.compressedBytes)
    throw Error('Chọn ZIP với tổng dung lượng nén tối đa 512 MB; có thể chia thành nhiều lần nhập.');
  if (!['one_listing_per_zip', 'listing_folders'].includes(options.layout)) throw Error('Chọn cấu trúc ZIP trước khi đọc.');
  let expanded = 0, entries = 0;
  const output: File[] = [], seen = new Set<string>();
  const unpack = async (bytes: Uint8Array, depth: number, prefix: string): Promise<{ path: string; bytes: Uint8Array }[]> => {
    options.signal?.throwIfAborted();
    if (depth > limits.depth) throw Error('ZIP lồng quá 3 tầng. Giải nén bớt một tầng rồi nhập lại.');
    const names = new Set<string>();
    try {
      // Inspect all central entries before allocating decompressed buffers. Nothing is extracted here.
      unzipSync(bytes, { filter(entry) {
        if (++entries > limits.entries) throw Error('ZIP vượt giới hạn 5.000 mục kể cả thư mục. Chia lô nhỏ hơn.');
        const directory = entry.name.endsWith('/'), path = checkedPath(directory ? entry.name.slice(0, -1) : entry.name);
        const identity = path.toLocaleLowerCase('vi');
        if (names.has(identity)) throw Error('ZIP có hai đường dẫn trùng nhau; cần đổi tên trước khi nhập.');
        names.add(identity);
        if (ignored(path) || directory) return false;
        expanded += entry.originalSize;
        if (!Number.isSafeInteger(entry.originalSize) || entry.originalSize < 0
          || entry.originalSize > (/\.zip$/i.test(path) ? limits.compressedBytes : limits.fileBytes) || expanded > limits.expandedBytes)
          throw Error('ZIP vượt giới hạn: 5.000 tệp, 64 MB/tệp hoặc 1 GB sau giải nén. Chia lô nhỏ hơn.');
        return false;
      } });
    } catch (error) {
      if (error instanceof Error && /^(ZIP|Chọn)/.test(error.message)) throw error;
      throw Error('ZIP bị lỗi hoặc chưa được hỗ trợ. Giữ tệp gốc và thử giải nén bằng công cụ trên máy.');
    }
    const content = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
      let settled = false;
      const abort = () => { if (!settled) { settled = true; terminate(); reject(Error('Đã dừng đọc ZIP.')); } };
      const terminate = unzip(bytes, { filter: entry => !entry.name.endsWith('/') && !ignored(entry.name) }, (error, files) => {
        options.signal?.removeEventListener('abort', abort);
        if (settled) return; settled = true;
        if (error) reject(Error('Không giải nén được ZIP. Chưa nhập các tệp của lần chọn này.')); else resolve(files);
      });
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
    });
    const result: { path: string; bytes: Uint8Array }[] = [];
    for (const [raw, contentBytes] of Object.entries(content).sort(([a], [b]) => a.localeCompare(b, 'vi', { numeric: true }))) {
      options.signal?.throwIfAborted();
      const path = checkedPath(prefix + checkedPath(raw));
      if (/\.zip$/i.test(path)) result.push(...await unpack(contentBytes, depth + 1, path.slice(0, -4) + '/'));
      else result.push({ path, bytes: contentBytes });
    }
    return result;
  };
  for (const archive of archives) {
    const stem = checkedPath(archive.name.slice(0, -4));
    let files = await unpack(new Uint8Array(await archive.arrayBuffer()), 1, '');
    if (!files.length) throw Error(`ZIP ${archive.name} không có tệp nguồn để nhập.`);
    if (options.stripOuterFolder) {
      const first = files[0]!.path.split('/')[0];
      if (files.some(file => !file.path.startsWith(first + '/')))
        throw Error(`ZIP ${archive.name} không có đúng một thư mục bao ngoài. Bỏ chọn tùy chọn bỏ tầng thư mục.`);
      files = files.map(file => ({ ...file, path: file.path.slice(first!.length + 1) }));
    }
    for (const entry of files) {
      const path = checkedPath('NguonZIP/' + (options.layout === 'one_listing_per_zip' ? stem + '/' : '') + entry.path);
      if (options.layout === 'listing_folders' && entry.path.split('/').length < 2)
        throw Error(`Tệp ${entry.path} nằm ngoài thư mục listing. Chọn “Mỗi ZIP là một listing” hoặc sửa bố cục ZIP.`);
      if (seen.has(path.toLocaleLowerCase('vi'))) throw Error(`Hai ZIP có đường dẫn trùng: ${path}. Chọn riêng để tránh ghép nhầm.`);
      seen.add(path.toLocaleLowerCase('vi')); output.push(fileAtPath(entry.bytes, path));
    }
    options.onProgress?.({ archive: archive.name, extractedFiles: output.length });
  }
  return output;
}

export function sourceSequence(name: string): string | null {
  // An explicit leading STT only. No fuzzy title match and no number from a volume suffix.
  const match = name.normalize('NFC').match(/^(?:\d{1,2}_)?(\d{2,4})(?=[\s._-]|$)/);
  return match ? String(Number(match[1])) : null;
}
export function planSeparateCovers(groups: { key: string; name: string }[], files: File[]) {
  const assignments: { groupKey: string; original: File; file: File }[] = [], issues: string[] = [];
  const images = files.filter(file => /\.(png|jpe?g|webp)$/i.test(file.name));
  const brand = (name: string) => {
    const text = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toUpperCase();
    if (/\bABURA\b/.test(text)) return 'ABURA';
    if (/\bVINA\s*TUOI\b/.test(text)) return 'VINA_TUOI';
    if (/\b(?:VUA\s*TINH\s*DAU|VTD)\b/.test(text)) return 'VUA_TINH_DAU';
    if (/\bTDSC\b/.test(text)) return 'TDSC';
    return null;
  };
  for (const file of images) {
    const sequence = sourceSequence(file.name), matches = groups.filter(group => sequence !== null && sourceSequence(group.name) === sequence);
    const sameCovers = images.filter(other => sequence !== null && sourceSequence(other.name) === sequence);
    if (!sequence || matches.length !== 1 || sameCovers.length !== 1) {
      issues.push(`${file.name}: ${!sequence ? 'không có STT rõ ở đầu tên' : matches.length === 0 ? 'không có bộ cùng STT' : matches.length > 1 ? 'nhiều bộ cùng STT' : 'nhiều ảnh bìa cùng STT'}; chưa tự gán.`);
      continue;
    }
    const coverBrand = brand(file.name), groupBrand = brand(matches[0]!.name);
    if (coverBrand && groupBrand && coverBrand !== groupBrand) {
      issues.push(`${file.name}: STT khớp nhưng thương hiệu trong tên khác thư mục listing; chưa tự gán.`); continue;
    }
    assignments.push({ groupKey: matches[0]!.key, original: file,
      file: fileAtPath(file, matches[0]!.key + '/__bia_bo_sung__/' + file.name) });
  }
  if (!images.length) issues.push('Thư mục bìa chưa có ảnh PNG, JPEG hoặc WebP.');
  return { assignments, issues };
}
