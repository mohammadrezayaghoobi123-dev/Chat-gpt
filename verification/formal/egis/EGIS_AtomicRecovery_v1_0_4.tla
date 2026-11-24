---------------- MODULE EGIS_AtomicRecovery_v1_0_4 ----------------
EXTENDS Naturals, FiniteSets, Sequences

CONSTANTS Tenants, Attempts, Policies, TrustEpochs, Fingerprints, MaxTime

ASSUME
    /\ Tenants # {}
    /\ Attempts # {}
    /\ Policies # {}
    /\ TrustEpochs # {}
    /\ Fingerprints # {}
    /\ MaxTime \in Nat
    /\ MaxTime >= 2

Phases ==
    {"IDLE", "PREPARED", "EVALUATED", "AUTHORIZED",
     "COMMIT_PENDING", "COMMITTED", "RECOVERY_PENDING", "ABORTED"}
AttemptStates == {"NEW", "PENDING", "WON", "REJECTED", "CANCELLED"}
GateStates == {"PASS", "FAIL", "UNKNOWN", "DISPUTED"}
OracleStates == {"PASS", "FAIL", "UNKNOWN", "DISPUTED"}
IntentStates == {"NONE", "RESERVED", "COMMITTED", "ABORTED"}
DurableOutcomes == {"UNKNOWN", "COMMITTED", "ABORTED"}
LookupStates ==
    {"NOT_QUERIED", "FOUND_VALID", "ABSENT_AUTHORITATIVE",
     "STALE_ABSENT", "UNKNOWN", "FOUND_INVALID"}
NoCommit == "NO_COMMIT"

VARIABLES
    phase, requestedTenant, resolvedTenant, snapshotPresent, snapshotTenant,
    currentPolicy, snapshotPolicy, currentTrustEpoch, snapshotTrustEpoch,
    operationFingerprint, snapshotFingerprint, graphComplete, evidenceValid,
    oracleResult, gateResult, authorizationIssued, authorizationConsumed,
    authorizationExpiry, currentTime, attemptState, reservedAttempt,
    intentState, durableOutcome, commitRecord, storeEpoch, lookupResult,
    lookupEpoch, commitObservation

vars ==
    <<phase, requestedTenant, resolvedTenant, snapshotPresent, snapshotTenant,
      currentPolicy, snapshotPolicy, currentTrustEpoch, snapshotTrustEpoch,
      operationFingerprint, snapshotFingerprint, graphComplete, evidenceValid,
      oracleResult, gateResult, authorizationIssued, authorizationConsumed,
      authorizationExpiry, currentTime, attemptState, reservedAttempt,
      intentState, durableOutcome, commitRecord, storeEpoch, lookupResult,
      lookupEpoch, commitObservation>>

CommitRecordType ==
    [tenant : Tenants, attempt : Attempts, policy : Policies,
     trustEpoch : TrustEpochs, fingerprint : Fingerprints]

Init ==
    /\ phase = "IDLE"
    /\ requestedTenant \in Tenants
    /\ resolvedTenant = requestedTenant
    /\ snapshotPresent = FALSE
    /\ snapshotTenant \in Tenants
    /\ currentPolicy \in Policies
    /\ snapshotPolicy \in Policies
    /\ currentTrustEpoch \in TrustEpochs
    /\ snapshotTrustEpoch \in TrustEpochs
    /\ operationFingerprint \in Fingerprints
    /\ snapshotFingerprint \in Fingerprints
    /\ graphComplete = TRUE
    /\ evidenceValid = TRUE
    /\ oracleResult = "PASS"
    /\ gateResult = "UNKNOWN"
    /\ authorizationIssued = FALSE
    /\ authorizationConsumed = FALSE
    /\ authorizationExpiry = 0
    /\ currentTime = 0
    /\ attemptState = [a \in Attempts |-> "NEW"]
    /\ reservedAttempt \in Attempts
    /\ intentState = "NONE"
    /\ durableOutcome = "UNKNOWN"
    /\ commitRecord = NoCommit
    /\ storeEpoch = 0
    /\ lookupResult = "NOT_QUERIED"
    /\ lookupEpoch = 0
    /\ commitObservation = "UNKNOWN"

