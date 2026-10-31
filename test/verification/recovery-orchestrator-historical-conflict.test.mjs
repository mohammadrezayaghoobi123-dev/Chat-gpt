import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverFromSnapshotAndJournal } from '../../master_brain/verification/harness/recovery-orchestrator.mjs';

const valid = (state, sequence) => ({status:'VALID', snapshot:{state, sequence}});

test('conflicting event at snapshot sequence is not silently discarded', () => {
  const r = recoverFromSnapshotAndJournal({snapshotResult:valid({status:'AUTHORIZED'},1), events:[{sequence:1,event_id:'CONFLICT-1',type:'deny',state_hash:JSON.stringify({status:'CONFLICT'})},{sequence:2,event_id:'E2',type:'deny'}]});
  assert.equal(r.status,'INCONCLUSIVE');
});

test('conflicting historical event before snapshot is not silently accepted', () => {
  const r = recoverFromSnapshotAndJournal({snapshotResult:valid({status:'AUTHORIZED'},2), events:[{sequence:1,event_id:'OLD-1',type:'deny',state_hash:JSON.stringify({status:'CONFLICT'})},{sequence:3,event_id:'E3',type:'deny'}]});
  assert.equal(r.status,'INCONCLUSIVE');
});
