import test from 'node:test';
import assert from 'node:assert/strict';
import { createObserver } from '../../master_brain/verification/harness/observer.mjs';

test('records an auditable event stream and reconstructs the observed evidence', () => {
  const observer = createObserver({ run_id: 'RUN-OBS-1' });
  observer.record({ type: 'state', value: 'READY', sequence: 1 });
  observer.record({ type: 'decision', value: 'PROCEED', sequence: 2 });
  const snapshot = observer.snapshot();
  assert.equal(snapshot.run_id, 'RUN-OBS-1');
  assert.equal(snapshot.events.length, 2);
  assert.equal(snapshot.events[1].type, 'decision');
  assert.equal(snapshot.observed.state, 'READY');
  assert.equal(snapshot.observed.decision, 'PROCEED');
});

test('preserves UNKNOWN observations instead of inventing values', () => {
  const observer = createObserver({ run_id: 'RUN-OBS-2' });
  observer.record({ type: 'authority', value: 'UNKNOWN', sequence: 1 });
  const snapshot = observer.snapshot();
  assert.equal(snapshot.observed.authority, 'UNKNOWN');
});

test('rejects events without a stable event type', () => {
  const observer = createObserver({ run_id: 'RUN-OBS-3' });
  assert.throws(() => observer.record({ value: 'x' }), /type/);
});
