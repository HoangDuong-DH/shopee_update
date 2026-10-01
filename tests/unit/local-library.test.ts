import { expect, it, vi } from 'vitest';
import { localLibraryQuerySchema } from '../../packages/domain/src/local-library.js';
import { LocalLibraryService } from '../../apps/api/src/local-library-service.js';

it('bounds pages and accepts only scalar library filters', () => {
  expect(localLibraryQuerySchema.parse({})).toEqual({lifecycle:'active',q:'',limit:50});
  expect(localLibraryQuerySchema.parse({q:'  Bình xịt  ',limit:'100'})).toMatchObject({q:'Bình xịt',limit:100});
  for(const raw of [{limit:0},{limit:101},{limit:'1.5'},{q:['a','b']},{lifecycle:'deleted'},{cursor:'!'}])
    expect(localLibraryQuerySchema.safeParse(raw).success).toBe(false);
});

it('reports unavailable storage without inventing an empty library or exposing its error', async () => {
  const query=vi.fn(async()=>{ throw Error('DATABASE secret-password@example.invalid'); });
  const service=new LocalLibraryService({pool:{query}} as any);
  try { await service.products({}); throw Error('Expected storage failure'); }
  catch(error:any) {
    expect(error.getStatus()).toBe(503); expect(JSON.stringify(error.getResponse())).toContain('LOCAL_LIBRARY_UNAVAILABLE');
    expect(JSON.stringify(error.getResponse())).not.toContain('secret-password');
  }
  expect(query).toHaveBeenCalledOnce();
});

it('rejects invalid pagination before querying the database', async () => {
  const query=vi.fn(),service=new LocalLibraryService({pool:{query}} as any);
  await expect(service.imports({limit:'999'})).rejects.toMatchObject({message:'LOCAL_LIBRARY_QUERY_INVALID'});
  await expect(service.products({cursor:'e30'})).rejects.toMatchObject({message:'LOCAL_LIBRARY_CURSOR_INVALID'});
  expect(query).not.toHaveBeenCalled();
});
