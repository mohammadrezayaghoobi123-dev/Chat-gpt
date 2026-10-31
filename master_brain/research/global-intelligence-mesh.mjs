const SOURCE_REGISTRY = Object.freeze({
  SEARCH_WEB:{class:'OPEN_WEB',roles:['discovery','current','general'],trust:'UNTRUSTED_DATA'},
  OFFICIAL_WEB:{class:'OPEN_WEB',roles:['primary','official','regulatory'],trust:'VERIFIED_IF_AUTHENTICATED'},
  NEWS:{class:'MEDIA',roles:['current','events','claims'],trust:'UNTRUSTED_DATA'},
  SOCIAL:{class:'SOCIAL',roles:['signals','public_reaction','market'],trust:'UNTRUSTED_DATA'},
  VIDEO:{class:'MEDIA',roles:['visual','interviews','process'],trust:'UNTRUSTED_DATA'},
  TV:{class:'BROADCAST',roles:['current','interviews','events'],trust:'UNTRUSTED_DATA'},
  RADIO:{class:'BROADCAST',roles:['current','interviews','events'],trust:'UNTRUSTED_DATA'},
  PODCAST:{class:'MEDIA',roles:['interviews','commentary'],trust:'UNTRUSTED_DATA'},
  FORUM:{class:'COMMUNITY',roles:['experience','signals','technical'],trust:'UNTRUSTED_DATA'},
  ACADEMIC:{class:'RESEARCH',roles:['scientific','experimental'],trust:'VERIFIED_IF_AUTHENTICATED'},
  PATENT:{class:'RESEARCH',roles:['prior_art','technical'],trust:'VERIFIED_IF_AUTHENTICATED'},
  GOVERNMENT:{class:'PRIMARY',roles:['official','regulatory','public_records'],trust:'VERIFIED_IF_AUTHENTICATED'},
  MARKET:{class:'FINANCIAL',roles:['price','market','filings'],trust:'VERIFIED_IF_AUTHENTICATED'},
  INDUSTRY:{class:'INDUSTRY',roles:['supplier','technical','market'],trust:'UNTRUSTED_DATA'},
  DEEP_WEB:{class:'DEEP_WEB',roles:['specialized','private_indexed'],trust:'UNTRUSTED_DATA'},
  DARK_WEB:{class:'DARK_WEB',roles:['threat_intelligence','exposure','leak_signal'],trust:'UNTRUSTED_DATA'},
  INTERNAL:{class:'INTERNAL',roles:['first_party','operations'],trust:'AUTHENTICATED_INTERNAL'},
});
const RISK_BY_CLASS=Object.freeze({DARK_WEB:'HIGH',DEEP_WEB:'HIGH',SOCIAL:'MEDIUM',COMMUNITY:'MEDIUM',OPEN_WEB:'MEDIUM',MEDIA:'MEDIUM',BROADCAST:'MEDIUM',RESEARCH:'LOW',PRIMARY:'LOW',FINANCIAL:'HIGH',INDUSTRY:'MEDIUM',INTERNAL:'HIGH'});
const riskOrder={LOW:0,MEDIUM:1,HIGH:2};
function normalizeNeeds(needs=[]){return [...new Set(needs.filter(x=>typeof x==='string'&&x.trim()).map(x=>x.trim().toLowerCase()))];}
function matches(profile,needs){return needs.some(need=>profile.roles.includes(need));}
export function selectGlobalSources({objective,needs=[],risk_tolerance='HIGH',require_dark_web=false}={}){
  if(typeof objective!=='string'||!objective.trim())throw new TypeError('objective is required');
  const normalized=normalizeNeeds(needs); if(!normalized.length)throw new TypeError('needs are required');
  const selected=Object.entries(SOURCE_REGISTRY).filter(([,p])=>matches(p,normalized)).map(([s])=>s);
  if(normalized.includes('current')&&!selected.includes('SEARCH_WEB'))selected.unshift('SEARCH_WEB');
  if((normalized.includes('threat_intelligence')||require_dark_web)&&!selected.includes('DARK_WEB'))selected.push('DARK_WEB');
  const maxRisk=riskOrder[risk_tolerance]??riskOrder.HIGH;
  const admitted=selected.filter(source=>(riskOrder[RISK_BY_CLASS[SOURCE_REGISTRY[source].class]]??2)<=maxRisk);
  return {status:'PLANNED',objective:objective.trim(),selected:admitted,source_roles:Object.fromEntries(admitted.map(s=>[s,SOURCE_REGISTRY[s].roles])),risk:Object.fromEntries(admitted.map(s=>[s,RISK_BY_CLASS[SOURCE_REGISTRY[s].class]])),dark_web_mode:admitted.includes('DARK_WEB')?'INTELLIGENCE_ONLY':'NOT_SELECTED',rejected:selected.filter(s=>!admitted.includes(s))};
}
export function classifySourceEvidence({source,provenance='UNKNOWN',content_type='DATA',collection_authorized=false,sanitized=false}={}){
  if(!SOURCE_REGISTRY[source])return {status:'INCONCLUSIVE',reason:'unknown source'};
  if(collection_authorized!==true)return {status:'FAIL',reason:'collection authorization is not proven'};
  if(provenance!=='VERIFIED')return {status:'INCONCLUSIVE',reason:'source provenance is not verified'};
  if(sanitized!==true)return {status:'INCONCLUSIVE',reason:'external content is not sanitized'};
  if(content_type==='INSTRUCTION')return {status:'FAIL',reason:'external data cannot become trusted control authority'};
  return {status:'PASS',source_class:SOURCE_REGISTRY[source].class,trust:SOURCE_REGISTRY[source].trust};
}
export function assessCrossSourceClaim({claims=[]}={}){
  if(!Array.isArray(claims)||!claims.length)return {status:'INCONCLUSIVE',reason:'no claims'};
  const usable=claims.filter(c=>c&&c.evidence_status==='VERIFIED'&&c.provenance==='VERIFIED');
  const lineages=new Set(usable.map(c=>c.lineage_id).filter(Boolean));
  if(usable.some(c=>c.contradicts===true))return {status:'CONFLICTED',reason:'verified sources contain a contradiction'};
  if(lineages.size>=2)return {status:'CORROBORATED',independent_sources:lineages.size};
  if(usable.length)return {status:'SINGLE_SOURCE',independent_sources:lineages.size};
  return {status:'INCONCLUSIVE',reason:'no independently verified evidence'};
}
export function assertGlobalIntelligenceIsolation({destination,source='DARK_WEB'}={}){
  const forbidden=new Set(['TRUSTED_MEMORY','EXECUTION','PAYMENT','CREDENTIAL_STORE','AUTHORITY']);
  if(source==='DARK_WEB'&&forbidden.has(destination))throw new Error('untrusted intelligence cannot directly reach trusted destination');
  return true;
}
export {SOURCE_REGISTRY,RISK_BY_CLASS};


