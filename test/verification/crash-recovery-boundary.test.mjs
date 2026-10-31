import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateCrashRecovery } from '../../master_brain/verification/harness/recovery-controller.mjs';

test('crash before commit produces no phantom commit',()=>{
  const r=simulateCrashRecovery({crash_point:'BEFORE_COMMIT',intended_event:'E1'});
  assert.equal(r.committed,false);
  assert.equal(r.event_count,0);
});

test('crash after commit preserves the committed event exactly once',()=>{
  const r=simulateCrashRecovery({crash_point:'AFTER_COMMIT',intended_event:'E1'});
  assert.equal(r.committed,true);
  assert.equal(r.event_count,1);
  assert.equal(r.duplicate_critical_side_effect,false);
});

test('crash after publication is replay-idempotent',()=>{
  const r=simulateCrashRecovery({crash_point:'AFTER_PUBLICATION',intended_event:'E1',replay_count:3});
  assert.equal(r.published,true);
  assert.equal(r.event_count,1);
  assert.equal(r.replay_side_effects,1);
});

test('stale worker cannot mutate state after recovery epoch changes',()=>{
  const r=simulateCrashRecovery({crash_point:'DURING_RECOVERY',worker_epoch:1,recovery_epoch:2,worker_attempts:2});
  assert.equal(r.stale_worker_mutations,0);
});

test('recovery during commit with ambiguous outcome stays unready',()=>{
  const r=simulateCrashRecovery({crash_point:'DURING_COMMIT',commit_outcome:'AMBIGUOUS'});
  assert.equal(r.ready,false);
});
