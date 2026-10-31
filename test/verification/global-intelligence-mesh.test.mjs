import test from 'node:test';
import assert from 'node:assert/strict';
import {selectGlobalSources,classifySourceEvidence,assessCrossSourceClaim,assertGlobalIntelligenceIsolation,assessSourceReliability,assessFreshness,buildLineageGraph,fuseEvidence,expandSources,runAdaptiveIntelligenceCampaign} from '../../master_brain/research/global-intelligence-mesh.mjs';

test('selects relevant global sources and dark web as intelligence sensor',()=>{
  const p=selectGlobalSources({objective:'threat landscape',needs:['current','threat_intelligence','market'],require_dark_web:true});
  assert.equal(p.status,'PLANNED'); assert.ok(p.selected.includes('SEARCH_WEB')); assert.ok(p.selected.includes('DARK_WEB')); assert.equal(p.dark_web_mode,'INTELLIGENCE_ONLY');
});
test('does not require every source for every question',()=>{
  const p=selectGlobalSources({objective:'scientific mechanism',needs:['scientific']});
  assert.deepEqual(p.selected,['ACADEMIC']);
});
test('unverified or unsanitized external evidence cannot pass',()=>{
  assert.equal(classifySourceEvidence({source:'DARK_WEB',collection_authorized:true,provenance:'UNKNOWN',sanitized:true}).status,'INCONCLUSIVE');
  assert.equal(classifySourceEvidence({source:'DARK_WEB',collection_authorized:true,provenance:'VERIFIED',sanitized:false}).status,'INCONCLUSIVE');
});
test('external instructions cannot become authority',()=>{
  assert.equal(classifySourceEvidence({source:'SOCIAL',collection_authorized:true,provenance:'VERIFIED',sanitized:true,content_type:'INSTRUCTION'}).status,'FAIL');
});
test('independent lineages corroborate; conflict stays conflicted',()=>{
  assert.equal(assessCrossSourceClaim({claims:[{evidence_status:'VERIFIED',provenance:'VERIFIED',lineage_id:'a'},{evidence_status:'VERIFIED',provenance:'VERIFIED',lineage_id:'b'}]}).status,'CORROBORATED');
  assert.equal(assessCrossSourceClaim({claims:[{evidence_status:'VERIFIED',provenance:'VERIFIED',lineage_id:'a',contradicts:true},{evidence_status:'VERIFIED',provenance:'VERIFIED',lineage_id:'b'}]}).status,'CONFLICTED');
});
test('dark web cannot directly reach trusted destinations',()=>{
  assert.throws(()=>assertGlobalIntelligenceIsolation({destination:'EXECUTION',source:'DARK_WEB'}));
  assert.doesNotThrow(()=>assertGlobalIntelligenceIsolation({destination:'ANALYSIS',source:'DARK_WEB'}));
});


test('source reliability is bounded and provenance-sensitive',()=>{
  const unknown=assessSourceReliability({source:'SOCIAL',historical_reliability:0.8,collection_quality:1,independence:1,provenance:'UNKNOWN'});
  assert.equal(unknown.status,'INCONCLUSIVE');
  const verified=assessSourceReliability({source:'SOCIAL',historical_reliability:0.8,collection_quality:1,independence:1,provenance:'VERIFIED'});
  assert.equal(verified.status,'PASS');
  assert.ok(verified.score>=0 && verified.score<=1);
});

test('freshness is domain-sensitive and stale evidence loses decision weight',()=>{
  const fresh=assessFreshness({observed_at:'2026-10-06T10:00:00Z',now:'2026-10-06T12:00:00Z',domain:'MARKET'});
  const stale=assessFreshness({observed_at:'2026-10-01T10:00:00Z',now:'2026-10-06T12:00:00Z',domain:'MARKET'});
  assert.equal(fresh.status,'FRESH');
  assert.equal(stale.status,'STALE');
  assert.ok(fresh.weight>stale.weight);
});

test('lineage graph collapses duplicate reporting but preserves independent sources',()=>{
  const graph=buildLineageGraph({claims:[
    {claim_id:'a',source_id:'site1',parent_claim_id:'root'},
    {claim_id:'b',source_id:'site2',parent_claim_id:'root'},
    {claim_id:'c',source_id:'site3',parent_claim_id:'other'}
  ]});
  assert.equal(graph.lineage_count,2);
  assert.equal(graph.independent_lineages,2);
});

test('evidence fusion preserves conflict and uncertainty instead of inventing certainty',()=>{
  const conflicted=fuseEvidence({observations:[
    {status:'VERIFIED',lineage_id:'a',weight:0.9,polarity:'SUPPORT'},
    {status:'VERIFIED',lineage_id:'b',weight:0.9,polarity:'OPPOSE'}
  ]});
  assert.equal(conflicted.status,'CONFLICTED');
  const uncertain=fuseEvidence({observations:[
    {status:'INCONCLUSIVE',lineage_id:'a',weight:0.9,polarity:'SUPPORT'}
  ]});
  assert.equal(uncertain.status,'INCONCLUSIVE');
});

test('dynamic source expansion adds missing high-value evidence roles without selecting everything',()=>{
  const expanded=expandSources({plan:{selected:['NEWS'],needs:['current','official']},available:['SEARCH_WEB','OFFICIAL_WEB','DARK_WEB','ACADEMIC']});
  assert.ok(expanded.added.includes('OFFICIAL_WEB'));
  assert.ok(!expanded.added.includes('ACADEMIC'));
  assert.ok(!expanded.added.includes('DARK_WEB'));
});

test('adaptive intelligence campaign blocks critical collection when evidence gates remain unresolved',()=>{
  const blocked=runAdaptiveIntelligenceCampaign({objective:'critical threat claim',observations:[
    {status:'INCONCLUSIVE',critical:true}
  ]});
  assert.equal(blocked.status,'HOLD');
  assert.equal(blocked.execution_authorized,false);
  const ready=runAdaptiveIntelligenceCampaign({objective:'critical threat claim',observations:[
    {status:'VERIFIED',critical:true,lineage_id:'a'},
    {status:'VERIFIED',critical:true,lineage_id:'b'}
  ]});
  assert.equal(ready.status,'READY_FOR_DECISION');
  assert.equal(ready.execution_authorized,false);
});
