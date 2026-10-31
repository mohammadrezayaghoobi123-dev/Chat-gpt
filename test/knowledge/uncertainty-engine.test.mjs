import assert from 'node:assert/strict';
import test from 'node:test';
import { assessUncertainty } from '../../master_brain/knowledge/uncertainty-engine.mjs';

test('assesses multiple uncertainty sources and identifies dominant uncertainty', () => {
  const result = assessUncertainty([
    { type: 'DATA', level: 0.2 },
    { type: 'MODEL', level: 0.8 },
    { type: 'PARAMETER', level: 0.4 },
  ]);

  assert.equal(result.total, 3);
  assert.equal(result.dominant.type, 'MODEL');
  assert.equal(result.dominant.level, 0.8);
});

test('rejects invalid uncertainty types and levels', () => {
  assert.throws(
    () => assessUncertainty([{ type: 'MAGIC', level: 0.5 }]),
    /invalid uncertainty type/i,
  );
  assert.throws(
    () => assessUncertainty([{ type: 'DATA', level: 1.2 }]),
    /invalid uncertainty level/i,
  );
});
