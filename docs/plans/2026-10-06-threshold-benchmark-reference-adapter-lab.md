# Threshold Benchmark & Reference-Adapter Lab (A+C) Implementation Plan

> **For agentic workers:** Use the host's available task-by-task implementation workflow. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a protocol-agnostic threshold benchmark laboratory that provides a common reference interface and independent verification gates, while allowing real protocol implementations to enter only after the laboratory qualification gates pass.

**Architecture:** The Lab is an isolated qualification layer between scientific candidates and the Master Brain Core. Every candidate is represented through a Reference Adapter and evaluated against the same threat model, vectors, fault/recovery scenarios, performance contract, and independent Oracle. Real implementations are sandboxed candidates; they cannot bypass the Lab or directly grant authority.

**Tech Stack:** Node.js ESM, Node built-in test runner, existing Master Brain verification harness, existing Reference Model/Oracle/Execution Sink/Recovery infrastructure.

## Global Constraints

- A real implementation never bypasses the Reference-Adapter qualification gates.
- No protocol is Production Qualified merely because it is popular, standardized, peer-reviewed, or named in the registry.
- Qualification is evidence-bound and version-bound.
- Exact artifact identity and SHA-256 binding are mandatory.
- Security assumptions, independent evidence, independent reproduction, negative evidence, and freshness remain mandatory.
- The Lab is provider/protocol agnostic.
- Multi-party signed quorum remains distinct from true threshold cryptography.
- Protected operations remain blocked by the independent execution/authorization gates.
- UNKNOWN and CONFLICTED evidence remain INCONCLUSIVE; unresolved security risk is REJECT.
- No existing unrelated working-tree changes may be reset, reverted, or overwritten.
- Current repository test command is `find test -name '*.test.mjs' -print0 | xargs -0 node --test`.

---

### Task 1: Common Threshold Reference Contract

**Files:**
- Create: `master_brain/verification/harness/threshold-reference-lab.mjs`
- Test: `test/verification/threshold-reference-lab.test.mjs`

**Interfaces:**
- Consumes: candidate metadata, adapter implementation, test vector, threat model, fault scenario, recovery scenario.
- Produces: normalized `REFERENCE_RUN` result with candidate identity, artifact hash, scenario identity, observations, independent verification status, and PASS/FAIL/INCONCLUSIVE qualification state.

- [ ] **Step 1: Add the focused failing test**
  - reject missing candidate identity;
  - reject missing versioned artifact/hash;
  - accept a normalized adapter contract;
  - preserve UNKNOWN/CONFLICTED observations;
  - never return QUALIFIED without all required evidence gates;
  - reject an adapter attempting to call the Master Brain authorization/execution path.

- [ ] **Step 2: Verify the relevant failure**
  Run: `node --test test/verification/threshold-reference-lab.test.mjs`
  Expected: missing-module/interface failures before implementation.

- [ ] **Step 3: Implement minimum behavior**
  Define `THRESHOLD_REFERENCE_VERSION`, `normalizeThresholdCandidate`, `runReferenceScenario`, and `evaluateReferenceQualification`.
  Use the existing independent Oracle semantics rather than importing decision/permission logic from the SUT.
  Treat adapter output as untrusted evidence until independently evaluated.

- [ ] **Step 4: Verify focused pass**
  Run: `node --test test/verification/threshold-reference-lab.test.mjs`
  Expected: all focused tests PASS.

- [ ] **Step 5: Run affected integration check**
  Run: `node --test test/verification/threshold-protocol-comparison.test.mjs test/verification/threshold-protocol-registry.test.mjs test/verification/threshold-reference-lab.test.mjs`
  Expected: all threshold qualification tests PASS.
---

### Task 2: Real Implementation Adapter Boundary

**Files:**
- Create: `master_brain/verification/harness/threshold-adapter-registry.mjs`
- Test: `test/verification/threshold-adapter-registry.test.mjs`

**Interfaces:**
- Consumes: adapter manifest with protocol id/version, artifact hash, implementation entry, capabilities, isolation metadata, and test-vector compatibility.
- Produces: admitted `CANDIDATE_ADAPTER` only when identity/integrity/isolation contracts are verified.

- [ ] **Step 1: Add the focused failing test**
  - verified identity/integrity/isolation is admitted as CANDIDATE;
  - artifact hash mismatch is rejected;
  - missing isolation is INCONCLUSIVE;
  - adapter cannot expose an execution/authorization callback;
  - protocol version mismatch is rejected;
  - revoked/quarantined adapter is rejected;
  - registry does not treat the adapter as Production Qualified.

- [ ] **Step 2: Verify the relevant failure**
  Run: `node --test test/verification/threshold-adapter-registry.test.mjs`
  Expected: missing-module/interface failures.

