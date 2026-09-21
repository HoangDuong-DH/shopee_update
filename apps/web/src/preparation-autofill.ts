import { z } from 'zod';

const attribute = z.object({
  attribute_id: z.number().int().positive().safe(),
  attribute_value_list: z.array(z.object({
    value_id: z.number().int().nonnegative().safe(),
    original_value_name: z.string().optional(), value_unit: z.string().optional(),
  }).strict()),
}).strict();
export const autofillChoicesSchema = z.object({
  categoryId: z.string().optional(), brandId: z.string().optional(), brandName: z.string().optional(),
  attributeList: z.array(attribute).optional(),
  logistics: z.array(z.object({channelId:z.string(),enabled:z.boolean()}).strict()).optional(),
  weightGrams: z.number().positive().finite().optional(),
  dimensionCm: z.object({length:z.number().positive(),width:z.number().positive(),height:z.number().positive()}).strict().optional(),
  condition: z.enum(['NEW','USED']).optional(),
  preOrder:z.object({is_pre_order:z.boolean(),days_to_ship:z.number().positive().int().optional()}).strict().optional(),
  stockLocation:z.object({referenceItemId:z.string(),expectedLocationBySku:z.record(z.string(),z.string()),writeLocationBySku:z.record(z.string(),z.string().nullable())}).strict().optional(),
}).strict();
export const autofillResultSchema = z.object({
  attributeMode:z.enum(['minimum_required','source_supported']).optional(),
  scope:z.object({shopId:z.string(),partnerId:z.string()}).passthrough(),
  observedAt:z.string(),connectionRevision:z.number().int(),fingerprint:z.string(),
  entries:z.array(z.object({
    productKey:z.string(),sourceRevision:z.number().int(),choices:autofillChoicesSchema,
    explanations:z.array(z.object({field:z.string(),value:z.unknown().optional(),message:z.string(),source:z.string().optional()})),
    unresolved:z.array(z.object({field:z.string(),message:z.string()})),
    issues:z.array(z.object({code:z.string(),message:z.string()})),metadata:z.unknown().optional(),
    knowledgeSuggestions:z.array(z.object({name:z.string(),applied:z.boolean(),references:z.array(z.object({itemId:z.string(),title:z.string(),evidenceId:z.string()})),reasons:z.array(z.string()).optional()}).passthrough()).optional(),
    knowledgeIssues:z.array(z.object({attributeId:z.number().optional(),code:z.string(),detail:z.string(),evidenceId:z.string().optional()})).optional(),
  })),
});
export type AutofillResult = z.infer<typeof autofillResultSchema>;
export type AutofillChoices = z.infer<typeof autofillChoicesSchema>;

/** Suggestions fill gaps; an operator's explicit values always win. */
export function mergeMissingChoices<T extends Record<string, any>>(current:T, proposed:AutofillChoices):T {
  const next={...current};
  for(const [field,value] of Object.entries(proposed)) {
    if(field==='attributeList') continue;
    if(current[field]===undefined || current[field]===null || current[field]==='') (next as any)[field]=value;
  }
  const sameCategory = !current.categoryId || current.categoryId===proposed.categoryId;
  const sameBrand = !current.brandId || current.brandId===proposed.brandId;
  if(sameCategory && sameBrand && proposed.attributeList) {
    const existing=current.attributeList as AutofillChoices['attributeList'];
    (next as any).attributeList=[...(existing ?? []), ...proposed.attributeList.filter(candidate=>!existing?.some(value=>value.attribute_id===candidate.attribute_id))];
  }
  return next;
}
