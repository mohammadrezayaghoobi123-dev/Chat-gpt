import test from 'node:test';
import assert from 'node:assert/strict';
import {COMPARISON_CRITERIA,evaluateProtocolCandidate,rankCandidates} from '../../master_brain/verification/harness/threshold-protocol-comparison.mjs';

const complete = id => ({id,version:'1',criteria:Object.fromEntries(COMPARISON_CRITERIA.map(k=>[k,'VERIFIED'])),negative_evidence:'RESOLVED',artifact:{version:'1',content_hash:'sha256:0123456789abcdef0123456789abcdef',status:'VERIFIED'},evidence_freshness:'VERIFIED',evidence_mesh:{status:'PASS',independent_lineages:5},security_assumptions:'VERIFIED'});

test('threshold protocol comparison requires the full scientific qualification matrix',()=>{
  assert.ok(COMPARISON_CRITERIA.includes('adaptive_security'));
  assert.ok(COMPARISON_CRITERIA.includes('pqc_readiness'));
  assert.ok(COMPARISON_CRITERIA.includes('negative_evidence'));
  assert.ok(COMPARISON_CRITERIA.includes('independent_reproduction'));
});

test('complete independently reproduced candidate can qualify',()=>{
  assert.equal(evaluateProtocolCandidate(complete('candidate-a')).status,'QUALIFIED');
});

test('missing evidence holds rather than promoting a protocol',()=>{
  const c=complete('candidate-b'); delete c.criteria.dkg;
  const r=evaluateProtocolCandidate(c);
  assert.equal(r.status,'HOLD'); assert.ok(r.missing.includes('dkg'));
});

test('unresolved negative evidence rejects qualification',()=>{
  const c=complete('candidate-c'); c.negative_evidence='UNRESOLVED_RISK';
  assert.equal(evaluateProtocolCandidate(c).status,'REJECT');
});

test('ranking never lets a popular or named candidate bypass evidence gates',()=>{
  const weak={id:'frost',version:'rfc9591',criteria:{}};
  const strong=complete('candidate-d');
  const ranked=rankCandidates([weak,strong]);
  assert.equal(ranked[0].evaluation.status,'QUALIFIED');
  assert.equal(ranked[1].evaluation.status,'HOLD');
});

test('production qualification requires exact artifact identity and evidence freshness',()=>{
  const c=complete('candidate-e');
  c.artifact={version:'1',content_hash:'sha256:abcdef12',status:'VERIFIED'};
  c.evidence_freshness='VERIFIED';
  assert.equal(evaluateProtocolCandidate(c).status,'QUALIFIED');
  delete c.artifact.content_hash;
  assert.equal(evaluateProtocolCandidate(c).status,'HOLD');
});

test('qualification integrates an independent evidence mesh rather than trusting criterion flags',()=>{
  const c=complete('candidate-f');
  c.artifact={version:'1',content_hash:'sha256:abcdef34',status:'VERIFIED'};
  c.evidence_freshness='VERIFIED';
  c.evidence_mesh={status:'PASS',independent_lineages:5};
  assert.equal(evaluateProtocolCandidate(c).status,'QUALIFIED');
  c.evidence_mesh={status:'PASS',independent_lineages:1};
  assert.equal(evaluateProtocolCandidate(c).status,'HOLD');
});

test('unverified artifact or stale evidence cannot promote a protocol',()=>{
  const c=complete('candidate-g');
  c.artifact={version:'1',content_hash:'sha256:abcdef56',status:'UNVERIFIED'};
  c.evidence_freshness='STALE';
  assert.equal(evaluateProtocolCandidate(c).status,'HOLD');
});

test('explicit security assumptions are mandatory and must be verified',()=>{
  const c=complete('candidate-h');
  c.artifact={version:'1',content_hash:'sha256:abcdef78',status:'VERIFIED'};
  c.evidence_freshness='VERIFIED';
  c.security_assumptions='UNKNOWN';
  assert.equal(evaluateProtocolCandidate(c).status,'HOLD');
});
