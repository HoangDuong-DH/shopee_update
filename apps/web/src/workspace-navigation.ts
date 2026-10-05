export const WORKSPACE_PAGES = [
  'overview',
  'sources',
  'prepared-batches',
  'updates',
  'workbench',
  'products',
  'image-qc',
  'sandbox-tryout',
  'shops',
  'archives',
  'guide',
  'assistant',
  'results',
  'handoff',
] as const;
export type WorkspacePage = (typeof WORKSPACE_PAGES)[number];
export type WorkspaceResource = 'imports' | 'products' | 'shops' | 'plans' | 'jobs' | 'status';
export type WorkspaceDraftRoute = {
  page: 'editor' | 'preview';
  productKey: string;
  revision: number;
};

export function readWorkspaceDraftRoute(search: string): WorkspaceDraftRoute | null {
  const query = new URLSearchParams(search),
    page = query.get('page');
  const productKey = query.get('productKey'),
    rawRevision = query.get('revision');
  if (
    !['editor', 'preview'].includes(page ?? '') ||
    !productKey?.trim() ||
    productKey.length > 1024 ||
    /[\x00-\x1f]/.test(productKey) ||
    !/^(0|[1-9]\d*)$/.test(rawRevision ?? '')
  )
    return null;
  const revision = Number(rawRevision);
  if (!Number.isSafeInteger(revision) || revision < (page === 'preview' ? 1 : 0)) return null;
  return { page: page as 'editor' | 'preview', productKey, revision };
}

function isPage(value: string | null): value is WorkspacePage {
  return value !== null && WORKSPACE_PAGES.some((page) => page === value);
}
export function readWorkspacePage(
  search: string,
  stored: string | null,
): WorkspacePage | 'editor' | 'preview' {
  const query = new URLSearchParams(search);
  const draft = readWorkspaceDraftRoute(search);
  if (draft) return draft.page;
  if (query.has('page'))
    return isPage(query.get('page')) ? (query.get('page') as WorkspacePage) : 'overview';
  if (query.has('connectShop')) return 'shops';
  return isPage(stored) ? stored : 'overview';
}
export function workspaceNavigationUrl(
  href: string,
  page: string,
  draft?: Omit<WorkspaceDraftRoute, 'page'>,
  scopeKey?: string,
): string {
  const url = new URL(href);
  const stable =
    ['editor', 'preview'].includes(page) && !draft
      ? 'products'
      : ['folder', 'import'].includes(page)
        ? 'sources'
        : page;
  url.searchParams.set(
    'page',
    isPage(stable) || ['editor', 'preview'].includes(stable) ? stable : 'overview',
  );
  if (draft && ['editor', 'preview'].includes(stable)) {
    url.searchParams.set('productKey', draft.productKey);
    url.searchParams.set('revision', String(draft.revision));
  } else {
    url.searchParams.delete('productKey');
    url.searchParams.delete('revision');
  }
  if (stable !== 'prepared-batches') { url.searchParams.delete('work'); url.searchParams.delete('stage'); }
  if (stable !== 'archives') url.searchParams.delete('copyTargets');
  if (stable !== 'shops') {
    url.searchParams.delete('connectShop');
    url.searchParams.delete('connectionId');
    if (stable === 'prepared-batches' && /^[1-9]\d*:[1-9]\d*$/.test(scopeKey ?? '')) {
      const [partner, shop] = scopeKey!.split(':');
      url.searchParams.set('partnerId', partner!);
      url.searchParams.set('shopId', shop!);
    } else {
      url.searchParams.delete('partnerId');
      url.searchParams.delete('shopId');
    }
  }
  return url.pathname + url.search + url.hash;
}
export function workspaceResources(
  page: string,
  sourceMode: 'catalog' | 'intake',
): WorkspaceResource[] {
  switch (page) {
    case 'shops':
    case 'prepared-batches':
      return ['shops', 'status'];
    case 'products':
      return ['status'];
    case 'results':
      return ['plans', 'jobs', 'shops', 'status'];
    case 'assistant':
      return ['plans', 'status'];
    case 'sources':
      return sourceMode === 'intake' ? ['imports', 'products', 'status'] : ['status'];
    case 'editor':
    case 'preview':
      return ['shops', 'status'];
    case 'folder':
    case 'import':
    case 'handoff':
      return ['imports', 'products', 'shops', 'status'];
    default:
      return ['status'];
  }
}
export async function settleWorkspaceReads<T extends Record<string, () => Promise<unknown>>>(
  readers: T,
) {
  type Values = { [K in keyof T]: Awaited<ReturnType<T[K]>> };
  const keys = Object.keys(readers) as (keyof T)[];
  const results = await Promise.allSettled(keys.map((key) => readers[key]()));
  const values: Partial<Values> = {},
    errors: Partial<Record<keyof T, string>> = {};
  results.forEach((result, index) => {
    const key = keys[index]!;
    if (result.status === 'fulfilled') values[key] = result.value as Values[typeof key];
    else
      errors[key] =
        result.reason instanceof Error
          ? result.reason.message
          : 'Chưa đọc được dữ liệu. Thử tải lại.';
  });
  return { values, errors };
}
