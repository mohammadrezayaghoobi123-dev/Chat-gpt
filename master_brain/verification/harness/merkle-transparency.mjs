import { createHash } from 'node:crypto';

const hash = x => createHash('sha256').update(x).digest('hex');
const pairHash = (a, b) => hash(a + b);

function merkleRoot(leaves) {
  if (!Array.isArray(leaves) || leaves.length === 0) return null;
  let level = [...leaves];
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(pairHash(level[i], level[i + 1] ?? level[i]));
    }
    level = next;
  }
  return level[0];
}

function merkleProof(leaves, index) {
  if (!Array.isArray(leaves) || index < 0 || index >= leaves.length) return [];
  let level = [...leaves];
  let idx = index;
  const proof = [];
  while (level.length > 1) {
    const sibling = idx % 2 === 0 ? idx + 1 : idx - 1;
    proof.push({
      position: idx % 2 === 0 ? 'right' : 'left',
      hash: level[sibling] ?? level[idx],
    });
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(pairHash(level[i], level[i + 1] ?? level[i]));
    level = next;
    idx = Math.floor(idx / 2);
  }
  return proof;
}

function verifyMerkleProof(leaf, proof, root) {
  let current = leaf;
  for (const step of proof ?? []) {
    current = step.position === 'right' ? pairHash(current, step.hash) : pairHash(step.hash, current);
  }
  return current === root;
}

function appendTransparencyRecord(log, record) {
  const previous = log.at(-1)?.entry_hash ?? 'GENESIS';
  const entry_hash = hash(previous + JSON.stringify(record));
  return { log: [...log, { ...record, previous, entry_hash }] };
}

function verifyTransparencyConsistency(oldLog, newLog) {
  if (!Array.isArray(oldLog) || !Array.isArray(newLog) || newLog.length < oldLog.length) return { status: 'FAIL' };
  for (let i = 0; i < oldLog.length; i++) {
    if (JSON.stringify(oldLog[i]) !== JSON.stringify(newLog[i])) return { status: 'FAIL' };
  }
  for (let i = 1; i < newLog.length; i++) {
    if (newLog[i].previous !== newLog[i - 1].entry_hash) return { status: 'FAIL' };
  }
  return { status: 'PASS' };
}

export { merkleRoot, merkleProof, verifyMerkleProof, appendTransparencyRecord, verifyTransparencyConsistency };
