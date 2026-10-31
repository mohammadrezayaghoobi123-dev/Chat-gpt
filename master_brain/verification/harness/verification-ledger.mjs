const REQUIRED=['verification_id','run_id','scenario_id','requirement_ids','invariant_ids','fault_id','SUT_version','harness_version','specification_version','policy_version','reference_model_version','environment_id','expected_result','observed_result','evidence_refs','oracle_result','coverage_snapshot','timestamp','verifier','status'];
export function createVerificationLedger(){ return {records:[]}; }
export function appendVerificationRecord(ledger,record={}) {
  const missing=REQUIRED.filter(k=>!(k in record));
  if(missing.length) throw new TypeError(`traceability/version metadata missing: ${missing.join(",")}`);
  const copy=structuredClone(record); ledger.records.push(Object.freeze(copy)); return copy;
}
export function freezeLedgerRevision(ledger,runId) {
  const records=ledger.records.filter(r=>r.run_id===runId).map(r=>structuredClone(r));
  return Object.freeze({run_id:runId,records:Object.freeze(records),record_count:records.length});
}