ResolveAndPrepare ==
    /\ phase = "IDLE"
    /\ requestedTenant = resolvedTenant
    /\ snapshotPresent' = TRUE
    /\ snapshotTenant' = resolvedTenant
    /\ snapshotPolicy' = currentPolicy
    /\ snapshotTrustEpoch' = currentTrustEpoch
    /\ snapshotFingerprint' = operationFingerprint
    /\ phase' = "PREPARED"
    /\ UNCHANGED <<requestedTenant, resolvedTenant, currentPolicy,
       currentTrustEpoch, operationFingerprint, graphComplete, evidenceValid,
       oracleResult, gateResult, authorizationIssued, authorizationConsumed,
       authorizationExpiry, currentTime, attemptState, reservedAttempt,
       intentState, durableOutcome, commitRecord, storeEpoch, lookupResult,
       lookupEpoch, commitObservation>>

Evaluate ==
    /\ phase = "PREPARED"
    /\ gateResult = "UNKNOWN"
    /\ gateResult' =
         IF ~graphComplete THEN "UNKNOWN"
         ELSE IF ~evidenceValid THEN "FAIL"
         ELSE IF oracleResult = "PASS" THEN "PASS"
         ELSE IF oracleResult = "FAIL" THEN "FAIL"
         ELSE IF oracleResult = "DISPUTED" THEN "DISPUTED"
         ELSE "UNKNOWN"
    /\ phase' = "EVALUATED"
    /\ UNCHANGED <<requestedTenant, resolvedTenant, snapshotPresent,
       snapshotTenant, currentPolicy, snapshotPolicy, currentTrustEpoch,
       snapshotTrustEpoch, operationFingerprint, snapshotFingerprint,
       graphComplete, evidenceValid, oracleResult, authorizationIssued,
       authorizationConsumed, authorizationExpiry, currentTime, attemptState,
       reservedAttempt, intentState, durableOutcome, commitRecord, storeEpoch,
       lookupResult, lookupEpoch, commitObservation>>

Authorize ==
    /\ phase = "EVALUATED"
    /\ snapshotPresent
    /\ requestedTenant = resolvedTenant
    /\ snapshotTenant = resolvedTenant
    /\ snapshotPolicy = currentPolicy
    /\ snapshotTrustEpoch = currentTrustEpoch
    /\ snapshotFingerprint = operationFingerprint
    /\ graphComplete
    /\ evidenceValid
    /\ oracleResult = "PASS"
    /\ gateResult = "PASS"
    /\ ~authorizationIssued
    /\ currentTime < MaxTime
    /\ authorizationIssued' = TRUE
    /\ authorizationExpiry' = MaxTime
    /\ phase' = "AUTHORIZED"
    /\ UNCHANGED <<requestedTenant, resolvedTenant, snapshotPresent,
       snapshotTenant, currentPolicy, snapshotPolicy, currentTrustEpoch,
       snapshotTrustEpoch, operationFingerprint, snapshotFingerprint,
       graphComplete, evidenceValid, oracleResult, gateResult,
       authorizationConsumed, currentTime, attemptState, reservedAttempt,
       intentState, durableOutcome, commitRecord, storeEpoch, lookupResult,
       lookupEpoch, commitObservation>>

StartAttempt(a) ==
    /\ a \in Attempts
    /\ phase \in {"AUTHORIZED", "COMMIT_PENDING"}
    /\ authorizationIssued
    /\ ~authorizationConsumed
    /\ intentState = "NONE"
    /\ attemptState[a] = "NEW"
    /\ attemptState' = [attemptState EXCEPT ![a] = "PENDING"]
    /\ phase' = "COMMIT_PENDING"
    /\ UNCHANGED <<requestedTenant, resolvedTenant, snapshotPresent,
       snapshotTenant, currentPolicy, snapshotPolicy, currentTrustEpoch,
       snapshotTrustEpoch, operationFingerprint, snapshotFingerprint,
       graphComplete, evidenceValid, oracleResult, gateResult,
       authorizationIssued, authorizationConsumed, authorizationExpiry,
       currentTime, reservedAttempt, intentState, durableOutcome, commitRecord,
       storeEpoch, lookupResult, lookupEpoch, commitObservation>>

