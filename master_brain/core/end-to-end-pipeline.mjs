import { routeTaskAdaptive } from '../routing/adaptive-router.mjs';
import { decide } from '../decision/decision-engine.mjs';
import { assessRisk } from './risk-engine.mjs';
import { authorize } from './permission-engine.mjs';

export async function runDecisionPipeline(input = {}) {
  if (!input.task || !input.analysis || !Array.isArray(input.registry)) throw new TypeError('task, analysis and registry are required');
  const route = routeTaskAdaptive(input.task, input.registry, input.learning ?? {});
  const risk = assessRisk(input.analysis.risk);
  const decision = decide(input.analysis);
  const permission = authorize({ risk: risk.level, decision: decision.status });
  const fault = input.fault_context ?? {};
  const controlPlaneAvailable = fault.policy_available !== false && fault.execution_gate_available !== false;
  const authorityValid = !fault.authority || fault.authority.status === 'VALID';
  const recoveryReady = !input.recovery_context || input.recovery_context.status === 'VERIFIED_READY';
  const allowed = permission.allowed === true && controlPlaneAvailable && authorityValid && recoveryReady;
  const executed = allowed && input.executed === true;
  const status = allowed ? decision.status : (decision.status === 'REJECT' ? 'REJECT' : 'HOLD');
  return { status, risk, route, permission: { ...permission, allowed }, executed };
}
