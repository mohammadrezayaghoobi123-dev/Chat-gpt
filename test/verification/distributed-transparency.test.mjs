import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  signTreeHead,
  verifyTreeHead,
  verifyConsistency,
  compareWitnessViews,
} from '../../master_brain/verification/harness/distributed-transparency.mjs';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');

test('signed tree head is independently verifiable', () => {
  const sth = signTreeHead({ log_id: 'mb-log', tree_size: 4, root_hash: 'root-4', timestamp: 100 }, privateKey);
  assert.equal(verifyTreeHead(sth, publicKey).status, 'PASS');
});

test('tampered tree head is rejected', () => {
  const sth = signTreeHead({ log_id: 'mb-log', tree_size: 4, root_hash: 'root-4', timestamp: 100 }, privateKey);
  assert.equal(verifyTreeHead({...sth, tree_head: {...sth.tree_head, root_hash: 'evil'}} , publicKey).status, 'FAIL');
});

test('same log history with monotonic growth is consistent', () => {
  const oldHead = { log_id: 'mb-log', tree_size: 4, root_hash: 'root-4', timestamp: 100 };
  const newHead = { log_id: 'mb-log', tree_size: 6, root_hash: 'root-6', timestamp: 120 };
  assert.equal(verifyConsistency(oldHead, newHead, { consistency_proof_valid: true }).status, 'PASS');
});

test('witness disagreement detects equivocation and fails closed', () => {
  const a = { log_id: 'mb-log', tree_size: 10, root_hash: 'root-A', timestamp: 200 };
  const b = { log_id: 'mb-log', tree_size: 10, root_hash: 'root-B', timestamp: 200 };
  const result = compareWitnessViews(a, b);
  assert.equal(result.status, 'FAIL');
  assert.equal(result.reason, 'EQUIVOCATION');
});

test('incomplete witness evidence is inconclusive', () => {
  const a = { log_id: 'mb-log', tree_size: 10, root_hash: 'root-A', timestamp: 200 };
  const result = compareWitnessViews(a, null);
  assert.equal(result.status, 'INCONCLUSIVE');
});
