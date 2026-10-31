import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const journal = new URL('../../master_brain/verification/harness/durable-journal.mjs', import.meta.url).href;

function spawnWorker(path, crash) {
  const code = [
    `import { DurableJournal } from ${JSON.stringify(journal)};`,
    `const j = new DurableJournal({path: ${JSON.stringify(path)}});`,
    `await j.append({event_id:'REAL-1', type:'COMMIT'});`,
    crash ? `process.kill(process.pid,'SIGKILL');` : `await j.close();`
  ].join('\n');
  return spawn(process.execPath, ['--input-type=module','-e',code], {stdio:'ignore'});
}

test('real child-process crash after durable append preserves exactly one event', async () => {
  const dir = await mkdtemp(join(tmpdir(),'mb-real-crash-'));
  const path = join(dir,'journal.jsonl');
  const child = spawnWorker(path,true);
  const signal = await new Promise(resolve => child.on('exit', (_code,sig) => resolve(sig)));
  assert.equal(signal,'SIGKILL');
  const before = (await readFile(path,'utf8')).trim().split('\n').filter(Boolean);
  assert.equal(before.length,1);
  const second = spawnWorker(path,false);
  await new Promise(resolve => second.on('exit',resolve));
  const after = (await readFile(path,'utf8')).trim().split('\n').filter(Boolean);
  assert.equal(after.length,1);
  await rm(dir,{recursive:true,force:true});
});