ReserveIntent(a) ==
    /\ a \in Attempts
    /\ phase = "COMMIT_PENDING"
    /\ attemptState[a] = "PENDING"
    /\ intentState = "NONE"
    /\ ~authorizationConsumed
    /\ reservedAttempt' = a
    /\ intentState' = "RESERVED"
    /\ UNCHANGED <<phase, requestedTenant, resolvedTenant, snapshotPresent,
       snapshotTenant, currentPolicy, snapshotPolicy, currentTrustEpoch,
       snapshotTrustEpoch, operationFingerprint, snapshotFingerprint,
       graphComplete, evidenceValid, oracleResult, gateResult,
       authorizationIssued, authorizationConsumed, authorizationExpiry,
       currentTime, attemptState, durableOutcome, commitRecord, storeEpoch,
       lookupResult, lookupEpoch, commitObservation>>

CommitBindingsValid ==
    /\ snapshotPresent
    /\ requestedTenant = resolvedTenant
    /\ resolvedTenant = snapshotTenant
    /\ currentPolicy = snapshotPolicy
    /\ currentTrustEpoch = snapshotTrustEpoch
    /\ operationFingerprint = snapshotFingerprint
    /\ graphComplete
    /\ evidenceValid
    /\ oracleResult = "PASS"
    /\ gateResult = "PASS"
    /\ currentTime < authorizationExpiry

CommitAndLoseAck ==
    /\ phase = "COMMIT_PENDING"
    /\ intentState = "RESERVED"
    /\ reservedAttempt \in Attempts
    /\ attemptState[reservedAttempt] = "PENDING"
    /\ authorizationIssued
    /\ ~authorizationConsumed
    /\ commitRecord = NoCommit
    /\ CommitBindingsValid
    /\ authorizationConsumed' = TRUE
    /\ intentState' = "COMMITTED"
    /\ durableOutcome' = "COMMITTED"
    /\ commitRecord' =
         [tenant |-> resolvedTenant, attempt |-> reservedAttempt,
          policy |-> snapshotPolicy, trustEpoch |-> snapshotTrustEpoch,
          fingerprint |-> snapshotFingerprint]
    /\ attemptState' =
         [a \in Attempts |->
             IF a = reservedAttempt THEN "WON"
             ELSE IF attemptState[a] = "PENDING" THEN "REJECTED"
             ELSE attemptState[a]]
    /\ storeEpoch' = storeEpoch + 1
    /\ lookupResult' = "UNKNOWN"
    /\ lookupEpoch' = storeEpoch
    /\ commitObservation' = "UNKNOWN"
    /\ phase' = "RECOVERY_PENDING"
    /\ UNCHANGED <<requestedTenant, resolvedTenant, snapshotPresent,
       snapshotTenant, currentPolicy, snapshotPolicy, currentTrustEpoch,
       snapshotTrustEpoch, operationFingerprint, snapshotFingerprint,
       graphComplete, evidenceValid, oracleResult, gateResult,
       authorizationIssued, authorizationExpiry, currentTime, reservedAttempt>>

AbortAndLoseAck ==
    /\ phase = "COMMIT_PENDING"
    /\ intentState = "RESERVED"
    /\ reservedAttempt \in Attempts
    /\ attemptState[reservedAttempt] = "PENDING"
    /\ commitRecord = NoCommit
    /\ authorizationConsumed' = TRUE
    /\ intentState' = "ABORTED"
    /\ durableOutcome' = "ABORTED"
    /\ attemptState' =
         [a \in Attempts |->
             IF attemptState[a] = "PENDING" THEN "CANCELLED"
             ELSE attemptState[a]]
    /\ storeEpoch' = storeEpoch + 1
    /\ lookupResult' = "UNKNOWN"
    /\ lookupEpoch' = storeEpoch
    /\ commitObservation' = "UNKNOWN"
    /\ phase' = "RECOVERY_PENDING"
    /\ UNCHANGED <<requestedTenant, resolvedTenant, snapshotPresent,
       snapshotTenant, currentPolicy, snapshotPolicy, currentTrustEpoch,
       snapshotTrustEpoch, operationFingerprint, snapshotFingerprint,
       graphComplete, evidenceValid, oracleResult, gateResult,
       authorizationIssued, authorizationExpiry, currentTime, reservedAttempt,
       commitRecord>>

