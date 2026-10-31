import test from 'node:test';
import assert from 'node:assert/strict';
import { runDecisionPipeline } from '../../master_brain/core/end-to-end-pipeline.mjs';

function rng(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17; x >>>= 0;
    x ^= x << 5; x >>>= 0;
    return (x >>> 0) / 0x100000000;
  };
}

function sample(seed, i) {
  const r = rng((seed ^ Math.imul(i + 1, 0x9e3779b9)) >>> 0);
  const policy = r() > 0.35;
  const gate = r() > 0.35;
  const authority = r() > 0.25 ? 'VALID' : 'REVOKED';
  const recovery = r() > 0.25 ? 'VERIFIED_READY' : (r() > 0.5 ? 'RECOVERED' : 'UNKNOWN');
  const risk = r() > 0.7 ? 'HIGH' : r() > 0.35 ? 'MEDIUM' : 'LOW';
  const decision = r() > 0.8 ? 'REJECT' : 'PROCEED';
  return { policy, gate, authority, recovery, risk, decision };
}

function inputFrom(s, executed) {
  return {
    task: { objective: 'fuzz', risk: s.risk.toLowerCase(), required_capabilities: ['reasoning'] },
    registry: [{ id:'fuzz-model', capabilities:['reasoning'], risk_levels:['low','medium','high'], reliability:0.99, cost:1 }],
    analysis: {
      verification: { status: 'VERIFIED' },
      stability: { status: 'ROBUST' },
      value_of_information: { status: 'DECIDE_NOW' },
      prediction: { success_probability: 0.99 },
      risk: { impact:s.risk, probability:0.01, reversibility:'REVERSIBLE' }
    },
    executed,
    fault_context: {
      policy_available: s.policy,
      execution_gate_available: s.gate,
      authority: { status:s.authority }
    },
    recovery_context: { status:s.recovery }
  };
}

test('adversarial property fuzz: 10000 deterministic states preserve fail-closed execution invariant', async () => {
  const seeds = [0x5eed, 0x12345678, 0xa11ce, 0xdeadbeef, 0x42];
  let checked = 0;
  for (const seed of seeds) {
    for (let i = 0; i < 2000; i++) {
      const s = sample(seed, i);
      const r = await runDecisionPipeline(inputFrom(s, true));
      const mustExecute = s.policy && s.gate && s.authority === 'VALID' && s.recovery === 'VERIFIED_READY';
      assert.equal(r.executed, mustExecute, `seed=${seed} i=${i} state=${JSON.stringify(s)}`);
      checked++;
    }
  }
  assert.equal(checked, 10000);
});

test('metamorphic property: disabling policy or gate can never turn non-execution into execution', async () => {
  const seed = 0xabcdef01;
  for (let i = 0; i < 2000; i++) {
    const base = sample(seed, i);
    const baseline = await runDecisionPipeline(inputFrom(base, true));
    const noPolicy = await runDecisionPipeline(inputFrom({...base, policy:false}, true));
    const noGate = await runDecisionPipeline(inputFrom({...base, gate:false}, true));
    assert.equal(noPolicy.executed, false, `policy mutation executed at i=${i}`);
    assert.equal(noGate.executed, false, `gate mutation executed at i=${i}`);
    assert.ok(!(baseline.executed === false && (noPolicy.executed === true || noGate.executed === true)));
  }
});
