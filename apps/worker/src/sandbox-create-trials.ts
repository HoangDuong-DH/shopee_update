import { canonicalJson } from '@shopee/domain';
import {
  Repository,
  SandboxCreateTrialStore,
  type SandboxCreateTrialClaim,
} from '@shopee/persistence';
import {
  SandboxCreateClient,
  SecretBox,
  createUnlistedSchema,
  initTiersSchema,
  type CreateUnlistedPayload,
  type InitTiersPayload,
  type ShopCredentials,
  type ProductOutcome,
} from '@shopee/gateway';

export type SandboxCreateTrialClient = Pick<
  SandboxCreateClient,
  'createUnlisted' | 'initializeTiers' | 'readBaseItems' | 'readModels'
>;
export type SandboxCreateTrialWorkerOptions = {
  store: SandboxCreateTrialStore;
  repo: Repository;
  workerId: string;
  encryptionKey?: string;
  clientFactory?: (credentials: ShopCredentials) => SandboxCreateTrialClient;
};
const object = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {};
const list = (value: unknown): Record<string, any>[] =>
  Array.isArray(value) ? value.map(object) : [];
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const numeric = (value: unknown): number | null =>
  (typeof value === 'number' || (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value))) &&
  Number.isFinite(Number(value))
    ? Number(value)
    : null;
const isAuth = (outcome: ProductOutcome<unknown>) =>
  outcome.kind === 'rejected' &&
  (outcome.httpStatus === 401 ||
    outcome.httpStatus === 403 ||
    /(?:token|auth|permission|partner_id|sign|app_key)/i.test(outcome.code));
const failureCode = (outcome: ProductOutcome<unknown>) =>
  outcome.kind === 'rejected'
    ? outcome.code
    : outcome.kind === 'unknown'
      ? 'REMOTE_' + outcome.reason.toUpperCase()
      : 'READBACK_INVALID';

