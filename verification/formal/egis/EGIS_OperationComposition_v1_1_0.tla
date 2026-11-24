---------------- MODULE EGIS_OperationComposition_v1_1_0 ----------------
EXTENDS Naturals, FiniteSets, EGIS_CanonicalTypes_v1_1_0

Phases ==
    {"UNREGISTERED", "PREPARED", "EVALUATED", "AUTHORIZED",
     "COMMIT_PENDING", "COMMITTED", "RECOVERY_PENDING", "ABORTED"}

AttemptStates == {"NEW", "PENDING", "WON", "REJECTED", "CANCELLED"}
IntentStates == {"NONE", "RESERVED", "COMMITTED", "ABORTED"}
DurableOutcomes == {"UNKNOWN", "COMMITTED", "ABORTED"}
LookupStates ==
    {"NOT_QUERIED", "FOUND_VALID", "ABSENT_AUTHORITATIVE",
     "STALE_ABSENT", "UNKNOWN"}
GateStates == {"UNKNOWN", "PASS", "FAIL"}
RequestResults == {"NONE", "ACCEPTED", "REPLAY", "CONFLICT", "SCOPE_REJECTED"}
ObservationStates ==
    {"UNKNOWN", "ACKNOWLEDGED_COMMITTED", "ACKNOWLEDGED_ABORTED"}

VARIABLES
    registry, phase, requestResult, snapshotPresent,
    currentPolicy, snapshotPolicy, currentTrust, snapshotTrust,
    graphComplete, evidenceValid, oraclePass, gateResult,
    membershipActive, authorizationIssued, authorizationConsumed,
    authorizationExpiry, currentTime, attemptState, reservedAttempt,
    intentState, durableOutcome, commitRecord, storeEpoch,
    lookupResult, lookupEpoch, commitObservation

vars ==
    <<registry, phase, requestResult, snapshotPresent,
      currentPolicy, snapshotPolicy, currentTrust, snapshotTrust,
      graphComplete, evidenceValid, oraclePass, gateResult,
      membershipActive, authorizationIssued, authorizationConsumed,
      authorizationExpiry, currentTime, attemptState, reservedAttempt,
      intentState, durableOutcome, commitRecord, storeEpoch,
      lookupResult, lookupEpoch, commitObservation>>

ScopeMatchesKey(k, s) ==
    /\ s.tenant = k.tenant
    /\ s.project = k.project
    /\ MembershipOf(s) \in ActiveMemberships
    /\ CapabilityOf(s) \in ActiveCapabilityGrants

ScopeIsCurrent(k) ==
    IF registry[k] = NoOperation THEN FALSE
    ELSE /\ ScopeMatchesKey(k, registry[k].scope)
         /\ membershipActive[MembershipOf(registry[k].scope)]

Init ==
    /\ registry = [k \in OperationKeys |-> NoOperation]
    /\ phase = [k \in OperationKeys |-> "UNREGISTERED"]
    /\ requestResult = [k \in OperationKeys |-> "NONE"]
    /\ snapshotPresent = [k \in OperationKeys |-> FALSE]
    /\ currentPolicy \in [OperationKeys -> Policies]
    /\ snapshotPolicy \in [OperationKeys -> Policies]
    /\ currentTrust \in [OperationKeys -> TrustEpochs]
    /\ snapshotTrust \in [OperationKeys -> TrustEpochs]
    /\ graphComplete = [k \in OperationKeys |-> TRUE]
    /\ evidenceValid = [k \in OperationKeys |-> TRUE]
    /\ oraclePass = [k \in OperationKeys |-> TRUE]
    /\ gateResult = [k \in OperationKeys |-> "UNKNOWN"]
    /\ membershipActive = [m \in MembershipType |-> m \in ActiveMemberships]
    /\ authorizationIssued = [k \in OperationKeys |-> FALSE]
    /\ authorizationConsumed = [k \in OperationKeys |-> FALSE]
    /\ authorizationExpiry = [k \in OperationKeys |-> 0]
    /\ currentTime = 0
    /\ attemptState = [k \in OperationKeys |-> [a \in Attempts |-> "NEW"]]
    /\ reservedAttempt = [k \in OperationKeys |-> NoAttempt]
    /\ intentState = [k \in OperationKeys |-> "NONE"]
    /\ durableOutcome = [k \in OperationKeys |-> "UNKNOWN"]
    /\ commitRecord = [k \in OperationKeys |-> NoCommit]
    /\ storeEpoch = [k \in OperationKeys |-> 0]
    /\ lookupResult = [k \in OperationKeys |-> "NOT_QUERIED"]
    /\ lookupEpoch = [k \in OperationKeys |-> 0]
    /\ commitObservation = [k \in OperationKeys |-> "UNKNOWN"]

