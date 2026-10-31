import { createHash, sign, verify } from 'node:crypto';

function canonicalizeRecord(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalizeRecord).join(',') + ']';
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonicalizeRecord(value[k])).join(',') + '}';
}

function digest(record) {
  return 'sha256:' + createHash('sha256').update(canonicalizeRecord(record)).digest('hex');
}

function signTrustRecord(record, privateKey) {
  const canonical = canonicalizeRecord(record);
  const record_hash = digest(record);
  const signature = sign(null, Buffer.from(canonical), privateKey).toString('base64');
  return { record, record_hash, signature, algorithm: 'Ed25519' };
}

function verifyTrustRecord(signed, publicKey) {
  if (!signed?.record || !signed?.signature || signed.algorithm !== 'Ed25519') {
    return { status: 'INCONCLUSIVE' };
  }
  const expectedHash = digest(signed.record);
  if (expectedHash !== signed.record_hash) return { status: 'FAIL' };
  const ok = verify(null, Buffer.from(canonicalizeRecord(signed.record)), publicKey, Buffer.from(signed.signature, 'base64'));
  return { status: ok ? 'PASS' : 'FAIL' };
}

function verifyTrustRecordAgainstKey(signed, key = {}) {
  if (key.status === 'REVOKED') return { status: 'FAIL' };
  if (key.status !== 'VERIFIED') return { status: 'INCONCLUSIVE' };
  return verifyTrustRecord(signed, key.publicKey);
}

export {
  canonicalizeRecord,
  signTrustRecord,
  verifyTrustRecord,
  verifyTrustRecordAgainstKey,
};
