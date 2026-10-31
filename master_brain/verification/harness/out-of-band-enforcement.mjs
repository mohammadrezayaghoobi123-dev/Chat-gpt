const RESULT = Object.freeze({ PASS: 'PASS', FAIL: 'FAIL', INCONCLUSIVE: 'INCONCLUSIVE' });

const PROTECTED_EFFECTS = new Set([
  'IRREVERSIBLE_WRITE',
  'FINANCIAL_TRANSACTION',
  'SENSITIVE_OUTBOUND_MESSAGE',
  'DESTRUCTIVE_FILE_OPERATION',
  'AUTHORITY_ESCALATION',
  'PRODUCTION_DEPLOYMENT'
]);

export function evaluateOutOfBandEnforcement({ request = {}, runtime = {}, policy = {} } = {}) {
  const required = ['effect', 'target', 'request_hash', 'intent_hash'];
  const missing = required.filter((k) => !Object.prototype.hasOwnProperty.call(request, k));
  if (missing.length) return { status: RESULT.INCONCLUSIVE, reason: 'effect-control evidence is incomplete', missing };
  if (!PROTECTED_EFFECTS.has(request.effect)) return { status: RESULT.PASS, reason: 'effect is outside protected consequential set' };
  if (runtime.enforcement_plane !== 'OUT_OF_BAND') return { status: RESULT.FAIL, reason: 'protected effect is not enforced out-of-band' };
  if (runtime.policy_source !== 'INDEPENDENT_POLICY_ENGINE') return { status: RESULT.FAIL, reason: 'protected effect policy is model/agent controlled' };
  if (runtime.sandbox_status !== 'ISOLATED' && request.effect !== 'SENSITIVE_OUTBOUND_MESSAGE') return { status: RESULT.FAIL, reason: 'protected effect lacks runtime isolation' };
  if (runtime.effect_observed !== true) return { status: RESULT.INCONCLUSIVE, reason: 'effect observation is missing' };
  if (runtime.request_hash !== request.request_hash || runtime.intent_hash !== request.intent_hash) return { status: RESULT.FAIL, reason: 'runtime effect binding drift detected' };
  if (policy.decision !== 'ALLOW') return { status: RESULT.FAIL, reason: 'out-of-band policy did not authorize protected effect' };
  if (runtime.quarantine_capable !== true) return { status: RESULT.INCONCLUSIVE, reason: 'runtime quarantine capability is not proven' };
  return { status: RESULT.PASS };
}

export function evaluateJitCredential({ credential = {}, request = {} } = {}) {
  const required = ['status', 'provenance', 'scope', 'audience', 'issued_at', 'expires_at', 'sender_binding'];
  const missing = required.filter((k) => !Object.prototype.hasOwnProperty.call(credential, k));
  if (missing.length) return { status: RESULT.INCONCLUSIVE, reason: 'JIT credential evidence is incomplete', missing };
  if (credential.status !== 'ACTIVE' || credential.provenance !== 'VERIFIED') return { status: RESULT.INCONCLUSIVE, reason: 'credential is not verified active' };
  if (credential.issued_at !== 'VALID' || credential.expires_at !== 'VALID') return { status: RESULT.FAIL, reason: 'credential lifetime is invalid' };
  if (!Array.isArray(credential.scope) || credential.scope.length === 0 || credential.scope.includes('*')) return { status: RESULT.FAIL, reason: 'credential scope is unbounded' };
  if (request.audience !== undefined && credential.audience !== request.audience) return { status: RESULT.FAIL, reason: 'credential audience mismatch' };
  if (request.scope !== undefined && !credential.scope.includes(request.scope)) return { status: RESULT.FAIL, reason: 'credential scope exceeds request' };
  if (request.consequential === true && credential.sender_binding !== 'VERIFIED') return { status: RESULT.INCONCLUSIVE, reason: 'sender binding required for consequential JIT access' };
  return { status: RESULT.PASS };
}

export { RESULT };
