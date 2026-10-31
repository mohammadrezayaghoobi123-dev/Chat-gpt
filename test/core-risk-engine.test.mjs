import test from 'node:test';
import assert from 'node:assert/strict';
import { assessRisk } from '../master_brain/core/risk-engine.mjs';

test('classifies critical irreversible actions as critical risk', () => {
  const result = assessRisk({ impact: 'CRITICAL', probability: 0.4, reversibility: 'IRREVERSIBLE' });
  assert.equal(result.level, 'CRITICAL');
});

test('classifies low impact reversible actions as low risk', () => {
  const result = assessRisk({ impact: 'LOW', probability: 0.1, reversibility: 'REVERSIBLE' });
  assert.equal(result.level, 'LOW');
});