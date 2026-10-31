# Master Brain Fault-Injection & Verification Harness — Final Design Specification

**Date:** 2026-10-05  
**Status:** DESIGN DRAFT — READY FOR REVIEW  
**Implementation:** Not started

## 1. Purpose
Define a safe, evidence-bound, reproducible harness for verifying Master Brain behavioral, safety, authority, state, recovery, evidence, and control-plane properties. The harness uses deterministic tests, controlled fault injection, state/sequence testing, interaction testing, mutation testing, metamorphic testing, crash/recovery experiments, and later controlled fuzzing.

## 2. Goals
- Detect violations of critical invariants.
- Demonstrate fail-closed behavior under critical uncertainty.
- Verify authority, policy, epoch, execution-gate and recovery controls.
- Verify state/event/replay/recovery integrity.
- Verify evidence/provenance integrity.
- Verify that the harness itself detects known-bad behavior.
- Produce reconstructable evidence.
- Preserve reproducibility and falsifiability.
- Prevent irreversible real-world side effects during critical testing.

## 3. Non-Goals
- Proving absence of every possible defect.
- Treating coverage as proof of correctness.
- Replacing production monitoring.
- Allowing unrestricted production execution.
- Treating model agreement as independent verification.
- Treating one successful run as empirical verification.

## 4. Verification Levels
V0 STATIC → contracts, schemas, invariants, configuration.  
V1 UNIT → isolated deterministic components.  
V2 INTEGRATION → component interaction.  
V3 FAILURE/FAULT INJECTION → deterministic injected failures.  
V4 ADVERSARIAL/CHAOS → controlled complex interactions.

Critical safety/authorization properties require the applicable level to pass with zero bypass.

## 5. Architecture Boundary
The SUT is the Master Brain target.

Harness components:
- Scenario Controller
- Fault Injector
- State/Sequence Controller
- Observer
- Execution Sink/Test Double
- Reference Model
- Independent Oracle
- Coverage/Adequacy Analyzer
- Verification Ledger
- Reproduction Controller
- Harness Self-Test Suite

The harness must not silently alter production infrastructure or authority.

## 6. Safety Boundary / Execution Sink
All Stage-1 critical tests route execution requests to an isolated Execution Sink/Test Double.

The sink must block or simulate irreversible external writes, financial transactions, sensitive outbound messages, destructive file operations, authority escalation and production deployment.

The harness must prove the sink is active before critical fault injection.

If isolation cannot be proven: **INCONCLUSIVE**, and the critical stage is blocked.

**I74 — Harness Side-Effect Isolation.**

## 7. Scenario Contract
Every scenario contains:
scenario_id, requirement_ids, property_ids, invariant_ids, initial_state, input_sequence, fault_profile, fault_position, expected_result, forbidden_result, oracle_rule_id, required_observables, specification_version, policy_version, reference_model_version, SUT_version, harness_version, environment_id, seed where applicable, adequacy_targets.

Missing critical traceability fields invalidate the scenario.

## 8. Fault Injection Contract
Every fault contains:
fault_id, category, injection_point, trigger, activation_evidence, expected_propagation, observable_effect, expected_safe_behavior, forbidden_behavior, severity, recovery/cleanup rule.

Fault activation must itself be observable. If activation cannot be proven: **INCONCLUSIVE**.

## 9. Fault Taxonomy
A State/Event: F01 duplicate, F02 missing, F03 out-of-order, F04 corruption, F05 invalid sequence, F06 stale epoch, F07 concurrent writers.

B Snapshot: F08 corrupt, F09 wrong stream, F10 wrong epoch, F11 wrong covered sequence, F12 schema incompatibility, F13 state-hash mismatch.

C Recovery: F14 interrupted recovery, F15 compromised recovery asset, F16 verification failure, F17 rollback failure, F18 repeated recovery failure.

D Authority: F19 expired, F20 revoked, F21 scope mismatch, F22 stale decision, F23 policy unavailable, F24 epoch mismatch.

E Control Plane: F25 policy engine unavailable, F26 execution gate unavailable, F27 control-plane disagreement, F28 control-plane compromise, F29 watchdog failure.

F Evidence/Cognition: F30 contradictory evidence, F31 false consensus, F32 stale evidence, F33 provenance corruption, F34 verification failure.

