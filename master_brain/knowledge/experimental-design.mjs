export function designExperiment(input = {}) {
  if (!input || typeof input !== 'object') throw new TypeError('input is required');
  const question = typeof input.question === 'string' ? input.question.trim() : '';
  const hypothesis = typeof input.hypothesis === 'string' ? input.hypothesis.trim() : '';
  const independent_variables = Array.isArray(input.independent_variables) ? input.independent_variables : [];
  const dependent_variables = Array.isArray(input.dependent_variables) ? input.dependent_variables : [];
  const controls = Array.isArray(input.controls) ? input.controls : [];
  const measurements = Array.isArray(input.measurements) ? input.measurements : [];
  const falsification_criteria = Array.isArray(input.falsification_criteria) ? input.falsification_criteria : [];
  const status = question && hypothesis && independent_variables.length && dependent_variables.length && controls.length && measurements.length && falsification_criteria.length ? 'DESIGN_READY' : 'INCOMPLETE';
  return { status, question, hypothesis, independent_variables, dependent_variables, controls, measurements, falsification_criteria };
}