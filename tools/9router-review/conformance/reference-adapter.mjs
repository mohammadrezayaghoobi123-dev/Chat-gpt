function notImplemented() {
  return { status: "NOT_IMPLEMENTED" };
}

export function createReferenceSystem() {
  const ledger = {
    appendIntent: async () => notImplemented(),
    appendOutcome: async () => notImplemented(),
    readComplete: async () => notImplemented(),
  };
  const adapter = {
    claim: async () => notImplemented(),
    renew: async () => notImplemented(),
    abortBeforeModel: async () => notImplemented(),
    resumeCompletedModel: async () => notImplemented(),
    beginModelAttempt: async () => notImplemented(),
    completeModelAttempt: async () => notImplemented(),
    beginCommentAttempt: async () => notImplemented(),
    completeCommentAttempt: async () => notImplemented(),
    markUnknown: async () => notImplemented(),
    expireAmbiguousAttempt: async () => notImplemented(),
    readAuthoritative: async () => notImplemented(),
    reconcileComment: async () => notImplemented(),
    closeWithoutPublish: async () => notImplemented(),
    setRecoveryMode: async () => notImplemented(),
    unlockRecovery: async () => notImplemented(),
  };
  return { adapter, ledger };
}
