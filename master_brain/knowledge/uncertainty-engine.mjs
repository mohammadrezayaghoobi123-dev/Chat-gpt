const TYPES = new Set([
  'DATA',
  'MEASUREMENT',
  'MODEL',
  'SOURCE',
  'SAMPLING',
  'PARAMETER',
  'SCENARIO',
  'UNKNOWN_UNKNOWN',
]);

export function assessUncertainty(items = []) {
  if (!Array.isArray(items)) throw new TypeError('uncertainty items must be an array');

  const normalized = items.map(item => {
    if (!item || !TYPES.has(item.type)) {
      throw new TypeError(`invalid uncertainty type: ${item?.type}`);
    }
    if (typeof item.level !== 'number' || item.level < 0 || item.level > 1) {
      throw new TypeError(`invalid uncertainty level: ${item.type}`);
    }
    return { ...item };
  });

  const sorted = [...normalized].sort((a, b) => b.level - a.level);
  return {
    total: normalized.length,
    items: normalized,
    dominant: sorted[0],
  };
}
