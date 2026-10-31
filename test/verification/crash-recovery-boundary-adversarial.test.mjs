import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateCrashRecovery } from '../../master_brain/verification/harness/recovery-controller.mjs';

test('during-commit crash with durable commit outcome preserves exactly one event',()=>{
  const r=simulateCrashRecovery({crash_point:'DURING_COMMIT',commit_outcome:'COMMITTED'});
  assert.equal(r.committed,true);
  assert.equal(r.event_count,1);
});

test('during snapshot publication never exposes a partially published snapshot as ready',()=>{
  const r=simulateCrashRecovery({crash_point:'DURING_SNAPSHOT_PUBLICATION',snapshot_status:'PARTIAL'});
  assert.equal(r.ready,false);
  assert.equal(r.snapshot_ready,false);
});

test('known-bad duplicate replay is detected rather than reported as idempotent',()=>{
  const r=simulateCrashRecovery({crash_point:'AFTER_PUBLICATION',force_duplicate_on_replay:true,replay_count:3});
  assert.equal(r.duplicate_critical_side_effect,true);
  assert.equal(r.safe,false);
});