/** Compare only documented readback fields, never infer success from the write acknowledgement. */
export function compareSandboxCreateReadback(
  create: CreateUnlistedPayload,
  tiers: Omit<InitTiersPayload, 'item_id'> | undefined,
  itemId: string,
  raw: unknown,
  rawModels?: unknown,
): string[] {
  const actual = object(raw),
    issues: string[] = [];
  const check = (field: string, ok: boolean) => {
    if (!ok) issues.push(field);
  };
  for (const field of [
    'item_name',
    'item_sku',
    'item_status',
    'description',
    'description_type',
    'condition',
  ] as const)
    check(field, actual[field] === create[field]);
  check('item_id', String(actual.item_id) === itemId);
  check('category_id', numeric(actual.category_id) === create.category_id);
  check('brand', numeric(object(actual.brand).brand_id) === create.brand.brand_id);
  check('weight', numeric(actual.weight) === create.weight);
  check(
    'dimension',
    Object.entries(create.dimension).every(
      ([key, value]) => numeric(object(actual.dimension)[key]) === value,
    ),
  );
  check(
    'pre_order',
    object(actual.pre_order).is_pre_order === false &&
      (create.pre_order.days_to_ship === undefined ||
        numeric(object(actual.pre_order).days_to_ship) === create.pre_order.days_to_ship),
  );
  check(
    'image',
    object(actual.image).image_ratio === create.image.image_ratio &&
      same(object(actual.image).image_id_list, create.image.image_id_list),
  );
  if (create.gtin_code !== undefined) check('gtin_code', actual.gtin_code === create.gtin_code);
  const attributes = list(actual.attribute_list);
  check(
    'attribute_list',
    attributes.length === create.attribute_list.length &&
      new Set(attributes.map((a) => numeric(a.attribute_id))).size === attributes.length &&
      create.attribute_list.every((expected) => {
        const found = attributes.find((a) => numeric(a.attribute_id) === expected.attribute_id);
        const values = list(found?.attribute_value_list);
        return (
          !!found &&
          values.length === expected.attribute_value_list.length &&
          expected.attribute_value_list.every((value, index) => {
            const result = values[index];
            return (
              result &&
              numeric(result.value_id) === value.value_id &&
              (value.original_value_name === undefined ||
                result.original_value_name === value.original_value_name) &&
              (value.value_unit === undefined || result.value_unit === value.value_unit)
            );
          })
        );
      }),
  );
  const logistics = list(actual.logistic_info);
  check(
    'logistic_info',
    new Set(logistics.map((channel) => numeric(channel.logistic_id))).size === logistics.length &&
      create.logistic_info.every((expected) => {
        const found = logistics.find(
          (channel) => numeric(channel.logistic_id) === expected.logistic_id,
        );
        return (
          !!found &&
          Object.entries(expected).every(([key, value]) =>
            typeof value === 'number' ? numeric(found[key]) === value : found[key] === value,
          )
        );
      }) &&
      logistics.every(
        (channel) =>
          !channel.enabled ||
          create.logistic_info.some(
            (expected) => expected.logistic_id === numeric(channel.logistic_id) && expected.enabled,
          ),
      ),
  );
  const checkPriceStock = (
    prefix: string,
    actual: Record<string, any>,
    price: number,
    stock: { stock: number }[],
  ) => {
    const prices = list(actual.price_info),
      match = prices.filter((entry) => entry.currency === 'VND');
    check(
      prefix + '.price',
      match.length === 1 &&
        numeric(match[0]?.original_price) === price &&
        numeric(match[0]?.current_price) === price,
    );
    const info = object(actual.stock_info_v2),
      summary = object(info.summary_info),
      seller = list(info.seller_stock),
      total = stock.reduce((sum, entry) => sum + entry.stock, 0);
    check(
      prefix + '.stock',
      seller.length === stock.length &&
        seller.every((entry, index) => numeric(entry.stock) === stock[index]?.stock) &&
        numeric(summary.total_available_stock) === total &&
        numeric(summary.total_reserved_stock) === 0,
    );
  };
  const hasTiers = !!tiers && tiers.standardise_tier_variation.length > 0;
  check('has_model', actual.has_model === hasTiers);
  if (!tiers) checkPriceStock('item', actual, create.original_price, create.seller_stock);
  else {
    const models = object(rawModels),
      actualTiers = list(models.tier_variation);
    check(
      'tier_variation',
      actualTiers.length === tiers.standardise_tier_variation.length &&
        tiers.standardise_tier_variation.every((tier, index) => {
          const found = actualTiers[index],
            options = list(found?.option_list);
          return (
            !!found &&
            found.name === tier.variation_name &&
            options.length === tier.variation_option_list.length &&
            tier.variation_option_list.every((option, optionIndex) => {
              const actualOption = options[optionIndex];
              return (
                !!actualOption &&
                actualOption.option === option.variation_option_name &&
                (option.image_id === undefined ||
                  object(actualOption.image).image_id === option.image_id)
              );
            })
          );
        }),
    );
    const actualModels = list(models.model);
    check(
      'model_membership',
      actualModels.length === tiers.model.length &&
        new Set(actualModels.map((model) => model.model_sku)).size === actualModels.length &&
        tiers.model.every((model) =>
          actualModels.some(
            (entry) =>
              entry.model_sku === model.model_sku && same(entry.tier_index, model.tier_index),
          ),
        ),
    );
    for (const model of tiers.model) {
      const found = actualModels.find((entry) => entry.model_sku === model.model_sku);
      if (found) {
        checkPriceStock(model.model_sku, found, model.original_price, model.seller_stock);
        if (model.gtin_code !== undefined)
          check(model.model_sku + '.gtin_code', found.gtin_code === model.gtin_code);
      }
    }
  }
  return issues;
}

async function context(
  options: SandboxCreateTrialWorkerOptions,
  claim: SandboxCreateTrialClaim,
): Promise<SandboxCreateTrialClient> {
  const row = (
    await options.repo.pool.query('SELECT * FROM connections WHERE id=$1', [claim.connectionId])
  ).rows[0];
  if (
    !row ||
    row.environment !== 'sandbox' ||
    row.partner_id !== '1232297' ||
    row.shop_id !== '227418363'
  )
    throw new Error('SANDBOX_TRIAL_SCOPE_NOT_ALLOWED');
  if (
    row.state !== 'connected' ||
    row.revision !== claim.connectionRevision ||
    !row.partner_key_ciphertext ||
    !row.token_ciphertext
  )
    throw new Error('SANDBOX_TRIAL_CONNECTION_CHANGED');
  const now = options.store.options.now?.() ?? new Date();
  if (row.expires_at && new Date(row.expires_at).getTime() <= now.getTime() + 30000)
    throw new Error('SANDBOX_TRIAL_TOKEN_EXPIRED');
  const box = new SecretBox(options.encryptionKey ?? process.env.APP_ENCRYPTION_KEY ?? ''),
    scope = 'sandbox:1232297:227418363';
  const partner = object(box.open(row.partner_key_ciphertext, scope)),
    token = object(box.open(row.token_ciphertext, scope));
  if (
    typeof partner.partnerKey !== 'string' ||
    !partner.partnerKey ||
    typeof token.accessToken !== 'string' ||
    !token.accessToken
  )
    throw new Error('SANDBOX_TRIAL_CONNECTION_REQUIRED');
  const credentials: ShopCredentials = {
    environment: 'sandbox',
    partnerId: row.partner_id,
    shopId: row.shop_id,
    partnerKey: partner.partnerKey,
    accessToken: token.accessToken,
  };
  return options.clientFactory?.(credentials) ?? new SandboxCreateClient(credentials);
}

