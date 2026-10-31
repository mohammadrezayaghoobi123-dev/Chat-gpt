import { runDecisionPipeline } from './end-to-end-pipeline.mjs';
import { createDecisionRecord, appendDecision } from '../learning/decision-ledger.mjs';
import { verifyOutcome } from '../learning/outcome-verification.mjs';
import { updateLearningMemory } from '../learning/learning-memory.mjs';

export async function runClosedLoop(input = {}) {
  if (typeof input.decision_id !== 'string' || !input.decision_id.trim()) throw new TypeError('decision_id is required');
  const pipeline = await runDecisionPipeline(input);
  const record = createDecisionRecord({ decision_id: input.decision_id, goal: input.task.objective, decision: pipeline.status, confidence: input.analysis.prediction.success_probability });
  const ledger = appendDecision([], record);
  if (!pipeline.permission.allowed || pipeline.executed !== true) return { pipeline, ledger };
  if (!input.observed || typeof input.observed.success !== 'boolean') throw new TypeError('observed outcome is required for executed decision');
  const outcome = verifyOutcome({ prediction: input.analysis.prediction, observed: input.observed });
  const modelId = pipeline.route[0].id;
  const capability = input.task.required_capabilities[0];
  const learning = updateLearningMemory({}, { model_id: modelId, capability, prediction_correct: outcome.prediction_correct });
  return { pipeline, ledger, outcome, learning };
}
