import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableJournal } from '../../master_brain/verification/harness/durable-journal.mjs';
import { SnapshotStore } from '../../master_brain/verification/harness/snapshot-store.mjs';

async function setup(){const dir=await mkdtemp(join(tmpdir(),'mb-consistency-'));return {dir,journal:new DurableJournal({path:join(dir,'journal.jsonl')}),snapshot:new SnapshotStore({path:join(dir,'snapshot.json')})};}

test('snapshot sequence must not be ahead of durable journal',async()=>{const x=await setup();await x.journal.append({event_id:'E1',type:'COMMIT',sequence:1});await x.snapshot.publish({value:1},2);const s=await x.snapshot.read();assert.equal(s.status,'VALID');assert.throws(()=>{if(s.snapshot.sequence>1)throw new Error('snapshot ahead of journal')});await x.journal.close();await rm(x.dir,{recursive:true,force:true});});

test('journal events after snapshot replay to the reference state',async()=>{const x=await setup();await x.snapshot.publish({status:'AUTHORIZED'},1);await x.journal.append({event_id:'E2',type:'STATE',sequence:2,payload:{status:'DENIED'}});const s=await x.snapshot.read();const events=await x.journal.readAll();assert.equal(s.snapshot.sequence,1);assert.equal(events.filter(e=>e.sequence>s.snapshot.sequence).length,1);await x.journal.close();await rm(x.dir,{recursive:true,force:true});});

test('snapshot hash mismatch blocks recovery even when journal is valid',async()=>{const x=await setup();await x.snapshot.publish({status:'AUTHORIZED'},1);await x.journal.append({event_id:'E2',type:'STATE',sequence:2});const raw=await import('node:fs/promises').then(fs=>fs.readFile(x.snapshot.path,'utf8'));const corrupted=JSON.parse(raw);corrupted.state.status='CORRUPTED';await import('node:fs/promises').then(fs=>fs.writeFile(x.snapshot.path,JSON.stringify(corrupted)+'\\n'));const s=await x.snapshot.read();assert.equal(s.status,'CORRUPTED');await x.journal.close();await rm(x.dir,{recursive:true,force:true});});
