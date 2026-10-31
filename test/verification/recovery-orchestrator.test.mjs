import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverFromSnapshotAndJournal, compareRecoveredState } from '../../master_brain/verification/harness/recovery-orchestrator.mjs';

const valid=(state,sequence)=>({status:'VALID',snapshot:{state,sequence}});

test('recovery replays contiguous journal events and matches expected state',()=>{const r=recoverFromSnapshotAndJournal({snapshotResult:valid({status:'AUTHORIZED'},1),events:[{sequence:2,type:'deny'}]});assert.equal(r.status,'RECOVERED');assert.deepEqual(r.state,{status:'DENIED'});assert.equal(compareRecoveredState(r,{status:'DENIED'}).status,'PASS');});

test('recovery blocks a sequence gap',()=>{const r=recoverFromSnapshotAndJournal({snapshotResult:valid({status:'AUTHORIZED'},1),events:[{sequence:3,type:'deny'}]});assert.equal(r.status,'INCONCLUSIVE');});

test('recovery blocks invalid snapshot before replay',()=>{const r=recoverFromSnapshotAndJournal({snapshotResult:{status:'CORRUPTED'},events:[]});assert.equal(r.status,'INCONCLUSIVE');});

test('state mismatch is independently detected',()=>{const r=recoverFromSnapshotAndJournal({snapshotResult:valid({status:'AUTHORIZED'},1),events:[{sequence:2,type:'deny'}]});assert.equal(compareRecoveredState(r,{status:'AUTHORIZED'}).status,'FAIL');});
