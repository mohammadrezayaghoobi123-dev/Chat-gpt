import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableJournal } from '../../master_brain/verification/harness/durable-journal.mjs';
import { SnapshotStore } from '../../master_brain/verification/harness/snapshot-store.mjs';
import { recoverFromSnapshotAndJournal, compareRecoveredState } from '../../master_brain/verification/harness/recovery-orchestrator.mjs';
import { createReferenceModel } from '../../master_brain/verification/harness/reference-model.mjs';

const journalModule = new URL('../../master_brain/verification/harness/durable-journal.mjs', import.meta.url).href;

function runCrashWorker(journalPath) {
  const code = [
    'import { DurableJournal } from ' + JSON.stringify(journalModule) + ';',
    'const j = new DurableJournal({path:' + JSON.stringify(journalPath) + '});',
    "await j.append({event_id:'E2',type:'deny',sequence:2});",
    "process.kill(process.pid,'SIGKILL');"
  ].join('\n');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module','-e',code], {stdio:['ignore','pipe','pipe']});
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve({code, signal, stderr}));
  });
}

test('real crash after journal append recovers snapshot+journal to reference state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mb-e2e-recovery-'));
  const journalPath = join(dir, 'journal.jsonl');
  const snapshotPath = join(dir, 'snapshot.json');
  try {
    const journal = new DurableJournal({path:journalPath});
    const snapshot = new SnapshotStore({path:snapshotPath});
    const model = createReferenceModel();
    const base = model.apply(model.initialState(), {type:'authorize',value:'APPROVED'});
    await journal.append({event_id:'E1',type:'authorize',value:'APPROVED',sequence:1});
    await snapshot.publish(base, 1);

    const crash = await runCrashWorker(journalPath);
    assert.equal(crash.signal, 'SIGKILL', crash.stderr);

    const restoredJournal = new DurableJournal({path:journalPath});
    const events = await restoredJournal.readAll();
    const restoredSnapshot = await snapshot.read();
    const recovered = recoverFromSnapshotAndJournal({snapshotResult:restoredSnapshot,events,model});
    const expected = model.apply(base,{type:'deny',sequence:2});
    assert.equal(recovered.status, 'RECOVERED');
    assert.equal(compareRecoveredState(recovered, expected).status, 'PASS');
  } finally {
    await rm(dir,{recursive:true,force:true});
  }
});

test('snapshot/journal divergence after real crash is detected independently', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mb-e2e-divergence-'));
  const journalPath = join(dir, 'journal.jsonl');
  const snapshotPath = join(dir, 'snapshot.json');
  try {
    const journal = new DurableJournal({path:journalPath});
    const snapshot = new SnapshotStore({path:snapshotPath});
    const model = createReferenceModel();
    const base = model.apply(model.initialState(), {type:'authorize',value:'APPROVED'});
    await journal.append({event_id:'E1',type:'authorize',value:'APPROVED',sequence:1});
    await snapshot.publish(base, 1);
    const crash = await runCrashWorker(journalPath);
    assert.equal(crash.signal, 'SIGKILL', crash.stderr);
    const events = await (new DurableJournal({path:journalPath})).readAll();
    const recovered = recoverFromSnapshotAndJournal({snapshotResult:await snapshot.read(),events,model});
    assert.equal(compareRecoveredState(recovered, {status:'AUTHORIZED'}).status, 'FAIL');
  } finally {
    await rm(dir,{recursive:true,force:true});
  }
});
