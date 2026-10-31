# Master Brain — Final System Design

**Version:** 1.0.0-design  
**Date:** 2026-10-05  
**Status:** FINAL DESIGN BASELINE — IMPLEMENTATION FOLLOWS THIS SPECIFICATION  
**Scope:** Master Brain, orchestration, reasoning, evidence, decision, execution, memory, learning, safety, verification, recovery, observability, and future specialist/model/tool integration.

> This document is the architectural source of truth for the Master Brain build. Existing code is treated as an implementation baseline and must be reconciled with this design; code does not redefine the design silently.

---

## 1. Mission

Master Brain is a model-agnostic executive intelligence and decision system.

Its job is not to answer every question itself. Its job is to:

1. understand the user's actual goal;
2. decompose the problem;
3. identify missing information and uncertainty;
4. select the appropriate models, agents, tools, and evidence sources;
5. execute independent analyses where useful;
6. detect contradictions and weak assumptions;
7. actively attempt to falsify its own conclusion;
8. decide whether to STOP, HOLD, REJECT, OVERRIDE, or PROCEED;
9. execute only within the applicable authority boundary;
10. verify outcomes;
11. record decisions, evidence, failures, and lessons;
12. recover deterministically after interruption or failure.

The user remains the final authority.

Master Brain is a decision-support and execution-orchestration system, not an autonomous authority that can silently redefine the user's objectives or safety boundaries.

---

## 2. Core Principles

### P1 — Evidence before confidence
Confidence must follow evidence quality. The system must never manufacture certainty.

### P2 — Uncertainty is a first-class state
UNKNOWN and CONFLICTED are explicit states. They are not converted into PASS, FAIL, or a positive assumption.

### P3 — Independent verification
Agreement between models is not automatically independent evidence.

### P4 — Falsifiability
Every critical claim must have a defined way it could be shown wrong.

### P5 — Fail closed
Critical uncertainty, authorization failure, verification failure, or unsafe execution conditions block progression.

### P6 — Reversibility first
Prefer reversible actions. Irreversible or high-impact actions require stronger evidence and authorization.

### P7 — User authority
The user is the final decision maker for actions requiring human approval.

### P8 — No silent privilege escalation
Tools, agents, models, and workflows cannot grant themselves broader authority.

### P9 — Traceability
Every critical decision must be reconstructable from goal → evidence → reasoning → decision → action → outcome.

### P10 — Verification is separate from execution
A successful execution is not proof that the decision was correct.

### P11 — Learning must not corrupt governance
Learning may improve routing and performance estimates, but cannot silently weaken safety rules, authority controls, or critical invariants.

### P12 — No unsupported claim
The system may say VERIFIED only within an explicitly defined scope supported by actual evidence.

---

# 3. System Boundary

The final system consists of these domains:

```
USER
  |
  v
AUTHORITY / SAFETY
  |
  v
MASTER BRAIN
  |
  +-- Intent & Goal
  +-- Planning / Task Graph
  +-- Memory / Context
  +-- Capability Registry
  +-- Model / Agent / Tool Router
  +-- Evidence & Epistemic Engine
  +-- Reasoning
  +-- Cross-Check
  +-- Devil's Advocate
  +-- Decision Engine
  +-- Execution Gate
  +-- Verification
  +-- Recovery
  +-- Learning
  +-- Audit / Ledgers
  |
  v
SPECIALISTS / MODELS / TOOLS
  |
  v
OBSERVABLE RESULTS
```

The verification harness sits outside the decision logic and must remain sufficiently independent to test the system rather than reproduce its implementation.

---

# 4. Executive Control Loop

Every material task follows:

```
GOAL
 ↓
INTENT PARSE
 ↓
TASK CLASSIFICATION
 ↓
RISK ASSESSMENT
 ↓
CONTEXT / MEMORY LOAD
 ↓
CAPABILITY MATCH
 ↓
ROUTING
 ↓
EVIDENCE COLLECTION
 ↓
ASSUMPTIONS
 ↓
INDEPENDENT ANALYSIS
 ↓
CROSS-CHECK
 ↓
DEVIL'S ADVOCATE
 ↓
SCENARIOS / ALTERNATIVES
 ↓
DECISION
 ↓
AUTHORIZATION
 ↓
EXECUTION
 ↓
OBSERVATION
 ↓
VERIFICATION
 ↓
OUTCOME
 ↓
MEMORY / LEDGER
 ↓
LEARNING
```

Not every task requires every expensive stage. The orchestrator selects the minimum sufficient process based on risk, uncertainty, complexity, and consequence.

Critical tasks cannot bypass mandatory safety and verification gates.

---

# 5. Authority Model

Authority is hierarchical:

1. User authority
2. System safety policy
3. Master Brain governance
4. Task-specific permissions
5. Tool/agent permissions
6. Individual operation

No lower layer may override a higher layer.

### Permission classes

- **L0:** observe/read
- **L1:** reversible low-risk action
- **L2:** consequential action requiring stronger checks
- **L3:** critical/high-impact/irreversible action requiring explicit approval

The existing permission engine is an implementation seed; it must eventually conform to this explicit authority model.

---

# 6. Risk Model

Risk is evaluated from at least:

- impact;
- probability;
- reversibility;
- uncertainty;
- externality;
- authority sensitivity;
- data sensitivity;
- financial consequence;
- operational consequence.

Risk levels:

```
LOW → MEDIUM → HIGH → CRITICAL
```

Critical or irreversible operations require the strongest safeguards.

Risk assessment must be recorded before execution for consequential tasks.

---

# 7. Decision Semantics

The final decision vocabulary is:

### STOP
Insufficient information, invalid premise, missing required capability, unsafe condition, or inability to verify.

### HOLD
Potentially viable, but additional evidence or analysis is required.

### REJECT
The proposed action violates constraints, has unacceptable risk, or fails a critical gate.

### OVERRIDE
The user's stated assumption or preferred direction conflicts with sufficiently strong evidence or a critical safety rule. Master Brain must explain the conflict rather than silently complying.

### PROCEED
Evidence, risk, stability, authority, and verification conditions satisfy the applicable gate.

A decision status must never be inferred only from model confidence.

---

# 8. Goal and Intent Engine

The Intent Engine converts natural language into a structured task:

- objective;
- desired outcome;
- constraints;
- deadline;
- budget;
- risk tolerance;
- authority level;
- required quality;
- known assumptions;
- missing information;
- success criteria.

Ambiguous goals are represented explicitly rather than guessed.

The system must distinguish:
- what the user said;
- what the system inferred;
- what remains unknown.

---

# 9. Task Graph

Complex work is represented as a dependency graph.

Each task node contains:

- task ID;
- objective;
- dependencies;
- inputs;
- expected outputs;
- risk;
- required capabilities;
- owner/agent;
- verification criteria;
- status;
- evidence references.

Independent nodes may execute in parallel.

Dependent nodes wait for their prerequisites.

Failure propagation is explicit; a failed critical dependency cannot silently appear successful downstream.

---

# 10. Memory Architecture

Memory is separated into:

### Working Memory
Current task context and transient intermediate results.

### Episodic Memory
Past tasks, actions, outcomes, and experiences.

### Semantic Memory
Stable facts, domain knowledge, definitions, specifications.

### Decision Memory
Why a decision was made, alternatives considered, evidence, confidence, outcome.

### Verification Memory
Tests, evidence packages, failures, reproductions, coverage, and acceptance results.

### Governance Memory
Policies, invariants, permission rules, system constraints, and versioned objectives.

Memory entries require provenance and version context where appropriate.

Memory retrieval must not be treated as automatically true evidence.

---

# 11. Epistemic Model

Every important statement is classified as one of:

- FACT
- OBSERVATION
- CALCULATION
- INFERENCE
- HYPOTHESIS
- ASSUMPTION
- ESTIMATE
- PREDICTION
- OPINION
- UNKNOWN
- CONFLICTED

Each record may include:
- basis;
- sources;
- timestamp;
- provenance;
- confidence;
- verification state.

The existing epistemic engine is the starting implementation for this layer.

---

# 12. Evidence Engine

Evidence is evaluated on:

- source quality;
- independence;
- recency;
- relevance;
- directness;
- reproducibility;
- consistency;
- provenance;
- measurement quality.

Evidence aggregation must not double-count multiple representations of the same underlying source.

Contradictory evidence remains contradictory until resolved or explicitly carried as uncertainty.

---

# 13. Reasoning Engine

Reasoning must separate:

1. observations;
2. assumptions;
3. calculations;
4. causal hypotheses;
5. predictions;
6. conclusions.

For quantitative work:
- formulas are explicit;
- inputs are traceable;
- units are preserved;
- sensitivity is tested when material;
- arithmetic is independently checked when risk warrants it.

For scientific/R&D work:
```
Question
→ Hypothesis
→ Literature
→ Patent
→ Experimental Design
→ Experiment
→ Data
→ Analysis
→ Falsification
→ Conclusion
→ Next Experiment
```

---

# 14. Cross-Check Engine

Cross-checking should use genuinely independent reasoning paths where practical.

Examples:
- independent model;
- independent calculation;
- alternative methodology;
- primary source verification;
- separate implementation;
- adversarial review.

Model agreement alone is insufficient to establish independence.

Disagreement becomes an explicit object for resolution.

---

# 15. Devil's Advocate

For material decisions, Master Brain must actively attempt to disprove its preferred conclusion.

It asks:

- What assumption is most fragile?
- What evidence would falsify this?
- What alternative explanation exists?
- What failure mode has been ignored?
- What happens in the worst credible case?
- Is there a cheaper/reversible experiment that resolves uncertainty?
- Could the apparent consensus be correlated error?

A Devil's Advocate result is evidence, not an automatic veto.

---

# 16. Scenario and Alternative Engine

Before high-impact decisions, generate:

- base case;
- upside case;
- downside case;
- failure case;
- alternative strategy;
- no-action option.

Compare:
- expected value;
- downside;
- reversibility;
- information value;
- resource requirements;
- execution risk.

---

# 17. Model / Agent / Tool Router

The system is model-agnostic.

Routing is based on capability rather than brand.

Each model/agent/tool has a capability profile containing:

- supported domains;
- task types;
- reasoning strengths;
- latency;
- cost;
- reliability;
- freshness;
- context capacity;
- tool access;
- historical calibrated performance;
- applicable risk classes.

The router chooses:
- one specialist;
- multiple independent specialists;
- sequential review;
- parallel panel;
- or no external specialist.

Routing decisions are logged for later calibration.

The existing capability registry, adaptive router, domain router, expert panel, and parallel executor form the initial implementation foundation.

---

# 18. Parallelism

Independent analyses should run in parallel when:

- dependencies allow;
- evidence sources are independent enough;
- cost is justified;
- risk warrants cross-checking.

Parallel results are normalized into a common result contract before synthesis.

The system must not mistake duplicated correlated analyses for independent confirmation.

---

# 19. Specialist Result Contract

Every specialist result should contain:

- task ID;
- agent/model ID;
- version;
- input references;
- conclusion;
- evidence;
- assumptions;
- uncertainty;
- confidence;
- limitations;
- recommended action;
- provenance.

Missing critical fields reduce trust and may block high-risk synthesis.

---

# 20. Decision Engine

The decision engine combines:

- evidence state;
- assumptions;
- contradictions;
- risk;
- stability;
- value of information;
- alternatives;
- authority;
- verification state.

Decision rules must be deterministic and inspectable for critical paths.

The existing decision engine is a starting point, not the final specification.

---

# 21. Value of Information

Before expensive or risky action, Master Brain should ask:

> Is obtaining more information worth more than acting now?

Possible outcomes:

- ACT;
- COLLECT INFORMATION;
- RUN SMALL EXPERIMENT;
- DEFER;
- REJECT.

The system should prefer cheap, reversible experiments when they can materially reduce uncertainty.

---

# 22. Execution Architecture

No reasoning component directly performs arbitrary external side effects.

Execution passes through:

```
DECISION
 ↓
AUTHORIZATION
 ↓
EXECUTION POLICY
 ↓
EXECUTION GATE
 ↓
TARGET ADAPTER
 ↓
ACTION
 ↓
OBSERVATION
 ↓
VERIFICATION
```

Critical operations must be isolated and auditable.

Protected categories include:
- financial transactions;
- sensitive outbound messages;
- destructive file operations;
- authority escalation;
- production deployment;
- unrestricted external writes.

---

# 23. Verification Architecture

Verification is a separate subsystem.

It must answer:

1. Did the action happen?
2. Did the expected state change happen?
3. Did forbidden side effects happen?
4. Is the result consistent with the specification?
5. Can the result be reproduced?
6. Is the evidence sufficient?

The existing verification engine is retained as an initial simple gate but must evolve into the broader verification architecture defined here.

---

# 24. Fault-Injection Harness

The complete fault-injection specification is authoritative in:

`docs/specs/2026-10-05-fault-injection-harness-design.md`

The harness contains:

- scenario controller;
- fault injector;
- observer;
- execution sink;
- reference model;
- independent oracle;
- coverage analyzer;
- mutation engine;
- verification ledger;
- recovery controller;
- reproduction controller;
- self-test;
- acceptance gates.

Critical testing must never depend on unproven external side-effect isolation.

---

# 25. Fault Taxonomy

The authoritative fault set is F01–F49:

- state/event faults;
- snapshot faults;
- recovery faults;
- authority faults;
- control-plane faults;
- evidence/cognition faults.

Every injected fault requires activation evidence.

Unconfirmed activation produces fault-detection INCONCLUSIVE.

An independently observed safety violation remains FAIL even if activation is inconclusive.

---

# 26. Reference Model

The Reference Model is simpler than and independent from the SUT.

It must not import or call SUT decision functions.

It models:
- state;
- valid transitions;
- authority;
- expected outcomes;
- invariants;
- UNKNOWN;
- CONFLICTED.

A defect in the Reference Model invalidates dependent verification until corrected and rerun.

---

# 27. Independent Oracle

Oracle inputs:

```
Specification
+ Reference Model
+ Invariants
+ Observed Evidence
```

