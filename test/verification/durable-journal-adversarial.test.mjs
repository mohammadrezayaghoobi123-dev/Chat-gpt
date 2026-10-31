import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
import { DurableJournal } from '../../master_brain/verification/harness/durable-journal.mjs';

test('truncated tail is never replayed as a committed event and blocks recovery', async()=>{
  const path='/tmp/master-brain-journal-truncated.jsonl';
  const j=new DurableJournal({path}); await j.reset();
  await j.append({event_id:'E1',type:'COMMIT'});
  await j.close();
  await appendFile(path,'{"event_id":"E2","type":"COMMIT"','utf8');
  const r=new DurableJournal({path});
  await assert.rejects(()=>r.readAll());
  await r.close();
});

test('corrupt non-tail journal record blocks recovery instead of being ignored', async()=>{
  const path='/tmp/master-brain-journal-corrupt.jsonl';
  const j=new DurableJournal({path}); await j.reset();
  await j.append({event_id:'E1',type:'COMMIT'}); await j.close();
  await appendFile(path,'not-json\n','utf8');
  const r=new DurableJournal({path});
  await assert.rejects(()=>r.readAll());
  await r.close();
});
