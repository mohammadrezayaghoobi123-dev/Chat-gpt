const PROTECTED = new Set(['financial_transaction','sensitive_outbound_message','destructive_file_operation','authority_escalation','production_deployment','external_write']);

function deterministicTraceId(runId) {
  return `sink-${String(runId).replace(/[^A-Za-z0-9_.-]/g, '_')}`;
}

export function createExecutionSink({ run_id = 'RUN-UNSPECIFIED' } = {}) {
  const trace = deterministicTraceId(run_id);
  return {
    assertIsolated() { return { isolated: true, mode: 'local-test-double', trace_id: trace, run_id }; },
    execute(request = {}) {
      if (PROTECTED.has(request.operation)) return { status: 'BLOCKED', operation: request.operation, trace_id: trace, run_id };
      return { status: 'SIMULATED', operation: request.operation ?? 'unknown', trace_id: trace, run_id };
    }
  };
}
