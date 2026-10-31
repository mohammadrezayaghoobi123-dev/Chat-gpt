import test from 'node:test';
import assert from 'node:assert/strict';
import { routeDomainTask } from '../../master_brain/routing/domain-task-router.mjs';

const domains = [
  { domain_id: 'chemistry', capabilities: ['chemistry', 'polymer'], criticality: 'C2', evidence_requirement: 'HIGH', human_oversight: 'REVIEW' },
  { domain_id: 'business', capabilities: ['business', 'strategy'], criticality: 'C1', evidence_requirement: 'MEDIUM', human_oversight: 'REVIEW' },
];

test('routes a single-domain task to the matching domain and capabilities', () => {
  const result = routeDomainTask({
    objective: 'analyze polymer formulation',
    required_capabilities: ['polymer'],
    domain_candidates: domains,
  });
  assert.deepEqual(result.domains, ['chemistry']);
  assert.deepEqual(result.required_capabilities, ['polymer']);
});

test('routes multi-domain work to all matching domains without duplicate selection', () => {
  const result = routeDomainTask({
    objective: 'evaluate polymer factory investment',
    required_capabilities: ['polymer', 'business'],
    domain_candidates: domains,
  });
  assert.deepEqual(result.domains, ['business', 'chemistry']);
  assert.equal(result.multi_domain, true);
});

test('fails closed when no domain can satisfy the required capability', () => {
  assert.throws(() => routeDomainTask({
    objective: 'astrophysics research',
    required_capabilities: ['astrophysics'],
    domain_candidates: domains,
  }), /no eligible domain/);
});
