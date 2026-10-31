import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateThreatIntelligenceAdmission,
  evaluateThreatClaim,
  evaluateThreatActionPolicy,
  assertThreatIntelligenceIsolation,
  BLOCKED_INTENTS
} from '../../master_brain/verification/harness/threat-intelligence-gate.mjs';

const base = {
  source_type:'dark_web', provenance:'VERIFIED', collection_legality:'AUTHORIZED',
  content_hash:'sha256:fixture', collected_at:'2026-10-06T00:00:00Z',
  confidence:'HIGH', uncertainty:'LOW', corroboration:'INDEPENDENT',
  payload_safety:'SAFE', sanitized:true, classification:'THREAT_INTEL'
};

test('F43 poisoned intelligence: corrupted provenance cannot be admitted', () => {
  assert.equal(evaluateThreatIntelligenceAdmission({record:{...base, provenance:'CORRUPTED'}}).status,'INCONCLUSIVE');
});

test('F44 malicious payload: unsafe content is blocked before admission', () => {
  assert.equal(evaluateThreatIntelligenceAdmission({record:{...base, payload_safety:'MALICIOUS'}}).status,'FAIL');
});

test('F45 false attribution: disproven high-impact claim cannot be promoted', () => {
  assert.equal(evaluateThreatClaim({
    claim:{claim_id:'C-F45', attribution:'HIGH_IMPACT', status:'FALSE'},
    sources:[{independence:'INDEPENDENT',verification:'VERIFIED'},{independence:'INDEPENDENT',verification:'VERIFIED'}]
  }).status,'FAIL');
});

test('F46 stale or low-confidence intelligence remains unresolved', () => {
  assert.equal(evaluateThreatIntelligenceAdmission({record:{...base, confidence:'LOW'}}).status,'INCONCLUSIVE');
});

test('F47 correlated reporting is not independent corroboration', () => {
  assert.equal(evaluateThreatClaim({
    claim:{claim_id:'C-F47', attribution:'HIGH_IMPACT', status:'ACTIVE'},
    sources:[{independence:'CORRELATED',verification:'VERIFIED'},{independence:'CORRELATED',verification:'VERIFIED'}]
  }).status,'INCONCLUSIVE');
});

test('F48 hostile intelligence cannot authorize a blocked action class', () => {
  assert.equal(evaluateThreatActionPolicy({intent:BLOCKED_INTENTS[0]}).status,'FAIL');
});

test('F49 spoofed provenance cannot become trusted intelligence', () => {
  assert.equal(evaluateThreatIntelligenceAdmission({record:{...base, provenance:'UNKNOWN'}}).status,'INCONCLUSIVE');
});

test('untrusted intelligence remains isolated from trusted destinations', () => {
  assert.throws(
    () => assertThreatIntelligenceIsolation({destinations:['trusted-memory','execution']}),
    /cannot directly reach trusted memory or execution/
  );
});
