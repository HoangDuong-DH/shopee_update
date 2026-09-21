import { z } from 'zod';
import { folderManifestSchema } from '@shopee/domain';
import { pendingListingMappingSchema } from '../../../packages/domain/src/pending-listing-mapping.js';
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
        pendingMappings: z.record(path, pendingListingMappingSchema).optional(),
        manifests: z
          .record(
            path,
            z
              .object({
                relativePath: path,
                sha256: z.string().regex(/^[a-f0-9]{64}$/),
                document: folderManifestSchema,
              })
              .strict(),
          )
          .optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine(({ state }, ctx) => {
    for (const [group, mapping] of Object.entries(state.pendingMappings ?? {})) {
      const files = state.files.filter((f) => f.relativePath === mapping.relativePath);
      if (
        state.manifests?.[group] ||
        !state.productKeys[group] ||
        mapping.relativePath !== group + '/listing-mapping.pending.json' ||
        files.length !== 1 ||
        files[0].name !== 'listing-mapping.pending.json' ||
        files[0].sha256 !== mapping.sha256 ||
        files[0].importId
      )
        ctx.addIssue({
          code: 'custom',
          path: ['state', 'pendingMappings', group],
          message:
            'Pending mapping must match its exact local file, source group and product identity.',
        });
    }
    for (const [group, manifest] of Object.entries(state.manifests ?? {})) {
      const files = state.files.filter((file) => file.relativePath === manifest.relativePath);
      if (
        !state.productKeys[group] ||
        manifest.relativePath !== group + '/listing-source.json' ||
        files.length !== 1 ||
        files[0].name !== 'listing-source.json' ||
        files[0].sha256 !== manifest.sha256 ||
        files[0].importId
      )
        ctx.addIssue({
          code: 'custom',
          path: ['state', 'manifests', group],
          message: 'Manifest must match its exact local sidecar file and source group.',
        });
    }
  });

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
