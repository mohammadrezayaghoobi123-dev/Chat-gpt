const DIMENSIONS = ['authority', 'freshness', 'independence', 'methodology'];

export function evaluateSourceQuality(input = {}) {
  for (const dimension of DIMENSIONS) {
    const value = input[dimension];
    if (typeof value !== 'number' || value < 0 || value > 1) {
      throw new TypeError(`invalid ${dimension}`);
    }
  }

  const score = Number((DIMENSIONS.reduce((sum, dimension) => sum + input[dimension], 0) / DIMENSIONS.length).toFixed(6));
  const band = score >= 0.75 ? 'STRONG' : score >= 0.5 ? 'MODERATE' : 'WEAK';

  return { score, band, dimensions: { ...input } };
}