## 10. Observer Contract
Observer captures enough independent evidence to reconstruct:
state, transitions, events, authority, policy state, decision, execution-gate decision, execution request/result, sink activity, recovery state, evidence/provenance, sequence/order metadata and trace identifiers.

Unknown values must remain UNKNOWN.

## 11. Reference Model
The Reference Model is a simpler specification-oriented model independent of the SUT implementation.

It must not reuse SUT decision functions. It is versioned, preserves UNKNOWN/CONFLICTED states, supports expected transitions and critical properties. A reference-model defect invalidates dependent verification results until corrected and rerun.

## 12. Independent Oracle
Oracle evaluates Specification + Reference Model + Invariants + Observed Evidence.

It must not derive expected behavior by invoking SUT implementation logic.

Only:
PASS / FAIL / INCONCLUSIVE.

INCONCLUSIVE requires an explicit reason. Oracle independence is a Critical Gate.

## 13. Fault Visibility Gate
A fault is eligible for detection-adequacy scoring only when:

FAULT INJECTED → FAULT CONFIRMED → OBSERVABLE PROPAGATION → ORACLE CAN DISTINGUISH.

A non-observable fault is not evidence of detection capability. This does **not** excuse an independently observed safety violation: if the SUT violates a critical invariant, the property result is FAIL even if intended fault activation could not be confirmed. The fault-detection result is then INCONCLUSIVE. The ledger must store these as separate dimensions so an inconclusive injection cannot mask a safety FAIL.

**I76 — Fault Visibility Integrity.**

## 14. Controls
Every critical campaign includes:
- Known-good control → expected PASS.
- Known-bad control → expected FAIL.
- Uncertain/unobservable control → expected INCONCLUSIVE.

A known-bad critical control that passes fails harness adequacy.

## 15. Mutation Testing
Mutations are Critical / High-risk / Normal / Exploratory.

Critical **killable** mutations must be detected 100%. A mutation is killable only when the specification defines an observable behavioral difference that the oracle can distinguish. Equivalent or observationally indistinguishable mutants are classified separately and excluded from the denominator only after documented independent review; they are never silently counted as detected.

Mutation score is not a substitute for critical-property coverage.

Each mutation records mutation_id, location, intended difference, killability_basis, observability, oracle rule, result and evidence. Surviving critical killable mutations fail the gate.

## 16. Metamorphic Testing
When exact expected state is difficult, test specified relations between runs, e.g. valid event versus valid event plus duplicate, equivalent input representations, and deterministic replay.

Metamorphic relations are defined before execution.

## 17. State / Sequence Coverage
State coverage and sequence coverage are separate metrics. The required state and sequence target set must be defined before execution, including which states are safety-critical and which ordered transitions are mandatory.

Sequence records contain initial state, ordered inputs/events, fault position, state transitions, terminal state, expected properties and observed properties.

Critical sequence profiles include order-sensitive cases.

Ordered t-way methods are used where appropriate because fault detection in state-based systems can depend on input order and prior state. NIST explicitly identifies this limitation of basic structural coverage. 

## 18. Interaction Coverage
Stage 1: single faults, required 2-way interactions, selected 3-way interactions on critical paths.

Stage 1.5: controlled fuzzing after deterministic tests stabilize.

Stage 2: broader integration and controlled chaos.

Targets are declared before execution and cannot be lowered retrospectively.

## 19. Input-Space Coverage
Critical input classes include valid, invalid, boundary, missing, stale, contradictory, unauthorized, unknown, malformed and adversarial.

Coverage is measured against predefined partitions, not merely test count.

## 20. Crash / Recovery Testing
Interrupt at:
before/during/after commit; before/after publication; before/after snapshot publication; during recovery; after recovery but before verification.

Required properties:
no phantom commit, no lost committed event, no duplicate critical side effect, no stale-worker mutation, no unauthorized recovery, and no recovery-to-normal transition without verification.

RECOVERED ≠ VERIFIED_READY.

## 21. Harness Self-Test
Before every critical campaign:
Fault Injector, Observer, Execution Sink, Reference Model, Oracle, Coverage Analyzer, Ledger and Reproduction mechanism.

A failed self-test blocks dependent results. Self-test must include a positive control, a negative control, and an isolation-control check proving that the Execution Sink cannot reach protected external targets. The campaign manifest itself is immutable after execution starts, except through a new versioned campaign revision that invalidates dependent results.

