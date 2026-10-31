const EVENT_TYPES = new Set(['state','decision','authority','policy','execution_gate','execution','sink','recovery','evidence','provenance','sequence']);

export function createObserver({ run_id = 'RUN-UNSPECIFIED' } = {}) {
  const events = [];
  return {
    record(event = {}) {
      if (!event.type || !EVENT_TYPES.has(event.type)) throw new TypeError('type must be a supported observer event type');
      const recorded = structuredClone(event);
      events.push(recorded);
      return recorded;
    },
    snapshot() {
      const observed = {};
      for (const event of events) {
        if (event.type === 'state') observed.state = event.value;
        if (event.type === 'decision') observed.decision = event.value;
        if (event.type === 'authority') observed.authority = event.value;
        if (event.type === 'policy') observed.policy = event.value;
        if (event.type === 'execution_gate') observed.execution_gate = event.value;
        if (event.type === 'execution') observed.execution = event.value;
        if (event.type === 'sink') observed.sink = event.value;
        if (event.type === 'recovery') observed.recovery = event.value;
        if (event.type === 'evidence') observed.evidence = event.value;
        if (event.type === 'provenance') observed.provenance = event.value;
      }
      return { run_id, events: structuredClone(events), observed };
    }
  };
}
