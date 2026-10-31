import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelProviderRegistry, routeAcrossProviders } from '../../master_brain/routing/model-provider-registry.mjs';

const registry = createModelProviderRegistry([
  {provider_id:'openai', model_id:'model-a', capabilities:['reasoning','coding'], risk_levels:['low','medium','high'], reliability:0.95, provenance:'VERIFIED', availability:'ACTIVE'},
  {provider_id:'anthropic', model_id:'model-b', capabilities:['reasoning','security'], risk_levels:['medium','high'], reliability:0.94, provenance:'VERIFIED', availability:'ACTIVE'},
  {provider_id:'google', model_id:'model-c', capabilities:['research','vision'], risk_levels:['low','medium'], reliability:0.91, provenance:'VERIFIED', availability:'ACTIVE'},
  {provider_id:'openclaw', model_id:'runtime-a', capabilities:['execution'], risk_levels:['low','medium','high'], reliability:0.90, provenance:'VERIFIED', availability:'ACTIVE', kind:'runtime'}
]);

test('registry is provider-agnostic and accepts multiple independent providers', () => {
  assert.equal(new Set(registry.map(x=>x.provider_id)).size, 4);
  assert.ok(registry.some(x=>x.provider_id==='openai'));
  assert.ok(registry.some(x=>x.provider_id==='anthropic'));
  assert.ok(registry.some(x=>x.provider_id==='google'));
  assert.ok(registry.some(x=>x.provider_id==='openclaw'));
});

test('routing can select independent providers for cross-check', () => {
  const routed = routeAcrossProviders(registry, {required_capabilities:['reasoning'], risk:'medium', min_independent_providers:2});
  assert.equal(routed.status, 'READY');
  assert.ok(routed.providers.length >= 2);
  assert.notEqual(routed.providers[0].provider_id, routed.providers[1].provider_id);
});

test('unverified or inactive providers are never admitted', () => {
  const result = routeAcrossProviders([
    {provider_id:'bad',model_id:'x',capabilities:['reasoning'],risk_levels:['medium'],reliability:1,provenance:'UNKNOWN',availability:'ACTIVE'}
  ], {required_capabilities:['reasoning'],risk:'medium',min_independent_providers:1});
  assert.equal(result.status, 'HOLD');
});

test('stale or degraded providers are excluded from medium-risk routing', () => {
  const result = routeAcrossProviders([
    {provider_id:'stale',model_id:'x',capabilities:['reasoning'],risk_levels:['medium'],reliability:0.99,provenance:'VERIFIED',availability:'ACTIVE',freshness:'STALE'},
    {provider_id:'degraded',model_id:'y',capabilities:['reasoning'],risk_levels:['medium'],reliability:0.99,provenance:'VERIFIED',availability:'ACTIVE',health:'DEGRADED'},
    {provider_id:'good',model_id:'z',capabilities:['reasoning'],risk_levels:['medium'],reliability:0.9,provenance:'VERIFIED',availability:'ACTIVE',health:'HEALTHY',freshness:'FRESH',integrity:'VERIFIED'}
  ], {required_capabilities:['reasoning'],risk:'medium',min_independent_providers:1});
  assert.equal(result.status, 'READY');
  assert.equal(result.providers[0].provider_id, 'good');
});

test('independence groups prevent correlated providers from counting as independent', () => {
  const result = routeAcrossProviders([
    {provider_id:'alias-a',model_id:'a',independence_group:'vendor-x',capabilities:['reasoning'],risk_levels:['medium'],reliability:0.99,provenance:'VERIFIED',availability:'ACTIVE',health:'HEALTHY',freshness:'FRESH',integrity:'VERIFIED'},
    {provider_id:'alias-b',model_id:'b',independence_group:'vendor-x',capabilities:['reasoning'],risk_levels:['medium'],reliability:0.98,provenance:'VERIFIED',availability:'ACTIVE',health:'HEALTHY',freshness:'FRESH',integrity:'VERIFIED'},
    {provider_id:'vendor-y',model_id:'c',independence_group:'vendor-y',capabilities:['reasoning'],risk_levels:['medium'],reliability:0.8,provenance:'VERIFIED',availability:'ACTIVE',health:'HEALTHY',freshness:'FRESH',integrity:'VERIFIED'}
  ], {required_capabilities:['reasoning'],risk:'medium',min_independent_providers:2});
  assert.equal(result.status, 'READY');
  assert.deepEqual(result.providers.map(x=>x.provider_id), ['alias-a','vendor-y']);
});

test('OpenClaw is not privileged by routing policy', () => {
  const routed = routeAcrossProviders(registry, {required_capabilities:['reasoning'], risk:'medium', min_independent_providers:1});
  assert.notEqual(routed.providers[0].provider_id, 'openclaw');
});