- [ ] **Step 3: Implement minimum behavior**
  Add `registerThresholdAdapter`, `evaluateThresholdAdapterAdmission`, and `getThresholdAdapter`.
  Enforce exact version/hash binding, sandbox/isolation evidence, and capability declaration.
  Explicitly forbid authority, credential, payment, or execution callbacks in the adapter contract.

- [ ] **Step 4: Verify focused pass**
  Run: `node --test test/verification/threshold-adapter-registry.test.mjs`
  Expected: all focused tests PASS.

- [ ] **Step 5: Run affected integration check**
  Run: `node --test test/verification/threshold-reference-lab.test.mjs test/verification/threshold-adapter-registry.test.mjs test/verification/threshold-protocol-comparison.test.mjs`
  Expected: all PASS.

---

### Task 3: Common Vectors, Threat/Fault Matrix, and Recovery/Performance Contract

**Files:**
- Create: `master_brain/verification/harness/threshold-benchmark-suite.mjs`
- Test: `test/verification/threshold-benchmark-suite.test.mjs`

**Interfaces:**
- Consumes: admitted candidate adapter and deterministic suite configuration.
- Produces: reproducible scenario results and an evidence bundle suitable for the existing comparison kernel.

- [ ] **Step 1: Add the focused failing test**
  - deterministic vector execution;
  - operation/transcript binding;
  - replay rejection;
  - malicious participant fault;
  - participant loss/liveness condition;
  - share lifecycle/rotation/revocation scenario;
  - crash/recovery scenario;
  - resource/performance measurement schema;
  - failed/unknown observations never become PASS.

- [ ] **Step 2: Verify the relevant failure**
  Run: `node --test test/verification/threshold-benchmark-suite.test.mjs`
  Expected: missing-module/interface failures.

- [ ] **Step 3: Implement minimum behavior**
  Define deterministic scenarios and stable scenario IDs.
  Reuse existing fault, recovery, reference-model, and oracle contracts where possible.
  Separate functional correctness, safety, liveness, recovery, and performance evidence.
  Performance is evidence only; it never overrides a security failure.

- [ ] **Step 4: Verify focused pass**
  Run: `node --test test/verification/threshold-benchmark-suite.test.mjs`
  Expected: all focused tests PASS.

- [ ] **Step 5: Run affected integration check**
  Run: `node --test test/verification/threshold-benchmark-suite.test.mjs test/verification/threshold-reference-lab.test.mjs test/verification/threshold-protocol-comparison.test.mjs`
  Expected: all PASS.

---

### Task 4: A+C Qualification Pipeline and Design Amendment

**Files:**
- Modify: `master_brain/verification/harness/threshold-protocol-comparison.mjs`
- Test: `test/verification/threshold-protocol-comparison.test.mjs`
- Modify: `docs/specs/2026-10-05-master-brain-final-system-design.md`

**Interfaces:**
- Consumes: live evidence registry + admitted adapter + benchmark evidence bundle.
- Produces: `HOLD`, `REJECT`, or `QUALIFIED`; only QUALIFIED candidates can become Production Candidates.

- [ ] **Step 1: Add the focused failing test**
  - complete scientific candidate without benchmark evidence remains HOLD;
  - benchmark evidence from an unadmitted adapter remains HOLD;
  - benchmark security failure prevents qualification;
  - performance evidence cannot override a security failure;
  - independently reproduced benchmark evidence can satisfy the experimental gate;
  - qualified result remains version/hash bound;
  - no path exists from adapter admission directly to execution authority.

- [ ] **Step 2: Verify the relevant failure**
  Run: `node --test test/verification/threshold-protocol-comparison.test.mjs`
  Expected: new benchmark-gate assertions fail before implementation.

- [ ] **Step 3: Implement minimum behavior**
  Add a `benchmark_evidence` qualification gate requiring:
  `REFERENCE_RUNS_VERIFIED`, `SECURITY_TESTS_VERIFIED`, `FAULT_RECOVERY_VERIFIED`, `PERFORMANCE_EVALUATION_VERIFIED`, and `INDEPENDENT_REPRODUCTION_VERIFIED`.
  Preserve all existing artifact/freshness/evidence-mesh/security-assumption gates.
  Add H.39 documenting A+C, the non-bypass rule, and the distinction between qualification and production authority.

- [ ] **Step 4: Verify focused pass**
  Run: `node --test test/verification/threshold-protocol-comparison.test.mjs`
  Expected: all comparison tests PASS.

- [ ] **Step 5: Run full regression**
  Run: `find test -name '*.test.mjs' -print0 | xargs -0 node --test`
  Expected: no FAIL, cancelled, or skipped tests; final aggregate count must be recorded from runner output rather than inferred.

- [ ] **Step 6: Commit**
  Do not commit automatically. The repository currently contains unrelated working-tree changes and commit authorization has not been explicitly granted.
