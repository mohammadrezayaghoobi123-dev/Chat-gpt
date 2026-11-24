---------------- MODULE EGIS_AtomicOperation_v1_0_3 ----------------
EXTENDS Naturals, FiniteSets, Sequences
CONSTANTS Tenants, Attempts, MaxTime
ASSUME /\ Tenants # {} /\ Attempts # {} /\ MaxTime \in Nat /\ MaxTime >= 1
Phases == {"IDLE", "PREPARED", "EVALUATED", "AUTHORIZED", "COMMIT_PENDING", "COMMITTED", "RECOVERY_PENDING", "ABORTED"}
AttemptStates == {"NEW", "PENDING", "WON", "REJECTED", "CANCELLED"}
GateStates == {"PASS", "FAIL", "UNKNOWN", "DISPUTED", "NOT_APPLICABLE"}
CommitTruthStates == {"AUTHORITATIVELY_ABSENT", "COMMITTED", "UNKNOWN"}
CommitObservationStates == {"ACKNOWLEDGED_COMMITTED", "ACKNOWLEDGED_ABORTED", "UNKNOWN"}
VARIABLES phase, requestedTenant, resolvedTenant, snapshotTenant, currentPolicy, snapshotPolicy, currentTrustEpoch, snapshotTrustEpoch, graphComplete, evidenceRevoked, gateResult, authorizationConsumed, authorizationExpiry, currentTime, attemptState, winner, commitTruth, commitObservation, ledger
vars == <<phase, requestedTenant, resolvedTenant, snapshotTenant, currentPolicy, snapshotPolicy, currentTrustEpoch, snapshotTrustEpoch, graphComplete, evidenceRevoked, gateResult, authorizationConsumed, authorizationExpiry, currentTime, attemptState, winner, commitTruth, commitObservation, ledger>>
Init ==
 /\ phase = "IDLE"
 /\ requestedTenant \in Tenants
 /\ resolvedTenant = requestedTenant
 /\ snapshotTenant = 0
 /\ currentPolicy = 1 /\ snapshotPolicy = 0
 /\ currentTrustEpoch = 1 /\ snapshotTrustEpoch = 0
 /\ graphComplete = TRUE /\ evidenceRevoked = FALSE
 /\ gateResult = "UNKNOWN"
 /\ authorizationConsumed = FALSE
 /\ authorizationExpiry = 0 /\ currentTime = 0
 /\ attemptState = [a \in Attempts |-> "NEW"]
 /\ winner = 0
 /\ commitTruth = "AUTHORITATIVELY_ABSENT"
 /\ commitObservation = "UNKNOWN"
 /\ ledger = <<>>
PrepareSnapshot ==
 /\ phase = "IDLE" /\ requestedTenant = resolvedTenant
 /\ snapshotTenant' = resolvedTenant
 /\ snapshotPolicy' = currentPolicy
 /\ snapshotTrustEpoch' = currentTrustEpoch
 /\ phase' = "PREPARED"
 /\ UNCHANGED <<requestedTenant, resolvedTenant, currentPolicy, currentTrustEpoch, graphComplete, evidenceRevoked, gateResult, authorizationConsumed, authorizationExpiry, currentTime, attemptState, winner, commitTruth, commitObservation, ledger>>
Evaluate ==
 /\ phase = "PREPARED" /\ graphComplete /\ ~evidenceRevoked /\ gateResult = "PASS"
 /\ phase' = "EVALUATED"
 /\ UNCHANGED <<requestedTenant, resolvedTenant, snapshotTenant, currentPolicy, snapshotPolicy, currentTrustEpoch, snapshotTrustEpoch, graphComplete, evidenceRevoked, gateResult, authorizationConsumed, authorizationExpiry, currentTime, attemptState, winner, commitTruth, commitObservation, ledger>>
Authorize ==
 /\ phase = "EVALUATED"
 /\ requestedTenant = resolvedTenant /\ snapshotTenant = resolvedTenant
 /\ snapshotPolicy = currentPolicy /\ snapshotTrustEpoch = currentTrustEpoch
 /\ graphComplete /\ ~evidenceRevoked /\ gateResult = "PASS"
 /\ currentTime < MaxTime
 /\ authorizationExpiry' = MaxTime /\ phase' = "AUTHORIZED"
 /\ UNCHANGED <<requestedTenant, resolvedTenant, snapshotTenant, currentPolicy, snapshotPolicy, currentTrustEpoch, snapshotTrustEpoch, graphComplete, evidenceRevoked, gateResult, authorizationConsumed, currentTime, attemptState, winner, commitTruth, commitObservation, ledger>>
