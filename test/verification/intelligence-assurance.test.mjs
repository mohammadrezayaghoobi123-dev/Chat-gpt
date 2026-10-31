import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessSourceReliability,
  assessFreshness,
  buildLineageGraph,
  detectClaimContradictions,
  fuseEvidence,
  expandSources,
  evaluateIntelligenceCampaign,
} from '../../master_brain/research/intelligence-assurance.mjs';

test('source reliability is bounded and degrades when provenance is weak', () => {
  const strong = assessSourceReliability({
    source_type: 'GOVERNMENT',
    provenance: 'VERIFIED',
    historical_reliability: 0.95,
    collection_quality: 0.95,
    independence: 0.9,
  });
  const weak = assessSourceReliability({
    source_type: 'SOCIAL',
    provenance: 'UNKNOWN',
    historical_reliability: 0.95,
    collection_quality: 0.4,
    independence: 0.2,
  });
  assert.equal(strong.status, 'PASS');
  assert.ok(strong.score > weak.score);
  assert.ok(strong.score >= 0 && strong.score <= 1);
  assert.ok(weak.score >= 0 && weak.score <= 1);
});

test('freshness applies source-class half-life and marks stale evidence', () => {
  const fresh = assessFreshness({ collected_at: '2026-10-06T00:00:00Z', now: '2026-10-06T12:00:00Z', half_life_hours: 24 });
  const stale = assessFreshness({ collected_at: '2026-09-01T00:00:00Z', now: '2026-10-06T00:00:00Z', half_life_hours: 24 });
  assert.equal(fresh.status, 'FRESH');
  assert.equal(stale.status, 'STALE');
  assert.ok(fresh.weight > stale.weight);
});

test('lineage graph distinguishes duplicated reporting from independent corroboration', () => {
  const graph = buildLineageGraph({
    claims: [
      { claim_id: 'c1', source_id: 'a', lineage_id: 'wire-a', parent_ids: [] },
      { claim_id: 'c2', source_id: 'b', lineage_id: 'wire-a', parent_ids: ['c1'] },
      { claim_id: 'c3', source_id: 'c', lineage_id: 'independent-c', parent_ids: [] },
    ],
  });
  assert.equal(graph.independent_lineages_for_claim('c1'), 2);
  assert.equal(graph.duplicated_lineages_for_claim('c1'), 1);
});

test('contradiction engine keeps mutually exclusive claims conflicted', () => {
  const result = detectClaimContradictions({
    claims: [
      { claim_id: 'a', topic: 'factory_status', value: 'OPEN', evidence_status: 'VERIFIED' },
      { claim_id: 'b', topic: 'factory_status', value: 'CLOSED', evidence_status: 'VERIFIED' },
    ],
  });
  assert.equal(result.status, 'CONFLICTED');
  assert.ok(result.conflicts.length === 1);
});

test('evidence fusion refuses to convert conflict or weak provenance into certainty', () => {
  const conflict = fuseEvidence({
    claims: [
      { claim_id: 'a', value: 'YES', confidence: 0.95, evidence_status: 'VERIFIED', provenance: 'VERIFIED', lineage_id: 'x' },
      { claim_id: 'b', value: 'NO', confidence: 0.95, evidence_status: 'VERIFIED', provenance: 'VERIFIED', lineage_id: 'y' },
    ],
  });
  const weak = fuseEvidence({
    claims: [
      { claim_id: 'a', value: 'YES', confidence: 0.99, evidence_status: 'VERIFIED', provenance: 'UNKNOWN', lineage_id: 'x' },
    ],
  });
  assert.equal(conflict.status, 'CONFLICTED');
  assert.equal(weak.status, 'INCONCLUSIVE');
});

test('dynamic source expansion adds high-value sources when uncertainty remains', () => {
  const expanded = expandSources({
    selected: ['NEWS'],
    objective: 'verify a breaking industrial event',
    uncertainty: 'HIGH',
    missing_roles: ['official', 'primary', 'current'],
  });
  assert.ok(expanded.added.includes('GOVERNMENT'));
  assert.ok(expanded.added.includes('SEARCH_WEB'));
  assert.ok(expanded.expansion_reason.length > 0);
});

test('adaptive intelligence campaign blocks poisoned, laundered, and stale evidence', () => {
  const result = evaluateIntelligenceCampaign({
    observations: [
      { source: 'DARK_WEB', provenance: 'VERIFIED', sanitized: true, content_type: 'DATA', confidence: 'HIGH', stale: false, lineage_id: 'dark-1', claim_id: 'x', value: 'BREACH' },
      { source: 'SOCIAL', provenance: 'VERIFIED', sanitized: true, content_type: 'DATA', confidence: 'HIGH', stale: false, lineage_id: 'social-1', claim_id: 'x', value: 'BREACH' },
      { source: 'FORUM', provenance: 'SPOOFED', sanitized: true, content_type: 'DATA', confidence: 'HIGH', stale: false, lineage_id: 'forum-1', claim_id: 'x', value: 'BREACH' },
      { source: 'NEWS', provenance: 'VERIFIED', sanitized: true, content_type: 'DATA', confidence: 'LOW', stale: true, lineage_id: 'news-1', claim_id: 'x', value: 'BREACH' },
    ],
    requested_action: 'ANALYZE',
  });
  assert.equal(result.status, 'HOLD');
  assert.ok(result.reasons.some((r) => /poison|stale|quality/i.test(r)));
});
