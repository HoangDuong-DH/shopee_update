export function parseEnduranceArgs(args) {
  const result = { seconds: 300, concurrency: 20, intervalMs: 150 };
  const rules = {
    '--seconds': ['seconds', 1, 86400],
    '--concurrency': ['concurrency', 1, 100],
    '--interval-ms': ['intervalMs', 20, 60000],
  };
  const seen = new Set();
  for (let i = 0; i < args.length; i += 2) {
    const rule = rules[args[i]],
      value = Number(args[i + 1]);
    if (
      !rule ||
      seen.has(args[i]) ||
      !Number.isInteger(value) ||
      value < rule[1] ||
      value > rule[2]
    )
      throw Error('ENDURANCE_ARGUMENTS_INVALID');
    seen.add(args[i]);
    result[rule[0]] = value;
  }
  return result;
}
export class BoundedLatency {
  buckets = new Uint32Array(1001);
  count = 0;
  maxMs = 0;
  add(ms) {
    if (!Number.isFinite(ms) || ms < 0) throw Error('LATENCY_INVALID');
    this.buckets[Math.min(1000, Math.ceil(ms / 10))]++;
    this.count++;
    this.maxMs = Math.max(this.maxMs, Math.round(ms));
  }
  percentile(p) {
    let cumulative = 0;
    const target = Math.ceil(this.count * p);
    for (let i = 0; i < this.buckets.length; i++) {
      cumulative += this.buckets[i];
      if (cumulative >= target) return i * 10;
    }
    return 10000;
  }
}
