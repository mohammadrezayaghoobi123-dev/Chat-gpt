# Fault-Injection & Verification Harness Implementation Plan

> **For agentic workers:** Use the host's available task-by-task implementation workflow. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a safe, deterministic, independently-oracled verification harness that can empirically test Master Brain's critical behavioral, safety, authority, state, recovery, evidence, and control-plane properties without allowing real-world irreversible side effects.

**Architecture:** The harness will sit beside the existing `master_brain/` modules and expose versioned scenario, fault, observation, reference-model, oracle, ledger, and campaign interfaces. Critical execution requests terminate in an isolated execution sink/test double; the independent oracle evaluates specification rules, reference-model expectations, invariants, and observed evidence without invoking SUT decision logic. Campaigns freeze their manifest and adequacy denominators before execution and produce append-only evidence-linked verification records.

**Tech Stack:** Node.js ES modules, built-in `node:test`, `node:assert/strict`, filesystem primitives available in the repository, and the existing `master_brain/` JavaScript modules. No package-manager dependency is required for Stage 0/1 unless repository evidence later proves one necessary.

## Global Constraints

- Do not modify production infrastructure, authority, credentials, external services, or irreversible targets during critical testing.
- All Stage-1 critical execution requests must terminate at the isolated Execution Sink/Test Double, with isolation independently proven before fault injection.
- PASS / FAIL / INCONCLUSIVE are the only oracle results; INCONCLUSIVE must preserve its explicit reason.
- Property result, fault-detection result, and campaign/stage result are separate fields.
- Critical fault activation must be independently observable before fault-detection adequacy is scored.
- An independently observed critical safety violation remains FAIL even when the intended fault activation is INCONCLUSIVE.
- Critical mutation detection applies to all pre-registered killable critical mutations; surviving killable critical mutations fail the gate.
- Coverage denominators and all critical applicability/exclusion decisions are frozen before execution; post-hoc exclusions cannot improve a gate.
- Critical traceability is Requirement → Property → Invariant → Scenario → Stimulus/Fault → Oracle Rule → Evidence → Verification Record.
- Reference Model and Oracle must not call SUT decision functions.
- Unknown and conflicted evidence/state must remain explicit rather than being coerced into PASS/FAIL.
- Exact reproduction requires matching recorded versions, inputs, fault, sequence, policy, environment/dependency manifest and seed where applicable.
- Independent reproduction uses a fresh execution context and must not reuse mutable run state or hidden evidence artifacts.
- Any failed harness self-test blocks dependent critical results.
- No commit, merge, reset, revoke, or infrastructure reconfiguration is part of implementation authorization; commits are only performed if separately authorized.

---

### Task 1: Define immutable contracts, scenario manifests, and safe execution boundary

**Files:**
- Create: `master_brain/verification/harness/contracts.mjs`
- Create: `master_brain/verification/harness/scenario-manifest.mjs`
- Create: `master_brain/verification/harness/execution-sink.mjs`
- Create: `test/verification/harness-contracts.test.mjs`
- Create: `test/verification/scenario-manifest.test.mjs`
- Create: `test/verification/execution-sink.test.mjs`

**Interfaces:**
- `createScenarioManifest(input) -> ScenarioManifest`
- `validateScenarioManifest(manifest) -> {valid, errors}`
- `freezeCampaignManifest(manifest) -> FrozenManifest`
- `createFaultProfile(input) -> FaultProfile`
- `createExecutionSink(config) -> ExecutionSink`
- `executionSink.execute(request) -> SinkResult`
- `executionSink.assertIsolated() -> IsolationEvidence`

- [ ] **Step 1: Add the focused failing test**

Test missing critical traceability/version/environment fields; stable IDs and UNKNOWN/CONFLICTED preservation; immutable frozen manifests; non-modifiable denominators; deny-by-default protected operations; required isolation evidence; deterministic trace/run IDs; and simulation without real external side effects.

- [ ] **Step 2: Verify the relevant failure**

Run: `node --test test/verification/harness-contracts.test.mjs test/verification/scenario-manifest.test.mjs test/verification/execution-sink.test.mjs`

Expected: The new tests fail because the contract, manifest, and sink interfaces do not yet exist.

- [ ] **Step 3: Implement the minimum behavior**

Implement schema-like validation without inventing product rules. Make manifest freezing explicit and versioned. Represent applicability, exclusions, equivalent mutants, adequacy targets, and denominators as immutable campaign metadata. Make the execution sink deny-by-default for protected operation classes and emit auditable isolation evidence. Do not call production connectors.

Edge cases: missing seed is allowed only when explicitly declared non-applicable; missing environment/dependency data invalidates critical reproducibility; post-freeze mutation creates a new revision; UNKNOWN remains UNKNOWN.

- [ ] **Step 4: Verify the focused pass**

Run the same focused command. Expected: all focused tests pass with zero failures.