Register(k, fp, s) ==
    /\ k \in OperationKeys
    /\ fp \in Fingerprints
    /\ s \in ScopeType
    /\ IF registry[k] = NoOperation
          THEN IF ScopeMatchesKey(k, s) /\ membershipActive[MembershipOf(s)]
                  THEN
                    /\ registry' =
                         [registry EXCEPT ![k] = [fingerprint |-> fp, scope |-> s]]
                    /\ phase' = [phase EXCEPT ![k] = "PREPARED"]
                    /\ requestResult' = [requestResult EXCEPT ![k] = "ACCEPTED"]
                    /\ snapshotPresent' = [snapshotPresent EXCEPT ![k] = TRUE]
                    /\ snapshotPolicy' = [snapshotPolicy EXCEPT ![k] = currentPolicy[k]]
                    /\ snapshotTrust' = [snapshotTrust EXCEPT ![k] = currentTrust[k]]
                    /\ UNCHANGED <<currentPolicy, currentTrust, graphComplete,
                         evidenceValid, oraclePass, gateResult, membershipActive,
                         authorizationIssued, authorizationConsumed,
                         authorizationExpiry, currentTime, attemptState,
                         reservedAttempt, intentState, durableOutcome, commitRecord,
                         storeEpoch, lookupResult, lookupEpoch, commitObservation>>
                  ELSE
                    /\ requestResult' = [requestResult EXCEPT ![k] = "SCOPE_REJECTED"]
                    /\ UNCHANGED <<registry, phase, snapshotPresent, currentPolicy,
                         snapshotPolicy, currentTrust, snapshotTrust, graphComplete,
                         evidenceValid, oraclePass, gateResult, membershipActive,
                         authorizationIssued, authorizationConsumed,
                         authorizationExpiry, currentTime, attemptState,
                         reservedAttempt, intentState, durableOutcome, commitRecord,
                         storeEpoch, lookupResult, lookupEpoch, commitObservation>>
          ELSE IF registry[k].fingerprint = fp /\ registry[k].scope = s
                  THEN
                    /\ requestResult' = [requestResult EXCEPT ![k] = "REPLAY"]
                    /\ UNCHANGED <<registry, phase, snapshotPresent, currentPolicy,
                         snapshotPolicy, currentTrust, snapshotTrust, graphComplete,
                         evidenceValid, oraclePass, gateResult, membershipActive,
                         authorizationIssued, authorizationConsumed,
                         authorizationExpiry, currentTime, attemptState,
                         reservedAttempt, intentState, durableOutcome, commitRecord,
                         storeEpoch, lookupResult, lookupEpoch, commitObservation>>
                  ELSE
                    /\ requestResult' = [requestResult EXCEPT ![k] = "CONFLICT"]
                    /\ UNCHANGED <<registry, phase, snapshotPresent, currentPolicy,
                         snapshotPolicy, currentTrust, snapshotTrust, graphComplete,
                         evidenceValid, oraclePass, gateResult, membershipActive,
                         authorizationIssued, authorizationConsumed,
                         authorizationExpiry, currentTime, attemptState,
                         reservedAttempt, intentState, durableOutcome, commitRecord,
                         storeEpoch, lookupResult, lookupEpoch, commitObservation>>

