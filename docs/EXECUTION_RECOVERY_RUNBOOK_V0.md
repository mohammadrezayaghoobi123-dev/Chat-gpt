# Execution Recovery Runbook V0

## Status and scope

This runbook describes the current local prototype's safe operator response when mission execution may have crossed an external side-effect boundary. It is operational guidance, not an implemented automated recovery engine. The SQLite registry is single-host coordination only; it does not provide distributed exactly-once execution.

## Non-negotiable rule

**Do not blindly retry an operation after it may have been dispatched.** A missing local response, missing audit event, process crash, or elapsed time is not proof that the external operation failed.

## State handling

| Persisted state | Meaning for recovery | Safe action |
| --- | --- | --- |
| PENDING | Reserved, but dispatch has not been proven to have started | Inspect the execution/audit trail before any controlled retry. Do not infer that no dispatch occurred solely from state if another worker or older version may have acted outside the registry. |
| RUNNING | The worker claimed the key; it may have stopped before or after an external effect | Add to the recovery queue. Do not reclaim the key or dispatch again automatically. |
| OUTCOME_UNKNOWN | The dispatch path was crossed, but the effect has not been independently verified | Reconcile against provider-side records or a trusted read-only query. Keep unknown if evidence is unavailable. |
| RECONCILIATION_REQUIRED | An explicit reconciliation decision is needed | Collect evidence and use a separately authorized, audited decision path. |
| SUCCEEDED | Should only mean trusted completion evidence was validated and bound to the exact request | In this prototype, direct transition to SUCCEEDED is blocked because the evidence-aware API is not implemented. |
| FAILED | A terminal state is valid only when the system has sufficient evidence that the operation did not succeed, or a policy-approved failure decision was recorded | Do not mark failed merely because the response timed out or is missing. |

## Recovery procedure

1. **Freeze automatic retries** for the affected idempotency key.
2. **Read the registry record** and capture its key, mission ID, contract digest, payload digest, state, version, and timestamps.
3. **Inspect the audit ledger** for dispatch-started and dispatch-finished events. A missing finish event means incomplete local evidence; it does not establish that the provider did nothing.
4. **Query the provider through a documented, read-only reconciliation interface**, if available. Match the exact provider operation/receipt to the mission and payload. Do not rely on a model's explanation or an adapter's unverified success-shaped response.
5. **Validate evidence** for issuer authenticity, mission/contract/payload binding, provider operation ID, freshness, replay, and policy/version. If any required check fails, retain uncertainty.
6. **Record the reconciliation decision** through a separately authorized and auditable path. The current prototype does not yet implement this evidence-verifier path.
7. **Retry only when safety is established**: either provider-side idempotency semantics guarantee deduplication for the same stable key, or trusted evidence establishes that no effect occurred and policy permits a new attempt. A new key must not be used to bypass an unresolved old attempt.
8. **Preserve evidence and report uncertainty explicitly.** Never describe adapter response receipt as independently verified external completion.

## Required completion-evidence binding

A future verifier should validate, at minimum:

- mission ID and immutable contract digest;
- canonical payload digest and idempotency key;
- attempt ID and integration/adapter/provider identity;
- provider operation or receipt identifier;
- evidence issuer, verification policy/version, timestamp, and evidence digest;
- authenticity, request binding, freshness, replay resistance, and allowed state transition.

Evidence validation and the state transition to SUCCEEDED must be atomic with respect to the registry record version, or use a durable two-phase protocol that makes partial outcomes recoverable.

## Required tests before enabling automated recovery

- process crash after reservation but before dispatch;
- crash after dispatch but before local result persistence;
- provider accepted operation but client timed out;
- audit write fails before dispatch and after dispatch;
- registry transition fails after dispatch;
- concurrent recovery workers race on the same record;
- evidence from another mission, payload, provider, or attempt is rejected;
- expired, replayed, unsigned, or policy-version-mismatched evidence is rejected;
- successful evidence verification with stale registry version is rejected;
- provider has no safe lookup or idempotency feature, in which case the system stays fail-closed and requires human reconciliation.

## Production blockers

This prototype still needs authenticated actor/time sources, provider-specific idempotency and reconciliation contracts, a trusted evidence verifier, atomic evidence-to-state transition, authorization and consent bound to an immutable contract digest, operational monitoring, and multi-process/distributed concurrency analysis. Until those are implemented and independently tested, keep automated external execution disabled for consequential or irreversible operations.
