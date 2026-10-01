import { inspectAssets, readKini, readWord } from '@shopee/domain';
import { BlobStore, Repository } from '@shopee/persistence';
export async function importNext(repo: Repository, blobs: BlobStore,
  options: { workerId?: string; renewEveryMs?: number } = {}): Promise<boolean> {
  const job = await repo.claimImport(options.workerId ?? `source-import:${process.pid}`);
  if (!job) return false;
  let leaseLost = false, renewalFailed = false, renewal: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (renewal || leaseLost) return;
    renewal = repo.renewImportLease(job).then(owned => { if (!owned) leaseLost = true; })
      .catch(() => { leaseLost = true; renewalFailed = true; }).finally(() => { renewal = null; });
  }, options.renewEveryMs ?? 60000);
  timer.unref();
  let body: unknown = null, message = '';
  try {
    const bytes = await blobs.read(job.sha256);
    body =
      job.kind === 'xlsx'
        ? await readKini(bytes, job.filename)
        : job.kind === 'docx'
          ? await readWord(bytes, job.filename)
          : (await inspectAssets([{ key: job.filename, bytes }]))[0];
  } catch (e) {
    const code = e instanceof Error ? e.message : '';
    const known = /^(ASSET_|UNSUPPORTED_|OFFICE_|ARCHIVE_|XML_|BLOB_|INVALID_)/.test(code);
    message = known ? code : 'Không đọc được tệp. Kiểm tra tệp nguồn và định dạng; bản gốc vẫn được giữ.';
  } finally {
    clearInterval(timer);
    await renewal;
  }
  if (renewalFailed) throw Error('IMPORT_LEASE_RENEWAL_FAILED');
  // Losing the lease is a normal concurrent outcome. Never retry completion by ID.
  if (!leaseLost) await repo.finishClaimedImport(job, body, message);
  return true;
}
