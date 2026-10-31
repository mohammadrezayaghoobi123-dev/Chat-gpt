import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, readFile, rm } from 'node:fs/promises';
import { DurableJournal } from '../../master_brain/verification/harness/durable-journal.mjs';

async function expectBlocked(path) {
  const j = new DurableJournal({path});
  await assert.rejects(() => j.readAll());
  await j.close();
}

test('partial JSON record at every byte boundary is never replayed as committed', async () => {
  const path = '/tmp/master-brain-journal-byte-boundary.jsonl';
  const full = JSON.stringify({event_id:'TORN-1',type:'COMMIT',payload:{value:'boundary'}})+'\\n';
  for (let n = 1; n < full.length; n++) {
    await rm(path,{force:true});
    await appendFile(path, full.slice(0,n),'utf8');
    await expectBlocked(path);
  }
  await rm(path,{force:true});
});

test('valid committed prefix followed by partial record blocks complete recovery', async () => {
  const path = '/tmp/master-brain-journal-prefix-torn.jsonl';
  const j = new DurableJournal({path});
  await j.reset();
  await j.append({event_id:'GOOD-1',type:'COMMIT'});
  await j.close();
  const partial = JSON.stringify({event_id:'TORN-2',type:'COMMIT'}).slice(0,12);
  await appendFile(path,partial,'utf8');
  await expectBlocked(path);
  await rm(path,{force:true});
});