StartAttempt(a) ==
 /\ a \in Attempts /\ phase \in {"AUTHORIZED", "COMMIT_PENDING"}
 /\ ~authorizationConsumed /\ attemptState[a] = "NEW"
 /\ attemptState' = [attemptState EXCEPT ![a] = "PENDING"]
 /\ phase' = "COMMIT_PENDING"
 /\ UNCHANGED <<requestedTenant, resolvedTenant, snapshotTenant, currentPolicy, snapshotPolicy, currentTrustEpoch, snapshotTrustEpoch, graphComplete, evidenceRevoked, gateResult, authorizationConsumed, authorizationExpiry, currentTime, winner, commitTruth, commitObservation, ledger>>
CommitBindingsValid ==
 /\ requestedTenant = resolvedTenant /\ resolvedTenant = snapshotTenant
 /\ currentPolicy = snapshotPolicy /\ currentTrustEpoch = snapshotTrustEpoch
 /\ graphComplete /\ ~evidenceRevoked /\ gateResult = "PASS"
 /\ currentTime < authorizationExpiry
CommitAttempt(a) ==
 /\ a \in Attempts /\ phase = "COMMIT_PENDING"
 /\ attemptState[a] = "PENDING" /\ ~authorizationConsumed /\ winner = 0
 /\ commitTruth = "AUTHORITATIVELY_ABSENT" /\ CommitBindingsValid
 /\ authorizationConsumed' = TRUE /\ winner' = a
 /\ attemptState' = [x \in Attempts |-> IF x = a THEN "WON" ELSE IF attemptState[x] = "PENDING" THEN "REJECTED" ELSE attemptState[x]]
 /\ commitTruth' = "COMMITTED" /\ commitObservation' = "ACKNOWLEDGED_COMMITTED"
 /\ phase' = "COMMITTED"
 /\ ledger' = Append(ledger, [kind |-> "COMMIT", tenant |-> resolvedTenant, attempt |-> a, policy |-> currentPolicy, trustEpoch |-> currentTrustEpoch])
 /\ UNCHANGED <<requestedTenant, resolvedTenant, snapshotTenant, currentPolicy, snapshotPolicy, currentTrustEpoch, snapshotTrustEpoch, graphComplete, evidenceRevoked, gateResult, authorizationExpiry, currentTime>>
TamperRequestedTenant(t) ==
 /\ t \in Tenants /\ phase \in {"PREPARED", "EVALUATED", "AUTHORIZED", "COMMIT_PENDING"}
 /\ requestedTenant' = t
 /\ UNCHANGED <<phase, resolvedTenant, snapshotTenant, currentPolicy, snapshotPolicy, currentTrustEpoch, snapshotTrustEpoch, graphComplete, evidenceRevoked, gateResult, authorizationConsumed, authorizationExpiry, currentTime, attemptState, winner, commitTruth, commitObservation, ledger>>
ChangePolicy ==
 /\ phase \in {"PREPARED", "EVALUATED", "AUTHORIZED", "COMMIT_PENDING"} /\ currentPolicy = 1
 /\ currentPolicy' = 2
 /\ UNCHANGED <<phase, requestedTenant, resolvedTenant, snapshotTenant, snapshotPolicy, currentTrustEpoch, snapshotTrustEpoch, graphComplete, evidenceRevoked, gateResult, authorizationConsumed, authorizationExpiry, currentTime, attemptState, winner, commitTruth, commitObservation, ledger>>
RevokeTrust ==
 /\ phase \in {"PREPARED", "EVALUATED", "AUTHORIZED", "COMMIT_PENDING"} /\ currentTrustEpoch = 1
 /\ currentTrustEpoch' = 2
 /\ UNCHANGED <<phase, requestedTenant, resolvedTenant, snapshotTenant, currentPolicy, snapshotPolicy, snapshotTrustEpoch, graphComplete, evidenceRevoked, gateResult, authorizationConsumed, authorizationExpiry, currentTime, attemptState, winner, commitTruth, commitObservation, ledger>>
