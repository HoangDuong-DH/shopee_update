import { createHash, randomUUID } from 'node:crypto';
import type { ChangePlan, Clock, StockInstruction } from './contracts.js';
export function canonicalJson(value: unknown): string {
  if (value === undefined) throw new Error('UNDEFINED_CANONICAL_VALUE');
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  return (
    '{' +
    Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => JSON.stringify(k) + ':' + canonicalJson(v))
      .join(',') +
    '}'
  );
}
export function planFingerprint(
  plan: Omit<ChangePlan, 'id' | 'fingerprint' | 'createdAt'> | ChangePlan,
): string {
  const { id: _, fingerprint: __, createdAt: ___, ...semantic } = plan as ChangePlan;
  return createHash('sha256').update(canonicalJson(semantic)).digest('hex');
}
export function makePlan(
  input: Omit<ChangePlan, 'id' | 'fingerprint' | 'createdAt'>,
  clock: Clock = { now: () => new Date() },
): ChangePlan {
  return structuredClone({
    ...input,
    id: randomUUID(),
    fingerprint: planFingerprint(input),
    createdAt: clock.now().toISOString(),
  });
}
export function shouldApplyStock(command: StockInstruction, appliedRevision: number): boolean {
  if (!Number.isSafeInteger(command.quantity) || command.quantity < 0)
    throw new Error('INVALID_STOCK');
  if (
    !Number.isSafeInteger(command.revision) ||
    command.revision < 1 ||
    !Number.isSafeInteger(appliedRevision) ||
    appliedRevision < 0
  )
    throw new Error('INVALID_STOCK_REVISION');
  return command.revision > appliedRevision;
}
