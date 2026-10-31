const SAFE_TRANSIENT_KINDS = new Set(['transient', 'ephemeral', 'scratch']);

function normalizeValue(value) {
  if (typeof value === 'string') return value.trim().replace(/\s+/g, ' ');
  return JSON.stringify(value);
}

export function pruneKnowledge(items = []) {
  if (!Array.isArray(items)) throw new TypeError('items must be an array');

  const kept = [];
  const pruned = [];
  const verifiedByValue = new Map();

  for (const item of items) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string') {
      kept.push(item);
      continue;
    }

    if (SAFE_TRANSIENT_KINDS.has(item.kind)) {
      pruned.push({ ...item, reason: 'SAFE_TRANSIENT_NOISE' });
      continue;
    }

    const key = normalizeValue(item.value);
    if (item.status === 'VERIFIED' && verifiedByValue.has(key)) {
      const survivor = verifiedByValue.get(key);
      pruned.push({ ...item, reason: `DUPLICATE_OF_${survivor.id}` });
      continue;
    }

    kept.push(item);
    if (item.status === 'VERIFIED' && key !== undefined) {
      verifiedByValue.set(key, item);
    }
  }

  return { kept, pruned, pruned_count: pruned.length };
}
