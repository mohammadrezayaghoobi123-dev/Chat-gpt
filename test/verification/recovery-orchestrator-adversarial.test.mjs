import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverFromSnapshotAndJournal, compareRecoveredState } from '../../master_brain/verification/harness/recovery-orchestrator.mjs';
const valid=(state,sequence)=>({status:'VALID',snapshot:{state,sequence}});

test('out-of-order events are normalized only when sequence is contiguous',()=>{const r=recoverFromSnapshotAndJournal({snapshotResult:valid({status:'AUTHORIZED'},1),events:[{sequence:3,type:'deny'},{sequence:2,type:'authorize',value:'APPROVED'}]});assert.equal(r.status,'RECOVERED');assert.deepEqual(r.state,{status:'DENIED'});});

test('duplicate sequence is blocked rather than silently replayed',()=>{const r=recoverFromSnapshotAndJournal({snapshotResult:valid({status:'AUTHORIZED'},1),events:[{sequence:2,type:'deny'},{sequence:2,type:'authorize',value:'APPROVED'}]});assert.equal(r.status,'INCONCLUSIVE');});

test('recovered state hash comparison catches semantic corruption',()=>{const r=recoverFromSnapshotAndJournal({snapshotResult:valid({status:'AUTHORIZED'},1),events:[{sequence:2,type:'deny'}]});const tampered={...r,state:{status:'AUTHORIZED'},state_hash:JSON.stringify({status:'AUTHORIZED'})};assert.equal(compareRecoveredState(tampered,{status:'DENIED'}).status,'FAIL');});