RevokeEvidence ==
 /\ phase \in {"PREPARED", "EVALUATED", "AUTHORIZED", "COMMIT_PENDING"} /\ evidenceRevoked = FALSE
 /\ evidenceRevoked' = TRUE
 /\ UNCHANGED <<phase, requestedTenant, resolvedTenant, snapshotTenant, currentPolicy, snapshotPolicy, currentTrustEpoch, snapshotTrustEpoch, graphComplete, gateResult, authorizationConsumed, authorizationExpiry, currentTime, attemptState, winner, commitTruth, commitObservation, ledger>>
MarkGraphIncomplete ==
 /\ phase \in {"PREPARED", "EVALUATED", "AUTHORIZED", "COMMIT_PENDING"} /\ graphComplete
 /\ graphComplete' = FALSE
 /\ UNCHANGED <<phase, requestedTenant, resolvedTenant, snapshotTenant, currentPolicy, snapshotPolicy, currentTrustEpoch, snapshotTrustEpoch, evidenceRevoked, gateResult, authorizationConsumed, authorizationExpiry, currentTime, attemptState, winner, commitTruth, commitObservation, ledger>>
AdvanceTime ==
 /\ currentTime < MaxTime /\ currentTime' = currentTime + 1
 /\ UNCHANGED <<phase, requestedTenant, resolvedTenant, snapshotTenant, currentPolicy, snapshotPolicy, currentTrustEpoch, snapshotTrustEpoch, graphComplete, evidenceRevoked, gateResult, authorizationConsumed, authorizationExpiry, attemptState, winner, commitTruth, commitObservation, ledger>>
LoseAcknowledgement ==
 /\ phase = "COMMITTED" /\ commitTruth = "COMMITTED" /\ commitObservation = "ACKNOWLEDGED_COMMITTED"
 /\ commitObservation' = "UNKNOWN" /\ phase' = "RECOVERY_PENDING"
 /\ UNCHANGED <<requestedTenant, resolvedTenant, snapshotTenant, currentPolicy, snapshotPolicy, currentTrustEpoch, snapshotTrustEpoch, graphComplete, evidenceRevoked, gateResult, authorizationConsumed, authorizationExpiry, currentTime, attemptState, winner, commitTruth, ledger>>
MakeStoreTruthUnknown ==
 /\ phase = "COMMIT_PENDING" /\ CommitBindingsValid
 /\ commitTruth' = "UNKNOWN" /\ commitObservation' = "UNKNOWN" /\ phase' = "RECOVERY_PENDING"
 /\ UNCHANGED <<requestedTenant, resolvedTenant, snapshotTenant, currentPolicy, snapshotPolicy, currentTrustEpoch, snapshotTrustEpoch, graphComplete, evidenceRevoked, gateResult, authorizationConsumed, authorizationExpiry, currentTime, attemptState, winner, ledger>>
ResolveStoreCommitted ==
 /\ phase = "RECOVERY_PENDING" /\ commitTruth = "UNKNOWN"
 /\ commitTruth' = "COMMITTED"
 /\ UNCHANGED <<phase, requestedTenant, resolvedTenant, snapshotTenant, currentPolicy, snapshotPolicy, currentTrustEpoch, snapshotTrustEpoch, graphComplete, evidenceRevoked, gateResult, authorizationConsumed, authorizationExpiry, currentTime, attemptState, winner, commitObservation, ledger>>
ResolveStoreAbsent ==
 /\ phase = "RECOVERY_PENDING" /\ commitTruth = "UNKNOWN"
 /\ commitTruth' = "AUTHORITATIVELY_ABSENT"
 /\ UNCHANGED <<phase, requestedTenant, resolvedTenant, snapshotTenant, currentPolicy, snapshotPolicy, currentTrustEpoch, snapshotTrustEpoch, graphComplete, evidenceRevoked, gateResult, authorizationConsumed, authorizationExpiry, currentTime, attemptState, winner, commitObservation, ledger>>
