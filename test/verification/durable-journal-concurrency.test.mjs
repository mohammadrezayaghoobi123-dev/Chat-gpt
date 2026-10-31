import test from 'node:test';
import assert from 'node:assert/strict';
import { DurableJournal } from '../../master_brain/verification/harness/durable-journal.mjs';

test('concurrent append of the same event id is exactly-once within one journal instance', async () => {
  const path = '/tmp/master-brain-journal-concurrency.jsonl';
  const journal = new DurableJournal({path});
  await journal.reset();
  const results = await Promise.all([
    journal.append({event_id:'CONCURRENT-1', type:'COMMIT', payload:{n:1}}),
    journal.append({event_id:'CONCURRENT-1', type:'COMMIT', payload:{n:1}}),
    journal.append({event_id:'CONCURRENT-1', type:'COMMIT', payload:{n:1}}),
  ]);
  const events = await journal.readAll();
  assert.equal(events.length, 1);
  assert.equal(results.filter(r => r.status === 'APPENDED').length, 1);
  assert.equal(results.filter(r => r.status === 'DUPLICATE').length, 2);
  await journal.close();
});
