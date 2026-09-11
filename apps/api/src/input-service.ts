import { z } from 'zod';
import { InputLibraryRepository, type Repository } from '@shopee/persistence';

const path = z.string().min(1).max(1024);
const productKey = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const priceSelection = z
  .object({
    importId: z.string().uuid(),
    sheet: z.string().min(1).max(255),
    priceProfile: z.string().max(255).nullable(),
  })
  .strict();

export const inputBatchSave = z
  .object({
    id: z.string().uuid(),
    expectedRevision: z.number().int().min(0).max(2147483646),
    state: z
      .object({
        version: z.literal(1),
        name: z
          .string()
          .min(1)
          .max(255)
          .refine((value) => !!value.trim()),
        mode: z.enum(['single_listing', 'parent_with_listing_folders']),
        files: z
          .array(
            z
              .object({
                relativePath: path,
                name: z.string().min(1).max(255),
                size: z
                  .number()
                  .int()
                  .min(0)
                  .max(1024 * 1024 * 1024),
                importId: z.string().uuid().optional(),
                sha256: z
                  .string()
                  .regex(/^[a-f0-9]{64}$/)
                  .optional(),
                error: z.string().max(2000).optional(),
              })
              .strict(),
          )
          .max(5000),
        priceSelection: priceSelection.nullable(),
        visual: z.record(
          path,
          z
            .object({
              coverPath: path.optional(),
              galleryPaths: z.array(path).max(5000),
              descriptionPaths: z.array(path).max(5000),
            })
            .strict(),
        ),
        wordPaths: z.record(path, path),
        wordRule: z
          .object({
            titleHeader: z.string().min(1).max(500),
            descriptionHeader: z.string().min(1).max(500),
            headline: z.enum(['first_line', 'none']),
            paragraphSeparator: z.enum(['\n', '\n\n']),
          })
          .strict()
          .nullable(),
        productKeys: z.record(path, productKey),
      })
      .strict(),
  })
  .strict();

export class InputService {
  readonly library: InputLibraryRepository;
  constructor(repo: Repository) {
    this.library = new InputLibraryRepository(repo.pool);
  }
  save(raw: unknown) {
    const { id, expectedRevision, state } = inputBatchSave.parse(raw);
    return this.library.save(id, expectedRevision, state);
  }
}