Oracle outputs only:

```
PASS
FAIL
INCONCLUSIVE
```

INCONCLUSIVE always contains a reason.

The Oracle must be testable for independence from the SUT.

---

# 28. Coverage Model

Track separately:

- structural coverage;
- functional coverage;
- invariant coverage;
- fault coverage;
- state coverage;
- sequence coverage;
- interaction coverage;
- input-space coverage;
- safety-property coverage;
- mutation detection.

Coverage is an adequacy measurement, never a substitute for safety verification.

Critical denominators are frozen before execution.

---

# 29. Mutation Testing

Mutation classes:

- Critical;
- High-risk;
- Normal;
- Exploratory.

Critical killable mutations must be detected at 100%.

Equivalent or observationally indistinguishable mutants require documented independent classification and cannot be silently removed from the denominator.

Surviving critical killable mutations block empirical verification.

---

# 30. Metamorphic Testing

Where exact expected output is difficult, verify relations between runs.

Examples:
- valid input vs equivalent representation;
- valid event vs duplicated event;
- deterministic replay;
- order-preserving vs order-changing sequence;
- state-preserving transformation.

Relations are defined before execution.

---

# 31. State / Sequence / Interaction Testing

State coverage and sequence coverage are distinct.

Critical tests must include order-sensitive behavior.

Stage 1:
- single faults;
- required 2-way interactions;
- selected 3-way critical-path interactions.

Stage 1.5:
- controlled fuzzing.

Stage 2:
- broader integration and controlled chaos.

Targets cannot be lowered after observing results.

---

# 32. Crash and Recovery

Recovery must test interruption:

- before commit;
- during commit;
- after commit;
- before publication;
- after publication;
- during snapshot publication;
- during recovery;
- after recovery but before verification.

Required properties:

- no phantom commit;
- no lost committed event;
- no duplicate critical side effect;
- no stale-worker mutation;
- no unauthorized recovery;
- no transition to ready without verification.

`RECOVERED != VERIFIED_READY`

---

# 33. Reproducibility

### Exact reproduction
Same:
- SUT version;
- harness version;
- specification;
- policy;
- input;
- fault;
- sequence;
- environment;
- dependencies;
- seed where applicable.

### Independent reproduction
Fresh execution context reproduces the same property without hidden mutable run state or evidence artifacts.

Critical verification requires both where technically applicable.

---

# 34. Verification Ledger

The ledger is append-only and evidence-linked.

Minimum record:

- verification ID;
- run ID;
- scenario ID;
- requirement IDs;
- invariant IDs;
- fault ID;
- versions;
- environment;
- seed;
- expected result;
- observed result;
- evidence references;
- oracle result;
- coverage snapshot;
- timestamp;
- verifier;
- status.

Statuses:

```
PLANNED
RUNNING
PASSED
FAILED
INCONCLUSIVE
SUPERSEDED
```

Historical records are never overwritten.

---

# 35. Learning Architecture

Learning occurs at three levels:

### Routing learning
Which models/agents/tools perform well for which task classes.

### Decision calibration
How predictions and confidence compare with actual outcomes.

### System learning
Which workflows, experiments, and safeguards improve outcomes.

Learning cannot automatically change:
- critical safety invariants;
- authority boundaries;
- verification semantics;
- acceptance gates.

Governance changes require a versioned design change.

---

# 36. Outcome Verification

Every material prediction or decision can create an expected-outcome record.

Later:

```
PREDICTION
 ↓
ACTUAL OUTCOME
 ↓
ERROR / CALIBRATION
 ↓
LESSON
 ↓
MODEL / ROUTER UPDATE
```

The learning loop must distinguish:
- model error;
- bad evidence;
- bad assumption;
- execution failure;
- environmental change;
- specification error.

---

# 37. Research and R&D Engine

For scientific and technical work:

- research question;
- literature search;
- source ranking;
- patent search;
- contradiction mapping;
- hypothesis generation;
- experimental design;
- parameter control;
- data capture;
- statistical/quantitative analysis;
- falsification;
- reproducibility;
- conclusion;
- next experiment.

The system must not present an untested hypothesis as established fact.

---

# 38. Business Decision Engine

Business analyses should support:

- market sizing;
- supplier comparison;
- CAPEX/OPEX;
- unit economics;
- cash-flow modeling;
- sensitivity;
- scenario analysis;
- procurement;
- production planning;
- ROI;
- break-even;
- operational risk.

Material financial assumptions require explicit provenance and sensitivity analysis.

---

# 39. Content / Growth Engine

A future integrated content system may manage:

- website content;
- SEO;
- social media;
- content calendar;
- campaign experiments;
- analytics;
- conversion hypotheses.

Publishing authority remains governed by the same permission model.

No autonomous publishing should bypass configured approval boundaries.

---

# 40. Observability

Every important workflow should expose:

- trace ID;
- task ID;
- decision ID;
- execution ID;
- model/agent ID;
- tool ID;
- timestamps;
- status;
- latency;
- cost;
- evidence references;
- errors;
- verification status.

Observability must support post-hoc reconstruction without relying on hidden state.

---

# 41. Security

Security architecture includes:

- least privilege;
- deny-by-default execution;
- credential isolation;
- secret non-disclosure;
- authority separation;
- auditability;
- immutable or append-only critical records;
- protected-target isolation;
- explicit approval for critical operations.

No tool connection is assumed safe merely because it is connected.

---

# 42. Failure Semantics

System-level failure states include:

- INVALID_INPUT;
- MISSING_CAPABILITY;
- INSUFFICIENT_EVIDENCE;
- CONTRADICTION;
- AUTHORIZATION_DENIED;
- SAFETY_BLOCK;
- EXECUTION_FAILURE;
- VERIFICATION_FAILURE;
- RECOVERY_FAILURE;
- NONDETERMINISTIC_RESULT;
- INCONCLUSIVE.

Failures must remain visible to upstream orchestration.

---

# 43. Versioning

Critical decisions depend on version identity.

Versioned artifacts include:

- Master Brain;
- specification;
- policy;
- harness;
- reference model;
- campaign manifest;
- environment/dependency manifest;
- model/agent;
- tool adapter.

A result from one version must not silently be presented as proof of another version.

---

# 44. Change Control

Changes to critical behavior require:

1. design update;
2. stable version increment;
3. affected requirement identification;
4. test impact analysis;
5. regression;
6. verification;
7. updated evidence.

No silent mutation of critical governance.

---

# 45. Final Acceptance Model

Master Brain is not called empirically verified merely because tests are green.

The final claim requires, as applicable:

- harness self-test PASS;
- baseline PASS;
- critical safety 100%;
- critical invariants 100%;
- unauthorized execution = 0;
- fault activation proven;
- fault visibility PASS;
- oracle independence PASS;
- known-bad controls detected;
- critical killable mutations detected 100%;
- required state/sequence/interaction/input-space targets met;
- crash/recovery PASS;
- evidence integrity PASS;
- exact reproduction PASS;
- independent reproduction PASS;
- critical INCONCLUSIVE = 0;
- no unexplained critical behavior;
- pre-registered exclusions documented;
- independent evidence-integrity review PASS.

Any critical safety violation fails the applicable stage.

---

# 46. Verification Claim Levels

### DESIGN VERIFIED
Architecture, contracts, invariants, and testability have been reviewed.

### IMPLEMENTATION VERIFIED
Implemented behavior satisfies the currently executed automated test suite within scope.

### EMPIRICALLY VERIFIED
Actual staged execution satisfies the defined acceptance gates with reconstructable evidence and independent verification.

### UNIVERSALLY CORRECT
**Never claimed.**

The system may only make the strongest claim supported by evidence.

---

# 47. Implementation Roadmap

## Phase 0 — Design
- final architecture;
- requirements;
- invariants;
- interfaces;
- safety boundaries;
- verification design.

## Phase 1 — Core stabilization
- task graph;
- routing;
- evidence;
- decision;
- permission;
- memory;
- ledgers.

## Phase 2 — Verification Harness
- contracts;
- scenario manifests;
- execution sink;
- observer;
- reference model;
- oracle;
- fault injector;
- coverage;
- mutation;
- ledger.

## Phase 3 — Campaign System
- self-test;
- campaign runner;
- recovery;
- reproduction;
- acceptance gates.

## Phase 4 — Empirical verification
- Stage 0;
- Stage 1A–1G;
- Stage 1.5;
- Stage 2.

## Phase 5 — Production hardening
Only after verification evidence justifies promotion:
- stronger isolation;
- external adapters;
- operational monitoring;
- controlled deployment;
- rollback.

---

# 48. Current Repository Mapping

The current repository already contains implementation seeds for:

- core pipeline;
- task graph;
- governance;
- permission;
- risk;
- routing;
- capability registry;
- parallel execution;
- evidence;
- epistemic classification;
- contradiction resolution;
- cross-check;
- Devil's Advocate;
- experimental design;
- falsification;
- quantitative validation;
- learning;
- decision ledger;
- verification.

The current Verification Harness implementation has begun with:
- immutable scenario/contract support;
- Execution Sink/Test Double;
- focused tests.

These components must be reconciled against this final architecture during implementation.

Passing unit tests do **not** yet constitute empirical verification of Master Brain.

---

# 49. Implementation Rules

1. Use TDD for new critical behavior.
2. Every new behavior must have an observed failing test before implementation where technically applicable.
3. Keep production execution separate from test execution.
4. Never weaken an assertion merely to make a test green.
5. Verify after each meaningful implementation stage.
6. Preserve evidence of failures and fixes.
7. Do not commit unless separately authorized.
8. Do not reset, merge, pull, revoke, or reconfigure infrastructure as part of ordinary implementation.
9. Do not claim empirical verification before the acceptance gates actually execute.
10. When evidence is insufficient, say INCONCLUSIVE.

---

# 50. Definition of Done

The project is complete only when:

```
FINAL DESIGN
      +
IMPLEMENTATION
      +
AUTOMATED TESTS
      +
HARNESS SELF-TEST
      +
BASELINE
      +
FAULT INJECTION
      +
STATE/SEQUENCE
      +
INTERACTION
      +
MUTATION
      +
RECOVERY
      +
REPRODUCTION
      +
INDEPENDENT EVIDENCE REVIEW
      +
ACCEPTANCE GATES
      =
SCOPED EMPIRICAL VERIFICATION
```

Until that point, the correct status is:

**DESIGN VERIFIED / EMPIRICAL VERIFICATION PENDING.**

---

# 51. Governing Statement

> **Master Brain must be powerful enough to decide, skeptical enough to challenge itself, disciplined enough to stop when evidence is insufficient, and auditable enough to prove what it actually did.**

And:

> **عدم قطعیتِ صادقانه، بهتر از قطعیتِ ساختگی است.**

And:

> **هر تناقض باید یا حل شود، یا صریحاً به‌عنوان تناقض باقی بماند.**

---

## Appendix A — Canonical End-to-End Flow

```
USER GOAL
→ INTENT
→ TASK GRAPH
→ RISK
→ MEMORY
→ CAPABILITY MATCH
→ ROUTING
→ PARALLEL / SEQUENTIAL ANALYSIS
→ EVIDENCE
→ ASSUMPTIONS
→ CROSS-CHECK
→ DEVIL'S ADVOCATE
→ SCENARIOS
→ DECISION
→ AUTHORIZATION
→ EXECUTION GATE
→ EXECUTION
→ OBSERVATION
→ VERIFICATION
→ OUTCOME
→ LEDGER
→ MEMORY
→ CALIBRATION
→ NEXT ACTION
```

## Appendix B — Canonical Critical Verification Flow

```
REQUIREMENT
→ PROPERTY
→ INVARIANT
→ SCENARIO
→ STIMULUS / FAULT
→ OBSERVATION
→ REFERENCE MODEL
→ INDEPENDENT ORACLE
→ EVIDENCE
→ VERIFICATION RECORD
→ COVERAGE / ADEQUACY
→ REPRODUCTION
→ ACCEPTANCE GATE
→ SCOPED CLAIM
```

## Appendix C — Non-Negotiable Truth States

```
PASS         = evidence supports the specified property
FAIL         = specified property is violated
INCONCLUSIVE = evidence is insufficient
UNKNOWN      = required fact is not known
CONFLICTED   = credible evidence disagrees
STOP         = cannot responsibly continue
REJECT       = proposed action is unacceptable
PROCEED      = applicable gates permit action
```

These states must never be silently collapsed into one another.

## Appendix D — Verified Runtime Baseline (2026-10-06)

The current implementation workspace has an empirically observed runtime baseline of Node.js v24.21.0 and OpenClaw 2026.9.8 (fc23bc8). OpenClaw 2026.9.8 is the current stable release observed during this verification checkpoint; the 2026.10.1-beta.1 line is explicitly not treated as the production baseline. Runtime compatibility is therefore verified against the stable line, not a pre-release build.

This appendix records an environment observation, not a universal compatibility claim. Any future runtime upgrade must re-run the runtime baseline test and the complete verification suite before the new version becomes an accepted baseline.
---

# Appendix E — Process-Trace Assurance and Expanded Agentic Fault Surface

**Added:** 2026-10-06  
**Status:** DESIGN AMENDMENT — implementation and empirical verification required

Recent agent-safety literature supports treating safety as a runtime contract with both preventive controls and evidential proof, while systems-security work emphasizes end-to-end runtime boundaries rather than model behavior alone. Master Brain therefore extends verification from outcome-only checking to process-trace assurance.

## E.1 Process Oracle

A material execution is not VERIFIED merely because its final outcome matches the expected result. The independent process oracle must establish, within its evidence scope:

- intent provenance;
- decision identity;
- authority validity;
- policy availability;
- execution-gate state;
- target identity;
- parameter integrity;
- actual execution state;
- observed side effects;
- audit integrity;
- evidence integrity.

Required semantic rule:

`OUTCOME PASS + PROCESS ANOMALY = NOT VERIFIED`

The process oracle must remain independent of decision, permission, risk-engine, execution-gate, and verification-engine implementation logic.