AuthoritativeLookup ==
    /\ phase = "RECOVERY_PENDING"
    /\ lookupResult \in {"UNKNOWN", "NOT_QUERIED", "STALE_ABSENT"}
    /\ lookupEpoch' = storeEpoch
    /\ lookupResult' =
         IF commitRecord # NoCommit
         THEN "FOUND_VALID"
         ELSE IF intentState = "ABORTED"
         THEN "ABSENT_AUTHORITATIVE"
         ELSE "UNKNOWN"
    /\ UNCHANGED <<phase, requestedTenant, resolvedTenant, snapshotPresent,
       snapshotTenant, currentPolicy, snapshotPolicy, currentTrustEpoch,
       snapshotTrustEpoch, operationFingerprint, snapshotFingerprint,
       graphComplete, evidenceValid, oracleResult, gateResult,
       authorizationIssued, authorizationConsumed, authorizationExpiry,
       currentTime, attemptState, reservedAttempt, intentState, durableOutcome,
       commitRecord, storeEpoch, commitObservation>>

StaleReplicaLookup ==
    /\ phase = "RECOVERY_PENDING"
    /\ lookupResult \in {"UNKNOWN", "NOT_QUERIED"}
    /\ lookupResult' = "STALE_ABSENT"
    /\ lookupEpoch' = IF storeEpoch > 0 THEN storeEpoch - 1 ELSE 0
    /\ UNCHANGED <<phase, requestedTenant, resolvedTenant, snapshotPresent,
       snapshotTenant, currentPolicy, snapshotPolicy, currentTrustEpoch,
       snapshotTrustEpoch, operationFingerprint, snapshotFingerprint,
       graphComplete, evidenceValid, oracleResult, gateResult,
       authorizationIssued, authorizationConsumed, authorizationExpiry,
       currentTime, attemptState, reservedAttempt, intentState, durableOutcome,
       commitRecord, storeEpoch, commitObservation>>

ReconcileCommitted ==
    /\ phase = "RECOVERY_PENDING"
    /\ lookupResult = "FOUND_VALID"
    /\ lookupEpoch = storeEpoch
    /\ commitRecord # NoCommit
    /\ commitRecord.tenant = snapshotTenant
    /\ commitRecord.attempt = reservedAttempt
    /\ commitRecord.policy = snapshotPolicy
    /\ commitRecord.trustEpoch = snapshotTrustEpoch
    /\ commitRecord.fingerprint = snapshotFingerprint
    /\ durableOutcome = "COMMITTED"
    /\ commitObservation' = "ACKNOWLEDGED_COMMITTED"
    /\ phase' = "COMMITTED"
    /\ UNCHANGED <<requestedTenant, resolvedTenant, snapshotPresent,
       snapshotTenant, currentPolicy, snapshotPolicy, currentTrustEpoch,
       snapshotTrustEpoch, operationFingerprint, snapshotFingerprint,
       graphComplete, evidenceValid, oracleResult, gateResult,
       authorizationIssued, authorizationConsumed, authorizationExpiry,
       currentTime, attemptState, reservedAttempt, intentState, durableOutcome,
       commitRecord, storeEpoch, lookupResult, lookupEpoch>>

ReconcileAbsent ==
    /\ phase = "RECOVERY_PENDING"
    /\ lookupResult = "ABSENT_AUTHORITATIVE"
    /\ lookupEpoch = storeEpoch
    /\ commitRecord = NoCommit
    /\ intentState = "ABORTED"
    /\ durableOutcome = "ABORTED"
    /\ commitObservation' = "ACKNOWLEDGED_ABORTED"
    /\ phase' = "ABORTED"
    /\ UNCHANGED <<requestedTenant, resolvedTenant, snapshotPresent,
       snapshotTenant, currentPolicy, snapshotPolicy, currentTrustEpoch,
       snapshotTrustEpoch, operationFingerprint, snapshotFingerprint,
       graphComplete, evidenceValid, oracleResult, gateResult,
       authorizationIssued, authorizationConsumed, authorizationExpiry,
       currentTime, attemptState, reservedAttempt, intentState, durableOutcome,
       commitRecord, storeEpoch, lookupResult, lookupEpoch>>

TamperRequestedTenant(t) ==
    /\ t \in Tenants
    /\ phase \in {"PREPARED", "EVALUATED", "AUTHORIZED", "COMMIT_PENDING"}
    /\ requestedTenant' = t
    /\ UNCHANGED <<phase, resolvedTenant, snapshotPresent, snapshotTenant,
       currentPolicy, snapshotPolicy, currentTrustEpoch, snapshotTrustEpoch,
       operationFingerprint, snapshotFingerprint, graphComplete, evidenceValid,
       oracleResult, gateResult, authorizationIssued, authorizationConsumed,
       authorizationExpiry, currentTime, attemptState, reservedAttempt,
       intentState, durableOutcome, commitRecord, storeEpoch, lookupResult,
       lookupEpoch, commitObservation>>

