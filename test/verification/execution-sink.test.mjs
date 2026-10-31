import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutionSink } from '../../master_brain/verification/harness/execution-sink.mjs';

test('denies protected operations by default and exposes isolation evidence', () => {
  const sink = createExecutionSink({ run_id: 'RUN-001' });
  assert.equal(sink.assertIsolated().isolated, true);
  assert.equal(sink.execute({operation:'financial_transaction'}).status, 'BLOCKED');
  assert.equal(sink.execute({operation:'production_deployment'}).status, 'BLOCKED');
  assert.equal(sink.execute({operation:'simulate'}).status, 'SIMULATED');
});

test('derives a deterministic trace id from the run id', () => {
  const a = createExecutionSink({ run_id: 'RUN-001' }).assertIsolated().trace_id;
  const b = createExecutionSink({ run_id: 'RUN-001' }).assertIsolated().trace_id;
  const c = createExecutionSink({ run_id: 'RUN-002' }).assertIsolated().trace_id;
  assert.equal(a, b);
  assert.notEqual(a, c);
});