- [ ] **Step 5: Run the affected integration check**

Run: `node --test test/verification/*.test.mjs`

Expected: all verification tests pass.

- [ ] **Step 6: Commit the passing deliverable**

Do not commit unless separately authorized.

---

### Task 2: Build Observer, independent Reference Model, and Oracle with three-valued semantics

**Files:**
- Create: `master_brain/verification/harness/observer.mjs`
- Create: `master_brain/verification/harness/reference-model.mjs`
- Create: `master_brain/verification/harness/oracle.mjs`
- Create: `test/verification/observer.test.mjs`
- Create: `test/verification/reference-model.test.mjs`
- Create: `test/verification/oracle.test.mjs`

**Interfaces:**
- `createObserver(config) -> Observer`
- `observer.record(event) -> Observation`
- `observer.snapshot(runId) -> EvidenceBundle`
- `createReferenceModel(specification) -> ReferenceModel`
- `referenceModel.initialState(initialState) -> ModelState`
- `referenceModel.apply(event) -> ModelTransition`
- `evaluateOracle({specification, referenceModel, invariants, evidence}) -> OracleResult`
- `assertOracleIndependence(oracle, sutModules) -> IndependenceEvidence`

- [ ] **Step 1: Add focused failing tests**

Test complete observation reconstruction; UNKNOWN preservation; Reference Model independence; conflict handling; PASS/FAIL/INCONCLUSIVE only; explicit reasons for INCONCLUSIVE; safety FAIL surviving fault-detection INCONCLUSIVE; and rejection of forbidden SUT decision dependencies.

- [ ] **Step 2: Verify the relevant failure**

Run: `node --test test/verification/observer.test.mjs test/verification/reference-model.test.mjs test/verification/oracle.test.mjs`

Expected: focused tests fail because these interfaces do not exist.

- [ ] **Step 3: Implement the minimum behavior**

Implement append-only observation records with provenance/timing metadata. Keep the Reference Model specification-oriented and simpler than the SUT. Implement Oracle as a pure evaluation over specification, model, invariants, and evidence. Keep property and fault-detection results separate.

- [ ] **Step 4: Verify the focused pass**

Run the same focused command. Expected: all focused tests pass.

- [ ] **Step 5: Run the affected integration check**

Run: `node --test test/verification/*.test.mjs`

Expected: all verification tests pass.

- [ ] **Step 6: Commit the passing deliverable**

Do not commit unless separately authorized.

---

### Task 3: Implement fault injection, visibility controls, coverage/mutation analysis, and verification ledger

**Files:**
- Create: `master_brain/verification/harness/fault-injector.mjs`
- Create: `master_brain/verification/harness/coverage-analyzer.mjs`
- Create: `master_brain/verification/harness/mutation-engine.mjs`
- Create: `master_brain/verification/harness/verification-ledger.mjs`
- Create: `test/verification/fault-injector.test.mjs`
- Create: `test/verification/coverage-analyzer.test.mjs`
- Create: `test/verification/mutation-engine.test.mjs`
- Create: `test/verification/verification-ledger.test.mjs`

**Interfaces:**
- `injectFault(faultProfile, executionContext) -> FaultActivation`
- `confirmFaultActivation(activationEvidence) -> ActivationStatus`
- `evaluateFaultVisibility({activation, propagation, oracle}) -> VisibilityResult`
- `analyzeCoverage(campaign, results) -> CoverageSnapshot`
- `classifyMutation(mutation, specification) -> MutationClassification`
- `evaluateMutation(mutationResult) -> MutationResult`
- `appendVerificationRecord(record) -> VerificationRecord`
- `freezeLedgerRevision(runId) -> LedgerRevision`

- [ ] **Step 1: Add focused failing tests**

Test fault metadata/activation evidence; visibility chain; safety FAIL versus fault INCONCLUSIVE; frozen coverage denominators; blocked/unobservable critical items; critical mutation survivors; equivalent-mutant handling; append-only ledger; and complete traceability/version/environment metadata.

- [ ] **Step 2: Verify the relevant failure**

Run: `node --test test/verification/fault-injector.test.mjs test/verification/coverage-analyzer.test.mjs test/verification/mutation-engine.test.mjs test/verification/verification-ledger.test.mjs`

Expected: focused tests fail because the components do not yet exist.

- [ ] **Step 3: Implement the minimum behavior**

Implement the 34 declarative fault profiles from the specification. Require independent activation evidence. Track structural, functional, invariant, fault, state, sequence, interaction, input-space, safety-property, and mutation coverage separately. Freeze denominators per campaign revision. Make the ledger append-only and evidence-linked.

Edge cases: invisible fault → fault-detection INCONCLUSIVE; forbidden side effect → FAIL; surviving critical killable mutation → gate FAIL; post-start denominator change → superseding revision; duplicate source representations are not independent evidence.

