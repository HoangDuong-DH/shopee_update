import { expect,it,vi } from 'vitest';
import { RecipeRequestError,readExistingRecipeProduct } from '../../scripts/import-recipe-product.mjs';
it('looks up one exact source key regardless of library page',async()=>{
 const read=vi.fn(async()=>({productKey:'old/key',revision:8}));
 expect(await readExistingRecipeProduct(read,'old/key')).toMatchObject({productKey:'old/key',revision:8});
 expect(read).toHaveBeenCalledExactlyOnceWith('/v1/products/old%2Fkey');
});
it('allows absence only after a true404 and propagates unavailable or malformed reads',async()=>{
 expect(await readExistingRecipeProduct(async()=>{throw new RecipeRequestError(404,'NOT_FOUND');},'key')).toBe(null);
 for(const error of [new RecipeRequestError(503,'DATABASE_REQUEST_TIMEOUT'),new RecipeRequestError(401,'NOT_FOUND'),Error('Lost read')])
  await expect(readExistingRecipeProduct(async()=>{throw error;},'key')).rejects.toBe(error);
 await expect(readExistingRecipeProduct(async()=>({items:[]}), 'key')).rejects.toThrow('RECIPE_PRODUCT_RESPONSE_INVALID');
 await expect(readExistingRecipeProduct(async()=>({productKey:'other',revision:1}), 'key')).rejects.toThrow('RECIPE_PRODUCT_RESPONSE_INVALID');
});