Evaluate(k) ==
    /\ k \in OperationKeys
    /\ phase[k] = "PREPARED"
    /\ gateResult[k] = "UNKNOWN"
    /\ gateResult' =
         [gateResult EXCEPT ![k] =
             IF ~graphComplete[k] THEN "UNKNOWN"
             ELSE IF ~evidenceValid[k] THEN "FAIL"
             ELSE IF oraclePass[k] THEN "PASS"
             ELSE "FAIL"]
    /\ phase' = [phase EXCEPT ![k] = "EVALUATED"]
    /\ UNCHANGED <<registry, requestResult, snapshotPresent, currentPolicy,
         snapshotPolicy, currentTrust, snapshotTrust, graphComplete, evidenceValid,
         oraclePass, membershipActive, authorizationIssued, authorizationConsumed,
         authorizationExpiry, currentTime, attemptState, reservedAttempt,
         intentState, durableOutcome, commitRecord, storeEpoch, lookupResult,
         lookupEpoch, commitObservation>>

Authorize(k) ==
    /\ k \in OperationKeys
    /\ phase[k] = "EVALUATED"
    /\ snapshotPresent[k]
    /\ ScopeIsCurrent(k)
    /\ snapshotPolicy[k] = currentPolicy[k]
    /\ snapshotTrust[k] = currentTrust[k]
    /\ graphComplete[k]
    /\ evidenceValid[k]
    /\ oraclePass[k]
    /\ gateResult[k] = "PASS"
    /\ ~authorizationIssued[k]
    /\ currentTime < MaxTime
    /\ authorizationIssued' = [authorizationIssued EXCEPT ![k] = TRUE]
    /\ authorizationExpiry' = [authorizationExpiry EXCEPT ![k] = MaxTime]
    /\ phase' = [phase EXCEPT ![k] = "AUTHORIZED"]
    /\ UNCHANGED <<registry, requestResult, snapshotPresent, currentPolicy,
         snapshotPolicy, currentTrust, snapshotTrust, graphComplete, evidenceValid,
         oraclePass, gateResult, membershipActive, authorizationConsumed,
         currentTime, attemptState, reservedAttempt, intentState, durableOutcome,
         commitRecord, storeEpoch, lookupResult, lookupEpoch, commitObservation>>

StartAttempt(k, a) ==
    /\ k \in OperationKeys
    /\ a \in Attempts
    /\ phase[k] \in {"AUTHORIZED", "COMMIT_PENDING"}
    /\ authorizationIssued[k]
    /\ ~authorizationConsumed[k]
    /\ intentState[k] = "NONE"
    /\ attemptState[k][a] = "NEW"
    /\ attemptState' =
         [attemptState EXCEPT ![k] = [@ EXCEPT ![a] = "PENDING"]]
    /\ phase' = [phase EXCEPT ![k] = "COMMIT_PENDING"]
    /\ UNCHANGED <<registry, requestResult, snapshotPresent, currentPolicy,
         snapshotPolicy, currentTrust, snapshotTrust, graphComplete, evidenceValid,
         oraclePass, gateResult, membershipActive, authorizationIssued,
         authorizationConsumed, authorizationExpiry, currentTime, reservedAttempt,
         intentState, durableOutcome, commitRecord, storeEpoch, lookupResult,
         lookupEpoch, commitObservation>>

ReserveIntent(k, a) ==
    /\ k \in OperationKeys
    /\ a \in Attempts
    /\ phase[k] = "COMMIT_PENDING"
    /\ attemptState[k][a] = "PENDING"
    /\ intentState[k] = "NONE"
    /\ ~authorizationConsumed[k]
    /\ reservedAttempt' = [reservedAttempt EXCEPT ![k] = a]
    /\ intentState' = [intentState EXCEPT ![k] = "RESERVED"]
    /\ UNCHANGED <<registry, phase, requestResult, snapshotPresent, currentPolicy,
         snapshotPolicy, currentTrust, snapshotTrust, graphComplete, evidenceValid,
         oraclePass, gateResult, membershipActive, authorizationIssued,
         authorizationConsumed, authorizationExpiry, currentTime, attemptState,
         durableOutcome, commitRecord, storeEpoch, lookupResult, lookupEpoch,
         commitObservation>>

