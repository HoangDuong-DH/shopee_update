import { z } from 'zod';
const column = z
  .string()
  .regex(/^[A-Z]{1,2}$/)
  .refine((v) => [...v].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) <= 128);
export const contentMappingSchema = z
  .object({
    importId: z.string().uuid(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    sheet: z.string().min(1).max(255),
    headerRow: z.number().int().min(1).max(100),
    columns: z
      .object({ stt: column, title: column, headline: column.optional(), body: column })
      .strict(),
    headers: z
      .object({
        stt: z.string().min(1).max(500),
        title: z.string().min(1).max(500),
        headline: z.string().min(1).max(500).optional(),
        body: z.string().min(1).max(500),
      })
      .strict(),
  })
  .strict()
  .refine(
    (v) => new Set(Object.values(v.columns)).size === Object.values(v.columns).length,
    'Mỗi vai trò phải chọn một cột riêng.',
  );
export const contentBindingSchema = z
  .object({
    mapping: contentMappingSchema,
    row: z.number().int().min(2).max(10000),
    stt: z.string().regex(/^\d{1,8}$/),
  })
  .strict();
export type ContentMapping = z.infer<typeof contentMappingSchema>;
export type ContentBinding = z.infer<typeof contentBindingSchema>;
export type ContentRow = {
  binding: ContentBinding;
  title: string;
  headline: string;
  body: string;
  issues: string[];
  sources: import('./contracts.js').SourceRef[];
};
export type ContentSelection = Omit<ContentRow, 'issues'>;
export const contentSelectionSchema = z
  .object({
    binding: contentBindingSchema,
    title: z.string().min(1).max(10000),
    headline: z.string().max(50000),
    body: z.string().max(100000),
    sources: z
      .array(
        z
          .object({
            kind: z.literal('product_file'),
            fileSha256: z.string().regex(/^[a-f0-9]{64}$/),
            locator: z.string().max(1000),
            filename: z.string().max(255),
            observedAt: z.string(),
          })
          .strict(),
      )
      .max(4),
  })
  .strict();
export type ContentWorkbookInventory = {
  importId: string;
  sha256: string;
  filename: string;
  priceParserStatus: string;
  sheets: {
    name: string;
    rows: number;
    preview: { row: number; cells: { column: string; text: string; issue?: string }[] }[];
  }[];
};
