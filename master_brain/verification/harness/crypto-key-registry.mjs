const DEFAULT_ALGORITHMS = ['Ed25519'];

function createKeyRegistry({ algorithms = DEFAULT_ALGORITHMS } = {}) {
  return { version: 1, algorithms: new Set(algorithms), keys: new Map() };
}

function registerKey(registry, key) {
  if (!key?.key_id || !key.algorithm || !key.publicKey) return { status:'INCONCLUSIVE', reason:'INCOMPLETE_KEY' };
  if (!registry.algorithms.has(key.algorithm)) return { status:'FAIL', reason:'UNSUPPORTED_ALGORITHM' };
  if (registry.keys.has(key.key_id)) return { status:'FAIL', reason:'DUPLICATE_KEY_ID' };
  if (!Number.isInteger(key.epoch) || key.epoch < 1) return { status:'FAIL', reason:'INVALID_EPOCH' };
  if (!['ACTIVE','PENDING'].includes(key.status)) return { status:'FAIL', reason:'INVALID_INITIAL_STATUS' };
  registry.keys.set(key.key_id, { ...key });
  return { status:'PASS', key_id:key.key_id };
}

function resolveKey(registry, keyId) {
  const key = registry.keys.get(keyId);
  return key ? { ...key } : { status:'UNKNOWN', reason:'KEY_NOT_FOUND' };
}

function canAuthorizeRotation({ approvals = 0, required_approvals = 2, distinct_approvers = false } = {}) {
  if (!Number.isInteger(approvals) || approvals < required_approvals) return { status:'FAIL', reason:'APPROVAL_THRESHOLD' };
  if (distinct_approvers !== true) return { status:'FAIL', reason:'DISTINCT_APPROVALS_REQUIRED' };
  return { status:'PASS' };
}

function rotateKey(registry, oldKeyId, nextKey, approval) {
  const old = registry.keys.get(oldKeyId);
  if (!old) return { status:'INCONCLUSIVE', reason:'OLD_KEY_UNKNOWN' };
  if (old.status !== 'ACTIVE') return { status:'FAIL', reason:'OLD_KEY_NOT_ACTIVE' };
  const auth = canAuthorizeRotation(approval);
  if (auth.status !== 'PASS') return auth;
  if (nextKey.epoch !== old.epoch + 1) return { status:'FAIL', reason:'EPOCH_NOT_MONOTONIC' };
  const added = registerKey(registry, { ...nextKey, status:'ACTIVE' });
  if (added.status !== 'PASS') return added;
  old.status = 'RETIRED';
  old.retired_by = nextKey.key_id;
  return { status:'PASS', old_key_id:oldKeyId, new_key_id:nextKey.key_id };
}

function revokeKey(registry, keyId) {
  const key = registry.keys.get(keyId);
  if (!key) return { status:'INCONCLUSIVE', reason:'KEY_UNKNOWN' };
  if (key.status === 'REVOKED') return { status:'FAIL', reason:'ALREADY_REVOKED' };
  key.status = 'REVOKED';
  return { status:'PASS', key_id:keyId };
}

export { createKeyRegistry, registerKey, rotateKey, revokeKey, resolveKey, canAuthorizeRotation };