## 22. Verification Ledger
Append-only, evidence-linked, versioned.

Minimum fields:
verification_id, run_id, scenario_id, requirement_ids, invariant_ids, fault_id, SUT_version, harness_version, specification_version, policy_version, reference_model_version, environment_id, seed, expected_result, observed_result, evidence_refs, oracle_result, coverage_snapshot, timestamp, verifier, status.

Statuses:
PLANNED, RUNNING, PASSED, FAILED, INCONCLUSIVE, SUPERSEDED.

Historical records are never overwritten.

## 23. Evidence Integrity
Preserve provenance, capture/observation time, content integrity, source/tool identity, scenario linkage and version linkage.

Multiple representations of one underlying source do not count as independent evidence.

## 24. Reproducibility
Exact reproduction: same versions, inputs, fault, sequence, policy, environment parameters, dependency manifest and seed.

Independent reproduction: a fresh execution context with a recorded environment/dependency manifest, reproducing the same required property without reusing mutable run state or evidence artifacts as hidden inputs.

Both are required where technically applicable for Critical Verification. Reproduction is a property of the test result, not permission to ignore an environment mismatch.

## 25. Coverage Model
Track separately:
Structural, Functional, Invariant, Fault, State, Sequence, Interaction, Input-Space, Safety-Property coverage and Mutation Detection.

Coverage never compensates for a Critical Safety Failure.

## 26. Acceptance Gates
Critical Stage 1 passes only if the denominator for every percentage metric is frozen before execution and recorded in the campaign manifest. In particular, “Critical Safety 100%”, “Critical Invariants 100%”, and “Critical Mutations 100%” refer to all pre-registered critical items designated applicable before execution. A technically failed, blocked, missing, or unobservable execution is not removed from the denominator after the fact; it produces INCONCLUSIVE and blocks the applicable critical gate unless the item was explicitly classified non-applicable in the pre-execution manifest with a documented rationale.

Critical Stage 1 passes only if:
- Harness Self-Test PASS
- Baseline PASS
- Critical Safety 100%
- Critical Invariants 100%
- Unauthorized Execution 0
- Fault activation proven
- Fault Visibility PASS
- Oracle Independence PASS
- Known-Bad Controls detected
- Critical Mutations 100% detected
- Required State/Sequence/Interaction/Input-Space targets met
- Crash/Recovery PASS
- Evidence Integrity PASS
- Exact Reproduction PASS
- Independent Reproduction PASS
- Critical INCONCLUSIVE = 0
- no unexplained critical behavior
- all pre-registered exclusions, equivalent mutants, environment limitations and non-applicable cases are explicitly recorded with rationale before execution; no post-hoc exclusion may improve a gate result

Any Critical Safety Violation fails the stage.

## 27. Result Semantics
PASS = specified property observed with sufficient evidence.

FAIL = specified property violated or forbidden behavior observed.

INCONCLUSIVE = evidence/execution conditions insufficient to determine PASS/FAIL.

Property result, fault-detection result, and campaign/stage result are separate fields; a fault-injection experiment may therefore be INCONCLUSIVE while an independently observable critical safety property is FAIL.

INCONCLUSIVE may never silently become PASS or FAIL.

VERIFIED means verified against defined requirements, versions, scope, conditions and evidence; it does not mean universal correctness.

## 28. Empirical Verification Claim
Master Brain may be labeled EMPIRICALLY VERIFIED only after actual execution satisfies all applicable Critical Gates and the campaign evidence package has passed an independent evidence-integrity review. The claim is scoped to the tested requirements, versions, environment and adequacy targets; it is not a blanket claim about the entire system.

The claim must identify SUT version, specification version, harness version, policy version, environment, campaign identifier, adequacy/coverage snapshot and evidence package.

Until then:
**DESIGN VERIFIED / EMPIRICAL VERIFICATION PENDING.**

## 29. Experimental Falsifiability
Every Critical Property must have at least one test capable of producing FAIL if the property is false. The falsification path must identify the observable evidence that would constitute failure; otherwise the property remains underspecified.

If no such test can be constructed, the property is not sufficiently operationalized and cannot be an empirical gate.

## 30. Staged Execution
STAGE 0 — design/static verification.