CommitBindingsValid(k) ==
    /\ snapshotPresent[k]
    /\ ScopeIsCurrent(k)
    /\ snapshotPolicy[k] = currentPolicy[k]
    /\ snapshotTrust[k] = currentTrust[k]
    /\ graphComplete[k]
    /\ evidenceValid[k]
    /\ oraclePass[k]
    /\ gateResult[k] = "PASS"
    /\ currentTime < authorizationExpiry[k]

CommitAndLoseAck(k) ==
    /\ k \in OperationKeys
    /\ phase[k] = "COMMIT_PENDING"
    /\ intentState[k] = "RESERVED"
    /\ reservedAttempt[k] \in Attempts
    /\ attemptState[k][reservedAttempt[k]] = "PENDING"
    /\ authorizationIssued[k]
    /\ ~authorizationConsumed[k]
    /\ commitRecord[k] = NoCommit
    /\ storeEpoch[k] < MaxStoreEpoch
    /\ CommitBindingsValid(k)
    /\ authorizationConsumed' = [authorizationConsumed EXCEPT ![k] = TRUE]
    /\ intentState' = [intentState EXCEPT ![k] = "COMMITTED"]
    /\ durableOutcome' = [durableOutcome EXCEPT ![k] = "COMMITTED"]
    /\ commitRecord' =
         [commitRecord EXCEPT ![k] =
             [operationKey |-> k,
              fingerprint |-> registry[k].fingerprint,
              scope |-> registry[k].scope,
              attempt |-> reservedAttempt[k],
              policy |-> snapshotPolicy[k],
              trustEpoch |-> snapshotTrust[k]]]
    /\ attemptState' =
         [attemptState EXCEPT ![k] =
             [a \in Attempts |->
                 IF a = reservedAttempt[k] THEN "WON"
                 ELSE IF attemptState[k][a] = "PENDING" THEN "REJECTED"
                 ELSE attemptState[k][a]]]
    /\ storeEpoch' = [storeEpoch EXCEPT ![k] = @ + 1]
    /\ lookupResult' = [lookupResult EXCEPT ![k] = "UNKNOWN"]
    /\ lookupEpoch' = [lookupEpoch EXCEPT ![k] = storeEpoch[k]]
    /\ commitObservation' = [commitObservation EXCEPT ![k] = "UNKNOWN"]
    /\ phase' = [phase EXCEPT ![k] = "RECOVERY_PENDING"]
    /\ UNCHANGED <<registry, requestResult, snapshotPresent, currentPolicy,
         snapshotPolicy, currentTrust, snapshotTrust, graphComplete, evidenceValid,
         oraclePass, gateResult, membershipActive, authorizationIssued,
         authorizationExpiry, currentTime, reservedAttempt>>

AbortAndLoseAck(k) ==
    /\ k \in OperationKeys
    /\ phase[k] = "COMMIT_PENDING"
    /\ intentState[k] = "RESERVED"
    /\ reservedAttempt[k] \in Attempts
    /\ attemptState[k][reservedAttempt[k]] = "PENDING"
    /\ commitRecord[k] = NoCommit
    /\ storeEpoch[k] < MaxStoreEpoch
    /\ authorizationConsumed' = [authorizationConsumed EXCEPT ![k] = TRUE]
    /\ intentState' = [intentState EXCEPT ![k] = "ABORTED"]
    /\ durableOutcome' = [durableOutcome EXCEPT ![k] = "ABORTED"]
    /\ attemptState' =
         [attemptState EXCEPT ![k] =
             [a \in Attempts |->
                 IF attemptState[k][a] = "PENDING" THEN "CANCELLED"
                 ELSE attemptState[k][a]]]
    /\ storeEpoch' = [storeEpoch EXCEPT ![k] = @ + 1]
    /\ lookupResult' = [lookupResult EXCEPT ![k] = "UNKNOWN"]
    /\ lookupEpoch' = [lookupEpoch EXCEPT ![k] = storeEpoch[k]]
    /\ commitObservation' = [commitObservation EXCEPT ![k] = "UNKNOWN"]
    /\ phase' = [phase EXCEPT ![k] = "RECOVERY_PENDING"]
    /\ UNCHANGED <<registry, requestResult, snapshotPresent, currentPolicy,
         snapshotPolicy, currentTrust, snapshotTrust, graphComplete, evidenceValid,
         oraclePass, gateResult, membershipActive, authorizationIssued,
         authorizationExpiry, currentTime, reservedAttempt, commitRecord>>