ChangePolicy ==
    /\ phase \in {"PREPARED", "EVALUATED", "AUTHORIZED", "COMMIT_PENDING"}
    /\ \E p \in Policies : p # currentPolicy
    /\ currentPolicy' \in Policies \ {currentPolicy}
    /\ UNCHANGED <<phase, requestedTenant, resolvedTenant, snapshotPresent,
       snapshotTenant, snapshotPolicy, currentTrustEpoch, snapshotTrustEpoch,
       operationFingerprint, snapshotFingerprint, graphComplete, evidenceValid,
       oracleResult, gateResult, authorizationIssued, authorizationConsumed,
       authorizationExpiry, currentTime, attemptState, reservedAttempt,
       intentState, durableOutcome, commitRecord, storeEpoch, lookupResult,
       lookupEpoch, commitObservation>>

RevokeTrust ==
    /\ phase \in {"PREPARED", "EVALUATED", "AUTHORIZED", "COMMIT_PENDING"}
    /\ \E e \in TrustEpochs : e # currentTrustEpoch
    /\ currentTrustEpoch' \in TrustEpochs \ {currentTrustEpoch}
    /\ UNCHANGED <<phase, requestedTenant, resolvedTenant, snapshotPresent,
       snapshotTenant, currentPolicy, snapshotPolicy, snapshotTrustEpoch,
       operationFingerprint, snapshotFingerprint, graphComplete, evidenceValid,
       oracleResult, gateResult, authorizationIssued, authorizationConsumed,
       authorizationExpiry, currentTime, attemptState, reservedAttempt,
       intentState, durableOutcome, commitRecord, storeEpoch, lookupResult,
       lookupEpoch, commitObservation>>

RevokeEvidence ==
    /\ phase \in {"PREPARED", "EVALUATED", "AUTHORIZED", "COMMIT_PENDING"}
    /\ evidenceValid
    /\ evidenceValid' = FALSE
    /\ UNCHANGED <<phase, requestedTenant, resolvedTenant, snapshotPresent,
       snapshotTenant, currentPolicy, snapshotPolicy, currentTrustEpoch,
       snapshotTrustEpoch, operationFingerprint, snapshotFingerprint,
       graphComplete, oracleResult, gateResult, authorizationIssued,
       authorizationConsumed, authorizationExpiry, currentTime, attemptState,
       reservedAttempt, intentState, durableOutcome, commitRecord, storeEpoch,
       lookupResult, lookupEpoch, commitObservation>>

MarkGraphIncomplete ==
    /\ phase \in {"PREPARED", "EVALUATED", "AUTHORIZED", "COMMIT_PENDING"}
    /\ graphComplete
    /\ graphComplete' = FALSE
    /\ UNCHANGED <<phase, requestedTenant, resolvedTenant, snapshotPresent,
       snapshotTenant, currentPolicy, snapshotPolicy, currentTrustEpoch,
       snapshotTrustEpoch, operationFingerprint, snapshotFingerprint,
       evidenceValid, oracleResult, gateResult, authorizationIssued,
       authorizationConsumed, authorizationExpiry, currentTime, attemptState,
       reservedAttempt, intentState, durableOutcome, commitRecord, storeEpoch,
       lookupResult, lookupEpoch, commitObservation>>

AdvanceTime ==
    /\ currentTime < MaxTime
    /\ currentTime' = currentTime + 1
    /\ UNCHANGED <<phase, requestedTenant, resolvedTenant, snapshotPresent,
       snapshotTenant, currentPolicy, snapshotPolicy, currentTrustEpoch,
       snapshotTrustEpoch, operationFingerprint, snapshotFingerprint,
       graphComplete, evidenceValid, oracleResult, gateResult,
       authorizationIssued, authorizationConsumed, authorizationExpiry,
       attemptState, reservedAttempt, intentState, durableOutcome, commitRecord,
       storeEpoch, lookupResult, lookupEpoch, commitObservation>>

