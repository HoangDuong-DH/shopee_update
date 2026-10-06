import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEnduranceArgs, BoundedLatency } from '../scripts/runtime-endurance-core.mjs';
test('endurance options reject unsafe or unbounded runs', () => {
  assert.deepEqual(parseEnduranceArgs([]), { seconds: 300, concurrency: 20, intervalMs: 150 });
  for (const args of [
    ['--seconds', '0'],
    ['--seconds', '86401'],
    ['--concurrency', '101'],
    ['--concurrency', 'NaN'],
    ['--url', 'http://remote'],
    ['--seconds', '10', '--seconds', '20'],
  ])
    assert.throws(() => parseEnduranceArgs(args));
});
test('latency memory is fixed while request count grows', () => {
  const histogram = new BoundedLatency();
  for (let i = 0; i < 100000; i++) histogram.add(32);
  histogram.add(4500);
  assert.equal(histogram.count, 100001);
  assert.equal(histogram.percentile(0.95), 40);
  assert.equal(histogram.maxMs, 4500);
  assert.equal(histogram.buckets.length, 1001);
});