AuthoritativeLookup(k) ==
    /\ k \in OperationKeys
    /\ phase[k] = "RECOVERY_PENDING"
    /\ lookupResult[k] \in {"UNKNOWN", "NOT_QUERIED", "STALE_ABSENT"}
    /\ lookupEpoch' = [lookupEpoch EXCEPT ![k] = storeEpoch[k]]
    /\ lookupResult' =
         [lookupResult EXCEPT ![k] =
             IF commitRecord[k] # NoCommit THEN "FOUND_VALID"
             ELSE IF intentState[k] = "ABORTED" THEN "ABSENT_AUTHORITATIVE"
             ELSE "UNKNOWN"]
    /\ UNCHANGED <<registry, phase, requestResult, snapshotPresent,
         currentPolicy, snapshotPolicy, currentTrust, snapshotTrust, graphComplete,
         evidenceValid, oraclePass, gateResult, membershipActive,
         authorizationIssued, authorizationConsumed, authorizationExpiry,
         currentTime, attemptState, reservedAttempt, intentState, durableOutcome,
         commitRecord, storeEpoch, commitObservation>>

StaleReplicaLookup(k) ==
    /\ k \in OperationKeys
    /\ phase[k] = "RECOVERY_PENDING"
    /\ lookupResult[k] \in {"UNKNOWN", "NOT_QUERIED"}
    /\ lookupResult' = [lookupResult EXCEPT ![k] = "STALE_ABSENT"]
    /\ lookupEpoch' =
         [lookupEpoch EXCEPT ![k] = IF storeEpoch[k] > 0 THEN storeEpoch[k] - 1 ELSE 0]
    /\ UNCHANGED <<registry, phase, requestResult, snapshotPresent,
         currentPolicy, snapshotPolicy, currentTrust, snapshotTrust, graphComplete,
         evidenceValid, oraclePass, gateResult, membershipActive,
         authorizationIssued, authorizationConsumed, authorizationExpiry,
         currentTime, attemptState, reservedAttempt, intentState, durableOutcome,
         commitRecord, storeEpoch, commitObservation>>

ReconcileCommitted(k) ==
    /\ k \in OperationKeys
    /\ IF commitRecord[k] = NoCommit THEN FALSE
          ELSE
            IF registry[k] = NoOperation THEN FALSE
            ELSE
              /\ phase[k] = "RECOVERY_PENDING"
              /\ lookupResult[k] = "FOUND_VALID"
              /\ lookupEpoch[k] = storeEpoch[k]
              /\ commitRecord[k].operationKey = k
              /\ commitRecord[k].fingerprint = registry[k].fingerprint
              /\ commitRecord[k].scope = registry[k].scope
              /\ commitRecord[k].attempt = reservedAttempt[k]
              /\ durableOutcome[k] = "COMMITTED"
              /\ commitObservation' = [commitObservation EXCEPT ![k] = "ACKNOWLEDGED_COMMITTED"]
              /\ phase' = [phase EXCEPT ![k] = "COMMITTED"]
              /\ UNCHANGED <<registry, requestResult, snapshotPresent, currentPolicy,
                   snapshotPolicy, currentTrust, snapshotTrust, graphComplete, evidenceValid,
                   oraclePass, gateResult, membershipActive, authorizationIssued,
                   authorizationConsumed, authorizationExpiry, currentTime, attemptState,
                   reservedAttempt, intentState, durableOutcome, commitRecord, storeEpoch,
                   lookupResult, lookupEpoch>>

