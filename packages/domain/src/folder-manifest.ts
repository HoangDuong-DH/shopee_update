import { z } from 'zod';

const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((v) => !!v.trim());
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const path = text(1024).refine(
  (v) =>
    !/[\\:\x00-\x1f*?"<>|]/.test(v) &&
    v.split('/').every((part) => !!part && part !== '.' && part !== '..'),
);
const file = z.object({ path, sha256: hash }).strict();
const range = z
  .object({ start: z.number().int().min(1), end: z.number().int().min(1) })
  .strict()
  .refine((v) => v.end >= v.start);

/** A portable source manifest is data. It contains no commands, remote URLs, prices or stock defaults. */
export const folderManifestSchema = z
  .object({
    format: z.literal('listing-source'),
    version: z.literal(1),
    product: z
      .object({
        productKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/),
        sourceRevision: z.number().int().min(0).max(2147483646),
      })
      .strict(),
    sourceListingId: z
      .object({
        value: z
          .string()
          .regex(/^[1-9]\d*$/)
          .refine((v) => Number.isSafeInteger(Number(v)))
          .nullable(),
        source: z
          .object({ fileSha256: hash, locator: text(1024), filename: text(255).optional() })
          .strict(),
      })
      .strict()
      .optional(),
    word: z
      .object({
        path,
        sha256: hash,
        title: range,
        headline: range.optional(),
        body: range.optional(),
        paragraphSeparator: z.enum(['\n', '\n\n']),
      })
      .strict(),
    priceSource: z
      .object({
        sha256: hash,
        sheet: text(255),
        priceProfile: z.string().max(255).nullable(),
        selectionMode: z.literal('operator_choice').optional(),
      })
      .strict(),
    media: z
      .object({
        cover: file.optional(),
        gallery: z.array(file).max(100),
        description: z.array(file).max(100),
      })
      .strict(),
    tierNames: z.array(text(200)).max(2),
    variants: z
      .array(
        z
          .object({
            sku: text(500),
            optionLabels: z.array(text(200)).max(2),
            image: file.optional(),
            rowKey: text(500).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(2000),
  })
  .strict()
  .superRefine((value, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (
      value.priceSource.selectionMode === 'operator_choice' &&
      value.priceSource.priceProfile !== null
    )
      fail('Operator choice must not preselect a price profile');
    if (new Set(value.tierNames).size !== value.tierNames.length) fail('Duplicate tier name');
    if (!value.tierNames.length && value.variants.length !== 1)
      fail('An untiered listing has one SKU');
    if (new Set(value.variants.map((v) => v.sku)).size !== value.variants.length)
      fail('Duplicate SKU');
    if (
      new Set(value.variants.map((v) => JSON.stringify(v.optionLabels))).size !==
      value.variants.length
    )
      fail('Duplicate option combination');
    if (value.variants.some((v) => v.optionLabels.length !== value.tierNames.length))
      fail('Incomplete option labels');
    for (const entries of [value.media.gallery, value.media.description])
      if (new Set(entries.map((f) => f.path)).size !== entries.length)
        fail('Duplicate image in one role');
    const paths = new Map<string, string>();
    for (const f of [
      value.word,
      ...(value.media.cover ? [value.media.cover] : []),
      ...value.media.gallery,
      ...value.media.description,
      ...value.variants.flatMap((v) => (v.image ? [v.image] : [])),
    ]) {
      const old = paths.get(f.path.toLocaleLowerCase());
      if (old && old !== f.sha256) fail('Conflicting file identity');
      paths.set(f.path.toLocaleLowerCase(), f.sha256);
    }
  });
export type FolderManifest = z.infer<typeof folderManifestSchema>;
export type StoredFolderManifest = {
  relativePath: string;
  sha256: string;
  document: FolderManifest;
};
