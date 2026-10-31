import test from 'node:test';
import assert from 'node:assert/strict';
import { DurableJournal } from '../../master_brain/verification/harness/durable-journal.mjs';

test('journal survives a new instance and replays committed events', async()=>{
  const path='/tmp/master-brain-journal-test.jsonl';
  const a=new DurableJournal({path});
  await a.reset();
  await a.append({event_id:'E1',type:'COMMIT',payload:{value:1}});
  await a.close();
  const b=new DurableJournal({path});
  const events=await b.readAll();
  assert.equal(events.length,1);
  assert.equal(events[0].event_id,'E1');
  await b.close();
});

test('duplicate event ids are idempotent across restart', async()=>{
  const path='/tmp/master-brain-journal-idempotency.jsonl';
  const a=new DurableJournal({path}); await a.reset();
  assert.equal((await a.append({event_id:'E1',type:'COMMIT'})).status,'APPENDED');
  await a.close();
  const b=new DurableJournal({path});
  assert.equal((await b.append({event_id:'E1',type:'COMMIT'})).status,'DUPLICATE');
  assert.equal((await b.readAll()).length,1);
  await b.close();
});