ReconcileCommitted ==
 /\ phase = "RECOVERY_PENDING" /\ commitTruth = "COMMITTED"
 /\ commitObservation' = "ACKNOWLEDGED_COMMITTED" /\ phase' = "COMMITTED"
 /\ UNCHANGED <<requestedTenant, resolvedTenant, snapshotTenant, currentPolicy, snapshotPolicy, currentTrustEpoch, snapshotTrustEpoch, graphComplete, evidenceRevoked, gateResult, authorizationConsumed, authorizationExpiry, currentTime, attemptState, winner, commitTruth, ledger>>
ReconcileAbsent ==
 /\ phase = "RECOVERY_PENDING" /\ commitTruth = "AUTHORITATIVELY_ABSENT"
 /\ commitObservation' = "ACKNOWLEDGED_ABORTED" /\ phase' = "ABORTED"
 /\ attemptState' = [x \in Attempts |-> IF attemptState[x] = "PENDING" THEN "CANCELLED" ELSE attemptState[x]]
 /\ UNCHANGED <<requestedTenant, resolvedTenant, snapshotTenant, currentPolicy, snapshotPolicy, currentTrustEpoch, snapshotTrustEpoch, graphComplete, evidenceRevoked, gateResult, authorizationConsumed, authorizationExpiry, currentTime, winner, commitTruth, ledger>>
Next ==
 \/ PrepareSnapshot \/ Evaluate \/ Authorize
 \/ \E a \in Attempts : StartAttempt(a)
 \/ \E a \in Attempts : CommitAttempt(a)
 \/ \E t \in Tenants : TamperRequestedTenant(t)
 \/ ChangePolicy \/ RevokeTrust \/ RevokeEvidence \/ MarkGraphIncomplete
 \/ AdvanceTime \/ LoseAcknowledgement \/ MakeStoreTruthUnknown
 \/ ResolveStoreCommitted \/ ResolveStoreAbsent \/ ReconcileCommitted \/ ReconcileAbsent
Spec == Init /\ [][Next]_vars
TypeOK ==
 /\ phase \in Phases /\ requestedTenant \in Tenants /\ resolvedTenant \in Tenants
 /\ snapshotTenant \in (Tenants \cup {0})
 /\ currentPolicy \in {1, 2} /\ snapshotPolicy \in {0, 1, 2}
 /\ currentTrustEpoch \in {1, 2} /\ snapshotTrustEpoch \in {0, 1, 2}
 /\ graphComplete \in BOOLEAN /\ evidenceRevoked \in BOOLEAN /\ gateResult \in GateStates
 /\ authorizationConsumed \in BOOLEAN /\ authorizationExpiry \in 0..MaxTime /\ currentTime \in 0..MaxTime
 /\ attemptState \in [Attempts -> AttemptStates] /\ winner \in (Attempts \cup {0})
 /\ commitTruth \in CommitTruthStates /\ commitObservation \in CommitObservationStates
 /\ ledger \in Seq([kind : {"COMMIT"}, tenant : Tenants, attempt : Attempts, policy : {1, 2}, trustEpoch : {1, 2}])
AtMostOneWinner == Cardinality({a \in Attempts : attemptState[a] = "WON"}) <= 1
WinnerConsistent == (winner = 0) <=> ~(\E a \in Attempts : attemptState[a] = "WON")
NoCommitWithoutBindings ==
 (phase \in {"COMMITTED", "RECOVERY_PENDING"} /\ commitTruth = "COMMITTED")
 =>
 (authorizationConsumed /\ winner \in Attempts /\ snapshotTenant = resolvedTenant /\ snapshotPolicy = currentPolicy /\ snapshotTrustEpoch = currentTrustEpoch /\ requestedTenant = resolvedTenant /\ graphComplete /\ ~evidenceRevoked /\ gateResult = "PASS")
NoUnknownCommitObservation == commitObservation = "ACKNOWLEDGED_COMMITTED" => commitTruth = "COMMITTED"
NoNewAttemptDuringRecovery == phase = "RECOVERY_PENDING" => \A a \in Attempts : attemptState[a] # "NEW"
NoDuplicateLedgerCommit == Len(ledger) <= 1
Safety == /\ TypeOK /\ AtMostOneWinner /\ WinnerConsistent /\ NoCommitWithoutBindings /\ NoUnknownCommitObservation /\ NoNewAttemptDuringRecovery /\ NoDuplicateLedgerCommit
=============================================================================