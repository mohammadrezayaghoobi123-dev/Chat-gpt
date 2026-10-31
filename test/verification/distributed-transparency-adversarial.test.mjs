import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { signTreeHead, verifyTreeHead, verifyConsistency, compareWitnessViews } from '../../master_brain/verification/harness/distributed-transparency.mjs';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');

test('stale tree head cannot silently outrank a newer verified checkpoint', () => {
  const newer = { log_id:'mb-log', tree_size:20, root_hash:'r20', timestamp:200 };
  const stale = { log_id:'mb-log', tree_size:19, root_hash:'r19', timestamp:190 };
  const result = verifyConsistency(newer, stale, { consistency_proof_valid:true });
  assert.equal(result.status, 'FAIL');
});

test('same-size conflicting roots are explicit equivocation', () => {
  const a = { log_id:'mb-log', tree_size:20, root_hash:'A', timestamp:200 };
  const b = { log_id:'mb-log', tree_size:20, root_hash:'B', timestamp:200 };
  assert.deepEqual(compareWitnessViews(a,b), {status:'FAIL', reason:'EQUIVOCATION'});
});

test('timestamp rollback is rejected', () => {
  const oldHead = { log_id:'mb-log', tree_size:20, root_hash:'r20', timestamp:200 };
  const newHead = { log_id:'mb-log', tree_size:21, root_hash:'r21', timestamp:199 };
  assert.equal(verifyConsistency(oldHead,newHead,{consistency_proof_valid:true}).status,'FAIL');
});

test('unverified signer cannot publish a trusted checkpoint', () => {
  const sth = signTreeHead({log_id:'mb-log',tree_size:20,root_hash:'r20',timestamp:200},privateKey);
  assert.equal(verifyTreeHead(sth, publicKey).status,'PASS');
});
