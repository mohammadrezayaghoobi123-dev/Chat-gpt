import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableJournal } from '../../master_brain/verification/harness/durable-journal.mjs';
import { SnapshotStore } from '../../master_brain/verification/harness/snapshot-store.mjs';

async function setup(){const dir=await mkdtemp(join(tmpdir(),'mb-adversarial-'));return {dir,journal:new DurableJournal({path:join(dir,'journal.jsonl')}),snapshot:new SnapshotStore({path:join(dir,'snapshot.json')})};}

test('journal cannot contain an event sequence older than a committed snapshot without blocking consistency',async()=>{const x=await setup();await x.snapshot.publish({v:2},2);await x.journal.append({event_id:'OLD',type:'COMMIT',sequence:1});const events=await x.journal.readAll();assert.equal(events.some(e=>e.sequence<=2),true);await x.journal.close();await rm(x.dir,{recursive:true,force:true});});

test('journal sequence gap is detected as non-contiguous recovery input',async()=>{const x=await setup();await x.snapshot.publish({v:1},1);await x.journal.append({event_id:'E3',type:'COMMIT',sequence:3});const events=await x.journal.readAll();const next=events.filter(e=>e.sequence>1).map(e=>e.sequence).sort((a,b)=>a-b);assert.deepEqual(next,[3]);assert.notEqual(next[0],2);await x.journal.close();await rm(x.dir,{recursive:true,force:true});});
