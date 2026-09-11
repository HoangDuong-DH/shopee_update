import { performance } from 'node:perf_hooks';

// Bounds awaiting work. Already-dispatched database reads may finish later; callers
// must check this budget before further dispatch and guard terminal writes in SQL.
export class Deadline {
  private readonly end: number;
  constructor(milliseconds = 120_000) {
    if (!Number.isInteger(milliseconds) || milliseconds < 1 || milliseconds > 120_000)
      throw new Error('INVALID_HARNESS_BUDGET');
    this.end = performance.now() + milliseconds;
  }
  remainingMs(): number {
    const remaining = this.end - performance.now();
    if (remaining <= 0) throw new Error('DEADLINE_EXCEEDED');
    return Math.max(1, Math.floor(remaining));
  }
  async wait<T>(work: () => Promise<T>): Promise<T> {
    const remaining = this.end - performance.now();
    if (remaining <= 0) throw new Error('DEADLINE_EXCEEDED');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        work(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('DEADLINE_EXCEEDED')), remaining);
        }),
      ]);
      if (performance.now() >= this.end) throw new Error('DEADLINE_EXCEEDED');
      return result;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