Next ==
    \/ ResolveAndPrepare
    \/ Evaluate
    \/ Authorize
    \/ \E a \in Attempts : StartAttempt(a)
    \/ \E a \in Attempts : ReserveIntent(a)
    \/ CommitAndLoseAck
    \/ AbortAndLoseAck
    \/ AuthoritativeLookup
    \/ StaleReplicaLookup
    \/ ReconcileCommitted
    \/ ReconcileAbsent
    \/ \E t \in Tenants : TamperRequestedTenant(t)
    \/ ChangePolicy
    \/ RevokeTrust
    \/ RevokeEvidence
    \/ MarkGraphIncomplete
    \/ AdvanceTime

Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ phase \in Phases
    /\ requestedTenant \in Tenants
    /\ resolvedTenant \in Tenants
    /\ snapshotPresent \in BOOLEAN
    /\ snapshotTenant \in Tenants
    /\ currentPolicy \in Policies
    /\ snapshotPolicy \in Policies
    /\ currentTrustEpoch \in TrustEpochs
    /\ snapshotTrustEpoch \in TrustEpochs
    /\ operationFingerprint \in Fingerprints
    /\ snapshotFingerprint \in Fingerprints
    /\ graphComplete \in BOOLEAN
    /\ evidenceValid \in BOOLEAN
    /\ oracleResult \in OracleStates
    /\ gateResult \in GateStates
    /\ authorizationIssued \in BOOLEAN
    /\ authorizationConsumed \in BOOLEAN
    /\ authorizationExpiry \in 0..MaxTime
    /\ currentTime \in 0..MaxTime
    /\ attemptState \in [Attempts -> AttemptStates]
    /\ reservedAttempt \in Attempts
    /\ intentState \in IntentStates
    /\ durableOutcome \in DurableOutcomes
    /\ commitRecord \in ({NoCommit} \cup CommitRecordType)
    /\ storeEpoch \in 0..2
    /\ lookupResult \in LookupStates
    /\ lookupEpoch \in 0..2
    /\ commitObservation \in {"ACKNOWLEDGED_COMMITTED", "ACKNOWLEDGED_ABORTED", "UNKNOWN"}

CommitRecordMatchesSnapshot ==
    commitRecord # NoCommit =>
      /\ commitRecord.tenant = snapshotTenant
      /\ commitRecord.policy = snapshotPolicy
      /\ commitRecord.trustEpoch = snapshotTrustEpoch
      /\ commitRecord.fingerprint = snapshotFingerprint

CommitRecordMatchesIntent ==
    commitRecord # NoCommit =>
      /\ intentState = "COMMITTED"
      /\ commitRecord.attempt = reservedAttempt

NoFalseAuthoritativeAbsence ==
    lookupResult = "ABSENT_AUTHORITATIVE" =>
      /\ lookupEpoch = storeEpoch
      /\ intentState = "ABORTED"
      /\ commitRecord = NoCommit
      /\ durableOutcome = "ABORTED"

NoStaleReplicaFinalization ==
    lookupResult = "STALE_ABSENT" => phase = "RECOVERY_PENDING"

NoCommitWithoutAuthorization ==
    commitRecord # NoCommit =>
      /\ authorizationIssued
      /\ authorizationConsumed
      /\ intentState = "COMMITTED"

NoAcknowledgedCommitWithoutRecord ==
    commitObservation = "ACKNOWLEDGED_COMMITTED" =>
      /\ commitRecord # NoCommit
      /\ durableOutcome = "COMMITTED"

NoAcknowledgedAbortWithoutProof ==
    commitObservation = "ACKNOWLEDGED_ABORTED" =>
      /\ lookupResult = "ABSENT_AUTHORITATIVE"
      /\ lookupEpoch = storeEpoch

SingleWinner ==
    Cardinality({a \in Attempts : attemptState[a] = "WON"}) <= 1

WinnerMatchesRecord ==
    commitRecord # NoCommit =>
      /\ attemptState[commitRecord.attempt] = "WON"
      /\ reservedAttempt = commitRecord.attempt

Safety ==
    /\ TypeOK
    /\ CommitRecordMatchesSnapshot
    /\ CommitRecordMatchesIntent
    /\ NoFalseAuthoritativeAbsence
    /\ NoStaleReplicaFinalization
    /\ NoCommitWithoutAuthorization
    /\ NoAcknowledgedCommitWithoutRecord
    /\ NoAcknowledgedAbortWithoutProof
    /\ SingleWinner
    /\ WinnerMatchesRecord

=============================================================================
