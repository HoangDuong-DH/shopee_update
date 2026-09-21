import { sandboxMutationLaneBusy, type Repository } from '@shopee/persistence';

/** A narrow entry point for technical acceptance. It never selects a business listing. */
export async function sandboxTryoutContext(repo: Repository) {
  const base = {
    available: false,
    connectionRevision: 0,
    trialItemId: 'b53c59ec-fec6-4554-a770-c5db3a660907',
    itemId: '803935036',
    shopName: 'Shop thử nghiệm VN',
    scope: { environment: 'sandbox' as const, partnerId: '1232297', shopId: '227418363' },
    fields: ['title', 'stock'] as const,
  };
  const row = (
    await repo.pool.query(
      `SELECT i.state AS trial_state,i.stage,i.item_id,i.source_key,c.environment,c.partner_id,c.shop_id,
      c.state AS connection_state,c.revision,c.display_name,c.name,c.expires_at,
      (c.token_ciphertext IS NOT NULL AND c.partner_key_ciphertext IS NOT NULL) AS has_credentials
     FROM sandbox_create_trial_items i JOIN connections c ON c.id=i.connection_id WHERE i.id=$1`,
      [base.trialItemId],
    )
  ).rows[0];
  if (
    !row ||
    row.trial_state !== 'verified' ||
    row.stage !== 'done' ||
    row.item_id !== base.itemId ||
    !String(row.source_key).startsWith('SBX-BULK-') ||
    row.environment !== base.scope.environment ||
    row.partner_id !== base.scope.partnerId ||
    row.shop_id !== base.scope.shopId
  )
    return {
      ...base,
      reason: 'Chưa có listing mẫu đúng phạm vi để thử. Không dùng listing kinh doanh thay thế.',
    };
  const recovery = (
    await repo.pool.query(`SELECT q.id,q.run_id,q.created_at,q.result->>'basis' AS basis
    FROM sandbox_listing_reconciliations q JOIN sandbox_listing_runs r ON r.id=q.run_id
    WHERE q.verified AND q.run_revision=r.revision AND q.run_input_fingerprint=r.input_fingerprint
      AND q.run_snapshot=to_jsonb(r) AND r.item_id='803934364'
    ORDER BY q.created_at DESC LIMIT 1`)
  ).rows[0];
  const context = {
    ...base,
    connectionRevision: row.revision,
    shopName: row.display_name || row.name || base.shopName,
    ...(recovery
      ? {
          legacyRecovery: {
            id: recovery.id,
            runId: recovery.run_id,
            verifiedAt: recovery.created_at.toISOString(),
            basis: recovery.basis,
          },
        }
      : {}),
  };
  if (
    row.connection_state !== 'connected' ||
    !row.has_credentials ||
    (row.expires_at && new Date(row.expires_at).getTime() <= Date.now())
  )
    return { ...context, reason: 'Cập nhật kết nối TEST trước khi đọc sản phẩm mẫu.' };
  const queued = await repo.pool.query(
    "SELECT 1 FROM sandbox_create_trial_items WHERE state IN ('queued','running','waiting') OR (state='unknown' AND stage IN ('create_intent','tiers_intent')) LIMIT 1",
  );
  if (queued.rowCount)
    return {
      ...context,
      reason:
        'Đợt đăng mẫu còn trong hàng đợi hoặc cần đối chiếu. Chờ xử lý đợt đó trước khi gửi phép thử mới.',
    };
  if (await sandboxMutationLaneBusy(repo.pool, 'sandbox:1232297:227418363'))
    return {
      ...context,
      reason:
        'Một lần gửi trong shop TEST đang chạy hoặc cần đối chiếu kết quả. Chưa thể gửi thêm thay đổi.',
    };
  return { ...context, available: true };
}