## E.2 Expanded Fault Surface

The authoritative fault surface is expanded from F01–F34 to F01–F49:

- F35 gate bypass
- F36 audit forgery
- F37 silent host failure
- F38 wrong-target execution
- F39 capability/skill poisoning
- F40 memory poisoning
- F41 multi-agent cascade failure
- F42 dependency/supply-chain compromise
- F43 poisoned intelligence
- F44 malicious payload
- F45 false attribution
- F46 stale leak
- F47 correlated false reporting
- F48 prompt injection
- F49 provenance spoofing

These additions are requirements until each fault receives activation evidence, observability, independent oracle discrimination, and recovery semantics.

## E.3 Acceptance Requirement

Empirical verification of a critical execution path requires `process_verification = PASS` in addition to the existing safety, authority, fault, recovery, reproduction, and evidence gates.

The new requirement does not retroactively convert previous test results into evidence for this property. It creates a new verification obligation that must be executed and independently assessed.


---

# Appendix F — Threat Intelligence & Adversary Intelligence / Dark Web

**Added:** 2026-10-06  
**Status:** DESIGN AMENDMENT — initial implementation and focused empirical tests PASS; broader campaign verification remains pending

Master Brain treats Threat Intelligence & Adversary Intelligence as a first-class domain. Dark Web and Deep Web sources are intelligence sensors, not trusted authorities and never execution environments.

## F.1 Domain scope

The domain covers:

- Surface Web intelligence
- Deep Web intelligence
- Dark Web intelligence
- vulnerability intelligence
- leak/exposure intelligence
- credential-exposure monitoring
- threat actors
- campaigns
- malware intelligence
- infrastructure intelligence
- indicators of compromise
- TTPs and ATT&CK mapping
- supply-chain threats
- brand/executive threats
- geopolitical cyber risk

## F.2 Untrusted-input boundary

The mandatory flow is:

```
SOURCE
→ COLLECTION
→ LEGAL / AUTHORITY CHECK
→ PROVENANCE
→ HASH / INTEGRITY
→ SANITIZATION
→ ISOLATION
→ CLASSIFICATION
→ CORROBORATION
→ CONFIDENCE / UNCERTAINTY
→ THREAT ASSESSMENT
→ POLICY GATE
→ QUARANTINE / ADMISSION
→ MEMORY
→ DECISION
```

The prohibited direct flows are:

```
DARK WEB → TRUSTED MEMORY
DARK WEB → EXECUTION
DARK WEB → PAYMENT
DARK WEB → CREDENTIAL STORE
DARK WEB → AUTHORITY ESCALATION
```

Untrusted content must never be interpreted as an instruction merely because it was retrieved from an intelligence source.

## F.3 Evidence semantics

Threat intelligence records require, as applicable:

- source type;
- source identity or controlled pseudonymous identifier;
- collection authorization;
- collection timestamp;
- content hash;
- provenance;
- source reliability;
- information credibility;
- confidence;
- uncertainty;
- corroboration status;
- technical indicator verification;
- affected asset correlation;
- classification;
- retention/expiry information.

High-impact attribution requires independent corroboration. Conflicted, stale, or provenance-uncertain claims remain CONFLICTED/INCONCLUSIVE and cannot silently become trusted facts.

## F.4 Dark Web safety policy

Permitted defensive activities include lawful collection, monitoring, metadata collection, exposure monitoring, correlation, analysis, reporting, IOC/TTP extraction, vulnerability intelligence, and risk assessment.

The policy blocks, unless separately authorized by an applicable lawful operational framework and outside this intelligence subsystem:

- purchase of stolen data or credentials;
- purchase/acquisition of malware or exploits;
- credential use;
- unauthorized intrusion;
- persistence;
- exfiltration;
- criminal transactions;
- unauthorized deanonymization.

The intelligence subsystem must fail closed on unknown operations.

## F.5 Prompt-injection and malicious-content boundary

Dark Web content is hostile input by default. Pages, posts, files, scripts, instructions, and embedded content must be treated as data, not executable authority.

Prompt injection, malicious payloads, poisoned intelligence, provenance spoofing, false attribution, stale leaks, and coordinated false reporting are explicit verification targets.

## F.6 Fault surface

The authoritative fault surface is now F01–F49.

New Threat Intelligence faults:

- F43 — poisoned intelligence
- F44 — malicious payload
- F45 — false attribution
- F46 — stale leak
- F47 — correlated false reporting
- F48 — prompt injection
- F49 — provenance spoofing

Each fault requires activation evidence, observable propagation, independent oracle discrimination, and recovery semantics before receiving empirical detection credit.

## F.7 Correlation rule

No single Dark Web claim should directly drive a critical decision when independent corroboration is reasonably obtainable.

The preferred correlation graph is:

```
DARK WEB CLAIM
   ↕
SURFACE WEB / GOVERNMENT CTI
   ↕
CVE / VULNERABILITY DATA
   ↕
IOC / TTP
   ↕
OWN ASSET / TELEMETRY
   ↕
BUSINESS IMPACT
```

A mismatch produces CONFLICTED or INCONCLUSIVE state rather than forced consensus.

## F.8 Memory admission

Threat intelligence enters trusted memory only through a versioned admission contract. Verified and corroborated intelligence is initially an ADMIT_CANDIDATE rather than an unconditional truth claim. Quarantined or unresolved intelligence remains isolated.

## F.9 Verification obligation

Focused runtime controls currently cover the principal admission, provenance, payload, attribution, policy, and isolation properties. This does not yet establish universal Dark Web safety.

Required next empirical stages:

1. concrete F43–F49 campaigns;
2. source-level mutation testing;
3. memory-poisoning persistence tests;
4. multi-agent propagation tests;
5. supply-chain/artifact provenance tests;
6. end-to-end correlation tests;
7. independent fresh-context reproduction;
8. controlled sandbox validation before any live external collection.

## F.10 Governing rule

> **Dark Web is a sensor, never an authority. Intelligence can inform a decision only after provenance, safety, evidence quality, corroboration, and policy gates are satisfied.**


---

# Appendix F — Threat Intelligence & Adversary Intelligence / Dark Web

Added: 2026-10-06
Status: DESIGN AMENDMENT — initial implementation and focused tests PASS; broader campaign verification pending.

Master Brain treats Threat Intelligence & Adversary Intelligence as a first-class domain. Dark Web and Deep Web sources are intelligence sensors, not trusted authorities and never execution environments.

## F.1 Domain scope

Surface Web, Deep Web, Dark Web, vulnerability intelligence, leak/exposure intelligence, credential-exposure monitoring, threat actors, campaigns, malware intelligence, infrastructure intelligence, indicators of compromise, TTPs, ATT&CK mapping, supply-chain threats, brand/executive threats, and geopolitical cyber risk.

## F.2 Mandatory untrusted-input boundary

SOURCE -> COLLECTION -> AUTHORITY CHECK -> PROVENANCE -> HASH/INTEGRITY -> SANITIZATION -> ISOLATION -> CLASSIFICATION -> CORROBORATION -> CONFIDENCE/UNCERTAINTY -> THREAT ASSESSMENT -> POLICY GATE -> QUARANTINE/ADMISSION -> MEMORY -> DECISION

Forbidden direct paths:
DARK WEB -> TRUSTED MEMORY
DARK WEB -> EXECUTION
DARK WEB -> PAYMENT
DARK WEB -> CREDENTIAL STORE
DARK WEB -> AUTHORITY ESCALATION

## F.3 Evidence contract

Threat intelligence records require, as applicable: source type, collection authorization, timestamp, content hash, provenance, source reliability, information credibility, confidence, uncertainty, corroboration, technical-indicator verification, affected-asset correlation, classification, and expiry/retention information.

High-impact attribution requires independent corroboration. Conflicted, stale, or provenance-uncertain claims remain CONFLICTED or INCONCLUSIVE.

## F.4 Dark Web safety policy

Permitted defensive activities include lawful collection, monitoring, metadata collection, exposure monitoring, correlation, analysis, reporting, IOC/TTP extraction, vulnerability intelligence, and risk assessment.

The subsystem blocks purchase of stolen data or credentials, malware/exploit acquisition, credential use, unauthorized intrusion, persistence, exfiltration, criminal transactions, and unauthorized deanonymization. Unknown operations fail closed.

## F.5 Hostile-content boundary

Dark Web pages, posts, files, scripts, instructions, and embedded content are hostile input by default. They are data, not executable authority. Prompt injection and malicious payloads are explicit verification targets.

## F.6 Fault surface

The authoritative fault surface is F01-F49.

F43 poisoned intelligence
F44 malicious payload
F45 false attribution
F46 stale leak
F47 correlated false reporting
F48 prompt injection
F49 provenance spoofing

Each fault requires activation evidence, observable propagation, independent oracle discrimination, and recovery semantics before receiving empirical detection credit.

## F.7 Correlation rule

A single Dark Web claim must not directly drive a critical decision when independent corroboration is reasonably obtainable.

Preferred correlation:
DARK WEB CLAIM <-> GOVERNMENT/SURFACE CTI <-> CVE/VULNERABILITY DATA <-> IOC/TTP <-> OWN ASSET/TELEMETRY <-> BUSINESS IMPACT

Mismatch produces CONFLICTED or INCONCLUSIVE rather than forced consensus.

## F.8 Memory admission

Threat intelligence enters trusted memory only through a versioned admission contract. Verified and corroborated intelligence is initially an ADMIT_CANDIDATE, not an unconditional truth claim. Unresolved intelligence remains quarantined.

## F.9 Verification obligations

Next empirical stages:
1. concrete F43-F49 campaigns;
2. source-level mutation testing;
3. persistent memory-poisoning tests;
4. multi-agent propagation tests;
5. supply-chain/artifact provenance tests;
6. end-to-end correlation tests;
7. independent fresh-context reproduction;
8. controlled sandbox validation before live external collection.

## F.10 Governing rule

Dark Web is a sensor, never an authority. Intelligence can inform a decision only after provenance, safety, evidence quality, corroboration, and policy gates are satisfied.


---

# Appendix G — 2026-10-06 Evidence Update: Persistent Memory, Identity/Authority, and Runtime Baseline

Added: 2026-10-06
Status: EVIDENCE-DRIVEN AMENDMENT — architecture strengthened; declared harness and current regression PASS; broader real-world verification remains pending.

## G.1 New empirical evidence affecting the threat model

Recent 2026 research reports that persistent memory can carry prompt-injection payloads across sessions and that memory-poisoning attacks can preserve benign task performance while still producing cross-session malicious behavior. A September 2026 study specifically evaluated Persistent Memory Poisoning against OpenClaw and Claude Code and reported substantial injection and cross-session attack success under its experimental conditions. These findings do not prove a vulnerability in this implementation, but they materially raise the required assurance bar for persistent memory.

Therefore the Master Brain must treat memory as a security boundary, not merely a storage feature.

## G.2 Required memory security chain

UNTRUSTED INPUT
-> MEMORY CANDIDATE
-> PROVENANCE / INTEGRITY
-> CONTENT CLASSIFICATION
-> ADMISSION POLICY
-> DURABLE PERSISTENCE
-> RESTART
-> RETRIEVAL SCOPE
-> RE-AUTHORIZATION
-> AGENT CONTEXT
-> DECISION
-> EXECUTION GATE
-> INDEPENDENT ORACLE

A record passing admission once is not by itself sufficient evidence for unrestricted future use.

## G.3 Identity and authority strengthening

