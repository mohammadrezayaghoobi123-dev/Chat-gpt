---------------- MODULE EGIS_CanonicalTypes_v1_1_0 ----------------
EXTENDS Naturals, FiniteSets

CONSTANTS
    Tenants, Projects, ChangeIds, Principals, MembershipRevisions, Capabilities,
    OperationIds, OperationKeys, Fingerprints, Attempts,
    Policies, TrustEpochs, ActiveMemberships, ActiveCapabilityGrants, MaxTime, MaxStoreEpoch

MembershipType ==
    [tenant : Tenants,
     project : Projects,
     principal : Principals,
     membershipRevision : MembershipRevisions]

CapabilityGrantType ==
    [tenant : Tenants,
     project : Projects,
     principal : Principals,
     capability : Capabilities]

ScopeType ==
    [tenant : Tenants,
     project : Projects,
     change : ChangeIds,
     principal : Principals,
     membershipRevision : MembershipRevisions,
     capability : Capabilities]

MembershipOf(s) ==
    [tenant |-> s.tenant, project |-> s.project,
     principal |-> s.principal, membershipRevision |-> s.membershipRevision]

CapabilityOf(s) ==
    [tenant |-> s.tenant, project |-> s.project,
     principal |-> s.principal, capability |-> s.capability]

OperationKeyType ==
    [tenant : Tenants,
     project : Projects,
     operation : OperationIds]

OperationEntryType ==
    [fingerprint : Fingerprints,
     scope : ScopeType]

CommitRecordType ==
    [operationKey : OperationKeyType,
     fingerprint : Fingerprints,
     scope : ScopeType,
     attempt : Attempts,
     policy : Policies,
     trustEpoch : TrustEpochs]

NoOperation == "NO_OPERATION"
NoCommit == "NO_COMMIT"
NoAttempt == "NO_ATTEMPT"

ASSUME
    /\ Tenants # {}
    /\ Projects # {}
    /\ ChangeIds # {}
    /\ Principals # {}
    /\ MembershipRevisions # {}
    /\ Capabilities # {}
    /\ OperationIds # {}
    /\ OperationKeys # {}
    /\ OperationKeys \subseteq OperationKeyType
    /\ Fingerprints # {}
    /\ Attempts # {}
    /\ Policies # {}
    /\ TrustEpochs # {}
    /\ ActiveMemberships \subseteq MembershipType
    /\ ActiveCapabilityGrants \subseteq CapabilityGrantType
    /\ MaxTime \in Nat
    /\ MaxTime >= 2
    /\ MaxStoreEpoch \in Nat
    /\ MaxStoreEpoch >= 2

=============================================================================