const FRESHNESS_HALF_LIFE_HOURS=Object.freeze({MARKET:24,NEWS:48,SOCIAL:24,THREAT_INTELLIGENCE:72,ACADEMIC:2160,INDUSTRY:336,DEFAULT:168});
export function assessSourceReliability({source,historical_reliability=0,collection_quality=0,independence=0,provenance='UNKNOWN'}={}) {
  if(!SOURCE_REGISTRY[source]) return {status:'INCONCLUSIVE',reason:'unknown source'};
  if(provenance!=='VERIFIED') return {status:'INCONCLUSIVE',reason:'provenance is not verified'};
  const values=[historical_reliability,collection_quality,independence];
  if(values.some(v=>!Number.isFinite(v)||v<0||v>1)) return {status:'INCONCLUSIVE',reason:'reliability inputs out of bounds'};
  return {status:'PASS',score:Number((0.45*historical_reliability+0.30*collection_quality+0.25*independence).toFixed(6))};
}
export function assessFreshness({observed_at,now,domain='DEFAULT'}={}) {
  const observed=Date.parse(observed_at), current=Date.parse(now);
  if(!Number.isFinite(observed)||!Number.isFinite(current)||current<observed) return {status:'INCONCLUSIVE',reason:'invalid timestamps'};
  const halfLife=FRESHNESS_HALF_LIFE_HOURS[domain]??FRESHNESS_HALF_LIFE_HOURS.DEFAULT;
  const ageHours=(current-observed)/3600000;
  const weight=Number(Math.pow(0.5,ageHours/halfLife).toFixed(6));
  return {status:weight>=0.5?'FRESH':weight>=0.1?'AGING':'STALE',age_hours:Number(ageHours.toFixed(3)),weight};
}
export function buildLineageGraph({claims=[]}={}) {
  const roots=new Map();
  for(const claim of claims){
    if(!claim?.claim_id) continue;
    const root=claim.parent_claim_id||claim.claim_id;
    if(!roots.has(root)) roots.set(root,new Set());
    if(claim.source_id) roots.get(root).add(claim.source_id);
  }
  return {lineage_count:roots.size,independent_lineages:[...roots.values()].filter(s=>s.size>0).length};
}
export function fuseEvidence({observations=[]}={}) {
  if(!Array.isArray(observations)||!observations.length) return {status:'INCONCLUSIVE',reason:'no observations'};
  if(observations.some(o=>o?.status==='CONFLICTED')) return {status:'CONFLICTED'};
  const verified=observations.filter(o=>o?.status==='VERIFIED');
  if(!verified.length) return {status:'INCONCLUSIVE',reason:'no verified observations'};
  const support=verified.filter(o=>o.polarity==='SUPPORT').reduce((a,o)=>a+(Number(o.weight)||0),0);
  const oppose=verified.filter(o=>o.polarity==='OPPOSE').reduce((a,o)=>a+(Number(o.weight)||0),0);
  if(support>0&&oppose>0) return {status:'CONFLICTED',support,oppose};
  return {status:'FUSED',direction:support>=oppose?'SUPPORT':'OPPOSE',weight:Number(Math.max(support,oppose).toFixed(6))};
}
export function expandSources({plan={},available=[]}={}) {
  const selected=new Set(plan.selected||[]);
  const needs=new Set(plan.needs||[]);
  const added=[];
  for(const source of available){
    if(selected.has(source)) continue;
    const roles=SOURCE_REGISTRY[source]?.roles||[];
    if([...needs].some(n=>roles.includes(n))){
      selected.add(source); added.push(source);
    }
  }
  return {selected:[...selected],added};
}
export function runAdaptiveIntelligenceCampaign({objective,observations=[]}={}) {
  if(typeof objective!=='string'||!objective.trim()) throw new TypeError('objective is required');
  const critical=observations.filter(o=>o?.critical===true);
  if(!critical.length) return {status:'HOLD',execution_authorized:false,reason:'critical evidence gate missing'};
  if(critical.some(o=>o.status!=='VERIFIED')) return {status:'HOLD',execution_authorized:false,reason:'critical evidence unresolved'};
  const lineages=new Set(critical.map(o=>o.lineage_id).filter(Boolean));
  if(lineages.size<2) return {status:'HOLD',execution_authorized:false,reason:'independent corroboration missing'};
  return {status:'READY_FOR_DECISION',execution_authorized:false,independent_lineages:lineages.size};
}
export {FRESHNESS_HALF_LIFE_HOURS};
