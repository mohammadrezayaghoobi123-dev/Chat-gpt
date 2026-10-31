export function runRecoveryExperiment(p={}) {
  if (p.recovered !== true) return {state:'RECOVERY_FAILED',ready:false};
  if (p.commit_status === 'AMBIGUOUS' || p.duplicate_critical_side_effect === true || p.lost_committed_event === true || p.unauthorized_recovery === true) {
    return {state:'RECOVERY_BLOCKED',ready:false};
  }
  if (p.verified === true) return {state:'VERIFIED_READY',ready:true};
  return {state:'RECOVERED',ready:false};
}

export function simulateCrashRecovery(p={}) {
  const point=p.crash_point;
  const base={committed:false,event_count:0,published:false,duplicate_critical_side_effect:false,ready:false,replay_side_effects:0,stale_worker_mutations:0,snapshot_ready:false,safe:true};
  if (point==='BEFORE_COMMIT') return base;
  if (point==='AFTER_COMMIT') return {...base,committed:true,event_count:1,replay_side_effects:1};
  if (point==='AFTER_PUBLICATION') {
    const duplicate=p.force_duplicate_on_replay===true;
    return {...base,committed:true,event_count:1,published:true,replay_side_effects:duplicate ? (p.replay_count ?? 1)+1 : 1,duplicate_critical_side_effect:duplicate,safe:!duplicate};
  }
  if (point==='DURING_RECOVERY') {
    const stale=p.worker_epoch !== undefined && p.recovery_epoch !== undefined && p.worker_epoch !== p.recovery_epoch;
    return {...base,stale_worker_mutations:stale ? 0 : (p.worker_attempts ?? 0),safe:stale ? true : false};
  }
  if (point==='DURING_COMMIT') {
    if (p.commit_outcome==='COMMITTED') return {...base,committed:true,event_count:1};
    if (p.commit_outcome==='AMBIGUOUS') return {...base,safe:true};
    return base;
  }
  if (point==='DURING_SNAPSHOT_PUBLICATION') return {...base,snapshot_ready:p.snapshot_status==='COMPLETE' && p.verified===true};
  return base;
}