ReconcileAbsent(k) ==
    /\ k \in OperationKeys
    /\ phase[k] = "RECOVERY_PENDING"
    /\ lookupResult[k] = "ABSENT_AUTHORITATIVE"
    /\ lookupEpoch[k] = storeEpoch[k]
    /\ commitRecord[k] = NoCommit
    /\ intentState[k] = "ABORTED"
    /\ durableOutcome[k] = "ABORTED"
    /\ commitObservation' = [commitObservation EXCEPT ![k] = "ACKNOWLEDGED_ABORTED"]
    /\ phase' = [phase EXCEPT ![k] = "ABORTED"]
    /\ UNCHANGED <<registry, requestResult, snapshotPresent, currentPolicy,
         snapshotPolicy, currentTrust, snapshotTrust, graphComplete, evidenceValid,
         oraclePass, gateResult, membershipActive, authorizationIssued,
         authorizationConsumed, authorizationExpiry, currentTime, attemptState,
         reservedAttempt, intentState, durableOutcome, commitRecord, storeEpoch,
         lookupResult, lookupEpoch>>

ChangePolicy(k, p) ==
    /\ k \in OperationKeys
    /\ p \in Policies
    /\ p # currentPolicy[k]
    /\ phase[k] \in {"PREPARED", "EVALUATED", "AUTHORIZED", "COMMIT_PENDING"}
    /\ currentPolicy' = [currentPolicy EXCEPT ![k] = p]
    /\ UNCHANGED <<registry, phase, requestResult, snapshotPresent,
         snapshotPolicy, currentTrust, snapshotTrust, graphComplete, evidenceValid,
         oraclePass, gateResult, membershipActive, authorizationIssued,
         authorizationConsumed, authorizationExpiry, currentTime, attemptState,
         reservedAttempt, intentState, durableOutcome, commitRecord, storeEpoch,
         lookupResult, lookupEpoch, commitObservation>>

ChangeTrust(k, e) ==
    /\ k \in OperationKeys
    /\ e \in TrustEpochs
    /\ e # currentTrust[k]
    /\ phase[k] \in {"PREPARED", "EVALUATED", "AUTHORIZED", "COMMIT_PENDING"}
    /\ currentTrust' = [currentTrust EXCEPT ![k] = e]
    /\ UNCHANGED <<registry, phase, requestResult, snapshotPresent,
         currentPolicy, snapshotPolicy, snapshotTrust, graphComplete, evidenceValid,
         oraclePass, gateResult, membershipActive, authorizationIssued,
         authorizationConsumed, authorizationExpiry, currentTime, attemptState,
         reservedAttempt, intentState, durableOutcome, commitRecord, storeEpoch,
         lookupResult, lookupEpoch, commitObservation>>

RevokeEvidence(k) ==
    /\ k \in OperationKeys
    /\ evidenceValid[k]
    /\ phase[k] \in {"PREPARED", "EVALUATED", "AUTHORIZED", "COMMIT_PENDING"}
    /\ evidenceValid' = [evidenceValid EXCEPT ![k] = FALSE]
    /\ UNCHANGED <<registry, phase, requestResult, snapshotPresent,
         currentPolicy, snapshotPolicy, currentTrust, snapshotTrust, graphComplete,
         oraclePass, gateResult, membershipActive, authorizationIssued,
         authorizationConsumed, authorizationExpiry, currentTime, attemptState,
         reservedAttempt, intentState, durableOutcome, commitRecord, storeEpoch,
         lookupResult, lookupEpoch, commitObservation>>

MarkGraphIncomplete(k) ==
    /\ k \in OperationKeys
    /\ graphComplete[k]
    /\ phase[k] \in {"PREPARED", "EVALUATED", "AUTHORIZED", "COMMIT_PENDING"}
    /\ graphComplete' = [graphComplete EXCEPT ![k] = FALSE]
    /\ UNCHANGED <<registry, phase, requestResult, snapshotPresent,
         currentPolicy, snapshotPolicy, currentTrust, snapshotTrust, evidenceValid,
         oraclePass, gateResult, membershipActive, authorizationIssued,
         authorizationConsumed, authorizationExpiry, currentTime, attemptState,
         reservedAttempt, intentState, durableOutcome, commitRecord, storeEpoch,
         lookupResult, lookupEpoch, commitObservation>>

