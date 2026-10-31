import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskGraph, runReadyTasks } from '../master_brain/core/task-graph.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('runs independent ready tasks in parallel', async () => {
  const graph = createTaskGraph([
    { id: 'A', objective: 'A' },
    { id: 'B', objective: 'B' },
  ]);
  const started = [];
  const startedAt = new Map();
  const runner = async task => {
    started.push(task.id);
    startedAt.set(task.id, Date.now());
    await wait(40);
    return `${task.id}:done`;
  };

  const result = await runReadyTasks(graph, runner);
  assert.deepEqual(started.sort(), ['A', 'B']);
  assert.ok(Math.abs(startedAt.get('A') - startedAt.get('B')) < 25);
  assert.equal(result.status, 'VERIFIED');
  assert.equal(graph.get('A').status, 'VERIFIED');
  assert.equal(graph.get('B').status, 'VERIFIED');
});

test('does not run a dependent task until its dependency is verified', async () => {
  const graph = createTaskGraph([
    { id: 'A', objective: 'A' },
    { id: 'B', objective: 'B', depends_on: ['A'] },
  ]);
  const order = [];
  const runner = async task => { order.push(task.id); return 'ok'; };

  await runReadyTasks(graph, runner);
  assert.deepEqual(order, ['A']);
  assert.equal(graph.get('B').status, 'READY');

  await runReadyTasks(graph, runner);
  assert.deepEqual(order, ['A', 'B']);
  assert.equal(graph.get('B').status, 'VERIFIED');
});

test('blocks dependents when a dependency fails', async () => {
  const graph = createTaskGraph([
    { id: 'A', objective: 'A' },
    { id: 'B', objective: 'B', depends_on: ['A'] },
  ]);
  await runReadyTasks(graph, async () => { throw new Error('boom'); });
  assert.equal(graph.get('A').status, 'FAILED');
  assert.equal(graph.get('B').status, 'BLOCKED');
});
