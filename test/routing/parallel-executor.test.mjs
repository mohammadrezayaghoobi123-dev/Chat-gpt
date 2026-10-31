import assert from 'node:assert/strict';
import test from 'node:test';
import { executeInParallel } from '../../master_brain/routing/parallel-executor.mjs';

test('parallel executor runs independent specialists concurrently and preserves result identity', async () => {
  const started = [];
  const tasks = [
    { id: 'research-a', run: async () => { started.push('a'); await new Promise(r => setTimeout(r, 30)); return { answer: 'A' }; } },
    { id: 'research-b', run: async () => { started.push('b'); await new Promise(r => setTimeout(r, 30)); return { answer: 'B' }; } },
  ];
  const began = Date.now();
  const results = await executeInParallel(tasks);
  const elapsed = Date.now() - began;
  assert.deepEqual(started.sort(), ['a', 'b']);
  assert.ok(elapsed < 55, `expected concurrent execution, got ${elapsed}ms`);
  assert.deepEqual(results.map(r => [r.id, r.status]), [['research-a', 'fulfilled'], ['research-b', 'fulfilled']]);
});
