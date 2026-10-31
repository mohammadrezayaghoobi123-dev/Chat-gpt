import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

export class SnapshotStore {
  constructor({path}) { if (!path) throw new TypeError('path is required'); this.path=path; }
  async publish(state, sequence) {
    const body={version:1,sequence,state,state_hash:digest(state)};
    const tmp=this.path+'.tmp';
    await writeFile(tmp, JSON.stringify(body)+'\n','utf8');
    await rename(tmp,this.path);
    return Object.freeze(body);
  }
  async read() {
    let raw;
    try { raw=await readFile(this.path,'utf8'); } catch(e) { if(e.code==='ENOENT') return {status:'MISSING'}; throw e; }
    if (!raw.endsWith('\n')) return {status:'CORRUPTED',reason:'incomplete snapshot'};
    let snap; try { snap=JSON.parse(raw); } catch { return {status:'CORRUPTED',reason:'invalid snapshot JSON'}; }
    if (typeof snap.state_hash!=='string' || snap.state_hash!==digest(snap.state)) return {status:'CORRUPTED',reason:'snapshot hash mismatch'};
    if (!Number.isInteger(snap.sequence) || snap.sequence<0) return {status:'CORRUPTED',reason:'invalid snapshot sequence'};
    return {status:'VALID',snapshot:snap};
  }
  async reset() { await rm(this.path,{force:true}); await rm(this.path+'.tmp',{force:true}); }
}