RevokeMembership(k) ==
    /\ k \in OperationKeys
    /\ IF registry[k] = NoOperation THEN FALSE
          ELSE /\ membershipActive[MembershipOf(registry[k].scope)]
               /\ phase[k] \in {"PREPARED", "EVALUATED", "AUTHORIZED", "COMMIT_PENDING"}
               /\ membershipActive' = [membershipActive EXCEPT ![MembershipOf(registry[k].scope)] = FALSE]
               /\ UNCHANGED <<registry, phase, requestResult, snapshotPresent,
                    currentPolicy, snapshotPolicy, currentTrust, snapshotTrust, graphComplete,
                    evidenceValid, oraclePass, gateResult, authorizationIssued,
                    authorizationConsumed, authorizationExpiry, currentTime, attemptState,
                    reservedAttempt, intentState, durableOutcome, commitRecord, storeEpoch,
                    lookupResult, lookupEpoch, commitObservation>>

AdvanceTime ==
    /\ currentTime < MaxTime
    /\ currentTime' = currentTime + 1
    /\ UNCHANGED <<registry, phase, requestResult, snapshotPresent,
         currentPolicy, snapshotPolicy, currentTrust, snapshotTrust, graphComplete,
         evidenceValid, oraclePass, gateResult, membershipActive,
         authorizationIssued, authorizationConsumed, authorizationExpiry,
         attemptState, reservedAttempt, intentState, durableOutcome, commitRecord,
         storeEpoch, lookupResult, lookupEpoch, commitObservation>>

Next ==
    \/ \E k \in OperationKeys, fp \in Fingerprints, s \in ScopeType : Register(k, fp, s)
    \/ \E k \in OperationKeys : Evaluate(k)
    \/ \E k \in OperationKeys : Authorize(k)
    \/ \E k \in OperationKeys, a \in Attempts : StartAttempt(k, a)
    \/ \E k \in OperationKeys, a \in Attempts : ReserveIntent(k, a)
    \/ \E k \in OperationKeys : CommitAndLoseAck(k)
    \/ \E k \in OperationKeys : AbortAndLoseAck(k)
    \/ \E k \in OperationKeys : AuthoritativeLookup(k)
    \/ \E k \in OperationKeys : StaleReplicaLookup(k)
    \/ \E k \in OperationKeys : ReconcileCommitted(k)
    \/ \E k \in OperationKeys : ReconcileAbsent(k)
    \/ \E k \in OperationKeys, p \in Policies : ChangePolicy(k, p)
    \/ \E k \in OperationKeys, e \in TrustEpochs : ChangeTrust(k, e)
    \/ \E k \in OperationKeys : RevokeEvidence(k)
    \/ \E k \in OperationKeys : MarkGraphIncomplete(k)
    \/ \E k \in OperationKeys : RevokeMembership(k)
    \/ AdvanceTime

Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ registry \in [OperationKeys -> ({NoOperation} \cup OperationEntryType)]
    /\ phase \in [OperationKeys -> Phases]
    /\ requestResult \in [OperationKeys -> RequestResults]
    /\ snapshotPresent \in [OperationKeys -> BOOLEAN]
    /\ currentPolicy \in [OperationKeys -> Policies]
    /\ snapshotPolicy \in [OperationKeys -> Policies]
    /\ currentTrust \in [OperationKeys -> TrustEpochs]
    /\ snapshotTrust \in [OperationKeys -> TrustEpochs]
    /\ graphComplete \in [OperationKeys -> BOOLEAN]
    /\ evidenceValid \in [OperationKeys -> BOOLEAN]
    /\ oraclePass \in [OperationKeys -> BOOLEAN]
    /\ gateResult \in [OperationKeys -> GateStates]
    /\ membershipActive \in [MembershipType -> BOOLEAN]
    /\ authorizationIssued \in [OperationKeys -> BOOLEAN]
    /\ authorizationConsumed \in [OperationKeys -> BOOLEAN]
    /\ authorizationExpiry \in [OperationKeys -> 0..MaxTime]
    /\ currentTime \in 0..MaxTime
    /\ attemptState \in [OperationKeys -> [Attempts -> AttemptStates]]
    /\ reservedAttempt \in [OperationKeys -> (Attempts \cup {NoAttempt})]
    /\ intentState \in [OperationKeys -> IntentStates]
    /\ durableOutcome \in [OperationKeys -> DurableOutcomes]
    /\ commitRecord \in [OperationKeys -> ({NoCommit} \cup CommitRecordType)]
    /\ storeEpoch \in [OperationKeys -> 0..MaxStoreEpoch]
    /\ lookupResult \in [OperationKeys -> LookupStates]
    /\ lookupEpoch \in [OperationKeys -> 0..MaxStoreEpoch]
    /\ commitObservation \in [OperationKeys -> ObservationStates]

