import test from 'node:test';
import assert from 'node:assert/strict';
import { createDomainGraph, resolveDomain } from '../../master_brain/routing/domain-graph.mjs';

test('builds a graph and resolves direct domain dependencies', () => {
  const graph = createDomainGraph([
    { domain_id: 'science.chemistry', name: 'Chemistry', criticality: 'C1', evidence_requirement: 'MEDIUM', human_oversight: 'NONE', capabilities: ['chemistry'] },
    { domain_id: 'science.chemistry.polymer', name: 'Polymer Chemistry', parent_domain: 'science.chemistry', criticality: 'C2', evidence_requirement: 'HIGH', human_oversight: 'REVIEW', capabilities: ['polymer_analysis'] },
  ]);

  const node = resolveDomain(graph, 'science.chemistry.polymer');
  assert.equal(node.parent_domain, 'science.chemistry');
  assert.deepEqual(graph.children['science.chemistry'], ['science.chemistry.polymer']);
});

test('rejects duplicate domain identifiers', () => {
  assert.throws(
    () => createDomainGraph([
      { domain_id: 'finance.stocks', name: 'Stocks', criticality: 'C1', evidence_requirement: 'MEDIUM', human_oversight: 'NONE', capabilities: [] },
      { domain_id: 'finance.stocks', name: 'Duplicate', criticality: 'C1', evidence_requirement: 'MEDIUM', human_oversight: 'NONE', capabilities: [] },
    ]),
    /duplicate domain_id/
  );
});
