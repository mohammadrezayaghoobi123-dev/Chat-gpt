import test from 'node:test';
import assert from 'node:assert/strict';
import { pruneWithRecovery } from '../../master_brain/core/reversible-pruning.mjs';

test('creates a recovery snapshot before pruning and can restore it after failed verification', async () => {
  const original = [
    { id: 'v1', kind: 'claim', status: 'VERIFIED', value: 'keep' },
    { id: 'n1', kind: 'transient', status: 'UNVERIFIED', value: 'noise' },
  ];

  const result = await pruneWithRecovery(original, {
    verify: async state => state.every(item => item.id !== 'n1'),
    forceVerificationFailure: true,
  });

  assert.equal(result.status, 'ROLLED_BACK');
  assert.deepEqual(result.state, original);
  assert.ok(result.snapshot_id);
});

test('commits safe pruning only after post-prune verification succeeds', async () => {
  const original = [
    { id: 'v1', kind: 'claim', status: 'VERIFIED', value: 'keep' },
    { id: 'n1', kind: 'transient', status: 'UNVERIFIED', value: 'noise' },
  ];

  const result = await pruneWithRecovery(original, {
    verify: async state => state.every(item => item.id !== 'n1'),
  });

  assert.equal(result.status, 'COMMITTED');
  assert.deepEqual(result.state.map(item => item.id), ['v1']);
  assert.ok(result.snapshot_id);
});
