import { createReferenceModel } from './reference-model.mjs';

function hashState(state) { return JSON.stringify(state); }

export function recoverFromSnapshotAndJournal({ snapshotResult, events = [], model = createReferenceModel() } = {}) {
  if (!snapshotResult || snapshotResult.status !== 'VALID') return { status:'INCONCLUSIVE', reason:'snapshot is not valid' };
  const snapshot = snapshotResult.snapshot;
  const validEvents = events.filter(e => Number.isInteger(e.sequence));
  const historical = validEvents.filter(e => e.sequence <= snapshot.sequence);
  const snapshotHash = hashState(snapshot.state);
  if (historical.some(e => e.state_hash && e.state_hash !== snapshotHash)) return { status:'INCONCLUSIVE', reason:'historical event state conflicts with snapshot' };
  if (historical.some(e => e.snapshot_hash && e.snapshot_hash !== snapshotHash)) return { status:'INCONCLUSIVE', reason:'historical event snapshot conflicts with snapshot' };
  const ordered = validEvents.filter(e => e.sequence > snapshot.sequence).sort((a,b)=>a.sequence-b.sequence);
  let expected = snapshot.sequence + 1;
  for (const event of ordered) {
    if (event.sequence !== expected) return { status:'INCONCLUSIVE', reason:'journal sequence gap', expected, observed:event.sequence };
    expected += 1;
  }
  let state = structuredClone(snapshot.state);
  for (const event of ordered) state = model.apply(state, event);
  return { status:'RECOVERED', sequence: expected-1, state, state_hash:hashState(state), model_version:model.version };
}

export function compareRecoveredState(recovered, expectedState) {
  if (!recovered || recovered.status !== 'RECOVERED') return { status:'INCONCLUSIVE' };
  const expected = hashState(expectedState);
  return recovered.state_hash === expected ? { status:'PASS' } : { status:'FAIL', expected_hash:expected, observed_hash:recovered.state_hash };
}
