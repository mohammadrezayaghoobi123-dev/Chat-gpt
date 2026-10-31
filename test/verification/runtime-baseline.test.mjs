import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

function versionTuple(v) {
  const m = String(v).match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? m.slice(1).map(Number) : null;
}

test('runtime baseline: Node LTS-compatible and OpenClaw stable release is observable', () => {
  const node = versionTuple(process.version);
  assert.ok(node, 'Node version must be observable');
  assert.ok(node[0] >= 24, `Node 24+ required for current baseline; observed ${process.version}`);

  const raw = execFileSync('openclaw', ['--version'], { encoding: 'utf8' }).trim();
  const openclaw = versionTuple(raw);
  assert.ok(openclaw, 'OpenClaw version must be observable');
  assert.ok(openclaw[0] === 2026 && openclaw[1] === 9 && openclaw[2] >= 8,
    `OpenClaw stable baseline 2026.9.8+ expected; observed ${raw}`);

  console.log('RUNTIME_BASELINE', JSON.stringify({
    node: process.version,
    openclaw: raw,
    status: 'PASS'
  }));
});
