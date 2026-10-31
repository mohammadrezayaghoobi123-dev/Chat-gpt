import { randomUUID } from 'node:crypto';

function clone(value) {
  return structuredClone(value);
}

export async function pruneWithRecovery(items = [], options = {}) {
  if (!Array.isArray(items)) throw new TypeError('items must be an array');
  if (typeof options.verify !== 'function') throw new TypeError('verify is required');

  const snapshot_id = randomUUID();
  const snapshot = clone(items);
  const state = clone(items).filter(item => item?.kind !== 'transient' && item?.kind !== 'ephemeral' && item?.kind !== 'scratch');

  if (options.forceVerificationFailure === true) {
    return { status: 'ROLLED_BACK', snapshot_id, state: snapshot };
  }

  const verified = await options.verify(clone(state));
  if (verified === true) return { status: 'COMMITTED', snapshot_id, state };

  return { status: 'ROLLED_BACK', snapshot_id, state: snapshot };
}