/** One durable stage; injected transport exercises this exact coordinator in isolated tests. */
export async function runSandboxCreateTrialOnce(
  options: SandboxCreateTrialWorkerOptions,
): Promise<boolean> {
  const { store } = options,
    claim = await store.claim(options.workerId);
  if (!claim) return false;
  let client: SandboxCreateTrialClient,
    create: CreateUnlistedPayload,
    tiers: InitTiersPayload | undefined;
  try {
    create = createUnlistedSchema.parse(claim.intent.create);
    // Validate every later write before creating anything. The real bound ID is validated again after create.
    tiers = claim.intent.tiers
      ? initTiersSchema.parse({ ...claim.intent.tiers, item_id: Number(claim.itemId ?? '1') })
      : undefined;
    if (claim.stage === 'queued') {
      const evidence = object(claim.evidence),
        scope = object(evidence.scope),
        validated = Date.parse(evidence.validatedAt),
        now = store.options.now?.() ?? new Date();
      if (
        scope.environment !== 'sandbox' ||
        scope.partnerId !== '1232297' ||
        scope.shopId !== '227418363' ||
        !Number.isFinite(validated) ||
        validated > now.getTime() + 5000 ||
        now.getTime() - validated > 15 * 60000
      )
        throw new Error('SANDBOX_TRIAL_PREFLIGHT_EXPIRED');
    }
    client = await context(options, claim);
  } catch (error) {
    const code =
      error instanceof Error && /^SANDBOX_TRIAL_[A-Z_]+$/.test(error.message)
        ? error.message
        : 'SANDBOX_TRIAL_INPUT_OR_CONNECTION_INVALID';
    await store.failBeforeSend(claim, code, true);
    return true;
  }
  if (claim.stage === 'queued' || (claim.stage === 'created' && tiers)) {
    const stage = claim.stage === 'queued' ? 'create_intent' : 'tiers_intent',
      payload = stage === 'create_intent' ? create : tiers!;
    const attemptId = await store.beginMutation(claim, stage, payload);
    if (!attemptId) return true;
    let result: ProductOutcome<{ itemId: string }>;
    try {
      result =
        stage === 'create_intent'
          ? await client.createUnlisted(create)
          : await client.initializeTiers(tiers!);
    } catch {
      result = { kind: 'unknown', reason: 'transport' };
    }
    // A storage error here deliberately leaves the intent. Recovery must never resend this write.
    await store.finishMutation(
      claim,
      attemptId,
      result.kind === 'success'
        ? { kind: 'success', itemId: result.data.itemId, requestId: result.requestId }
        : {
            kind: result.kind,
            code: failureCode(result),
            requestId: result.requestId,
            auth: isAuth(result),
          },
    );
    return true;
  }
  if (!claim.itemId || !['created', 'readback'].includes(claim.stage))
    throw new Error('SANDBOX_TRIAL_INVALID_READ_STAGE');
  let base: ProductOutcome<Record<string, unknown>[]>,
    models: ProductOutcome<Record<string, unknown>> | undefined;
  try {
    base = await client.readBaseItems([claim.itemId]);
    if (base.kind === 'success' && tiers) models = await client.readModels(claim.itemId);
  } catch {
    base = { kind: 'unknown', reason: 'transport' };
  }
  const failure =
    base.kind !== 'success' ? base : models && models.kind !== 'success' ? models : undefined;
  if (failure)
    await store.finishRead(claim, {
      verified: false,
      issues: [failureCode(failure)],
      code: failureCode(failure),
      auth: isAuth(failure),
      requestIds: [base.requestId, models?.requestId].filter((value): value is string => !!value),
    });
  else {
    const data = base.kind === 'success' && base.data.length === 1 ? base.data[0] : undefined;
    const issues = compareSandboxCreateReadback(
      create,
      tiers,
      claim.itemId,
      data,
      models?.kind === 'success' ? models.data : undefined,
    );
    await store.finishRead(claim, {
      verified: issues.length === 0,
      issues,
      requestIds: [base.requestId, models?.requestId].filter((value): value is string => !!value),
      evidence: { item: data, models: models?.kind === 'success' ? models.data : null },
    });
  }
  return true;
}
