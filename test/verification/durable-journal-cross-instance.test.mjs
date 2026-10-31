import test from 'node:test';
import assert from 'node:assert/strict';
import { DurableJournal } from '../../master_brain/verification/harness/durable-journal.mjs';

test('concurrent append of the same event id across journal instances is exactly-once', async () => {
  const path = '/tmp/master-brain-journal-cross-instance.jsonl';
  const a = new DurableJournal({path});
  const b = new DurableJournal({path});
  await a.reset();
  const results = await Promise.all([
    a.append({event_id:'CROSS-1', type:'COMMIT', payload:{n:1}}),
    b.append({event_id:'CROSS-1', type:'COMMIT', payload:{n:1}}),
  ]);
  const verifier = new DurableJournal({path});
  const events = await verifier.readAll();
  assert.equal(events.length, 1);
  assert.equal(results.filter(r => r.status === 'APPENDED').length, 1);
  assert.equal(results.filter(r => r.status === 'DUPLICATE').length, 1);
  await a.close(); await b.close(); await verifier.close();
});
