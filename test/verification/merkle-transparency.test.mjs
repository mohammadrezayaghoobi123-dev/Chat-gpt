import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  merkleRoot,
  merkleProof,
  verifyMerkleProof,
  appendTransparencyRecord,
  verifyTransparencyConsistency,
} from '../../master_brain/verification/harness/merkle-transparency.mjs';

const h = x => createHash('sha256').update(x).digest('hex');

test('Merkle root and inclusion proof verify deterministically', () => {
  const leaves = ['a', 'b', 'c', 'd'].map(h);
  const root = merkleRoot(leaves);
  const proof = merkleProof(leaves, 2);
  assert.equal(verifyMerkleProof(leaves[2], proof, root), true);
});

test('tampered leaf or proof is rejected', () => {
  const leaves = ['a', 'b', 'c', 'd'].map(h);
  const root = merkleRoot(leaves);
  const proof = merkleProof(leaves, 1);
  assert.equal(verifyMerkleProof(h('tampered'), proof, root), false);
});

test('transparency log detects append-only consistency violations', () => {
  const first = appendTransparencyRecord([], { id: 1, hash: h('one') });
  const second = appendTransparencyRecord(first.log, { id: 2, hash: h('two') });
  assert.equal(verifyTransparencyConsistency(first.log, second.log).status, 'PASS');

  const altered = [...second.log];
  altered[0] = { ...altered[0], hash: h('evil') };
  assert.equal(verifyTransparencyConsistency(first.log, altered).status, 'FAIL');
});
