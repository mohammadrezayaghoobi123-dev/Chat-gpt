import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const journal = new URL('../../master_brain/verification/harness/durable-journal.mjs', import.meta.url).href;

function runWorker(path, mode) {
  const code = [
    `import { DurableJournal } from ${JSON.stringify(journal)};`,
    `const j = new DurableJournal({path: ${JSON.stringify(path)}});`,
    `await j.append({event_id:'BOUNDARY-1',type:'COMMIT'});`,
    mode === 'CRASH' ? `process.kill(process.pid,'SIGKILL');` : `await j.close();`
  ].join('\n');
  return spawn(process.execPath,['--input-type=module','-e',code],{stdio:'ignore'});
}

test('repeated real crash/restart cycles remain exactly once', async () => {
  const dir = await mkdtemp(join(tmpdir(),'mb-crash-cycles-'));
  const path = join(dir,'journal.jsonl');
  for (let i=0;i<5;i++) {
    const child = runWorker(path,'CRASH');
    const signal = await new Promise(resolve => child.on('exit',(_c,s)=>resolve(s)));
    assert.equal(signal,'SIGKILL');
    const lines = (await readFile(path,'utf8')).trim().split('\n').filter(Boolean);
    assert.equal(lines.length,1);
    const restart = runWorker(path,'RESTART');
    await new Promise(resolve => restart.on('exit',resolve));
    const replay = (await readFile(path,'utf8')).trim().split('\n').filter(Boolean);
    assert.equal(replay.length,1);
  }
  await rm(dir,{recursive:true,force:true});
});
