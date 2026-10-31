export function assessValueOfInformation(input = {}) {
  if (!input || typeof input !== 'object') throw new TypeError('input is required');
  for (const key of ['current_value', 'expected_value_with_information', 'information_cost']) {
    if (typeof input[key] !== 'number' || !Number.isFinite(input[key])) throw new TypeError(key + ' must be a finite number');
  }
  const gross_value = input.expected_value_with_information - input.current_value;
  const net_value = gross_value - input.information_cost;
  return { status: net_value > 0 ? 'COLLECT_INFORMATION' : 'DECIDE_NOW', gross_value, net_value };
}