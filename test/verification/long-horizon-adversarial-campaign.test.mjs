import test from 'node:test';
import assert from 'node:assert/strict';
import { runLongHorizonAdversarialScenario } from '../../master_brain/verification/harness/long-horizon-adversarial-campaign.mjs';

const blockedScenarios = ['malicious_payload','spoofed_source','correlated_claim','poisoned_persistence','specialist_failure'];

for (const scenario of blockedScenarios) {
  test(`long-horizon adversarial campaign safely contains: ${scenario}`, () => {
    const result = runLongHorizonAdversarialScenario({ scenario });
    assert.notEqual(result.execution, 'EXECUTED', JSON.stringify(result));
    assert.ok(['PASS','FAIL','INCONCLUSIVE'].includes(result.status), JSON.stringify(result));
    if (['poisoned_persistence','specialist_failure'].includes(scenario)) assert.equal(result.status,'FAIL',JSON.stringify(result));
  });
}

test('long-horizon clean path survives threat → memory → restart-equivalent retrieval → multi-agent → process oracle', () => {
  const result = runLongHorizonAdversarialScenario({ scenario:'clean' });
  assert.equal(result.status, 'PASS', JSON.stringify(result));
  assert.equal(result.stage, 'END_TO_END');
  assert.equal(result.execution, 'EXECUTED');
});

test('campaign must never treat an unobserved execution as success', () => {
  const result = runLongHorizonAdversarialScenario({ scenario:'malicious_payload' });
  assert.equal(result.execution, 'NOT_EXECUTED');
  assert.equal(result.expected_execution, false);
});