NIST'''s 2026 agent-identity work emphasizes that model-only guardrails are insufficient and that agent identification, authentication, authorization, and auditing need explicit system-level treatment. The architecture therefore retains authority as an independent control plane and does not allow model output, memory content, or threat intelligence to grant authority by implication.

## G.4 OpenClaw baseline policy

As of this amendment, the official release list shows OpenClaw 2026.9.8 as the stable release and 2026.10.1-beta.1 as a pre-release. The verification baseline remains 2026.9.8. The beta is not promoted merely because it is newer. Any future promotion requires runtime baseline verification, compatibility checks, full regression, recovery verification, and release-integrity evidence.

## G.5 New verification interpretation

The campaign oracle distinguishes:
- system FAIL as a deliberate safety outcome;
- test FAIL as an incorrect implementation/oracle result;
- INCONCLUSIVE as insufficient or conflicting evidence;
- PASS as evidence that the declared property held under the tested conditions.

This distinction is mandatory for long-horizon adversarial campaigns.

## G.6 Next empirical obligation

The highest-priority campaign is a real durable cross-session memory attack in an isolated test workspace: inject hostile data, attempt persistence, terminate the process, restart in a fresh context, retrieve memory, propagate through multiple agents, attempt execution, and independently verify every transition. A successful defense must prevent unauthorized propagation or execution without manufacturing evidence or silently deleting the attack trace.

## G.7 Governing statement

**Persistent memory is an attack surface. Identity and authority are system controls. Newer software is not automatically safer. Evidence must determine promotion.**


---

# Appendix H — 2026-10-06 Global Intelligence Mesh Assurance Amendment

Added: 2026-10-06
Status: IMPLEMENTED + FRESHLY REGRESSION-VERIFIED; broader live-source verification remains pending.

## H.1 Purpose

The Global Intelligence Mesh is strengthened from source selection into an assurance layer that evaluates source reliability, evidence freshness, lineage, contradiction, corroboration, fusion, and adaptive source expansion.

The mesh remains source-agnostic. It may use Open Web, official sources, news, social media, video, TV, radio, podcasts, forums, academic literature, patents, government/regulatory sources, markets, industry sources, Deep Web, Dark Web, and authenticated internal data when relevant and lawful.

## H.2 Source reliability

Every source observation receives a bounded reliability assessment. Reliability is not equivalent to truth.

The assessment considers source class, historical reliability, collection quality, independence, and provenance. Unknown provenance reduces usable evidence; spoofed or corrupted provenance is a hard failure.

## H.3 Freshness

Evidence receives an explicit freshness assessment. Freshness is domain-sensitive and uses a declared half-life rather than an arbitrary global expiration rule.

Stale evidence may remain useful as historical context but must not silently retain the same decision weight as current evidence.

## H.4 Lineage and corroboration

The mesh distinguishes independent corroboration from duplicated reporting.

Multiple articles, posts, or broadcasts that inherit the same underlying claim are one lineage, not independent confirmation. Independent lineages may increase corroboration confidence when provenance and evidence quality are verified.

## H.5 Contradiction engine

Mutually exclusive verified claims remain CONFLICTED. The engine must not select a winner merely because one source is more convenient, more recent, more popular, or more aligned with a requested outcome.

Resolution requires additional evidence, source-quality analysis, or an explicit decision policy.

## H.6 Evidence fusion

Evidence fusion may increase confidence only when provenance, lineage, freshness, and contradiction state permit it.

The fusion layer must preserve UNKNOWN, INCONCLUSIVE, and CONFLICTED states. Confidence scores never authorize execution by themselves.

## H.7 Dynamic source expansion

Source collection is adaptive rather than indiscriminate.

When uncertainty remains high or critical evidence roles are missing, the mesh may expand the source set toward high-value sources such as official/primary records, current search, technical literature, market data, industry sources, or threat-intelligence sensors.

The system must not interpret "search everywhere" as "trust everything."

## H.8 Dark Web

Dark Web remains a first-class intelligence sensor for exposure monitoring, threat intelligence, leak signals, adversary intelligence, and other lawful defensive research.

The governing rule remains:

**DARK WEB = SENSOR, NEVER AUTHORITY.**

Dark Web observations pass through provenance, authorization, sanitization, payload safety, freshness, reliability, corroboration, contradiction, and policy gates before influencing a critical decision.

Direct paths remain forbidden:

DARK WEB -> TRUSTED MEMORY
DARK WEB -> EXECUTION
DARK WEB -> PAYMENT
DARK WEB -> CREDENTIAL STORE
DARK WEB -> AUTHORITY ESCALATION

## H.9 Adversarial testing

The intelligence mesh is explicitly tested against poisoned provenance, malicious payloads, correlated false reporting, stale intelligence, false attribution, prompt injection, and cross-agent intelligence laundering.

Where the user owns or is explicitly authorized to test the target, controlled security testing/red-teaming may be used to validate containment. Unauthorized intrusion, credential theft, persistence, exfiltration, or criminal acquisition remain outside the system's permitted execution boundary.

## H.10 Current implementation evidence

The new assurance module covers:
1. source reliability;
2. freshness;
3. lineage;
4. contradiction detection;
5. evidence fusion;
6. dynamic source expansion;
7. adaptive intelligence campaign containment.

Focused tests: 7/7 PASS.
Fresh routing + verification regression on 2026-10-06: **228/228 PASS**, 0 failures, 0 cancelled, 0 skipped, exit code 0. The regression includes provider health/freshness/integrity admission and independence-group routing controls.
Runtime baseline observed during the same regression: Node v24.21.0 and OpenClaw 2026.9.8.

## H.10a 2026-10-06 Evidence Refresh — Agent Identity, Token Security, and Model Routing

The design baseline is refreshed against current 2026 public guidance and engineering evidence. NIST's September 2026 agent identity work emphasizes explicit agent identification, authentication, and authorization; NIST IR 8587 (final September 15, 2026) emphasizes token verification, key management, lifecycle controls, continuous monitoring, and short-lived workload credentials. The routing architecture is also consistent with current model-neutral routing practice: NVIDIA NeMo Switchyard separates routing logic from provider endpoints and uses capability, cost, latency, infrastructure health, and workload signals to select among models.

Design consequences adopted by Master Brain:
1. Agent identity and authorization remain distinct from model capability.
2. Consequential authorization must be bounded, auditable, revocable, and sender/intent bound.
3. Static/shared credentials cannot serve as accountable authorization; credential sharing is rejected.
4. Provider/model routing must remain provider-neutral and health/freshness/integrity aware.
5. Independent corroboration must account for common provider/lineage dependencies; correlated sources do not count as independent merely because their API endpoints differ.
6. Unknown, stale, conflicted, or unverified signals remain unresolved and cannot silently promote a decision or execution.
7. Dark Web intelligence remains a first-class sensor with no direct authority path to trusted memory, credentials, payment, or execution.

Evidence status: implementation regression verified locally; external standards and engineering references are evidence for design alignment, not proof of universal correctness.

## H.11 Security Coverage Gap Engine

The system now has an explicit **Security Coverage Gap Engine**. Its purpose is not merely to count tests, but to identify security requirements that are **VERIFIED, PARTIAL, UNTESTED, or UNKNOWN** and to prevent critical unresolved coverage from being reported as ready.

The initial coverage registry includes:
1. Web/API execution boundaries;
2. identity, authorization, and revocation;
3. indirect prompt injection;
4. memory poisoning and provenance;
5. multi-agent propagation and trust boundaries;
6. long-horizon state/sequence behavior;
7. crash/recovery and independent comparison;
8. supply-chain/artifact provenance;
9. Dark-Web intelligence provenance/corroboration/payload isolation;
10. tool poisoning and response sanitization;
11. authority propagation and scope attenuation.

The engine preserves **UNKNOWN** and **CONFLICTED** evidence rather than silently converting it to UNTESTED or PASS. A critical requirement is considered ready only when all required evidence roles are verified. This creates an explicit mechanism for discovering what the verification program has **not yet demonstrated**, rather than treating the current test suite as the universe of possible failures.

Current focused coverage-gap tests: **4/4 PASS**.

## H.12 Scientific/professional alignment

This amendment is consistent with current 2026 security guidance emphasizing explicit agent identity/authorization, token lifecycle protection, continuous monitoring, and the inadequacy of model-only guardrails. It also reflects recent research showing persistent memory can become a cross-session attack surface.

## H.13 Remaining empirical obligations

1. Live multi-source collection in an isolated workspace.
2. Real cross-source lineage reconstruction.
3. Freshness calibration by domain.
4. Real misinformation/correlated-reporting campaign.
5. Persistent Dark-Web-to-memory poisoning campaign using synthetic authorized data.
6. Multi-agent intelligence laundering campaign.
7. Supply-chain and artifact provenance testing.
8. Independent fresh-environment reproduction.
9. Controlled authorized red-team against the complete mesh boundary.
10. Periodic revalidation as threat research and source ecosystems change.

## H.13 Governing statement

**Collect broadly when useful. Trust narrowly. Correlate independently. Preserve uncertainty. Treat Dark Web as a sensor. Attack the system only inside an authorized test boundary. Let evidence, not volume, determine confidence.**


## H.14 2026-10-06 Verification Refresh — Out-of-Band Enforcement, JIT Credentials, and Current Regression

This amendment records a fresh implementation verification pass after the 2026-10-06 security-hardening work. The runtime baseline observed is Node v24.21.0 with OpenClaw 2026.9.8 (fc23bc8).

### H.14.1 External evidence alignment

1. NIST IR 8587 (final, September 15, 2026) reinforces explicit token verification, key management, lifecycle controls, revocation, and continuous monitoring for identity and authorization infrastructure.
2. NIST's September 29, 2026 agent identity work reinforces explicit identification, authentication, and authorization of AI agents rather than treating model capability as authority.
3. Current engineering guidance from NVIDIA's September 28, 2026 Open Agent Safety Platform emphasizes independent/out-of-band enforcement, sandboxed runtime isolation, verifiable policy, and continuous monitoring outside the model's control plane.
4. NVIDIA's July 2026 agent-security guidance further emphasizes deterministic access control, sandboxing, default-deny network egress, and keeping secrets outside the agent's reach.

These sources are design-alignment evidence, not proof of universal correctness.

### H.14.2 Implementation controls verified

The implementation now explicitly covers:
- independent out-of-band enforcement for protected effects;
- rejection of in-band model policy as sufficient authorization for protected effects;
- bounded JIT credentials with valid lifetime, audience, scope, and sender binding;
- rejection of wildcard JIT scope for consequential actions;
- provider-neutral model routing with health, freshness, integrity, provenance, and independence-group controls;
- Dark Web as a sensor only, with provenance, sanitization, corroboration, contradiction, payload-safety, and isolation gates;
- authorized red-team testing only inside an explicitly authorized target boundary;
- preservation of UNKNOWN and CONFLICTED states rather than forced promotion.

### H.14.3 Fresh local regression

A fresh full local Node test run on 2026-10-06 completed with **222/222 PASS**, 0 failures, 0 cancelled, 0 skipped, exit code 0, in approximately 5.91 seconds. The run included provider routing, out-of-band enforcement, JIT credentials, Dark-Web intelligence controls, 49 declared fault profiles, deterministic adversarial fuzzing, mutation controls, state/sequence/interaction coverage, and real crash/recovery campaigns.

This is an **implementation-level empirical verification result for the executed test set**, not a universal security claim. The earlier 228/228 figure remains historical evidence and is not overwritten by this refresh.

### H.14.4 Remaining empirical boundary

The system must continue to distinguish synthetic/local verification from live-world assurance. Remaining obligations include independent fresh-environment reproduction, live multi-source Dark-Web/CTI collection in an isolated workspace, real lineage reconstruction, freshness calibration, broader supply-chain/artifact provenance testing, and controlled authorized red-team testing of the complete deployed mesh.


## H.15 2026-10-06 Verification Refresh — MCP Coverage Synchronization

This amendment records a second fresh verification pass focused on alignment between the implemented MCP security controls and the formal Security Coverage Gap Registry.

### H.15.1 Standards alignment

Current OWASP MCP Security guidance explicitly identifies tool/schema integrity, supply-chain integrity, least-privilege scope, sandboxed execution, input/output validation, audience validation, Origin validation, replay protection, cross-server isolation, secret protection, and audit/monitoring as relevant MCP security boundaries. NIST IR 8587 (final September 2026) reinforces token verification, key management, lifecycle controls, revocation, and continuous monitoring. These references inform the control model but do not establish universal correctness.

### H.15.2 Corrective change

A registry-to-implementation mismatch was identified: the MCP runtime enforcement already contained 15 independently evaluated security roles, while the Security Coverage Gap Registry declared only 9 of them. The registry has now been synchronized to require all 15 roles:

1. server_identity
2. server_artifact_integrity
3. dependency_integrity
4. tool_provenance
5. response_sanitization
6. scope_enforcement
7. command_execution_boundary
8. audit_telemetry
9. tool_definition_integrity
10. replay_transaction_binding
11. cross_server_flow_control
12. schema_validation
13. origin_validation
14. audience_binding
15. secret_leakage_control

The correction prevents the coverage engine from reporting MCP readiness while an independently enforced MCP security boundary remains outside the denominator.

### H.15.3 TDD evidence

The new registry-alignment test was intentionally added first and observed failing: the implementation exposed 15 controls while the registry exposed only 9. The registry was then minimally corrected. The focused test subsequently completed with 5/5 PASS.

### H.15.4 Fresh full regression

A fresh full local Node test run on 2026-10-06 completed with **228/228 PASS**, 0 failures, 0 cancelled, 0 skipped, exit code 0, in approximately 6.31 seconds. The run included the newly added MCP coverage-registry assertion plus the existing provider-routing, out-of-band enforcement, JIT credential, Dark-Web intelligence, fault-injection, mutation, state/sequence/interaction, and real crash/recovery controls.

This is scoped implementation-level empirical evidence for the executed local test set. It is not a universal security claim and does not convert unresolved live-world obligations into VERIFIED status.

### H.15.5 Token/key lifecycle boundary

NIST IR 8587's final guidance was reviewed against the existing token lifecycle controls. Current runtime checks already cover issuer trust, signature/integrity, temporal validity, revocation, audience, bounded scope, consequential-action sender binding, and sender-binding identity matching. A separate explicit short-lived-token/key-rotation policy should be added only with a corresponding failing test, implementation, and fresh verification; it is therefore recorded as a **future hardening requirement**, not falsely marked as implemented here.


## H.16 2026-10-06 Verification Refresh — Workload Token Lifetime and Key-Rotation Enforcement

A further standards-driven hardening pass was completed against the workload-identity/token lifecycle boundary. NIST IR 8587 (final, September 2026) was reviewed for token protection, key management, lifecycle, revocation, and monitoring requirements. The implementation previously verified issuer trust, signature/integrity, temporal validity, revocation, audience, bounded scope, consequential-action sender binding, and sender identity matching, but did not yet enforce an explicit policy-controlled short-lived-token bound or key-rotation evidence.

### H.16.1 TDD evidence

A new focused behavioral test was introduced for policy-demanded short-lived tokens and verified signing-key rotation lifecycle. The test initially failed because an overlong token was accepted as PASS. The minimum runtime change then added:
- policy-controlled maximum token lifetime enforcement;
- explicit incomplete evidence handling for short-lived lifetime policy;
- VERIFIED/UNKNOWN/FAILED key-rotation lifecycle semantics;
- fail-closed behavior when required rotation evidence is absent or failed.

The focused runtime-assurance suite subsequently completed with **20/20 PASS**.

### H.16.2 Full regression

A fresh full local verification run completed with **229/229 PASS**, 0 failures, 0 cancelled, 0 skipped, exit code 0, approximately 6.13 seconds. This includes the new workload-token lifetime/key-rotation tests in addition to the existing MCP, provider-routing, out-of-band enforcement, Dark-Web intelligence, fault-injection, mutation, state/sequence/interaction, and crash/recovery controls.

### H.16.3 Verification boundary

The new control is **policy-demanded**, not a universal hard-coded lifetime. Different trust domains may legitimately require different maximum lifetimes. The system therefore enforces the bound only when the policy explicitly requests short-lived credentials, preserving provider/domain neutrality while preventing a policy-required lifecycle control from being silently ignored.

This remains scoped implementation-level empirical evidence. It does not establish universal correctness, cryptographic implementation certification, or live-world security assurance.


## H.17 2026-10-06 Evidence-Quality Hardening — External Security Scanner Results

Fresh 2026 research was reviewed against the verification architecture. NIST emphasizes independently governed identity, authorization, auditing and non-repudiation for agentic systems, while OWASP's MCP guidance treats tool output and third-party execution evidence as untrusted unless independently verified. A July 2026 ecosystem-scale MCP study also found substantial disagreement and false-positive limitations in scanner results, demonstrating that scanner output should not be treated as sufficient evidence of security readiness.

### Required policy

External scanner findings are **evidence inputs, not authorities**. A scanner result alone must not promote a CRITICAL security requirement to VERIFIED. Readiness requires independently verifiable provenance and, where the property permits, independent corroboration or observation. Supplier assertions and scanner assertions remain distinguishable from independently re-checkable evidence.

### Current implementation status

The existing architecture already enforces independent reference models, process oracles, evidence provenance, conflict preservation, and critical readiness gates. A dedicated scanner-evidence admission function is therefore recorded as the next hardening item; it must be introduced with a failing test first and must not be represented as implemented until that RED → GREEN cycle and full regression are observed.

Status: **HARDENING PENDING — NOT CLAIMED VERIFIED**.


## H.18 2026-10-06 Verification Refresh — External Scanner Evidence Gate Implemented

H.17's pending hardening item was executed using a recorded RED → GREEN cycle.

### RED
A focused behavioral test was created first against the existing MCP security boundary. The test failed because `evaluateExternalSecurityEvidence` did not exist as an independently enforceable admission function. Node reported a missing named export and the focused test exited non-zero.

### GREEN
The minimum implementation was added to the MCP security harness. External scanner evidence now follows these semantics:
- scanner provenance not VERIFIED → INCONCLUSIVE;
- clean scanner result without independent review → INCONCLUSIVE;
- clean scanner result without independent corroboration → INCONCLUSIVE;
- independently reviewed and independently corroborated clean result → PASS;
- reported security risk → FAIL;
- insufficient or unclassified external evidence → INCONCLUSIVE.

The implementation deliberately does not grant scanner output authority over the Master Brain's independent Oracle, policy, authorization, or execution gates.

### Verification
Focused test: **1/1 PASS**.
Fresh full regression: **230/230 PASS**, 0 failures, 0 cancelled, 0 skipped, exit code 0, approximately 6.15 seconds.
Runtime baseline remained PASS: Node v24.21.0; OpenClaw 2026.9.8 (fc23bc8).

### Claim boundary
This verifies the implemented evidence-admission behavior in the executed test set. It does not certify any particular third-party scanner, nor does it establish universal security correctness. Scanner output remains an evidence source whose claims must pass provenance, independent review/corroboration, and the existing verification architecture.


## H.19 2026-10-06 Verification Refresh — MCP Host Validation and Resource Controls

This amendment records a standards-driven hardening pass against the MCP security boundary. Current OWASP MCP guidance recommends validating request Origin and Host boundaries, enforcing least privilege, and applying resource controls such as rate limits, quotas, and timeouts at appropriate session/tenant boundaries. These references inform the design; they do not establish universal correctness.

### H.19.1 RED — Host validation

A focused TDD case was added for an unexpected Host while Origin and Audience remained valid. The existing implementation initially did not enforce Host as an independent security boundary, so the test correctly exposed the gap.

### H.19.2 GREEN — Host validation

The MCP security harness now treats Host validation as an independently required role:
- unexpected/invalid Host → FAIL;
- missing or unverified Host evidence → INCONCLUSIVE;
- verified Host is required for PASS.

The MCP Security Coverage Gap Registry was synchronized so Host validation cannot exist in runtime enforcement while remaining outside the formal coverage denominator.

### H.19.3 RED — Resource controls

A second TDD case was added for per-session/tenant resource controls. Before implementation, both an unverified resource-control state and an explicitly violated state incorrectly reached PASS, demonstrating that this boundary was absent from the runtime gate.

### H.19.4 GREEN — Resource controls

The MCP harness now treats resource controls as an independently required security role:
- explicit violation → FAIL;
- missing/unverified evidence → INCONCLUSIVE;
- verified resource controls required for PASS.

The implementation deliberately does not hard-code a universal numeric rate limit, quota, or timeout. Those values remain policy/domain dependent; the security gate instead requires evidence that the applicable resource-control policy is verified.

### H.19.5 Coverage synchronization

The MCP Security Coverage Gap Registry now contains 18 independently enforced roles:
1. server_identity
2. capability_attestation
3. server_artifact_integrity
4. dependency_integrity
5. tool_provenance
6. response_sanitization
7. scope_enforcement
8. command_execution_boundary
9. audit_telemetry
10. tool_definition_integrity
11. replay_transaction_binding
12. cross_server_flow_control
13. schema_validation
14. origin_validation
15. host_validation
16. resource_controls
17. audience_binding
18. secret_leakage_control

### H.19.6 Verification evidence

Focused MCP + coverage regression: **22/22 PASS**, 0 failures, 0 cancelled, 0 skipped.

A historical full local Node regression recorded in an earlier run was **374/374 PASS**; that result is not treated as the current authoritative regression because it was not reproduced in the latest fresh environment run.

The latest authoritative fresh local Node regression is **244/244 PASS**, 0 failures, 0 cancelled, 0 skipped, exit code 0, approximately 6.46 seconds. Runtime baseline observed in that fresh run: Node v24.21.0; OpenClaw 2026.9.8 (fc23bc8).

The full regression also retained the existing 49-fault campaign, deterministic adversarial fuzzing, mutation controls, state/sequence/interaction coverage, real crash/recovery experiments, Dark-Web intelligence gates, provider/model routing, token lifecycle, out-of-band enforcement, external scanner evidence gate, process Oracle, and verification-ledger controls.

### H.19.7 Claim boundary

This amendment establishes **scoped implementation-level empirical evidence** for the executed local test suite. It does not certify MCP deployments in the live world, prove the absence of unknown vulnerabilities, certify third-party servers, or establish universal security correctness.

The next hardening cycle should prioritize independent observation of resource-control behavior (not merely policy declaration), fresh-environment reproduction, and live/deployed MCP boundary testing where an authorized isolated environment is available.


---

# H.20 — Formal Assurance Layer (2026-10-06)

**Status:** IMPLEMENTED AS A SCOPED BOUNDED-ASSURANCE KERNEL; FORMAL COMPLETENESS NOT CLAIMED

The Master Brain verification architecture now includes a dedicated Formal Assurance layer. Its purpose is to establish properties that can be expressed over a finite, explicitly declared state/transition model, rather than treating empirical test coverage as proof.

## H.20.1 Assurance hierarchy

The system distinguishes:

1. **Formal proof / model checking** — property proven for the complete declared model under explicit assumptions.
2. **Bounded formal assurance** — property checked over an explicitly enumerated finite model; this is the current implementation baseline.
3. **Empirical verification** — observed behavior across executed tests and fault scenarios.
4. **INCONCLUSIVE** — model, assumptions, observability, or evidence are insufficient.

A bounded result must never be promoted to universal correctness.

## H.20.2 Current implementation

Implementation:
master_brain/verification/harness/formal-assurance.mjs

Current property:

- AUTHORITY_NON_ESCALATION

Current checks include:

- explicit non-empty assumptions;
- explicit finite state set;
- explicit transition set;
- explicit invariant set;
- invariant violation detection;
- parent/child scope containment;
- deterministic PASS / FAIL / INCONCLUSIVE semantics.

The kernel is independent of the SUT decision, permission, execution, and verification functions. It consumes a declared model and does not import SUT authority logic.

## H.20.3 Required semantics

PASS means the declared property holds for the supplied finite model and declared assumptions.

FAIL means a declared invariant or modeled transition violates the property.

INCONCLUSIVE means the property cannot be established because the model, assumptions, or required evidence are incomplete.

No missing state or transition may silently be treated as safe.

## H.20.4 Expansion roadmap

Formal Assurance must progressively add independently specified properties where the semantics are sufficiently formalizable:

- scope containment;
- authority non-escalation;
- token lifecycle validity;
- intent binding;
- authorization monotonicity;
- transaction idempotency;
- recovery safety;
- snapshot/journal consistency;
- critical state-machine invariants;
- temporal properties where a suitable formal model exists.

Each new property requires its own RED → GREEN → REFACTOR cycle and independent evidence.

## H.20.5 Non-claim rule

Formal Assurance does not establish universal correctness of Master Brain. It establishes only the strongest claim supported by the formal model, assumptions, and proof/verification method actually used.

FORMAL ASSURANCE ≠ UNIVERSAL CORRECTNESS

BOUNDED MODEL PROOF ≠ PROOF OF THE OPEN-WORLD SYSTEM

UNKNOWN MODEL COVERAGE → INCONCLUSIVE

## H.20.6 Acceptance gate

A formal-assurance property is accepted only when:

- the property is explicitly defined;
- assumptions are explicit;
- the model is independently specified;
- violations are represented as FAIL;
- incomplete models are represented as INCONCLUSIVE;
- the implementation does not import the SUT decision logic;
- focused TDD RED and GREEN evidence exists;
- the full regression suite remains green;
- the claim scope is documented.

This amendment is subordinate to user authority and does not modify safety, authorization, or governance rules.
## H.21 — Dynamic Model Pool Baseline and Expansion (2026-10-06)

The Master Brain model layer SHALL use a **minimum qualified model pool of 6** as its architectural baseline. Six is a floor, not a ceiling.

### H.21.1 Baseline
- minimum_models = 6
- The six models MUST be qualified for the task's required capabilities and risk level.
- If fewer than six qualified models are available, the model-pool decision MUST fail closed rather than silently lowering the baseline.

### H.21.2 Dynamic Expansion
The Model Router MAY expand the active pool beyond six when justified by:
- model disagreement,
- evidence conflict,
- critical/high decision risk,
- explicit task requirements,
- insufficient confidence,
- specialist capability requirements,
- or other registered expansion signals.

The pool MAY expand as:
6 → 8 → 10 → 15 → N

There is no architecture-level hard ceiling. Operational limits MAY be imposed by policy, budget, latency, provider availability, or resource controls.

### H.21.3 Independence
A larger count does not automatically mean a larger independent evidence base. Provider, model-family, infrastructure, training, and other correlation metadata SHALL be considered when assessing independence.

### H.21.4 Decision Semantics
Model count SHALL NOT be treated as majority-vote correctness. Model outputs remain evidence inputs to:
Cross-Check → Devil's Advocate → Independent Oracle → Decision Engine.

### H.21.5 Current Implementation
Implemented through:
- master_brain/routing/model-pool.mjs
- routeTaskWithModelPool(...)
- focused tests covering six-model baseline, dynamic expansion, configured maximum, and fail-closed behavior.

Status:
**IMPLEMENTED — BOUNDED DYNAMIC MODEL-POOL CONTROL; PROVIDER/MODEL AVAILABILITY IS ENVIRONMENT-DEPENDENT.**


# H.22 — Dark-Web Intelligence Specialist Base-6 Seat (2026-10-06)

### Decision

The Base-6 model pool retains **six as the minimum number of qualified independent model seats**, but one seat may be reserved as a **Dark-Web / Threat-Intelligence Specialist capability seat** when the task requires that capability.

This is a capability requirement, not a brand-name requirement. The selected specialist may be:

- a domain-specific model;
- a domain-adapted general model;
- a model plus a verified domain adapter;
- or, where independently benchmarked and justified, a specialist ensemble.

### DarkBERT status

**DarkBERT** is registered conceptually as a specialist candidate, not as an automatically trusted production model.

The research literature establishes that DarkBERT is a language model pretrained on Dark Web corpora and that domain-specific training can materially improve specialized Dark-Web NLP tasks. However, current 2026 evidence also shows that DarkBERT is not universally best across all Dark-Web intelligence tasks. A recent peer-reviewed Journal of Big Data study reports a domain-adapted ModernBERT/ensemble pipeline outperforming DarkBERT on its evaluated illicit-market classification benchmarks. Separate 2026 research evaluates modern NER models for Darknet-market entity extraction. Therefore, Master Brain must benchmark the actual task before promoting any single Dark-Web model to a production Base-6 seat.

### Qualification gate

A Dark-Web specialist can occupy a production Base-6 seat only when:

1. capability coverage is verified;
2. provider/model provenance is VERIFIED;
3. model/artifact integrity is VERIFIED;
4. availability is ACTIVE;
5. health is HEALTHY;
6. freshness is acceptable;
7. risk compatibility is satisfied;
8. independence from the other selected model seats is established to the required degree;
9. usage/license restrictions permit the intended deployment;
10. task-relevant benchmark evidence is available;
11. safety evaluation covers prompt injection, malicious content, provenance spoofing, false attribution, stale intelligence, and poisoned intelligence;
12. outputs remain untrusted intelligence and cannot directly authorize memory, credentials, payments, or execution.

### Research-only restriction

If a candidate has research-only, non-profit, access-controlled, or otherwise incompatible usage terms, it cannot silently enter the production Base-6. It remains a CANDIDATE until its deployment authority and usage rights are independently verified.

The currently published DarkBERT distribution explicitly states that access is request-based and restricted to research/non-profit use. This makes it a valid **research candidate and benchmark target**, but not an automatic production dependency.

### Base-6 selection semantics

When a task requires dark_web_intelligence:

QUALIFIED POOL >= 6
AND
AT LEAST ONE QUALIFIED INDEPENDENT SPECIALIST ROLE
→ Base-6 may proceed

If the specialist capability is unavailable or cannot be represented independently:

→ HOLD / STOP

The system must not weaken the six-model baseline merely because the specialist seat is unavailable.

### Evidence architecture

Dark-Web intelligence follows:

COLLECT → SANITIZE → CLASSIFY → CORROBORATE → CROSS-CHECK → DEVIL'S ADVOCATE → ORACLE → DECISION

Dark-Web output is **SENSOR DATA, NEVER AUTHORITY**.

No Dark-Web model may directly:

DARK WEB → TRUSTED MEMORY
DARK WEB → CREDENTIAL STORE
DARK WEB → PAYMENT
DARK WEB → EXECUTION
DARK WEB → AUTHORITY ESCALATION

without passing the same independent evidence, authorization, and execution gates as every other external source.

### Implementation status

Implemented in master_brain/routing/model-pool.mjs:

- task-level required_specialist_roles;
- specialist-role coverage within the Base-6 selection;
- preservation of independence groups;
- fail-closed behavior when a required specialist role is unavailable;
- exclusion of non-ACTIVE candidates from production routing;
- explicit specialist-role metadata in the model-pool result.

Test: test/routing/dark-web-specialist.test.mjs

Status: **IMPLEMENTED — FOCUSED TESTS VERIFIED; LIVE PROVIDER/MODEL QUALIFICATION REMAINS ENVIRONMENT-DEPENDENT.**

### Scientific basis reviewed 2026-10-06

- Jin et al., DarkBERT: A Language Model for the Dark Side of the Internet (ACL 2023).
- Yazdanjue et al., A language model-driven semi-supervised ensemble framework for illicit market detection across deep/dark web and social platforms (Journal of Big Data, 2026).
- Bakermans et al., Scraping the shadows: Deep learning breakthroughs in dark web intelligence (Array, September 2026).
- OWASP MCP / GenAI security guidance, including tool poisoning, prompt injection, provenance, least privilege, and agentic-system security.

This amendment does not claim that DarkBERT is the best Dark-Web model. It establishes a permanent specialist capability slot and a scientific qualification process so the best currently verified model can occupy that slot.

# H.23 — Cryptographic Trust & Blockchain/DLT Layer (2026-10-06)

The Master Brain SHALL retain a provider-agnostic Trust Layer for cryptographic integrity, provenance, auditability, and independent verification. Blockchain/DLT is an optional anchoring backend, not the Brain, not the authorization engine, and not a source of authority.

### H.23.1 Architecture
- Sensitive evidence remains off-chain/private by default.
- Canonical records MAY be hashed, signed, and committed to Merkle structures.
- Trust records MAY be anchored to a permissioned or permissionless DLT when justified by the threat model and governance requirements.
- The Core SHALL depend on a Trust Interface, not on a specific blockchain implementation.
- Alternative transparency mechanisms MAY be used when they provide equivalent or superior integrity/audit properties.

### H.23.2 Authority Separation
Blockchain/DLT evidence MUST NOT grant, expand, renew, or transfer authorization. A valid anchor can establish integrity/ordering evidence only; execution remains subject to independent authority, policy, intent binding, execution-gate, and verification controls.

### H.23.3 Required Evidence Properties
Critical trust records SHOULD provide, as applicable:
- canonical record representation;
- cryptographic hash;
- signer identity and trust status;
- signature verification;
- key lifecycle/revocation status;
- timestamp/ordering evidence;
- unique transaction/record identifier;
- replay protection;
- anchor status;
- provenance lineage;
- independent verification path.

Missing or conflicting critical evidence SHALL produce INCONCLUSIVE rather than synthetic confidence.

### H.23.4 Privacy
The system SHALL NOT place secrets, credentials, raw sensitive intelligence, private user data, or unnecessary personal information on an immutable public ledger. Off-chain storage plus cryptographic commitments/anchors is the default pattern. Privacy and deletion requirements SHALL be part of ledger selection.

### H.23.5 Blockchain/DLT Selection
Selection SHALL be evidence-based and may consider:
- security model and consensus assumptions;
- finality and reorganization behavior;
- throughput/latency;
- operating and transaction cost;
- permissioning and identity;
- interoperability;
- key management;
- privacy/redaction requirements;
- auditability;
- availability and recovery;
- long-term maintainability.

The system SHALL NOT assume that “blockchain” automatically improves security. The ledger is useful only where its trust properties address a defined threat or verification requirement.

### H.23.6 Verification Tests
The Trust Layer SHALL be tested for:
- tampered record detection;
- invalid signature;
- unknown/revoked signer;
- anchor mismatch;
- conflicting anchors;
- replay/duplicate transaction;
- ordering/timestamp anomalies;
- key rotation;
- revocation;
- ledger recovery;
- Merkle proof verification;
- offline independent verification;
- cross-ledger anchoring where used;
- authority non-escalation;
- privacy/data-minimization violations.

### H.23.7 Current Implementation
Implemented:
- `master_brain/verification/harness/blockchain-trust-layer.mjs`
- `test/verification/blockchain-trust-layer.test.mjs`

Focused verification: **4/4 PASS**.

This verifies the current bounded trust-anchor contract only. It does NOT establish production readiness of a specific blockchain/DLT network, consensus mechanism, key-management system, or end-to-end ledger deployment.

### H.23.8 Scientific/Standards Basis Reviewed 2026-10-06
NIST describes blockchain as a shared, tamper-evident/tamper-resistant ledger and explicitly notes that blockchain properties must be matched to application requirements. NIST also highlights privacy limitations of conventional immutable ledgers and research into redactable DLT designs. Current ISO 23353 work addresses BC/DLT auditing, risks, controls, and audit programs. Current OWASP MCP guidance supports cryptographic pinning, provenance, replay protection where required, least privilege, and independent audit/verification boundaries. NISTIR 8587 (final September 2026) reinforces secure token/key lifecycle, verification, configurability, interoperability, and continuous monitoring.

This amendment preserves the principle:

**BLOCKCHAIN = TRUST/INTEGRITY/AUDIT ANCHOR, NEVER AUTHORITY.**
# H.24 — Multi-Architecture Trust Fabric (2026-10-06)

Master Brain SHALL NOT equate trust architecture with blockchain. It SHALL maintain a composable Trust Fabric and select one or more mechanisms according to threat model, privacy, interoperability, evidence requirements, operating environment, and risk.

### H.24.1 Trust-Fabric Components
The architecture SHALL support, as distinct capabilities:
- signed transparency logs / append-only audit logs;
- hash chains and Merkle evidence structures;
- blockchain / DLT anchoring;
- verifiable credentials and decentralized identity where appropriate;
- threshold / multi-party cryptography for high-value authorization and key custody;
- hardware-backed identity and key protection (HSM/TPM/secure enclave) where available;
- confidential computing / trusted execution environments for sensitive computation where justified;
- zero-knowledge or privacy-preserving proofs where selective disclosure is required;
- content-addressed storage and immutable object/version addressing;
- secure timestamping and independent time/order evidence;
- independent external witnesses/attestors where required.

### H.24.2 Composition
No single mechanism SHALL be treated as universally sufficient. The Trust Fabric MAY compose multiple mechanisms:
Private Evidence -> Canonicalization -> Hash -> Signature -> Merkle Commitment -> Transparency Log -> Optional DLT Anchor -> Independent Witness -> Verification.

Sensitive computation MAY use:
Identity -> Attestation -> Confidential Compute -> Signed Result -> Evidence Commitment -> Independent Verification.

High-value authorization MAY use:
User Authority -> Intent Binding -> Threshold/Bounded Key Control -> Independent Policy -> Execution Gate -> Signed Execution Evidence.

### H.24.3 Architecture Selection
Selection SHALL be evidence-driven:
- single-organization/high-privacy workloads may prefer signed transparency logs and Merkle evidence without public blockchain;
- multi-organization shared trust with durable independent anchoring may justify DLT/blockchain;
- highly sensitive computation may require confidential computing;
- high-value key custody may require threshold cryptography and HSM-backed controls;
- selective disclosure may justify zero-knowledge proofs;
- long-lived audit trails may use external transparency witnesses.

Unknown critical requirements SHALL produce INCONCLUSIVE.

### H.24.4 Security Boundary
Trust mechanisms provide evidence, integrity, identity, attestation, or custody properties. They DO NOT independently grant execution authority. Authorization remains an independent control plane.

### H.24.5 Current Implementation
Implemented:
- master_brain/verification/harness/trust-architecture-selector.mjs
- test/verification/trust-architecture-selector.test.mjs

Focused verification: 4/4 PASS.

This is a bounded architecture-selection kernel, not proof that every listed technology is production-ready. Each concrete implementation requires its own cryptographic, privacy, performance, failure, recovery, and independent-verification tests.

### H.24.6 Governing Principle
USE THE STRONGEST VERIFIED TRUST COMBINATION THAT THE THREAT MODEL JUSTIFIES — NOT THE MOST HYPED TECHNOLOGY.


# H.25 — Evidence-Driven Multi-Architecture Trust Selection Hardening (2026-10-06)

This amendment strengthens H.24 from a component catalog into a fail-closed architecture-selection contract. Master Brain SHALL select Trust Fabric mechanisms from explicit requirements and SHALL NOT infer that any single technology is universally superior.

### H.25.1 Required Inputs
A trust-architecture decision SHALL require, at minimum:
- privacy classification;
- throughput class;
- deletion/modification requirement;
- cross-organization trust requirement;
- participant count;
- sensitive-compute requirement where applicable;
- critical-authorization requirement where applicable;
- privacy-proof/selective-disclosure requirement where applicable;
- agent-identity requirement where applicable;
- independent execution-attestation requirement where applicable.

Missing critical inputs SHALL yield INCONCLUSIVE rather than a default architecture.

### H.25.2 Architecture Mapping
The selector SHALL support composable mechanisms, including:
- MERKLE_EVIDENCE as a common integrity primitive;
- SIGNED_TRANSPARENCY_LOG for appropriate single-operator or high-privacy audit cases;
- DLT_ANCHOR where durable cross-organization shared trust is justified;
- CONFIDENTIAL_COMPUTING for justified sensitive computation;
- THRESHOLD_CRYPTOGRAPHY for critical authorization/key-custody cases;
- HARDWARE_BACKED_KEY_PROTECTION for critical key material where supported;
- ZERO_KNOWLEDGE_PROOF where privacy-preserving proof/selective disclosure is required;
- VERIFIABLE_CREDENTIALS where agent/provider identity assertions require portable verification;
- INDEPENDENT_ATTESTATION where execution or environment claims require an independently verifiable witness.

### H.25.3 Selection Rules
1. Blockchain SHALL NOT be selected merely because it is available or fashionable.
2. Privacy requirements SHALL be allowed to reject conventional public-chain anchoring where immutability or visibility conflicts with deletion/data-minimization requirements.
3. Cross-organization trust MAY justify DLT anchoring, but the ledger remains an evidence/integrity mechanism rather than an authorization source.
4. Critical authorization SHALL require hardware-backed key protection and multi-party/threshold control unless an explicitly verified alternative satisfies the same threat model.
5. Privacy-proof requirements SHALL be able to select zero-knowledge mechanisms without requiring a public blockchain.
6. Agent identity and execution-attestation requirements SHALL be independently representable in the Trust Fabric.
7. Unknown or incomplete critical requirements SHALL produce INCONCLUSIVE.

### H.25.4 Security Boundary
No selected Trust Fabric mechanism, including a valid blockchain anchor, signature, credential, hardware attestation, or proof, SHALL directly grant execution authority. Authority remains governed by the independent authorization, policy, intent-binding, and execution-gate controls defined elsewhere in this specification.

### H.25.5 Verification
TDD red phase was observed before implementation: the enhanced selector tests initially produced **0/4 PASS, 4/4 FAIL**, with failures demonstrating missing hardware-backed protection, zero-knowledge selection, verifiable-credential/attestation selection, and fail-closed handling of incomplete requirements.

After the minimum implementation change, focused enhanced verification produced **4/4 PASS, 0 FAIL**.

Combined focused regression across:
- blockchain trust layer;
- original trust architecture selector;
- enhanced trust architecture selector
produced **12/12 PASS, 0 FAIL**.

These results verify the bounded selector and trust-anchor contracts only. They do not verify the security, performance, privacy, availability, cryptographic implementation, or production readiness of any concrete HSM, TEE, ZK system, credential infrastructure, DLT network, or external witness.

### H.25.6 Scientific/Standards Alignment
The architecture is aligned with current reviewed NIST and OWASP guidance: blockchain provides tamper-evident/tamper-resistant ledger properties but must be matched to application needs; NIST specifically documents privacy tensions with conventional immutable ledgers; current DLT standards work spans identity, access control, privacy/security, interoperability, and threshold cryptography; current MCP guidance emphasizes provenance, cryptographic pinning, least privilege, replay protection where required, strict validation, and independent verification.

### H.25.7 Governing Principle
**TRUST FABRIC IS COMPOSABLE; TECHNOLOGY CHOICE IS EVIDENCE-DRIVEN; AUTHORITY REMAINS INDEPENDENT.**


# H.26 — Trust-Fabric Adversarial Boundary Verification (2026-10-06)

This amendment extends H.25 with adversarial verification of the most important architectural boundary: trust evidence SHALL NOT become execution authority, and incomplete or conflicting trust evidence SHALL fail closed.

### H.26.1 Adversarial Properties
The following properties are now explicitly tested:
- DLT selection never implies execution authorization;
- critical authorization cannot silently degrade to a single-key trust model;
- privacy-proof requirements remain independent of public blockchain selection;
- incomplete critical requirements remain INCONCLUSIVE;
- conflicting or unverified trust anchors remain INCONCLUSIVE.

### H.26.2 Verification Result
Focused combined regression covering blockchain trust, original selector, enhanced selector, and adversarial Trust Fabric boundaries produced **17/17 PASS, 0 FAIL**.

This is stronger evidence than the previous 12/12 selector/trust-anchor run because it adds explicit adversarial boundary cases. It remains scoped empirical verification of the tested contracts, not universal security assurance.

### H.26.3 Required Next Evidence
The next Trust-Fabric verification phase SHALL move beyond selector contracts into concrete implementations and real failure behavior:
- cryptographic signature verification with real key material;
- key rotation and revocation;
- HSM/TPM-backed key operations;
- threshold signing/recovery;
- Merkle inclusion/exclusion proof verification;
- transparency-log consistency and equivocation detection;
- DLT finality/reorganization behavior;
- ZK proof soundness/verification and privacy leakage assessment;
- credential issuance, expiry, revocation, audience and subject binding;
- TEE attestation verification and stale/rollback detection;
- independent witness disagreement and recovery;
- replay, duplicate, ordering, rollback and crash/recovery campaigns;
- cross-tenant and cross-provider isolation.

No concrete Trust-Fabric technology SHALL be promoted to PRODUCTION-QUALIFIED until the relevant implementation-level evidence exists.

### H.26.4 Governing Rule
**A VERIFIED TRUST MECHANISM IS EVIDENCE, NOT AUTHORITY; A MISSING OR CONFLICTING TRUST SIGNAL IS NOT SILENTLY CONVERTED INTO TRUST.**


# H.27 — Real Cryptographic Trust-Record Verification (2026-10-06)

This amendment moves Trust Fabric verification from selector/contract evidence into a real cryptographic implementation boundary.

### H.27.1 Implemented Primitive
A dedicated implementation provides:
- deterministic canonicalization of structured records;
- SHA-256 content digest binding;
- Ed25519 digital signatures;
- signature verification against the supplied public key;
- record-hash verification before signature acceptance;
- revoked-key FAIL behavior;
- unknown/unverified-key INCONCLUSIVE behavior.

### H.27.2 TDD Evidence
RED phase: the focused test suite initially failed because the cryptographic implementation module did not exist (**0/4 tests executable; module-not-found**).

Implementation was then added and the same focused suite was rerun:
**4/4 PASS, 0 FAIL**.

Verified cases:
1. real Ed25519 signature verifies a canonical trust record;
2. post-signing record tampering is detected;
3. a different public key cannot verify the signature;
4. revoked or unknown key evidence fails closed.

### H.27.3 Scope Boundary
This verifies a real cryptographic primitive and its local evidence contract. It does NOT yet verify HSM/TPM key custody, external CA/VC lifecycle, key rotation in production, threshold signing, Merkle proofs, transparency-log consistency, DLT finality, ZK systems, TEE attestation, or distributed recovery.

### H.27.4 Governing Rule
**CRYPTOGRAPHIC VALIDITY IS NECESSARY TRUST EVIDENCE; IT IS NOT BY ITSELF AUTHORIZATION OR PROOF OF REAL-WORLD EXECUTION.**


# H.28 — Cryptographic Key Lifecycle Hardening (2026-10-06)

Trust-record verification is extended from static key verification to lifecycle-aware verification.

### H.28.1 Rules
- A cryptographic signature is accepted only when the verifying key has explicit lifecycle state VERIFIED.
- A REVOKED/retired key cannot validate a current trust record.
- A new verified key may replace an older key without weakening trust semantics.
- Missing lifecycle state is INCONCLUSIVE, never implicitly trusted.
- Key epoch/version SHOULD be bound to the signed record where rotation semantics require it.
- Key rotation SHALL preserve auditability and SHALL NOT silently rewrite historical signatures.

### H.28.2 Verification
Focused lifecycle suite: **2/2 PASS, 0 FAIL**.

Combined cryptographic trust verification now covers real Ed25519 signing/verification plus lifecycle-aware key acceptance, tamper detection, wrong-key rejection, revocation and unknown-state fail-closed behavior.

### H.28.3 Next Required Layer
Before Production-Qualified status, the implementation SHALL add and verify:
- explicit key registry and lifecycle transitions;
- rotation authorization and dual-control for critical keys;
- secure key storage/HSM integration;
- revocation propagation and cache invalidation;
- replay/epoch protection;
- signature algorithm/version agility;
- transparency-log evidence for rotation/revocation;
- recovery after partial rotation;
- independent verifier reproduction.

### H.28.4 Governing Rule
**KEY VALIDITY IS A LIFECYCLE PROPERTY, NOT MERELY A CRYPTOGRAPHIC PROPERTY.**


# H.29 — Merkle Evidence and Append-Only Transparency Verification (2026-10-06)

Trust Fabric now includes a concrete Merkle evidence and append-only transparency implementation.

### H.29.1 Implemented
- deterministic SHA-256 Merkle root construction;
- inclusion-proof construction and verification;
- tampered leaf/proof rejection;
- append-only chained transparency records;
- consistency verification between a prior log view and a later view;
- detection of historical-entry alteration and broken predecessor linkage.

### H.29.2 TDD Evidence
RED phase: focused tests initially failed because the implementation module did not exist (**0/3 executable; module-not-found**).

After implementation, the same focused suite produced **3/3 PASS, 0 FAIL**.

### H.29.3 Scope Boundary
This verifies local Merkle/proof and append-only consistency primitives. It does not yet verify distributed transparency-log equivocation detection, external witness consistency, signed tree heads, checkpoint recovery, large-scale performance, or public DLT anchoring.

### H.29.4 Governing Rule
**INTEGRITY PROOF MUST BE REPRODUCIBLE FROM THE RECORD; A LEDGER CLAIM WITHOUT VERIFIABLE HISTORY IS NOT SUFFICIENT EVIDENCE.**


# H.30 — Distributed Transparency, Signed Tree Heads, and Witness Equivocation Detection (2026-10-06)

This amendment advances H.29 from local append-only evidence to a distributed transparency verification boundary. The design follows the transparency-log model of signed tree heads, consistency evidence, and independent witness comparison, while preserving fail-closed semantics.

### H.30.1 Implemented
- Ed25519-signed Tree Heads;
- independent Tree Head verification;
- monotonic tree-size consistency checks;
- explicit requirement for consistency-proof evidence when a tree grows;
- same-size/different-root equivocation detection;
- independent witness-view comparison;
- missing witness evidence → INCONCLUSIVE;
- witness disagreement → FAIL with explicit EQUIVOCATION classification.

### H.30.2 TDD Evidence
RED phase: the new distributed-transparency suite initially failed at module resolution because the implementation did not exist.

After implementation, the same focused suite produced **5/5 PASS, 0 FAIL**.

Verified cases:
1. independently verifiable signed Tree Head;
2. Tree Head tampering rejection;
3. monotonic consistency with explicit consistency evidence;
4. witness disagreement/equivocation detection;
5. incomplete witness evidence remains INCONCLUSIVE.

### H.30.3 Scientific Alignment
The implementation follows the transparency-log model standardized in RFC 9162, including signed tree-head concepts and consistency verification. Independent witness comparison is treated as an external evidence layer rather than authority. This architecture is consistent with modern transparency systems such as certificate/software transparency, while remaining technology-agnostic.

### H.30.4 Security Boundary
A valid Tree Head does not prove that the underlying log operator is honest; it proves only that the signed statement verifies under the accepted key. Independent witness comparison is therefore required for equivocation detection. Conflicting views SHALL NOT be silently reconciled by choosing one view.

### H.30.5 Next Required Evidence
Before production qualification, verify:
- signed checkpoints and witness persistence;
- non-equivocation across more than two witnesses;
- consistency proofs over realistic tree growth;
- split-view campaigns across concurrent clients;
- crash/restart during checkpoint publication;
- rollback and stale-checkpoint detection;
- key rotation/revocation for transparency signers;
- DLT anchoring of selected checkpoints;
- independent fresh-environment reproduction.

### H.30.6 Governing Rule
**A TRANSPARENCY LOG IS TRUSTWORTHY ONLY WHEN ITS HISTORY IS INDEPENDENTLY VERIFIABLE AND EQUIVOCATION IS DETECTABLE; CONFLICTING VIEWS REMAIN CONFLICTED UNTIL RESOLVED BY EVIDENCE.**


# H.31 — Distributed Transparency Adversarial Hardening and Crypto-Agility Gate (2026-10-06)

This amendment strengthens H.30 using current transparency-log and cryptographic lifecycle guidance. The system SHALL treat signed checkpoints, consistency, witness evidence, timestamps, key lifecycle and algorithm agility as separate verification dimensions.

### H.31.1 New Adversarial Controls
- stale/lower-tree-size checkpoints cannot silently supersede a newer checkpoint;
- timestamp rollback is rejected;
- same-size conflicting roots are classified as EQUIVOCATION;
- missing witness evidence remains INCONCLUSIVE;
- cryptographic signature verification is separate from signer lifecycle trust;
- algorithm identifiers are explicit and SHALL remain replaceable through a crypto-agility mechanism.

### H.31.2 Verification
The combined distributed-transparency baseline and adversarial suite produced **9/9 PASS, 0 FAIL**.

### H.31.3 Current Standards Alignment
RFC 9162 specifies Signed Tree Heads, inclusion proofs and consistency proofs and explicitly treats append-only and consistent log views as auditable properties. NIST IR 8587 (September 2026) emphasizes key management, token verification, lifecycle controls, interoperability and continuous monitoring. NIST CSWP 39-upd1 (June 2026) explicitly addresses crypto-agility as the ability to replace cryptographic algorithms while preserving security and operations. NIST IR 8214C (January 2026) provides a current threshold-cryptography submission/evaluation framework including reference implementations and experimental evaluation.

### H.31.4 Architectural Requirement
Trust Fabric SHALL NOT hard-code Ed25519 as a permanent universal algorithm. Ed25519 is the current verified implementation primitive in this test harness; production deployment SHALL support an explicit algorithm/version registry, migration policy, dual-validation transition where required, and rollback/recovery semantics.

### H.31.5 Next Required Implementation
The next implementation stage SHALL add:
1. explicit signer/key registry;
2. key rotation authorization and dual control;
3. signer revocation propagation;
4. algorithm/version registry and crypto-agility migration;
5. real Merkle consistency-proof generation/verification matching RFC 9162 semantics;
6. multi-witness quorum/evidence policy;
7. checkpoint persistence and crash recovery;
8. DLT checkpoint anchoring;
9. threshold signing implementation and fault injection;
10. fresh-environment independent reproduction.

### H.31.6 Governing Rule
**NO CHECKPOINT MAY BECOME TRUSTED MERELY BECAUSE IT IS SIGNED; TRUST REQUIRES VALID CRYPTOGRAPHY, VALID KEY LIFECYCLE, VALID TEMPORAL/STRUCTURAL CONSISTENCY, AND SUFFICIENT INDEPENDENT EVIDENCE.**


# H.32 — Explicit Key Registry, Rotation Governance, and Crypto-Agility Baseline (2026-10-06)

This amendment advances Trust Fabric from key-lifecycle semantics to an explicit key registry and rotation-governance implementation.

### H.32.1 Implemented
- explicit key registry with lifecycle state;
- algorithm registry and rejection of unsupported algorithms;
- monotonic key epochs;
- controlled rotation from ACTIVE to RETIRED;
- monotonic revocation;
- independent approval threshold for critical rotation;
- distinct-approver requirement;
- missing/invalid lifecycle evidence remains fail-closed;
- crypto-agility is represented as a registry capability rather than hard-coded permanent algorithm identity.

### H.32.2 TDD Evidence
The first focused implementation run exposed a test-specification defect: the successful rotation case omitted the required independent-approver evidence and correctly failed. The test was corrected to satisfy the declared governance contract, then rerun.

Final focused result: **4/4 PASS, 0 FAIL**.

This is itself a useful verification result: the gate prevented an under-specified critical rotation from passing.

### H.32.3 Scientific/Standards Alignment
NIST's current cryptographic-agility work treats algorithm replacement as a lifecycle and operational capability rather than a one-time algorithm choice. NIST threshold-cryptography work also emphasizes evaluation of implementations rather than relying solely on abstract claims. The Master Brain design therefore keeps algorithm identity, lifecycle, authorization and verification as separate dimensions.

### H.32.4 Required Next Layer
Production qualification still requires:
- tamper-evident persistent registry;
- real rotation transaction journal;
- revocation distribution and cache invalidation;
- HSM/TPM-backed key custody where applicable;
- dual-control/threshold implementation with real key shares;
- signer transparency and witness verification;
- cryptographic migration/dual-validation tests;
- crash recovery during rotation;
- independent fresh-environment reproduction.

### H.32.5 Governing Rule
**A CRITICAL KEY ROTATION IS A GOVERNED STATE TRANSITION; A VALID SIGNATURE OR A MODEL'S ASSERTION CANNOT SUBSTITUTE FOR EXPLICIT LIFECYCLE AND INDEPENDENT AUTHORIZATION EVIDENCE.**


# H.33 — Multi-Party Signed Quorum Baseline Before True Threshold Cryptography (2026-10-06)

This amendment advances the critical-authorization path from policy-only quorum semantics to a real cryptographically verified multi-party approval baseline, while explicitly distinguishing that baseline from a true threshold cryptographic primitive.

### H.33.1 Scientific Rationale

NIST IR 8214C (January 2026) treats threshold cryptography as distributed computation of a cryptographic primitive using secret-shared key material and requires technical specification, reference implementation, and experimental evaluation for submitted schemes. The Master Brain SHALL therefore not label ordinary multi-signature/quorum approval as threshold cryptography.

The current implementation is a staged control:
MULTI-PARTY SIGNED QUORUM → TRUE THRESHOLD CRYPTOGRAPHY

This preserves evidence quality while preventing premature claims.

### H.33.2 Implemented Baseline

- explicit threshold policy with bounded participant set;
- distinct participant requirement;
- real Ed25519 signatures over canonical operation binding;
- signature verification against registered participant public keys;
- operation-hash binding;
- duplicate participant rejection;
- unauthorized participant rejection;
- invalid signature rejection;
- missing public-key evidence → INCONCLUSIVE;
- insufficient verified quorum → INCONCLUSIVE;
- cryptographically verified quorum evidence is classified as MULTI_PARTY_SIGNED_QUORUM;
- the quorum layer cannot itself grant execution authority.

### H.33.3 TDD Evidence

RED phase:
the new focused cryptographic approval suite initially failed because the required implementation exports were absent.

After the minimum implementation was added, the same focused command produced:
8/8 PASS, 0 FAIL.

The passing suite covers:
1. distinct verified signatures satisfy the configured quorum;
2. tampered/wrong-operation approval cannot satisfy quorum;
3. missing public-key evidence remains INCONCLUSIVE;
4. policy quorum semantics;
5. duplicate participant rejection;
6. revoked participant rejection;
7. insufficient quorum fail-closed behavior;
8. invalid threshold-policy rejection.

### H.33.4 Critical Naming Boundary

The current implementation SHALL NOT be described as a true threshold signature, threshold encryption, threshold key-generation scheme, or secret-sharing cryptosystem.

A true threshold implementation requires distributed cryptographic computation with protected/secret-shared key material and an independently evaluated protocol. The current multi-party signed quorum is a safer intermediate layer because each participant signs independently and the resulting evidence can be independently verified.

### H.33.5 Required True-Threshold Gate

Promotion from MULTI_PARTY_SIGNED_QUORUM to TRUE_THRESHOLD_CRYPTOGRAPHY SHALL require:
- a documented threshold protocol and security assumptions;
- reference implementation;
- independent cryptographic review;
- known-good and known-bad test vectors;
- participant/share lifecycle;
- share generation and refresh;
- participant addition/removal/revocation;
- quorum/liveness failure behavior;
- malicious-participant fault injection;
- replay and transcript-binding protection;
- nonce/session safety where applicable;
- recovery after participant loss;
- key rotation;
- performance and resource evaluation;
- fresh-environment independent reproduction;
- explicit algorithm/version registry;
- no single participant possessing the reconstructible private key in normal operation.

### H.33.6 Governing Rule

MULTI-PARTY SIGNED QUORUM IS EVIDENCE OF INDEPENDENT APPROVAL; IT IS NOT, BY ITSELF, THRESHOLD CRYPTOGRAPHY AND IT NEVER BECOMES AUTHORITY WITHOUT THE SEPARATE AUTHORIZATION GATE.


## H.34 — True Threshold Cryptography Qualification Gate (2026-10-06)

### Decision
The Master Brain shall not label ordinary multi-party signatures, quorum approval, or key-splitting alone as true threshold cryptography. H.33 remains the current approval baseline. A true-threshold implementation must use a documented threshold cryptographic protocol in which secret key material is distributed among participants and normal operation does not require reconstruction of a single private key.

### Scientific basis
NIST threshold-cryptography work treats threshold schemes as distributed computation of a cryptographic primitive using distributed/secret-shared key material and expects a technical specification, reference implementation, and experimental evaluation. Therefore the project advances in two explicit stages:

MULTI-PARTY SIGNED QUORUM -> TRUE THRESHOLD CRYPTOGRAPHY

### New qualification registry
Implementation:
master_brain/verification/harness/threshold-protocol-registry.mjs

The registry requires evidence for:
- technical specification
- reference implementation
- test vectors
- independent cryptographic review
- share lifecycle
- malicious-participant tests
- replay/transcript binding
- recovery
- key rotation
- performance/resource evaluation
- fresh-environment reproduction

The gate also requires verified secret sharing and explicitly rejects qualification when normal operation can reconstruct a single private key.

### Qualification states
- PASS: all required evidence is independently verified, protocol is ACTIVE, secret sharing is verified, and normal-operation key reconstruction is excluded.
- INCONCLUSIVE: evidence, lifecycle, protocol status, or security assumptions are incomplete/unknown.
- FAIL: protocol is explicitly revoked/quarantined or otherwise prohibited from deployment.

### TDD evidence
Focused test:
test/verification/threshold-protocol-registry.test.mjs

RED was observed first because the registry implementation was intentionally absent. After implementation: 5/5 PASS, 0 FAIL.

### Promotion gate for a production threshold protocol
Before promotion, the selected protocol must additionally pass:
1. independent cryptographic review;
2. known-good/known-bad vectors;
3. participant/share generation and distribution tests;
4. share refresh and revocation;
5. participant add/remove lifecycle;
6. malicious participant and unavailable participant fault injection;
7. replay/transcript/nonce safety;
8. threshold liveness and quorum-loss recovery;
9. key rotation without unauthorized reconstruction;
10. side-channel/resource and performance assessment appropriate to the threat model;
11. fresh-environment reproduction;
12. explicit algorithm/version/parameter registry;
13. no normal-operation single-party reconstruction of the protected private key.

### Governing rule
A protocol name, publication, library, or vendor claim is evidence to investigate—not authority to promote. The Master Brain promotes a threshold protocol only after the complete evidence gate passes.

H.34 status: IMPLEMENTED — QUALIFICATION GATE + TDD VERIFIED; TRUE THRESHOLD CRYPTOGRAPHY ITSELF REMAINS A SEPARATE IMPLEMENTATION/PROMOTION STAGE.

## H.35 — Multi-Source Evidence Mesh and Threshold Protocol Reassessment (2026-10-06)

### Decision
NIST SHALL remain a high-value standards anchor, but SHALL NOT be treated as the sole scientific authority. Critical technology selection shall use a multi-source evidence mesh spanning standards, protocol specifications, academic research, independent reviews, implementations, benchmarks, real deployments, negative evidence, and independent reproduction.

### Evidence Mesh
The qualification baseline now requires independent evidence classes:
- PROTOCOL_SPEC
- ACADEMIC
- IMPLEMENTATION
- NEGATIVE_EVIDENCE
- REPRODUCTION

Evidence is grouped by independence lineage. Reposts, derivative analyses, or multiple artifacts from the same underlying source SHALL NOT be counted as independent corroboration.

Unresolved negative evidence is FAIL. Missing required evidence is INCONCLUSIVE. Correlated evidence cannot silently promote a technology.

Implementation:
master_brain/verification/harness/evidence-mesh.mjs

Focused TDD:
test/verification/evidence-mesh.test.mjs

Focused result: 4/4 PASS.

### Threshold Protocol Reassessment
Threshold cryptography selection SHALL compare, at minimum:
- FROST and relevant variants;
- adaptive-security alternatives such as Mask-FROST where applicable;
- post-quantum threshold candidates such as TSitH and threshold ML-DSA research;
- MPC-based authorization;
- HSM/quorum architectures;
- hybrid trust architectures.

Comparison criteria include security/adversary model, adaptive security, DKG, share lifecycle/refresh, malicious participants, liveness/DoS, nonce/session/transcript safety, replay resistance, recovery, rotation/revocation, PQC readiness, implementation maturity, independent review, vectors/interoperability, performance/resource cost, licensing/deployment constraints, negative evidence, and independent reproduction.

No protocol is production-qualified merely because it is standardized, published, popular, vendor-supported, or passes a local implementation test.

### Current verification
Focused evidence-mesh + threshold qualification suite: 9/9 PASS.

Full repository regression after the evidence-mesh addition:
444/444 PASS, 0 FAIL, 0 cancelled, 0 skipped; duration ~11.60s.
Runtime observed: Node v24.21.0; OpenClaw 2026.9.8 (fc23bc8).

The regression result verifies the current automated test suite only. It does NOT establish universal correctness, production cryptographic qualification, or live provider/model availability.

### Governing rule
NIST, IETF/IRTF, academia, vendors, implementations, benchmarks, and deployments are evidence sources—not authority by themselves. Master Brain SHALL resolve, preserve, or explicitly surface disagreement rather than manufacture consensus.

H.35 status: IMPLEMENTED — MULTI-SOURCE EVIDENCE-MESH GATE + TDD VERIFIED; THRESHOLD PROTOCOL SELECTION REMAINS A SEPARATE SCIENTIFIC/CRYPTOGRAPHIC QUALIFICATION STAGE.

## H.36 — Scientific Threshold-Protocol Comparative Qualification Layer (2026-10-06)

### Decision
Threshold-cryptography selection is now explicitly separated from threshold-policy enforcement. Named protocols are candidates, not authority. A protocol cannot be promoted merely because it is standardized, published, popular, vendor-supported, or locally implemented.

### Comparative qualification matrix
The minimum comparison matrix is:
- security/adversary model
- adaptive security
- DKG
- share lifecycle/refresh
- malicious-participant robustness
- liveness/DoS
- nonce/session/transcript safety
- replay resistance
- recovery
- rotation/revocation
- PQC readiness
- implementation maturity
- independent review
- test vectors/interoperability
- performance/resource cost
- deployment/licensing rights
- negative evidence
- independent reproduction

Implementation:
master_brain/verification/harness/threshold-protocol-comparison.mjs

TDD:
test/verification/threshold-protocol-comparison.test.mjs

Focused result: 5/5 PASS.

### Promotion semantics
- COMPLETE + independently reproduced + no unresolved negative evidence → QUALIFIED candidate.
- Missing evidence → HOLD.
- Unresolved negative evidence → REJECT.
- Incomplete identity → HOLD.
- Qualification does not itself grant authorization or execution authority.

### Research interpretation
The current evidence refresh confirms that FROST is a serious protocol candidate, but its RFC status, security model, key-generation scope, and deployment maturity must be evaluated rather than assumed. Adaptive-security and post-quantum candidates remain research/comparison candidates until the same evidence matrix is satisfied. No protocol is preselected.

### Verification boundary
This layer verifies the selection/qualification methodology and its fail-closed semantics. It does not claim that FROST, Mask-FROST, TSitH, threshold ML-DSA, MPC, HSM/quorum, or any hybrid architecture is production-qualified.

H.36 status: IMPLEMENTED — COMPARATIVE QUALIFICATION KERNEL + TDD VERIFIED.

## H.37 — Live Scientific Evidence Refresh: Threshold Candidates (2026-10-06)

### Evidence refresh
The live evidence review was refreshed against current 2026 material. The Master Brain MUST keep protocol candidates in HOLD/CANDIDATE status until the full evidence matrix is independently satisfied.

Current research interpretation:
- FROST: strong baseline candidate for two-round Schnorr threshold signing, but RFC 9591 is Informational rather than an Internet Standards Track specification; key generation is outside the core RFC scope; the RFC explicitly does not target post-quantum security or robustness. These are qualification inputs, not automatic rejection.
- Mask-FROST: active adaptive-security research candidate; not production-qualified by publication alone.
- FaFROST: promising adaptive-security/identifiable-abort research candidate; remains unqualified until the complete matrix and independent reproduction pass.
- TSitH: current 2026 post-quantum-oriented research candidate based on MPC-in-the-Head/Merkle commitments; remains unqualified until implementation, review, performance, lifecycle and reproduction evidence mature.
- Threshold ML-DSA/TALUS: active 2026 research candidate; its current evidence includes a revised design responding to a previously identified key-recovery issue, so versioned artifact identity and fresh reproduction are mandatory before promotion.
- FROST2+/other variants: research candidates; any performance/security claim must be tied to the exact version and independently reproduced.
- MPC / HSM-quorum / hybrid authorization: retained as architecture alternatives because the system requirement is threshold authorization, not necessarily threshold signatures.

### Hard rule
No candidate receives PRODUCTION_QUALIFIED status from:
- name recognition;
- NIST/IRTF inclusion;
- a single paper;
- vendor implementation;
- benchmark alone;
- local test vectors alone;
- a single audit;
- majority vote among correlated sources.

The current decision is therefore:
**NO THRESHOLD PROTOCOL IS YET PRODUCTION-QUALIFIED.**

This is a deliberate HOLD, not a failure of the architecture.

### Required next promotion evidence
For each candidate:
1. exact versioned artifact;
2. formal security model and assumptions;
3. DKG/key-generation evidence;
4. share refresh/lifecycle;
5. malicious-participant and liveness evidence;
6. nonce/session/transcript/replay safety;
7. key rotation/revocation/recovery;
8. implementation and interoperability vectors;
9. performance/resource benchmark;
10. independent cryptographic review;
11. negative-evidence review;
12. fresh-environment independent reproduction;
13. deployment/license rights;
14. explicit PQC migration posture.

H.37 status: IMPLEMENTED — LIVE EVIDENCE REFRESHED; ALL THRESHOLD PROTOCOLS REMAIN UNQUALIFIED UNTIL THE COMPLETE PROMOTION GATE PASSES.

## H.38 — Scientific Candidate Update: Adaptive-Security and PQC Evidence Tightening (2026-10-06)

### Live evidence interpretation
The threshold candidate registry is tightened to require exact versioned artifact identity, cryptographic content binding, evidence freshness, an independently evaluated evidence mesh, and explicit verification of security assumptions before any candidate can reach QUALIFIED.

Current evidence refresh:
- FROST remains a strong two-round Schnorr baseline candidate, but RFC 9591 is Informational, key generation is outside the core protocol scope, and deployment suitability must be established separately.
- Adaptive-security analysis has materially changed the evaluation landscape. NIST's 2026 MPTS program documents active work on FROST adaptive security, including the LDVR/AOMDL line of analysis and Mask-FROST.
- FaFROST is a current 2026 research candidate claiming full adaptive security plus identifiable aborts under AOMDL; this claim requires exact artifact capture and independent reproduction before promotion.
- Threshold ML-DSA has active 2026 research, including FIPS-204-compatible constructions and TALUS. The TALUS evidence record is version-sensitive because its 2026 presentation was edited to address a previously identified key-recovery issue; no stale artifact may qualify.
- FROST2+ is a very recent research proposal (October 2026) and therefore receives especially strict freshness, independent review, and reproduction requirements; performance claims are not accepted from the paper alone.
- PQC-oriented threshold approaches and MPC-in-the-head approaches remain candidates rather than defaults.

### New hard qualification requirements
A candidate marked QUALIFIED by the comparative kernel MUST now provide:
1. exact candidate version;
2. VERIFIED artifact status;
3. SHA-256 content binding for the artifact;
4. evidence freshness VERIFIED;
5. evidence mesh PASS with at least three independent lineages;
6. explicit security assumptions VERIFIED;
7. every comparison criterion VERIFIED;
8. independently reproduced evidence;
9. no unresolved negative evidence.

Any failure above produces HOLD, except an explicit unresolved security/negative-evidence risk, which produces REJECT.

### Verification
Focused threshold-comparison regression after hardening: 9/9 PASS.

The hardening verifies the qualification gate, not the cryptographic correctness of any candidate protocol. No threshold protocol is promoted to production by this amendment.

H.38 status: IMPLEMENTED — VERSIONED-ARTIFACT + FRESHNESS + EVIDENCE-MESH + SECURITY-ASSUMPTION GATES TDD VERIFIED.
