import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateEvidenceMesh, REQUIRED_INDEPENDENT_CLASSES } from '../../master_brain/verification/harness/evidence-mesh.mjs';

const good = REQUIRED_INDEPENDENT_CLASSES.map((className, i) => ({
  id: `e${i}`, class: className, status: 'VERIFIED', independence_group: `g${i}`, source_id: `s${i}`
}));

test('evidence mesh requires multiple independent evidence classes', () => {
  const r = evaluateEvidenceMesh({ evidence: good });
  assert.equal(r.status, 'PASS');
  assert.equal(r.independent_lineages, 5);
});

test('correlated evidence cannot masquerade as independent evidence', () => {
  const r = evaluateEvidenceMesh({ evidence: good.map(e => ({...e, independence_group:'same-lineage'})) });
  assert.equal(r.status, 'INCONCLUSIVE');
  assert.equal(r.reason, 'INSUFFICIENT_INDEPENDENT_LINEAGES');
});

test('missing negative evidence blocks qualification', () => {
  const r = evaluateEvidenceMesh({ evidence: good.filter(e => e.class !== 'NEGATIVE_EVIDENCE') });
  assert.equal(r.status, 'INCONCLUSIVE');
  assert.ok(r.missing.includes('NEGATIVE_EVIDENCE'));
});

test('unresolved negative evidence fails closed', () => {
  const r = evaluateEvidenceMesh({ evidence: good.map(e => e.class === 'NEGATIVE_EVIDENCE' ? {...e, result:'RISK'} : e) });
  assert.equal(r.status, 'FAIL');
});
