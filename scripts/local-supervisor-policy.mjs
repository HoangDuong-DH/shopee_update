// Recovery policy is pure and injected; it never sends platform requests or kills a process.
export const DEFAULT_RECOVERY_POLICY = Object.freeze({ pollMs: 5000, baseDelayMs: 1000, maxDelayMs: 30000, maxRetries: 3, windowMs: 600000 });
const stamp = value => new Date(value).toISOString();
function validPolicy(policy) {
  return policy && Object.keys(DEFAULT_RECOVERY_POLICY).every(key => Number.isSafeInteger(policy[key]) && policy[key] > 0)
    && policy.maxRetries <= 3 && policy.windowMs <= 600000 && policy.baseDelayMs <= policy.maxDelayMs && policy.maxDelayMs <= 30000 && policy.pollMs <= 5000;
}
export function validSupervisorReceipt(state) {
  const statuses = ['checking', 'unknown', 'running', 'degraded', 'held', 'backoff', 'restarting'];
  return Boolean(state && state.version === 1 && state.kind === 'listingstudio-local-supervisor' && typeof state.enabled === 'boolean'
    && typeof state.projectRoot === 'string' && typeof state.runtimePath === 'string' && validPolicy(state.policy)
    && state.roles && typeof state.roles === 'object' && !Array.isArray(state.roles) && Array.isArray(state.events) && state.events.length <= 100
    && Object.entries(state.roles).every(([role, detail]) => ['api', 'web', 'worker'].includes(role) && detail && typeof detail === 'object'
      && !Array.isArray(detail) && statuses.includes(detail.status) && Array.isArray(detail.attempts) && detail.attempts.length <= 3
      && detail.attempts.every(at => Number.isSafeInteger(at) && at >= 0)));
}
export function newSupervisorState({ projectRoot, identity, runtimePath, now = Date.now(), policy = DEFAULT_RECOVERY_POLICY }) {
  if (!validPolicy(policy)) throw Error('Invalid recovery policy.');
  return { version: 1, kind: 'listingstudio-local-supervisor', projectRoot, runtimePath, identity, enabled: true, createdAt: stamp(now), policy: { ...policy }, roles: {}, events: [] };
}
function event(state, role, reason, now, details = {}) {
  // Whitelist values only: never persist exceptions, commands, environment or credentials.
  state.events = [...(Array.isArray(state.events) ? state.events : []), { at: stamp(now), role, reason, ...details }].slice(-100);
}
export function createSupervisorController(adapters) {
  let active = false;
  return { async tick() {
    if (active) return { busy: true };
    active = true;
    try { return await adapters.lock(async () => {
      const state = await adapters.readState();
      if (!state?.enabled) return { disabled: true };
      const now = adapters.now?.() ?? Date.now();
      if (!validSupervisorReceipt(state)) {
        state.enabled = false; state.status = 'held'; state.holdReason = 'invalid_recovery_receipt';
        state.events = [{ at: stamp(now), role: 'supervisor', reason: 'invalid_recovery_receipt' }];
        await adapters.writeState(state); return { held: true };
      }
      let safe;
      try { safe = await adapters.guard(state); } catch { safe = { ok: false, reason: 'configuration_unavailable' }; }
      if (!safe?.ok) {
        state.status = 'held'; state.holdReason = safe?.reason === 'identity_changed' ? 'identity_changed' : 'configuration_unavailable';
        state.enabled = false; event(state, 'supervisor', state.holdReason, now);
        await adapters.writeState(state); return { held: true };
      }
      let runtime;
      try { runtime = await adapters.readRuntime(); } catch {}
      if (!runtime || runtime.version !== 1 || runtime.projectRoot !== state.projectRoot || !runtime.roles || typeof runtime.roles !== 'object' || Array.isArray(runtime.roles) || !Object.keys(runtime.roles).length
        || Object.values(runtime.roles).some(claim => !claim || typeof claim !== 'object' || !Number.isInteger(claim.pid) || claim.pid <= 0)) {
        state.enabled = false; state.status = 'held'; state.holdReason = 'runtime_unavailable';
        event(state, 'supervisor', state.holdReason, now); await adapters.writeState(state); return { held: true };
      }
      for (const [role, claim] of Object.entries(runtime.roles ?? {})) {
        if (!['api', 'web', 'worker'].includes(role)) continue;
        const detail = state.roles[role] ??= { attempts: [], status: 'checking' };
        if (detail.status === 'held') continue;
        let result;
        try { result = await adapters.inspect(claim, state.projectRoot); } catch { result = { kind: 'unknown' }; }
        if (result.kind === 'unknown') {
          if (detail.status !== 'unknown') event(state, role, 'ownership_unknown', now);
          detail.status = 'unknown'; continue;
        }
        if (result.kind === 'alive') {
          let healthy = true;
          try { healthy = await adapters.health?.(role) ?? true; } catch { healthy = false; }
          detail.status = healthy ? 'running' : 'degraded';
          delete detail.nextAttemptAt; delete detail.deadPid;
          continue;
        }
        if (result.kind !== 'dead') { detail.status = 'unknown'; continue; }
        if (detail.deadPid !== claim.pid || detail.deadStartedAt !== claim.startedAt) {
          detail.deadPid = claim.pid; detail.deadStartedAt = claim.startedAt;
          event(state, role, 'process_observed_dead', now, { pid: claim.pid, exitCode: Number.isInteger(result.exitCode) ? result.exitCode : null, exitReason: result.exitReason === 'process_exit' ? 'process_exit' : 'exit_unknown' });
          detail.nextAttemptAt = now + Math.min(state.policy.maxDelayMs, state.policy.baseDelayMs * 2 ** Math.min(detail.attempts.length, 20));
        }
        // The importer can consume queued work as soon as it boots. Require explicit review.
        if (role === 'worker' || safe.recoveryHeld) {
          detail.status = 'held'; detail.holdReason = role === 'worker' ? 'worker_queue_review_required' : 'transfer_hold';
          event(state, role, detail.holdReason, now); continue;
        }
        detail.attempts = detail.attempts.filter(at => at > now - state.policy.windowMs);
        if (detail.attempts.length >= state.policy.maxRetries) {
          detail.status = 'held'; detail.holdReason = 'retry_limit'; event(state, role, 'retry_limit', now); continue;
        }
        detail.status = 'backoff';
        if (now < detail.nextAttemptAt) continue;
        // Persist the budget before spawning: a crash cannot silently reset the retry count.
        detail.attempts.push(now); detail.status = 'restarting'; event(state, role, 'restart_attempt', now);
        await adapters.writeState(state);
        try {
          await adapters.restart(role, runtime);
          detail.status = 'running'; delete detail.nextAttemptAt;
          event(state, role, 'restart_verified', now);
        } catch {
          // A spawn may have succeeded before ownership timed out. Do not send it again.
          detail.status = 'held'; detail.holdReason = 'restart_unverified'; event(state, role, 'restart_unverified', now);
        }
      }
      state.lastTickAt = stamp(now);
      state.status = Object.values(state.roles).some(item => ['held', 'unknown', 'degraded', 'backoff'].includes(item.status)) ? 'degraded' : 'monitoring';
      await adapters.writeState(state);
      return { status: state.status };
    }); } finally { active = false; }
  } };
}
export async function disableSupervisor({ readState, writeState, now = Date.now() }) {
  const state = await readState();
  if (!state) return;
  state.enabled = false; state.status = 'stopped'; state.stoppedAt = stamp(now);
  event(state, 'supervisor', 'manual_stop', now);
  await writeState(state);
}
