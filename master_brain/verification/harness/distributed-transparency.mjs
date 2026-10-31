import { sign, verify } from 'node:crypto';

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

function signTreeHead(tree_head, privateKey) {
  const signature = sign(null, Buffer.from(canonical(tree_head)), privateKey).toString('base64');
  return { tree_head, algorithm: 'Ed25519', signature };
}

function verifyTreeHead(signed, publicKey) {
  if (!signed?.tree_head || signed.algorithm !== 'Ed25519' || !signed.signature) return { status: 'INCONCLUSIVE' };
  const ok = verify(null, Buffer.from(canonical(signed.tree_head)), publicKey, Buffer.from(signed.signature, 'base64'));
  return { status: ok ? 'PASS' : 'FAIL' };
}

function verifyConsistency(oldHead, newHead, evidence = {}) {
  if (!oldHead || !newHead || oldHead.log_id !== newHead.log_id) return { status: 'FAIL' };
  if (newHead.tree_size < oldHead.tree_size) return { status: 'FAIL' };
  if (newHead.timestamp < oldHead.timestamp) return { status: 'FAIL' };
  if (newHead.tree_size === oldHead.tree_size) {
    return newHead.root_hash === oldHead.root_hash ? { status: 'PASS' } : { status: 'FAIL', reason: 'EQUIVOCATION' };
  }
  if (evidence.consistency_proof_valid !== true) return { status: 'INCONCLUSIVE' };
  return { status: 'PASS' };
}

function compareWitnessViews(a, b) {
  if (!a || !b) return { status: 'INCONCLUSIVE', reason: 'MISSING_WITNESS' };
  if (a.log_id !== b.log_id) return { status: 'FAIL', reason: 'LOG_ID_MISMATCH' };
  if (a.tree_size === b.tree_size && a.root_hash !== b.root_hash) {
    return { status: 'FAIL', reason: 'EQUIVOCATION' };
  }
  if (a.tree_size === b.tree_size && a.root_hash === b.root_hash) return { status: 'PASS' };
  return { status: 'INCONCLUSIVE', reason: 'INSUFFICIENT_COMPARISON_EVIDENCE' };
}

export { signTreeHead, verifyTreeHead, verifyConsistency, compareWitnessViews };
