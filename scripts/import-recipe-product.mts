import type { ListingDraft } from '@shopee/domain';
export class RecipeRequestError extends Error {
  constructor(readonly status:number,code:string){super(code);}
}
/** A failed read is never evidence that a source can be recreated. */
export async function readExistingRecipeProduct(read:(path:string)=>Promise<unknown>,key:string):Promise<ListingDraft|null>{
  if(typeof key!=='string'||!key) throw Error('RECIPE_PRODUCT_KEY_INVALID');
  try {
    const record=await read('/v1/products/'+encodeURIComponent(key)) as ListingDraft;
    if(record?.productKey!==key || !Number.isSafeInteger(record.revision) || record.revision<1)
      throw Error('RECIPE_PRODUCT_RESPONSE_INVALID');
    return record;
  } catch(error){
    if(error instanceof RecipeRequestError && error.status===404) return null;
    throw error;
  }
}
