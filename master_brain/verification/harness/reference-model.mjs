const TRANSITIONS = Object.freeze({
  authorize: (state, event) => ({ ...state, status: event.value === 'APPROVED' ? 'AUTHORIZED' : 'UNAUTHORIZED' }),
  deny: (state) => ({ ...state, status: 'DENIED' }),
  reset: () => ({ status: 'UNKNOWN' })
});

export function createReferenceModel({ version = 'rm-v1' } = {}) {
  return {
    version,
    initialState() { return { status: 'UNKNOWN' }; },
    apply(state = { status: 'UNKNOWN' }, event = {}) {
      if (state.status === 'CONFLICTED') return structuredClone(state);
      const transition = TRANSITIONS[event.type];
      if (!transition) return structuredClone(state);
      return structuredClone(transition(state, event));
    }
  };
}
