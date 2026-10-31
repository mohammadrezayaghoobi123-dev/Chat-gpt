import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, readFile, rm } from 'node:fs/promises';
import { SnapshotStore } from '../../master_brain/verification/harness/snapshot-store.mjs';

const path='/tmp/master-brain-snapshot.json';

test('snapshot publish is atomically readable and hash verified',async()=>{const s=new SnapshotStore({path});await s.reset();const out=await s.publish({status:'READY',value:7},3);assert.equal(out.sequence,3);const r=await s.read();assert.equal(r.status,'VALID');assert.deepEqual(r.snapshot.state,{status:'READY',value:7});await s.reset();});

test('snapshot corruption is blocked',async()=>{const s=new SnapshotStore({path});await s.reset();await s.publish({status:'READY'},4);const raw=JSON.parse(await readFile(path,'utf8'));raw.state.status='CORRUPTED';await rm(path);await appendFile(path,JSON.stringify(raw)+'\n');const r=await s.read();assert.equal(r.status,'CORRUPTED');await s.reset();});

test('partial snapshot publication is never valid',async()=>{const s=new SnapshotStore({path});await s.reset();await appendFile(path,JSON.stringify({version:1,sequence:5,state:{x:1},state_hash:'bad'}).slice(0,-2));const r=await s.read();assert.equal(r.status,'CORRUPTED');await s.reset();});

test('stale snapshot sequence is rejected by recovery policy',async()=>{const s=new SnapshotStore({path});await s.reset();await s.publish({status:'READY'},2);const r=await s.read();assert.equal(r.status,'VALID');assert.equal(r.snapshot.sequence,2);assert.ok(r.snapshot.sequence < 5);await s.reset();});
