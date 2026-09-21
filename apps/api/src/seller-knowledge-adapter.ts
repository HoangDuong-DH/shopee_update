import { z } from 'zod';

const scopeSchema = z.object({
  environment: z.enum(['production', 'sandbox']),
  partnerId: z.string().regex(/^\d+$/),
  shopId: z.string().regex(/^\d+$/),
});
const identifier = z.coerce.number().int().positive().safe();
const timestamp = z.string().refine((value) => Number.isFinite(Date.parse(value)));
const record = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const label = (entry: Record<string, any>) => {
  const localized = Array.isArray(entry.multi_lang)
    ? entry.multi_lang.find((v: any) => v?.language === 'vn' && typeof v.value === 'string')?.value
    : undefined;
  return z
    .string()
    .min(1)
    .parse(localized ?? entry.name);
};

/** Wire validation is separate from judging whether a product claim is true. */
export function normalizeSellerCategory(raw: any) {
  try {
    if (!Array.isArray(raw?.attributeTree)) throw Error();
    const seen = new Set<number>();
    const flatten = (
      tree: any[],
      dependsOn: Array<{ attributeId: number; valueId: number }> = [],
      depth = 0,
    ): any[] =>
      tree.flatMap((entry: any) => {
        if (depth > 16 || seen.size >= 500) throw Error();
        if (!record(entry) || !record(entry.attribute_info)) throw Error();
        const info = entry.attribute_info;
        const attributeId = identifier.parse(entry.attribute_id);
        if (seen.has(attributeId)) throw Error();
        seen.add(attributeId);
        const values = z.array(z.any()).parse(entry.attribute_value_list ?? []);
        const attribute = {
          attributeId,
          name: label(entry),
          mandatory: z.boolean().parse(entry.mandatory),
          ...(dependsOn.length ? { dependsOn } : {}),
          inputType: z
            .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)])
            .parse(info.input_type),
          inputValidationType: z
            .union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
            .parse(info.input_validation_type),
          formatType: z.union([z.literal(1), z.literal(2)]).parse(info.format_type),
          ...(info.max_value_count !== undefined
            ? { maxValueCount: z.number().int().positive().parse(info.max_value_count) }
            : {}),
          units: z.array(z.string()).parse(info.attribute_unit_list ?? []),
          values: values.map((value) => ({
            valueId: identifier.parse(value.value_id),
            name: z.string().min(1).parse(value.name),
            displayName: label(value),
            ...(value.value_unit !== undefined
              ? { valueUnit: z.string().parse(value.value_unit) }
              : {}),
          })),
        };
        return [
          attribute,
          ...values.flatMap((value) =>
            flatten(
              z.array(z.any()).parse(value.child_attribute_list ?? []),
              [...dependsOn, { attributeId, valueId: identifier.parse(value.value_id) }],
              depth + 1,
            ),
          ),
        ];
      });
    const attributes = flatten(raw.attributeTree);
    return {
      scope: scopeSchema.parse(raw.scope),
      categoryId: identifier.parse(raw.categoryId),
      observedAt: timestamp.parse(raw.observedAt),
      ...(raw.expiresAt ? { expiresAt: timestamp.parse(raw.expiresAt) } : {}),
      attributes,
    };
  } catch {
    throw Error('SELLER_KNOWLEDGE_METADATA_INVALID');
  }
}

export function normalizeSellerObservation(raw: any) {
  try {
    if(raw?.attributeEvidenceComplete===false || raw?.issues?.includes('ATTRIBUTE_LIST_NOT_RETURNED')) throw Error();
    if (raw?.brandId === null || raw?.brandId === undefined || raw?.brandId === '') throw Error();
    const models = z.array(z.any()).parse(raw.models ?? []);
    const modelSkus = z
      .array(z.string())
      .parse(
        models.length
          ? models.map((model) => z.string().parse(model.model_sku)).filter(Boolean)
          : raw.modelSkus?.length
            ? raw.modelSkus
            : raw.itemSku
              ? [raw.itemSku]
              : [],
      );
    const skuIdentityComplete = models.length
      ? modelSkus.length === models.length &&
        new Set(modelSkus).size === models.length &&
        new Set(models.map((model) => String(model.model_id))).size === models.length
      : modelSkus.length === 1;
    return {
      evidenceId: z.string().min(1).parse(raw.evidenceId),
      scope: scopeSchema.parse(raw.scope),
      itemId: z.string().regex(/^\d+$/).parse(String(raw.itemId)),
      title: z.string().parse(raw.title),
      categoryId: identifier.parse(raw.categoryId),
      brandId: z.coerce.number().int().nonnegative().safe().parse(raw.brandId),
      modelSkus: [...new Set(modelSkus)],
      modelCount: models.length,
      skuIdentityComplete,
      observedAt: timestamp.parse(raw.observedAt),
      status: z.string().parse(raw.itemStatus ?? raw.status ?? 'UNKNOWN'),
      approvedForReuse: false,
      attributes: z
        .array(z.any())
        .parse(raw.attributes)
        .map((attribute) => ({
          attributeId: identifier.parse(attribute.attribute_id ?? attribute.attributeId),
          values: z
            .array(z.any())
            .parse(attribute.attribute_value_list ?? attribute.values)
            .map((value) => ({
              valueId: z.coerce
                .number()
                .int()
                .nonnegative()
                .safe()
                .parse(value.value_id ?? value.valueId),
              ...((value.original_value_name ?? value.originalValueName) !== undefined
                ? {
                    originalValueName: z
                      .string()
                      .parse(value.original_value_name ?? value.originalValueName),
                  }
                : {}),
              ...((value.value_unit ?? value.valueUnit) !== undefined
                ? { valueUnit: z.string().parse(value.value_unit ?? value.valueUnit) }
                : {}),
            })),
        })),
    };
  } catch {
    throw Error('SELLER_KNOWLEDGE_OBSERVATION_INVALID');
  }
}
