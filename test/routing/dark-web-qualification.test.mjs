import test from 'node:test';
import assert from 'node:assert/strict';
import { qualifyDarkWebSpecialist } from '../../master_brain/routing/dark-web-qualification.mjs';

const base = {
  id: 'dark-specialist',
  provider_id: 'p-dark',
  capabilities: ['dark_web_intelligence'],
  specialist_roles: ['dark_web_intelligence'],
  availability: 'ACTIVE',
  provenance: 'VERIFIED',
  integrity: 'VERIFIED',
  health: 'HEALTHY',
  freshness: 'FRESH',
  risk_levels: ['medium', 'high'],
  independence_group: 'p-dark',
};

const strongBenchmark = {
  task_suite: 'dark-web-intelligence-v1',
  score: 0.91,
  baseline_score: 0.86,
  reproducible: true,
  independent_review: 'VERIFIED',
  dataset_provenance: 'VERIFIED',
  test_contamination: 'NONE_DETECTED',
  holdout_integrity: 'VERIFIED',
  metrics: { primary: 0.91, critical_subtasks_pass: true },
};

const strongSafety = {
  prompt_injection: 'PASS',
  poisoned_intelligence: 'PASS',
  false_attribution: 'PASS',
  stale_intelligence: 'PASS',
  provenance_spoofing: 'PASS',
};

test('Dark-Web specialist requires task-relevant benchmark evidence and deployment rights', () => {
  assert.equal(qualifyDarkWebSpecialist(base).status, 'INCONCLUSIVE');

  const result = qualifyDarkWebSpecialist({
    ...base,
    usage_authorization: 'VERIFIED',
    benchmark: strongBenchmark,
    safety: strongSafety,
  });
  assert.equal(result.status, 'QUALIFIED');
});

test('research-only candidate cannot qualify for production', () => {
  const result = qualifyDarkWebSpecialist({
    ...base,
    availability: 'CANDIDATE',
    usage_authorization: 'RESEARCH_ONLY',
    benchmark: strongBenchmark,
    safety: strongSafety,
  });
  assert.equal(result.status, 'INCONCLUSIVE');
});

test('benchmark without leakage/holdout evidence is not production qualification evidence', () => {
  const result = qualifyDarkWebSpecialist({
    ...base,
    usage_authorization: 'VERIFIED',
    benchmark: {
      ...strongBenchmark,
      test_contamination: 'UNKNOWN',
      holdout_integrity: 'UNKNOWN',
    },
    safety: strongSafety,
  });
  assert.equal(result.status, 'INCONCLUSIVE');
});

test('missing safety coverage for stale intelligence and provenance spoofing blocks qualification', () => {
  const result = qualifyDarkWebSpecialist({
    ...base,
    usage_authorization: 'VERIFIED',
    benchmark: strongBenchmark,
    safety: {
      ...strongSafety,
      stale_intelligence: 'UNKNOWN',
      provenance_spoofing: 'UNKNOWN',
    },
  });
  assert.equal(result.status, 'INCONCLUSIVE');
});
