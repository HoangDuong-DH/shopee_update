import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { canonicalJson, type PreparedDocument } from '@shopee/domain';
import type { Repository } from '@shopee/persistence';
import { preparedWireMediaRequirements } from '../../../packages/shopee/src/prepared-wire.js';
import {
  collectProductionPilotInput,
  productionPilotScope,
  type ProductionPilotCollectOptions,
} from './production-pilot-source.js';
import type { ProductionPilotPreparedInput } from './production-pilot-runner.js';
import { verifyProductionPriceCells } from './production-batch-price-proof.js';

export const productionBatchPass1Root = resolve('.local/production-batch-pass1-20260915');
export const productionPublicationModeSchema = z.enum([
  'hidden_for_review',
  'publish_after_verification',
]);
export type ProductionPublicationMode = z.infer<typeof productionPublicationModeSchema>;
export const productionImageQcPolicySchema = z.enum(['required', 'defer_image_qc']);
export function productionImageQcPolicy(value: object) {
  return productionImageQcPolicySchema.parse(
    'imageQcPolicy' in value ? (value.imageQcPolicy ?? 'required') : 'required',
  );
}
/** Missing mode belongs to immutable legacy preparations/manifests. Never default them to hidden. */
export function productionPublicationMode(value: object): ProductionPublicationMode {
  const stored = 'publicationMode' in value ? value.publicationMode : undefined;
  return stored === undefined
    ? 'publish_after_verification'
    : productionPublicationModeSchema.parse(stored);
}
function fail(code: string): never {
  throw Error('PRODUCTION_BATCH_' + code);
}
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const sha = z.string().regex(/^[a-f0-9]{64}$/),
  text = z.string().min(1).max(4000);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const id = z
  .string()
  .regex(/^[1-9]\d*$/)
  .refine((value) => Number.isSafeInteger(Number(value)));
const price = id;
const dimensions = z
  .object({ length: integer.min(1), width: integer.min(1), height: integer.min(1) })
  .strict();
const media = z
  .object({
    importId: z.string().uuid(),
    sha256: sha,
    width: integer.min(1),
    height: integer.min(1),
    mime: z.enum(['image/png', 'image/jpeg']),
  })
  .strict();
const model = z
  .object({
    sku: text,
    optionLabels: z.array(text).max(2),
    tierIndex: z.array(integer).max(2),
    originalPrice: price,
    stock: z.literal(100),
    image: media.optional(),
    weightGrams: z.number().finite().positive().optional(),
    dimensionCm: dimensions.optional(),
  })
  .strict();
const document = z
  .object({
    sourceKey: text,
    title: text,
    description: z
      .array(
        z.discriminatedUnion('type', [
          z.object({ type: z.literal('text'), text: z.string() }).strict(),
          z.object({ type: z.literal('image'), image: media }).strict(),
        ]),
      )
      .min(1)
      .max(500),
    cover: media,
    gallery: z.array(media).min(1).max(100),
    tierNames: z.array(text).max(2),
    models: z.array(model).min(1).max(100),
    categoryId: id,
    brandId: id,
    attributes: z.record(z.string(), z.array(z.string()).min(1)),
    logistics: z
      .array(z.object({ channelId: id, enabled: z.boolean() }).strict())
      .min(1)
      .max(100),
    weightGrams: z.number().finite().positive(),
    dimensionCm: dimensions,
    publication: z.literal('unlisted'),
  })
  .strict();
