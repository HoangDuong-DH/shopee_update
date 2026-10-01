import { describe, expect, it } from 'vitest';

describe('workspace navigation and partial loading', () => {
  it('opens a shareable route instead of restoring an unrelated previous page', async () => {
    const navigation = await import('../../apps/web/src/workspace-navigation.js').catch(() => null);
    expect(navigation?.readWorkspacePage('?page=workbench', 'shops')).toBe('workbench');
    expect(navigation?.readWorkspacePage('?page=editor', 'shops')).toBe('overview');
    expect(navigation?.readWorkspacePage('', null)).toBe('overview');
  });
  it('retains explicit shop scope only on the connection route', async () => {
    const navigation = await import('../../apps/web/src/workspace-navigation.js').catch(() => null);
    const origin = 'http://127.0.0.1:5273/?page=shops&connectShop=1340479212&partnerId=2010476';
    expect(navigation?.workspaceNavigationUrl(origin, 'products')).toBe('/?page=products');
    expect(navigation?.workspaceNavigationUrl(origin, 'shops')).toContain('connectShop=1340479212');
  });
  it('does not request the whole draft and import archive on a connection screen', async () => {
    const navigation = await import('../../apps/web/src/workspace-navigation.js').catch(() => null);
    expect(navigation?.workspaceResources('shops', 'catalog')).toEqual(['shops', 'status']);
    expect(navigation?.workspaceResources('sources', 'catalog')).toEqual(['status']);
    expect(navigation?.workspaceResources('products', 'catalog')).toEqual(['status']);
    expect(navigation?.workspaceResources('editor', 'catalog')).toEqual(['shops','status']);
  });
  it('restores only a bounded draft route and keeps the exact revision', async()=>{
    const navigation=await import('../../apps/web/src/workspace-navigation.js');
    expect(navigation.readWorkspacePage('?page=editor&productKey=bo%20nguon&revision=0','shops')).toBe('editor');
    expect(navigation.readWorkspaceDraftRoute('?page=editor&productKey=bo%20nguon&revision=0')).toEqual({page:'editor',productKey:'bo nguon',revision:0});
    for(const invalid of ['?page=editor&productKey=x&revision=-1','?page=preview&productKey=x&revision=0','?page=editor&productKey=x&revision=9007199254740992','?page=editor&productKey=%00x&revision=1'])expect(navigation.readWorkspaceDraftRoute(invalid)).toBeNull();
    expect(navigation.workspaceNavigationUrl('http://127.0.0.1:5273/?page=shops&connectShop=2&partnerId=3','editor',{productKey:'bo nguon',revision:4})).toBe('/?page=editor&productKey=bo+nguon&revision=4');
  });
  it('preserves the target scope on preparation without leaking it into other pages',async()=>{
    const navigation=await import('../../apps/web/src/workspace-navigation.js');
    expect(navigation.workspaceNavigationUrl('http://127.0.0.1:5273/','prepared-batches',undefined,'2010476:1340479212')).toBe('/?page=prepared-batches&partnerId=2010476&shopId=1340479212');
    expect(navigation.workspaceNavigationUrl('http://127.0.0.1:5273/?page=prepared-batches&partnerId=2010476&shopId=1340479212','products')).toBe('/?page=products');
  });
  it('keeps independently successful results when a different endpoint fails', async () => {
    const navigation = await import('../../apps/web/src/workspace-navigation.js').catch(() => null);
    const settled = await navigation?.settleWorkspaceReads({
      shops: async () => { throw Error('Không đọc được kết nối'); },
      products: async () => [{ productKey: 'source-kept' }],
      status: async () => ({ worker: 'online' }),
    });
    expect(settled?.values.products).toEqual([{ productKey: 'source-kept' }]);
    expect(settled?.values.status).toEqual({ worker: 'online' });
    expect(settled?.errors.shops).toBe('Không đọc được kết nối');
    expect(settled?.values).not.toHaveProperty('shops');
  });
});
