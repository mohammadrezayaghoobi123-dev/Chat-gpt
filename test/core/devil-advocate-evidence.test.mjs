import test from 'node:test';
import assert from 'node:assert/strict';
import { challengeDecision } from '../../master_brain/knowledge/devil-advocate.mjs';

test('generates falsification questions for a tentatively resolved claim', () => {
  const result = challengeDecision({
    claim: { subject: 'machine-A', predicate: 'capacity', value: '1000 kg/day' },
    evidence: [
      { source_type: 'supplier_document', directness: 'DIRECT', methodology: 'DOCUMENTED', lineage_independent: true, freshness_days: 5 },
      { source_type: 'social_post', directness: 'INDIRECT', methodology: 'UNKNOWN', lineage_independent: false, freshness_days: 2 },
    ],
    alternatives: [{ value: '700 kg/day', evidence_score: 0.61 }],
  });

  assert.equal(result.status, 'CHALLENGE_REQUIRED');
  assert.ok(result.questions.some(q => q.includes('definition')));
  assert.ok(result.questions.some(q => q.includes('operating')));
  assert.ok(result.reconsideration_triggers.length >= 2);
});

test('raises unresolved status when evidence is too close to defend one side', () => {
  const result = challengeDecision({
    claim: { subject: 'A', predicate: 'capacity', value: '1000' },
    evidence: [
      { source_type: 'supplier_document', directness: 'DIRECT', methodology: 'DOCUMENTED', lineage_independent: true, freshness_days: 10 },
      { source_type: 'official_document', directness: 'DIRECT', methodology: 'DOCUMENTED', lineage_independent: true, freshness_days: 10 },
    ],
    alternatives: [{ value: '700', evidence_score: 0.91 }],
  });

  assert.equal(result.status, 'UNRESOLVED');
  assert.equal(result.decision_safe, false);
});
