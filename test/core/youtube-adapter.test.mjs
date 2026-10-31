import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildYouTubeSearchRequest,
  buildYouTubeCommentsRequest,
  buildYouTubeCaptionsRequest,
  normalizeYouTubeSearchResults,
} from '../../master_brain/research/youtube-adapter.mjs';

test('builds a constrained video search request', () => {
  const r = buildYouTubeSearchRequest({ query: 'EVA foam hot press machine', maxResults: 10 });
  assert.equal(r.endpoint, 'https://www.googleapis.com/youtube/v3/search');
  assert.equal(r.params.type, 'video');
  assert.equal(r.params.maxResults, 10);
  assert.equal(r.requires_credential, true);
  assert.equal(Object.hasOwn(r.params, 'key'), false);
});

test('builds a read-only comments request for a video', () => {
  const r = buildYouTubeCommentsRequest({ videoId: 'abc123', maxResults: 20 });
  assert.equal(r.endpoint, 'https://www.googleapis.com/youtube/v3/commentThreads');
  assert.equal(r.params.videoId, 'abc123');
  assert.equal(r.params.part, 'snippet');
  assert.equal(r.params.maxResults, 20);
  assert.equal(r.requires_credential, true);
});

test('builds a caption-track discovery request without claiming transcript access', () => {
  const r = buildYouTubeCaptionsRequest({ videoId: 'abc123' });
  assert.equal(r.endpoint, 'https://www.googleapis.com/youtube/v3/captions');
  assert.equal(r.params.videoId, 'abc123');
  assert.equal(r.params.part, 'snippet');
  assert.equal(r.requires_oauth, true);
  assert.equal(r.returns_transcript, false);
});

test('normalizes search results without inventing claims or transcripts', () => {
  const results = normalizeYouTubeSearchResults({
    items: [{
      id: { videoId: 'abc123' },
      snippet: {
        channelId: 'channel-1',
        title: 'EVA foam hot press',
        description: 'Machine overview',
        publishedAt: '2026-10-05T00:00:00Z',
      },
    }],
  }, '2026-10-05T01:00:00Z');

  assert.equal(results.length, 1);
  assert.equal(results[0].platform, 'youtube');
  assert.equal(results[0].source_id, 'abc123');
  assert.equal(results[0].provenance.source_id, 'abc123');
  assert.equal(results[0].provenance.lineage_id, 'abc123');
  assert.equal(results[0].metadata.channel_id, 'channel-1');
  assert.deepEqual(results[0].claims, []);
  assert.equal(Object.hasOwn(results[0], 'transcript'), false);
});
