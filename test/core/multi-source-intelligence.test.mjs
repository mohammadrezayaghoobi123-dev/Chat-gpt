import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSourceRecord } from '../../master_brain/research/multi-source-intelligence.mjs';

test('normalizes a source record with provenance and independence metadata', () => {
  const result = normalizeSourceRecord({
    platform: 'youtube',
    source_id: 'video-123',
    source_url: 'https://youtube.com/watch?v=video-123',
    source_type: 'video',
    retrieved_at: '2026-10-05T00:00:00Z',
    claims: [{ text: 'Machine capacity is 1000 kg/day' }],
  });
  assert.equal(result.platform, 'youtube');
  assert.equal(result.source_id, 'video-123');
  assert.equal(result.provenance.platform, 'youtube');
  assert.equal(result.independence.key, 'youtube:video-123');
  assert.equal(result.claims[0].status, 'UNVERIFIED');
});

test('rejects a source record without platform or source identity', () => {
  assert.throws(() => normalizeSourceRecord({ claims: [] }), /platform is required/);
});