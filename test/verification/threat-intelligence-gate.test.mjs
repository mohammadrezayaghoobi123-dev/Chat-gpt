import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateThreatIntelligenceAdmission,
  evaluateThreatClaim,
  evaluateThreatActionPolicy,
  assertThreatIntelligenceIsolation
} from '../../master_brain/verification/harness/threat-intelligence-gate.mjs';

const goodRecord = {
  source_type: 'dark_web',
  provenance: 'VERIFIED',
  collection_legality: 'AUTHORIZED',
  content_hash: 'sha256:x',
  collected_at: '2026-10-06T00:00:00Z',
  confidence: 'HIGH',
  uncertainty: 'LOW',
  corroboration: 'INDEPENDENT',
  payload_safety: 'SAFE',
  sanitized: true,
  classification: 'THREAT_INTELLIGENCE'
};

test('Dark Web is admitted only as verified, sanitized, authorized intelligence', () => {
  assert.equal(evaluateThreatIntelligenceAdmission({record:goodRecord}).status, 'PASS');
});

test('unknown provenance remains INCONCLUSIVE', () => {
  assert.equal(evaluateThreatIntelligenceAdmission({record:{...goodRecord, provenance:'UNKNOWN'}}).status, 'INCONCLUSIVE');
});

test('unsafe payload is blocked', () => {
  assert.equal(evaluateThreatIntelligenceAdmission({record:{...goodRecord, payload_safety:'UNSAFE'}}).status, 'FAIL');
});

test('high-impact attribution requires independent corroboration', () => {
  assert.equal(evaluateThreatClaim({
    claim:{claim_id:'c1', attribution:'HIGH_IMPACT', status:'SUPPORTED'},
    sources:[{independence:'INDEPENDENT',verification:'VERIFIED'}]
  }).status, 'INCONCLUSIVE');
  assert.equal(evaluateThreatClaim({
    claim:{claim_id:'c1', attribution:'HIGH_IMPACT', status:'SUPPORTED'},
    sources:[
      {independence:'INDEPENDENT',verification:'VERIFIED'},
      {independence:'INDEPENDENT',verification:'VERIFIED'}
    ]
  }).status, 'PASS');
});

test('conflicted threat intelligence cannot be promoted', () => {
  assert.equal(evaluateThreatClaim({
    claim:{claim_id:'c2', attribution:'NORMAL', status:'CONFLICTED'},
    sources:[{independence:'INDEPENDENT',verification:'VERIFIED'}]
  }).status, 'INCONCLUSIVE');
});

test('poisoned provenance is a hard failure', () => {
  assert.equal(evaluateThreatClaim({
    claim:{claim_id:'c3', attribution:'NORMAL', status:'SUPPORTED', provenance:'CORRUPTED'},
    sources:[{independence:'INDEPENDENT',verification:'VERIFIED'}]
  }).status, 'FAIL');
});

test('illicit Dark Web actions are blocked by policy', () => {
  assert.equal(evaluateThreatActionPolicy({intent:'purchase_credentials'}).status, 'FAIL');
  assert.equal(evaluateThreatActionPolicy({intent:'purchase_malware'}).status, 'FAIL');
  assert.equal(evaluateThreatActionPolicy({intent:'monitor_exposure'}).status, 'PASS');
});

test('untrusted intelligence cannot directly reach trusted memory or execution', () => {
  assert.throws(() => assertThreatIntelligenceIsolation({destinations:['trusted-memory']}), /cannot directly reach/);
  assert.throws(() => assertThreatIntelligenceIsolation({destinations:['execution']}), /cannot directly reach/);
  assert.doesNotThrow(() => assertThreatIntelligenceIsolation({destinations:['quarantine']}));
});

test('missing admission evidence remains INCONCLUSIVE', () => {
  assert.equal(evaluateThreatIntelligenceAdmission({record:{source_type:'dark_web'}}).status, 'INCONCLUSIVE');
});
