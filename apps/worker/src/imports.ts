import { inspectAssets, readKini, readWord } from '@shopee/domain';
import { BlobStore, Repository } from '@shopee/persistence';
export async function importNext(repo: Repository, blobs: BlobStore): Promise<boolean> {
  const job = await repo.claimImport();
  if (!job) return false;
  try {
    const bytes = await blobs.read(job.sha256);
    const body =
      job.kind === 'xlsx'
        ? await readKini(bytes, job.filename)
        : job.kind === 'docx'
          ? await readWord(bytes, job.filename)
          : (await inspectAssets([{ key: job.filename, bytes }]))[0];
    await repo.finishImport(job.id, body);
  } catch (e) {
    const code = e instanceof Error ? e.message : '';
    const known = /^(ASSET_|UNSUPPORTED_|OFFICE_|ARCHIVE_|XML_|BLOB_|INVALID_)/.test(code);
    await repo.finishImport(
      job.id,
      null,
      known ? code : 'Không đọc được tệp. Kiểm tra tệp nguồn và định dạng; bản gốc vẫn được giữ.',
    );
  }
  return true;
}
