import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
const receipt = JSON.parse(await readFile('.local/acceptance-20260914/prepared-business-latest.json', 'utf8'));
if (!receipt.outcomes.length || receipt.outcomes.some((row: any) => row.status !== 'passed'))
  throw new Error('Only package the fully passed acceptance run.');
const root = resolve(receipt.evidenceRoot), allowed = resolve('.local/acceptance-20260914/business-batch');
if (!root.startsWith(allowed + sep)) throw new Error('Evidence path is outside the acceptance workspace.');
const manifest = JSON.parse(await readFile(join(root, 'source-manifest.json'), 'utf8'));
const archive: Record<string, Uint8Array> = {};
for (const file of manifest.files) {
  const path = resolve(file.path);
  if (!path.startsWith(root + sep) || file.relativePath.split('/').some((part: string) => part === '..' || part === '.'))
    throw new Error('Fixture path mismatch.');
  const bytes = await readFile(path);
  if (createHash('sha256').update(bytes).digest('hex') !== file.sha256 || bytes.length !== file.bytes)
    throw new Error('Fixture content changed.');
  archive[file.relativePath] = bytes;
}
archive['HUONG-DAN.txt'] = strToU8(`BỘ DỮ LIỆU THỬ 80 LISTING — HOÀN TOÀN GIẢ LẬP\n\n80 Word, 440 ảnh, 200 SKU, 3 shop và 4 ngành giả lập.\nGiải nén toàn bộ; Excel chung nằm ngoài thư mục 80-business-listings.\nMỗi thư mục con là một listing. Sheet Điều phối listing xác định đúng shop, ngành, sheet giá, vai trò/thứ tự ảnh. Các sheet QA Bắc/Trung/Nam chứa giá, tồn và phân loại.\n\nĐã kiểm thử bằng ứng dụng thật tại máy và phía nhận listing mô phỏng riêng. Không dùng các mã shop/ngành hoặc nội dung trong bộ này để đăng Shopee thật. Ứng dụng chính không tự tạo kết nối giả lập khi nhập tệp.\n\nẢnh/Word là dữ liệu thử, không phải nguồn kinh doanh do doanh nghiệp cung cấp. Nội dung, giá và ảnh Lamy gốc không được thay đổi.\n`);
await mkdir('.local/acceptance-20260914/prepared-delivery', { recursive: true });
const output = resolve('.local/acceptance-20260914/prepared-delivery/Bo-du-lieu-thu-80-listing.zip');
const bytes = zipSync(archive, { level: 6 }); await writeFile(output, bytes);
const summary = { output, evidenceRoot: root, sourceFiles: manifest.files.length, sourceBytes: manifest.files.reduce((sum: number, file: any) => sum + file.bytes, 0), zipBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), expected: manifest.expected };
await writeFile('.local/acceptance-20260914/prepared-delivery/package.json', JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ output, sourceFiles: summary.sourceFiles, sourceBytes: summary.sourceBytes, zipBytes: summary.zipBytes }));
