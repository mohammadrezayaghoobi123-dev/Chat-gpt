import { normalizeSourceRecord } from './multi-source-intelligence.mjs';

const SEARCH_ENDPOINT = 'https://www.googleapis.com/youtube/v3/search';
const COMMENTS_ENDPOINT = 'https://www.googleapis.com/youtube/v3/commentThreads';
const CAPTIONS_ENDPOINT = 'https://www.googleapis.com/youtube/v3/captions';

function validateVideoId(videoId) {
  if (typeof videoId !== 'string' || !videoId.trim()) throw new TypeError('videoId is required');
  return videoId.trim();
}

function validateMaxResults(maxResults) {
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 50) {
    throw new TypeError('maxResults must be an integer between 1 and 50');
  }
}

export function buildYouTubeSearchRequest(input = {}) {
  if (!input || typeof input !== 'object') throw new TypeError('input is required');
  if (typeof input.query !== 'string' || !input.query.trim()) throw new TypeError('query is required');
  const maxResults = input.maxResults ?? 10;
  validateMaxResults(maxResults);

  const params = { part: 'snippet', q: input.query.trim(), type: 'video', maxResults };
  if (input.order !== undefined) params.order = input.order;
  if (input.relevanceLanguage !== undefined) params.relevanceLanguage = input.relevanceLanguage;
  if (input.regionCode !== undefined) params.regionCode = input.regionCode;
  if (input.videoCaption !== undefined) params.videoCaption = input.videoCaption;

  return { endpoint: SEARCH_ENDPOINT, params, requires_credential: true };
}

export function buildYouTubeCommentsRequest(input = {}) {
  if (!input || typeof input !== 'object') throw new TypeError('input is required');
  const videoId = validateVideoId(input.videoId);
  const maxResults = input.maxResults ?? 20;
  validateMaxResults(maxResults);
  return {
    endpoint: COMMENTS_ENDPOINT,
    params: { part: 'snippet', videoId, maxResults },
    requires_credential: true,
  };
}

export function buildYouTubeCaptionsRequest(input = {}) {
  if (!input || typeof input !== 'object') throw new TypeError('input is required');
  const videoId = validateVideoId(input.videoId);
  return {
    endpoint: CAPTIONS_ENDPOINT,
    params: { part: 'snippet', videoId },
    requires_oauth: true,
    returns_transcript: false,
  };
}

export function normalizeYouTubeSearchResults(payload = {}, retrievedAt = null) {
  if (!payload || typeof payload !== 'object') throw new TypeError('payload is required');
  if (!Array.isArray(payload.items)) throw new TypeError('items must be an array');

  return payload.items.flatMap(item => {
    const videoId = item?.id?.videoId;
    if (typeof videoId !== 'string' || !videoId.trim()) return [];
    const snippet = item.snippet ?? {};
    return [normalizeSourceRecord({
      platform: 'youtube',
      source_id: videoId.trim(),
      source_type: 'video',
      source_url: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId.trim())}`,
      retrieved_at: retrievedAt,
      lineage_id: videoId.trim(),
      lineage_type: 'YOUTUBE_VIDEO',
      metadata: {
        channel_id: snippet.channelId ?? null,
        title: snippet.title ?? null,
        description: snippet.description ?? null,
        published_at: snippet.publishedAt ?? null,
      },
      claims: [],
    })];
  });
}