- [ ] **Step 4: Verify the focused pass**

Run the same focused command. Expected: all focused tests pass.

- [ ] **Step 5: Run the affected integration check**

Run: `node --test test/verification/*.test.mjs`

Expected: all verification tests pass.

- [ ] **Step 6: Commit the passing deliverable**

Do not commit unless separately authorized.

---

### Task 4: Build staged campaign execution, crash/recovery, reproducibility, and empirical acceptance gates

**Files:**
- Create: `master_brain/verification/harness/campaign-runner.mjs`
- Create: `master_brain/verification/harness/reproduction-controller.mjs`
- Create: `master_brain/verification/harness/recovery-controller.mjs`
- Create: `master_brain/verification/harness/self-test.mjs`
- Create: `master_brain/verification/harness/acceptance-gates.mjs`
- Create: `test/verification/campaign-runner.test.mjs`
- Create: `test/verification/reproduction-controller.test.mjs`
- Create: `test/verification/recovery-controller.test.mjs`
- Create: `test/verification/self-test.test.mjs`
- Create: `test/verification/acceptance-gates.test.mjs`
- Create: `test/verification/empirical-verification.test.mjs`

**Interfaces:**
- `runCampaign({stage, manifest, scenarios, harness}) -> CampaignResult`
- `runSelfTest(harness) -> SelfTestResult`
- `runRecoveryExperiment(profile, context) -> RecoveryResult`
- `captureReproductionManifest(run) -> ReproductionManifest`
- `reproduceExact(manifest) -> ReproductionResult`
- `reproduceIndependent(manifest) -> ReproductionResult`
- `evaluateAcceptanceGates(campaignResult) -> StageGateResult`
- `buildEmpiricalVerificationClaim(campaignResult) -> VerificationClaim | null`

- [ ] **Step 1: Add focused failing tests**

Test Stage 0 validation; Stage 1A self-test blocking; baseline gating; single-fault separation; state/sequence and interaction targets; mutation/negative controls; crash/recovery invariants; exact and independent reproduction; critical INCONCLUSIVE blocking; critical safety FAIL; and scoped empirical claim creation only after all applicable gates plus independent evidence-integrity review.

- [ ] **Step 2: Verify the relevant failure**

Run: `node --test test/verification/campaign-runner.test.mjs test/verification/reproduction-controller.test.mjs test/verification/recovery-controller.test.mjs test/verification/self-test.test.mjs test/verification/acceptance-gates.test.mjs test/verification/empirical-verification.test.mjs`

Expected: focused tests fail because staged execution and acceptance interfaces do not yet exist.

- [ ] **Step 3: Implement the minimum behavior**

Implement Stage 0, 1A–1G, 1.5, and 2 with fail-closed promotion. Recovery must enforce `RECOVERED != VERIFIED_READY`. Exact reproduction matches recorded versions/environment/dependencies/seed; independent reproduction uses a fresh context. No empirical claim from static/unit success alone.

- [ ] **Step 4: Verify the focused pass**

Run the same focused command. Expected: all focused tests pass.

- [ ] **Step 5: Run the full repository test suite**

Run: `find test -name '*.test.mjs' -print0 | xargs -0 node --test`

Expected: existing Master Brain tests plus all harness tests pass with zero failures, cancellations, or skipped tests.

- [ ] **Step 6: Run a deterministic Stage-0/Stage-1 campaign only against synthetic/local scenarios and the Execution Sink/Test Double**

Verify self-test PASS, baseline PASS, controls, sink isolation, reconstructable ledger evidence, a deliberately bad synthetic case producing FAIL, an insufficient-evidence case producing INCONCLUSIVE, and exact reproduction of the same property result.

Expected: the campaign gate passes only when every applicable critical acceptance criterion passes; otherwise promotion is blocked and the failure remains in the ledger.

- [ ] **Step 7: Commit the passing deliverable**

Do not commit unless separately authorized.

---

## Unresolved externally observable decisions

1. **Persistent ledger storage:** JSONL, SQLite, or another backend is not prescribed. Recommendation: append-only JSONL for Stage 0/1 because it is inspectable and dependency-free; migrate only if measured campaign volume requires it.
2. **Harness configuration source:** The specification requires versioned configuration but not a file format. Recommendation: version-controlled JSON/ESM manifests with schema validation.
3. **Protected-target isolation mechanism:** The specification requires a provable sink boundary but not OS/container/network enforcement. Recommendation: Stage 1 uses a deny-by-default local sink plus reachability tests; stronger OS/network isolation is required before any stage that could otherwise touch external systems.
4. **Authoritative critical requirement inventory:** The complete Master Brain product/safety requirement set must be extracted into stable requirement IDs before the first real Stage-1 campaign. The current invariants are the initial verification meta-requirements; missing product requirements must not be invented by the harness.
