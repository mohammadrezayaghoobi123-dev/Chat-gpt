import { getEligibleModels } from './capability-registry.mjs';
import { assessPerformanceConfidence } from '../learning/performance-confidence.mjs';

export function routeTaskAdaptive(task, registry = [], learning = {}) {
  const eligible = getEligibleModels(registry, task);
  if (!eligible.length) throw new Error(`no eligible model for risk=${task.risk ?? 'medium'}`);
  return [...eligible].map(model => {
    const observation = learning[model.id];
    const confidence = observation ? assessPerformanceConfidence(observation) : { score: 0, band: 'LOW' };
    const learning_weight = confidence.band === 'HIGH' ? 0.5 : confidence.band === 'MEDIUM' ? 0.1 : 0;
    const observed = confidence.band === 'LOW' ? model.reliability : observation.accuracy * observation.freshness;
    const score = (model.reliability * (1 - learning_weight)) + (observed * learning_weight);
    return { ...model, adaptive_score: Number(score.toFixed(6)), performance_confidence: confidence };
  }).sort((a, b) => b.adaptive_score - a.adaptive_score || (a.cost ?? 1) - (b.cost ?? 1));
}
