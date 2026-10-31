import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const journal = new URL('../../master_brain/verification/harness/durable-journal.mjs', import.meta.url).href;

function spawnWorker(path, mode) {
  const code = [
    "import { DurableJournal } from " + JSON.stringify(journal) + ";",
    "const j = new DurableJournal({path: " + JSON.stringify(path) + "});",
    mode === 'CRASH_BEFORE_APPEND'
      ? "process.kill(process.pid,'SIGKILL');"
      : "await j.append({event_id:'MATRIX-1',type:'COMMIT'});" + (mode === 'CRASH_AFTER_APPEND' ? "process.kill(process.pid,'SIGKILL');" : "await j.close();")
  ].join('\n');
  return spawn(process.execPath,['--input-type=module','-e',code],{stdio:'ignore'});
}
function wait(child) { return new Promise(resolve => child.on('exit',(_c,s)=>resolve(s))); }

for (const mode of ['CRASH_BEFORE_APPEND','CRASH_AFTER_APPEND']) {
  test('real process crash matrix: ' + mode, async () => {
    const dir = await mkdtemp(join(tmpdir(),'mb-crash-matrix-'));
    const path = join(dir,'journal.jsonl');
    const signal = await wait(spawnWorker(path,mode));
    assert.equal(signal,'SIGKILL');
    let lines=[];
    try { lines=(await readFile(path,'utf8')).trim().split('\n').filter(Boolean); } catch(e) { if(e.code!=='ENOENT') throw e; }
    assert.equal(lines.length, mode === 'CRASH_BEFORE_APPEND' ? 0 : 1);
    await wait(spawnWorker(path,'RESTART'));
    lines=(await readFile(path,'utf8')).trim().split('\n').filter(Boolean);
    assert.equal(lines.length,1);
    await rm(dir,{recursive:true,force:true});
  });
}
