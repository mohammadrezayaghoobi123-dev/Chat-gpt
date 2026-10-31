import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableJournal } from '../../master_brain/verification/harness/durable-journal.mjs';
import { SnapshotStore } from '../../master_brain/verification/harness/snapshot-store.mjs';
import { createReferenceModel } from '../../master_brain/verification/harness/reference-model.mjs';
import { recoverFromSnapshotAndJournal, compareRecoveredState } from '../../master_brain/verification/harness/recovery-orchestrator.mjs';

const SEEDS = [0x5eed, 0x12345678, 0xa11ce, 0xdeadbeef, 0x42];
const EVENTS = 80;

function rng(seed) {
  let x = seed >>> 0;
  return () => { x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0; x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0; return ((x ^ (x >>> 16)) >>> 0) / 0x100000000; };
}
function makeEvents(seed, count = EVENTS) {
  const r = rng(seed);
  return Array.from({length: count}, (_, i) => ({
    event_id: `RCR-${seed.toString(16)}-${i + 1}`,
    sequence: i + 1,
    type: r() < 0.5 ? 'authorize' : r() < 0.75 ? 'deny' : 'reset',
    value: r() < 0.5 ? 'APPROVED' : 'REJECTED'
  }));
}
function wait(child) {
  return new Promise(resolve => child.on('exit', (code, signal) => resolve({code, signal})));
}

async function crashAppendWorker(journalPath, events, startIndex, endIndex) {
  const fixture = journalPath + '.events.json';
  await writeFile(fixture, JSON.stringify(events.slice(startIndex, endIndex)), 'utf8');
  const journalModule = new URL('../../master_brain/verification/harness/durable-journal.mjs', import.meta.url).href;
  const code = [
    `import { readFile } from 'node:fs/promises';`,
    `import { DurableJournal } from ${JSON.stringify(journalModule)};`,
    `const events = JSON.parse(await readFile(${JSON.stringify(fixture)}, 'utf8'));`,
    `const j = new DurableJournal({path:${JSON.stringify(journalPath)}});`,
    `for (const e of events) await j.append(e);`,
    `process.kill(process.pid, 'SIGKILL');`
  ].join('\n');
  return wait(spawn(process.execPath, ['--input-type=module', '-e', code], {stdio:'ignore'}));
}

test('deterministic randomized crash/recovery campaign: real crash, snapshot, replay, reference-model comparison', async () => {
  const results = [];
  for (const seed of SEEDS) {
    const dir = await mkdtemp(join(tmpdir(), `mb-random-rcr-${seed.toString(16)}-`));
    const journalPath = join(dir, 'journal.jsonl');
    const snapshotPath = join(dir, 'snapshot.json');
    try {
      const events = makeEvents(seed);
      const r = rng(seed ^ 0x9e3779b9);
      const snapshotPoint = Math.floor(r() * 20);
      const crashIndex = snapshotPoint + 1 + Math.floor(r() * (events.length - snapshotPoint));
      const model = createReferenceModel();
      let expected = model.initialState();
      for (const e of events.slice(0, snapshotPoint)) expected = model.apply(expected, e);

      const journal = new DurableJournal({path: journalPath});
      for (const e of events.slice(0, snapshotPoint)) await journal.append(e);
      const snapshot = await new SnapshotStore({path: snapshotPath}).publish(expected, snapshotPoint);
      await journal.close();

      const crash = await crashAppendWorker(journalPath, events, snapshotPoint, crashIndex);
      assert.equal(crash.signal, 'SIGKILL', `seed=${seed}: crash boundary was not observed`);

      const restarted = new DurableJournal({path: journalPath});
      for (const e of events.slice(crashIndex)) await restarted.append(e);
      const persisted = await restarted.readAll();
      await restarted.close();

      for (const e of events.slice(snapshotPoint)) expected = model.apply(expected, e);
      const snapshotResult = await new SnapshotStore({path: snapshotPath}).read();
      const recovered = recoverFromSnapshotAndJournal({snapshotResult, events: persisted, model});
      const comparison = compareRecoveredState(recovered, expected);
      assert.equal(recovered.status, 'RECOVERED', `seed=${seed}: recovery failed: ${JSON.stringify(recovered)}`);
      assert.equal(comparison.status, 'PASS', `seed=${seed}: state divergence: ${JSON.stringify(comparison)}`);
      assert.equal(persisted.length, events.length, `seed=${seed}: durable event loss/duplication`);
      results.push({seed, snapshotPoint, crashIndex, recoveredSequence: recovered.sequence, status: comparison.status});
    } finally {
      await rm(dir, {recursive:true, force:true});
    }
  }
  assert.equal(results.length, SEEDS.length);
  assert.ok(results.every(x => x.status === 'PASS'));
  console.log('RANDOMIZED_RCR_CAMPAIGN', JSON.stringify(results));
});
