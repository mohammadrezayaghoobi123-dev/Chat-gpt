import assert from 'node:assert/strict';
import test from 'node:test';
import { createEpistemicRecord } from '../../master_brain/knowledge/epistemic-engine.mjs';

test('creates an explicit epistemic record without collapsing inference into fact', () => {
  const record = createEpistemicRecord({
    statement: 'Demand will increase next quarter',
    kind: 'PREDICTION',
    basis: ['sales trend'],
  });

  assert.equal(record.kind, 'PREDICTION');
  assert.equal(record.statement, 'Demand will increase next quarter');
  assert.deepEqual(record.basis, ['sales trend']);
});

test('rejects unsupported epistemic kinds', () => {
  assert.throws(
    () => createEpistemicRecord({ statement: 'x', kind: 'GUESSING' }),
    /invalid epistemic kind/i,
  );
});
