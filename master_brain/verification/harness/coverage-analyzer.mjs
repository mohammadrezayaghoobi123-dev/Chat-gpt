const DIMENSIONS=['structural','functional','invariant','fault','state','sequence','interaction','input_space','safety_property','mutation'];
export function analyzeCoverage(campaign={},results=[]) {
  const configured=campaign.manifest?.coverage??{};
  const out={};
  for(const dim of DIMENSIONS){
    const cfg=configured[dim]??{denominator:0};
    const denominator=Number.isInteger(cfg.denominator)&&cfg.denominator>=0?cfg.denominator:0;
    const relevant=results.filter(r=>r?.[dim]!==undefined || (dim==='fault'&&r?.fault_id));
    const numerator=dim==='fault'?relevant.filter(r=>r.fault_detection==='PASS').length:relevant.filter(r=>r[dim]==='PASS'||r[dim]===true).length;
    out[dim]={numerator,denominator,rate:denominator?numerator/denominator:1};
  }
  const criticalIds=configured.fault?.critical_ids??[];
  const blocked=criticalIds.length
    ? criticalIds.filter(id=>{const r=results.find(x=>x.fault_id===id); return !r||r.fault_detection==='INCONCLUSIVE';})
    : results.filter(r=>r?.fault_detection==='INCONCLUSIVE').map(r=>r.fault_id).filter(Boolean);
  out.critical_inconclusive=blocked.length;
  out.blocked=blocked;
  out.denominators=Object.freeze(Object.fromEntries(DIMENSIONS.map(d=>[d,out[d].denominator])));
  return out;
}