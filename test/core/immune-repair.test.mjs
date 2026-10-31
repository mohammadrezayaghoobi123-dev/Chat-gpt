import test from 'node:test';
import assert from 'node:assert/strict';
import { runSafeRepair } from '../../master_brain/core/immune-repair.mjs';

test('safe repair applies a repair only after verification succeeds', async () => {
  const events = [];
  const result = await runSafeRepair({
    incident: { id: 'INC-1', severity: 'WARNING', signature: 'worker-unavailable' },
    repair: async () => events.push('repair'),
    verify: async () => { events.push('verify'); return true; },
    rollback: async () => events.push('rollback'),
  });

  assert.equal(result.status, 'REPAIRED');
  assert.deepEqual(events, ['repair', 'verify']);
});

test('failed verification rolls back and never reports a successful repair', async () => {
  const events = [];
  const result = await runSafeRepair({
    incident: { id: 'INC-2', severity: 'WARNING', signature: 'config-drift' },
    repair: async () => events.push('repair'),
    verify: async () => { events.push('verify'); return false; },
    rollback: async () => events.push('rollback'),
  });

  assert.equal(result.status, 'ROLLED_BACK');
  assert.deepEqual(events, ['repair', 'verify', 'rollback']);
});

test('critical or irreversible repair is blocked before mutation', async () => {
  let repaired = false;
  const result = await runSafeRepair({
    incident: { id: 'INC-3', severity: 'CRITICAL', signature: 'core-modification' },
    repair: async () => { repaired = true; },
    verify: async () => true,
    rollback: async () => {},
  });

  assert.equal(result.status, 'APPROVAL_REQUIRED');
  assert.equal(repaired, false);
});