const attribute = z
  .object({
    attribute_id: integer.min(1),
    attribute_value_list: z
      .array(
        z
          .object({
            value_id: integer,
            original_value_name: z.string().optional(),
            value_unit: z.string().optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
const sourceFile = z
  .object({ id: text, role: z.enum(['listing-markdown', 'pricebook']), path: text, sha256: sha })
  .strict();
const listing = z
  .object({
    sourceIdentity: text,
    sourceRevision: integer.min(1),
    sourceKey: text,
    sourceFileId: text,
    existingListingAuthorization: z
      .object({
        reason: z.literal('distinct_prepared_listing_test'),
        authorizationReference: text,
      })
      .strict()
      .optional(),
    document,
    proposedAttributeList: z.array(attribute),
    brandName: text,
    condition: z.enum(['NEW', 'USED']),
    preOrder: z
      .object({ is_pre_order: z.boolean(), days_to_ship: integer.min(1).optional() })
      .strict(),
    stockLocation: z
      .object({
        referenceItemId: id,
        expectedLocationBySku: z.record(z.string(), z.string().min(1)),
        writeLocationBySku: z.record(z.string(), z.string().min(1).nullable()),
      })
      .strict(),
    priceProof: z
      .array(
        z
          .object({
            sku: text,
            sourceFileId: text,
            sheetName: text,
            skuCell: z.string().regex(/^[A-Z]+[1-9]\d*$/),
            priceCell: z.string().regex(/^[A-Z]+[1-9]\d*$/),
            originalPrice: price,
            priceSet: z.literal('SHOP MALL'),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
const legacyManifest = z
  .object({
    version: z.literal(1),
    batchId: z.string().uuid(),
    scope: z
      .object({
        environment: z.literal('production'),
        partnerId: z.literal('2010476'),
        shopId: z.literal('1423724897'),
      })
      .strict(),
    authorizationReference: text,
    sourceFiles: z.array(sourceFile).min(2).max(100),
    assets: z.record(z.string().uuid(), text),
    listings: z.array(listing).min(1).max(4),
  })
  .strict();
// New saved-source preparations carry their own immutable ID/fingerprint. Legacy PASS1
// keeps its original contract and authorized stock/profile; it is never migrated in place.
const savedListing = listing.extend({
  document: document.extend({
    brandId: z
      .string()
      .regex(/^(0|[1-9]\d*)$/)
      .refine((value) => Number.isSafeInteger(Number(value))),
    models: z
      .array(model.extend({ stock: integer }))
      .min(1)
      .max(100),
  }),
  priceProof: z.array(listing.shape.priceProof.element.extend({ priceSet: text })).min(1),
});
const savedManifest = legacyManifest.extend({
  version: z.literal(2),
  publicationMode: productionPublicationModeSchema.optional(),
  imageQcPolicy: productionImageQcPolicySchema.optional(),
  preparation: z.object({ id: z.string().uuid(), fingerprint: sha }).strict(),
  sourceFiles: z
    .array(sourceFile.extend({ role: z.enum(['listing-snapshot', 'pricebook']) }))
    .min(2)
    .max(100),
  listings: z.array(savedListing).min(1).max(4),
});
const manifest = z
  .discriminatedUnion('version', [legacyManifest, savedManifest])
  .refine(
    (value) =>
      productionImageQcPolicy(value) !== 'defer_image_qc' ||
      productionPublicationMode(value) === 'hidden_for_review',
    { message: 'Image QC deferral requires hidden publication mode' },
  );
export type ProductionBatchManifest = z.infer<typeof manifest>;
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function inside(root: string, path: string) {
  const child = relative(root, path);
  return !!child && child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child);
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function checkRelations(value: ProductionBatchManifest) {
  if (
    new Set(value.listings.map((source) => source.sourceIdentity)).size !== value.listings.length ||
    new Set(value.listings.map((source) => source.sourceKey)).size !== value.listings.length ||
    new Set(value.sourceFiles.map((file) => file.id)).size !== value.sourceFiles.length ||
    value.sourceFiles.filter((file) => file.role === 'pricebook').length !== 1
  )
    fail('SOURCE_IDENTITY_INVALID');
  const descriptors = new Map<string, z.infer<typeof media>>();
  for (const source of value.listings) {
    const doc = source.document,
      skus = doc.models.map((entry) => entry.sku);
    if (
      source.sourceIdentity !== doc.sourceKey ||
      value.sourceFiles.find((file) => file.id === source.sourceFileId)?.role !==
        (value.version === 1 ? 'listing-markdown' : 'listing-snapshot') ||
      new Set(skus).size !== skus.length ||
      new Set(doc.models.map((entry) => canonicalJson(entry.tierIndex))).size !== skus.length ||
      new Set(doc.tierNames).size !== doc.tierNames.length ||
      new Set(doc.logistics.map((channel) => channel.channelId)).size !== doc.logistics.length ||
      doc.models.some(
        (entry) =>
          entry.optionLabels.length !== doc.tierNames.length ||
          entry.tierIndex.length !== doc.tierNames.length ||
          (entry.dimensionCm !== undefined && entry.weightGrams === undefined),
      ) ||
      (!doc.tierNames.length &&
        (doc.models.length !== 1 ||
          doc.models[0]!.weightGrams !== undefined ||
          doc.models[0]!.dimensionCm !== undefined)) ||
      !same(
        [...Object.keys(source.stockLocation.expectedLocationBySku)].sort(),
        [...skus].sort(),
      ) ||
      !same([...Object.keys(source.stockLocation.writeLocationBySku)].sort(), [...skus].sort())
    )
      fail('SOURCE_MAPPING_INVALID');
    for (let tierIndex = 0; tierIndex < doc.tierNames.length; tierIndex++) {
      const indexes = new Map<number, string>(),
        labels = new Map<string, number>();
      for (const entry of doc.models) {
        const index = entry.tierIndex[tierIndex]!,
          label = entry.optionLabels[tierIndex]!;
        if (
          (indexes.has(index) && indexes.get(index) !== label) ||
          (labels.has(label) && labels.get(label) !== index)
        )
          fail('SOURCE_TIER_INVALID');
        indexes.set(index, label);
        labels.set(label, index);
      }
      if ([...indexes.keys()].sort((a, b) => a - b).some((index, position) => index !== position))
        fail('SOURCE_TIER_INVALID');
    }
    if (
      source.priceProof.length !== skus.length ||
      new Set(source.priceProof.map((proof) => proof.sku)).size !== skus.length ||
      source.priceProof.some(
        (proof) =>
          value.sourceFiles.find((file) => file.id === proof.sourceFileId)?.role !== 'pricebook' ||
          doc.models.find((entry) => entry.sku === proof.sku)?.originalPrice !==
            proof.originalPrice,
      )
    )
      fail('PRICE_PROOF_INVALID');
    for (const { media: image } of preparedWireMediaRequirements(doc as PreparedDocument)) {
      const previous = descriptors.get(image.importId);
      if (previous && !same(previous, image)) fail('ASSET_IDENTITY_INVALID');
      descriptors.set(image.importId, image as z.infer<typeof media>);
    }
  }
  if (!same([...descriptors.keys()].sort(), Object.keys(value.assets).sort()))
    fail('ASSET_MAPPING_INVALID');
  return descriptors;
}

/** Immutable status snapshot only. Execution must use loadProductionBatchSource. */
export async function readProductionBatchManifest(manifestPath: string, expectedSha256: string) {
  if (
    !sha.safeParse(expectedSha256).success ||
    !isAbsolute(manifestPath) ||
    !inside(productionBatchPass1Root, manifestPath)
  )
    fail('MANIFEST_PATH_INVALID');
  const root = await realpath(productionBatchPass1Root),
    actualPath = await realpath(manifestPath);
  if (!inside(root, actualPath)) fail('MANIFEST_PATH_INVALID');
  const bytes = await readFile(actualPath);
  if (bytes.length > 2 * 1024 * 1024 || hash(bytes) !== expectedSha256) fail('MANIFEST_CHANGED');
  let value: ProductionBatchManifest;
  try {
    value = manifest.parse(JSON.parse(bytes.toString('utf8')));
  } catch {
    return fail('MANIFEST_INVALID');
  }
  checkRelations(value);
  return { value: freeze(value), sha256: expectedSha256, manifestPath: actualPath };
}

/** Exact nominated source bytes are checked again before execution. */
export async function loadProductionBatchSource(manifestPath: string, expectedSha256: string) {
  const loaded = await readProductionBatchManifest(manifestPath, expectedSha256),
    value = loaded.value,
    root = await realpath(productionBatchPass1Root),
    descriptors = checkRelations(value);
  for (const file of value.sourceFiles) {
    if (!isAbsolute(file.path)) fail('SOURCE_PATH_INVALID');
    const sourceBytes = await readFile(file.path);
    if (hash(sourceBytes) !== file.sha256) fail('SOURCE_FILE_CHANGED');
    if (value.version === 2 && file.role === 'pricebook')
      await verifyProductionPriceCells(
        sourceBytes,
        value.listings
          .flatMap((entry) => entry.priceProof)
          .filter((proof) => proof.sourceFileId === file.id),
      );
  }
  for (const [importId, path] of Object.entries(value.assets)) {
    if (
      !isAbsolute(path) ||
      !inside(productionBatchPass1Root, path) ||
      !inside(root, await realpath(path))
    )
      fail('ASSET_PATH_INVALID');
    if (hash(await readFile(path)) !== descriptors.get(importId)!.sha256) fail('ASSET_CHANGED');
  }
  return loaded;
}

/** Shared fresh GET collector, isolated evidence files, no registrations, writes or capability probe. */
export async function collectProductionBatchInput(
  repo: Repository,
  input: {
    manifestPath: string;
    expectedSha256: string;
    sourceKey: string;
  },
  options: Omit<ProductionPilotCollectOptions, 'trustedSource' | 'priorCapabilityEvidence'> & {
    priorCapabilityEvidence: ProductionPilotPreparedInput['capabilityEvidence'];
    shopName?: string;
  },
) {
  const evidence = options?.priorCapabilityEvidence;
  if (
    !evidence ||
    evidence.environment !== productionPilotScope.environment ||
    evidence.partnerId !== productionPilotScope.partnerId ||
    evidence.shopId !== productionPilotScope.shopId ||
    evidence.gallery34?.state !== 'supported' ||
    !evidence.gallery34.verifiedOperationId
  )
    fail('CAPABILITY_EVIDENCE_REQUIRED');
  const loaded = await loadProductionBatchSource(input.manifestPath, input.expectedSha256);
  const selected = loaded.value.listings.find((source) => source.sourceKey === input.sourceKey);
  if (!selected) fail('SOURCE_NOT_ALLOWED');
  if (
    selected.document.description.some((block) => block.type === 'image') &&
    (evidence.extendedDescription.state === 'unknown' ||
      (evidence.extendedDescription.state === 'supported' &&
        !evidence.extendedDescription.verifiedOperationId))
  )
    fail('DESCRIPTION_CAPABILITY_UNVERIFIED');
  return collectProductionPilotInput(repo, input.sourceKey, {
    transport: options.transport,
    encryptionKey: options.encryptionKey,
    purpose: options.purpose,
    readSession: options.readSession,
    trustedExistingOperation: options.trustedExistingOperation,
    priorCapabilityEvidence: evidence,
    ...(selected.document.description.some((block) => block.type === 'image') &&
    evidence.extendedDescription.state === 'unsupported'
      ? { descriptionFallbackPolicy: 'plain_text_when_unsupported' as const }
      : {}),
    allowExistingListings:
      options.allowExistingListings === true || !!selected.existingListingAuthorization,
    trustedSource: {
      load: () => loadProductionBatchSource(input.manifestPath, input.expectedSha256),
      sourceKeys: loaded.value.listings.map((source) => source.sourceKey),
      evidenceRoot: resolve(productionBatchPass1Root, 'evidence', loaded.value.batchId),
      shopName: options.shopName ?? 'Vuatinhdau - Đại Lý Chính Hãng',
    },
  });
}