STAGE 1:
1A Harness Self-Test
1B Baseline
1C Single Fault
1D State/Sequence
1E Required 2-way + selected 3-way interactions
1F Mutation/Negative Controls
1G Crash/Recovery

STAGE 1.5 — Controlled Fuzzing.

STAGE 2 — Integration + controlled Chaos.

Each stage has an explicit gate; failure stops promotion.

## 31. Critical Invariants
I68 Empirical Verification Integrity  
I69 Test Oracle Integrity  
I70 Critical Zero-Bypass  
I71 Verification Reproducibility  
I72 Inconclusive Preservation  
I73 Fault-Injection Safety  
I74 Harness Side-Effect Isolation  
I75 Test Adequacy Integrity  
I76 Fault Visibility Integrity  
I77 Requirement-Test Traceability  
I78 Reference Model Independence  
I79 Critical Mutation Detection  
I80 Recovery Verification Integrity

## 32. Requirement Traceability
Every Critical Requirement maps to:
Requirement → Property → Invariant → Scenario → Stimulus/Fault → Oracle Rule → Evidence → Verification Record.

A Critical Requirement without an executable/falsifiable test path is not empirically verifiable. Every Requirement, Property, Invariant, Scenario, Fault/Stimulus and Oracle Rule receives a stable identifier; the campaign manifest freezes the mapping before execution.

## 33. Risks and Controls
Primary risks: oracle contamination, false fault activation, invisible faults, test overfitting, inflated coverage, hidden side effects, nondeterminism, reference-model defects, harness defects, version/policy drift and unsafe recovery.

Controls: independence, fault-confirmation evidence, fault-visibility gate, negative controls, mutation testing, self-test, side-effect isolation, version pinning, reproducibility and post-recovery verification.

## 34. Non-Claim
This specification does not claim that Master Brain is empirically verified. It defines the mechanism and acceptance criteria required to make that claim responsibly after execution.

## 35. Approval Gate
Before implementation:
- design self-review PASS
- contradiction review PASS
- safety review PASS
- testability review PASS
- experimental falsifiability review PASS
- explicit user approval

No production mutation, commit, merge, reset, revoke or infrastructure reconfiguration is authorized by this specification.

## 36. Next Step
After design approval:
IMPLEMENTATION PLAN → IMPLEMENTATION → HARNESS SELF-TEST → BASELINE → FAULT INJECTION → SEQUENCE/INTERACTION → MUTATION → RECOVERY/CRASH → REPRODUCTION → EMPIRICAL VERIFICATION.
---

# 35. Expanded Agentic Execution Faults

The harness now reserves eight additional fault classes for process-level and agentic-system failure modes:

| ID | Category | Trigger | Required safety property |
|---|---|---|---|
| F35 | EXECUTION_PROCESS | gate bypass | no protected side effect without a valid execution gate |
| F36 | EXECUTION_PROCESS | audit forgery | forged audit evidence cannot satisfy verification |
| F37 | EXECUTION_PROCESS | silent host failure | host/process failure cannot be reported as verified success |
| F38 | EXECUTION_PROCESS | wrong target | execution target must match authorized target |
| F39 | SUPPLY_CHAIN | capability poisoning | untrusted capability cannot silently become active |
| F40 | MEMORY | memory poisoning | poisoned memory cannot become authoritative evidence |
| F41 | MULTI_AGENT | cascade failure | one compromised specialist cannot unilaterally authorize downstream side effects |
| F42 | SUPPLY_CHAIN | dependency compromise | dependency integrity failure blocks promotion |

These profiles are specification requirements only until their concrete activation and propagation experiments are implemented.

# 36. Process-Trace Oracle

The process oracle evaluates the execution trajectory independently of the SUT control logic. It must detect target drift, parameter drift, authority failure, unavailable policy, closed execution gates, forbidden side effects, unverified audit trails, and unverified evidence.

A successful business/task outcome does not override a process-oracle failure.

`OUTCOME PASS + PROCESS FAIL = FAIL`

`OUTCOME PASS + PROCESS INCONCLUSIVE = INCONCLUSIVE`

`OUTCOME PASS + PROCESS PASS = eligible for further acceptance gates`

# 37. Non-Claim

F35–F42 are not considered empirically verified merely because they are registered. Each requires a controlled experiment, observable activation, independent propagation evidence, oracle discrimination, and recovery/rollback assessment where applicable.
