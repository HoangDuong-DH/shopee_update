import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';

const identifier = z.string().regex(/^[1-9]\d*$/).refine(value => Number.isSafeInteger(Number(value)));
export const productionScopeSchema = z.object({
  environment: z.literal('production'), partnerId: identifier, shopId: identifier,
}).strict();
export type ProductionScope = Readonly<z.infer<typeof productionScopeSchema>>;
export const legacyProductionScope: ProductionScope = Object.freeze({
  environment: 'production', partnerId: '2010476', shopId: '1423724897',
});
const scopes = new AsyncLocalStorage<ProductionScope>();

/** Immutable execution context, never a process-wide mutable "selected shop".
 * Unscoped historical CLI operations retain their original pilot contract.
 * HTTP workflows must bind an explicit validated scope at the entry point.
 */
export function currentProductionScope(): ProductionScope { return scopes.getStore() ?? legacyProductionScope; }
export function productionOwner(scope = currentProductionScope()) { return `${scope.environment}:${scope.partnerId}:${scope.shopId}`; }
export function withProductionScope<T>(scope: ProductionScope, run: () => T): T {
  return scopes.run(Object.freeze(productionScopeSchema.parse(scope)), run);
}
export function assertProductionScope(scope: unknown) {
  const parsed = productionScopeSchema.parse(scope), expected = currentProductionScope();
  if (productionOwner(parsed) !== productionOwner(expected)) throw Error('PRODUCTION_BATCH_SCOPE_MISMATCH');
  return parsed;
}
export function selectedProductionScope(raw: unknown): ProductionScope {
  const selected = z.object({ partnerId: identifier, shopId: identifier }).passthrough().parse(raw);
  return Object.freeze({ environment: 'production', partnerId: selected.partnerId, shopId: selected.shopId });
}

/** All methods including detached/background work inherit the captured scope.
 * Use a separate service instance per shop to isolate in-memory caches and gates.
 */
export function bindProductionService<T extends object>(scope: ProductionScope, service: T): T {
  const captured = Object.freeze(productionScopeSchema.parse(scope));
  return new Proxy(service, { get(target, key) {
    const value = Reflect.get(target, key, target);
    return typeof value === 'function'
      ? (...args: unknown[]) => withProductionScope(captured, () => Reflect.apply(value, target, args))
      : value;
  } });
}