CommitRecordMatchesEntry ==
    \A k \in OperationKeys :
      IF commitRecord[k] = NoCommit THEN TRUE
      ELSE IF registry[k] = NoOperation THEN FALSE
      ELSE
        /\ commitRecord[k].operationKey = k
        /\ commitRecord[k].fingerprint = registry[k].fingerprint
        /\ commitRecord[k].scope = registry[k].scope
        /\ commitRecord[k].attempt = reservedAttempt[k]
        /\ commitRecord[k].policy = snapshotPolicy[k]
        /\ commitRecord[k].trustEpoch = snapshotTrust[k]

NoCrossTenantProjectCommit ==
    \A k \in OperationKeys :
      IF commitRecord[k] = NoCommit THEN TRUE
      ELSE
        /\ commitRecord[k].scope.tenant = k.tenant
        /\ commitRecord[k].scope.project = k.project

NoFalseAuthoritativeAbsence ==
    \A k \in OperationKeys :
      lookupResult[k] = "ABSENT_AUTHORITATIVE" =>
        /\ lookupEpoch[k] = storeEpoch[k]
        /\ intentState[k] = "ABORTED"
        /\ commitRecord[k] = NoCommit
        /\ durableOutcome[k] = "ABORTED"

NoStaleReplicaFinalization ==
    \A k \in OperationKeys :
      lookupResult[k] = "STALE_ABSENT" => phase[k] = "RECOVERY_PENDING"

NoCommitWithoutAuthorization ==
    \A k \in OperationKeys :
      commitRecord[k] # NoCommit =>
        /\ authorizationIssued[k]
        /\ authorizationConsumed[k]
        /\ intentState[k] = "COMMITTED"

SingleWinnerPerOperationKey ==
    \A k \in OperationKeys :
      Cardinality({a \in Attempts : attemptState[k][a] = "WON"}) <= 1

WinnerMatchesCommitRecord ==
    \A k \in OperationKeys :
      IF commitRecord[k] = NoCommit THEN TRUE
      ELSE
        /\ attemptState[k][commitRecord[k].attempt] = "WON"
        /\ reservedAttempt[k] = commitRecord[k].attempt

NoAcknowledgedCommitWithoutRecord ==
    \A k \in OperationKeys :
      commitObservation[k] = "ACKNOWLEDGED_COMMITTED" =>
        /\ commitRecord[k] # NoCommit
        /\ durableOutcome[k] = "COMMITTED"

NoAcknowledgedAbortWithoutProof ==
    \A k \in OperationKeys :
      commitObservation[k] = "ACKNOWLEDGED_ABORTED" =>
        /\ lookupResult[k] = "ABSENT_AUTHORITATIVE"
        /\ lookupEpoch[k] = storeEpoch[k]

Safety ==
    /\ TypeOK
    /\ CommitRecordMatchesEntry
    /\ NoCrossTenantProjectCommit
    /\ NoFalseAuthoritativeAbsence
    /\ NoStaleReplicaFinalization
    /\ NoCommitWithoutAuthorization
    /\ SingleWinnerPerOperationKey
    /\ WinnerMatchesCommitRecord
    /\ NoAcknowledgedCommitWithoutRecord
    /\ NoAcknowledgedAbortWithoutProof

=============================================================================
