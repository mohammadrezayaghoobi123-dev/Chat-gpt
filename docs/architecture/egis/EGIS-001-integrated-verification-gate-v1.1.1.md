# EGIS Integrated Verification Gate Standard v1.1.1

**Status:** Candidate; NOT_VERIFIED  
**Parent:** EGIS operation-composition v1.1.0 (PR #472)  
**Scope:** Formal verification tooling and evidence gate only

## Integration boundary

This increment adds a fail-closed runner for the formal model without changing the canonical operation types, lifecycle model, runtime, or prior PRs. The gate is stacked on v1.1.0 and preserves that baseline.

## Canonical execution order

1. Validate expected commit and clean checkout.
2. Validate required module/config inputs exist.
3. Record SHA-256 of exact module and configuration.
4. Validate the tool jar against caller-approved SHA-256.
5. Run SANY.
6. If SANY is not PASS, mark TLC BLOCKED and stop.
7. Run TLC with deterministic single worker and deadlock checking.
8. Record commands, status, exit code, stdout/stderr, input/tool digests.
9. Atomically write evidence JSON.

## Adversarial fail-closed semantics

- No source commit pin or dirty checkout: not PASS.
- Missing input/tool/runtime: BLOCKED.
- Tool digest mismatch: FAIL, no execution.
- SANY failure: TLC BLOCKED.
- TLC nonzero or timeout: FAIL.
- Only all mandatory checks PASS can yield overall PASS.
- PASS is scoped to model parsing/model checking only; it does not mean implementation conforms.

## Hostile review

FMH-046..FMH-057 recorded in the gate review. Source binding, tool digest, input digests, failure sequencing, and atomic evidence write are addressed. Artifact authenticity, Java provenance, independent TLC-output parsing, mutation/differential checks, and independent reviewer remain open.

## Verification status

The runner and unit tests are committed to this candidate branch, but execution remains NOT_RUN. SANY and TLC remain NOT_RUN. Do not merge/promote until the exact commit is tested and formal tools are run with independently approved provenance.
