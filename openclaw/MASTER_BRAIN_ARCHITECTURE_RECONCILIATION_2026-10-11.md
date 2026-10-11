# Master Brain — Architecture Reconciliation & Recovery Status
**Date:** 2026-10-11  
**Status:** Evidence-based first-pass reconciliation; not a final architecture freeze.  
**Branch:** `master-brain/planning-baseline`

## 1. Scope and source hierarchy

This note reconciles three accessible sources without replacing any of them:
1. The prior Master Brain mother/continuation documents in the user's connected Notion workspace and ChatGPT Library.
2. The current GitHub planning baseline at `openclaw/MASTER_BRAIN_ARCHITECTURE_BASELINE.md`.
3. The recorded recovery and prototype-test status dated 2026-10-10.

This is not proof that the complete historical conversations or original implementation have been recovered. The reported original implementation (~3,000 lines) remains **INACCESSIBLE / RECOVERY PENDING**, not confirmed lost.

## 2. What the earlier architecture requires

The earlier Master Brain / Opportunity Engine concept is broader than a multi-model chat interface. It calls for:
- Goal and policy layer with success criteria, budget, risk and permission boundaries.
- Master orchestrator and adaptive model/tool routing.
- Evidence engine with provenance, freshness, source independence and claim/evidence/inference separation.
- Contradiction engine that distinguishes true same-context conflicts from changed scope, definitions, time, dependencies, measurement error and inference differences.
- Opportunity engine to generate/rank options against expected value, feasibility, time, downside risk, uncertainty and evidence quality.
- Separate Intelligence Plane and Proof Plane.
- Independent evaluation, benchmark generation, red-team, reality monitoring and evaluator governance.
- Persistent evidence/event store, traceability, immutable raw artifacts and versioned interpretations.
- Controlled self-repair with isolated tests, baseline comparison, canary, rollback and approval gates.
- Permanent R&D, explicit preservation of negative evidence, and a requirement to challenge weak prior decisions.

Core loop: **Observe → Challenge → Research → Decide → Act → Verify → Repair → Re-verify → Learn**.

## 3. What the GitHub planning baseline already covers

The current baseline appropriately specifies:
- Model/provider independence through adapters.
- Task classification, policy gate and risk tiers.
- Least privilege and explicit approval for consequential actions.
- Read-only tools as the MVP starting point.
- Evidence bundles and provenance, output validation and disagreement handling.
- Separation of session context, project knowledge and user-approved durable memory.
- Safe logging, secret redaction, deterministic routing before learned routing, bounded retries and budget controls.
- Staged delivery, test requirements, no direct writes to `main`, and honest fallback when a provider is unavailable.
- OpenClaw as optional/out of scope for the current milestone, rather than a mandatory runtime dependency.

These are useful safety and implementation controls. They do not establish that these components are implemented in production code.

## 4. Gaps to reconcile before architecture freeze

The GitHub baseline is a narrower MVP proposal. It does not yet fully specify the following concepts from the earlier project:
1. **Opportunity Engine:** opportunity generation, ranking, expected-value model, feasibility and downside-risk analysis.
2. **Proof Plane contract:** independent ground truth, evaluator/verifier separation, red-team, benchmark/holdout policy, reality outcomes and evaluator drift.
3. **CTP protocol:** claim normalization, rival hypotheses, falsifiers, discriminating test selection, protocol lock, bounded verdict taxonomy and counterevidence handling.
4. **Evidence maturity and reproducibility:** evidence ladder, reproducibility levels, preregistration, locked thresholds, contamination controls and independent replication.
5. **Evidence store and provenance schema:** Claim, Hypothesis, Source, Evidence, Experiment, Run, Trace, Metric, Failure, Attack, Replication, Reality Outcome, Decision and Audit entities; immutable versus versioned data.
6. **Failure and attack registries:** explicit negative knowledge, invalid-run preservation, root-cause classification and recovery experiments.
7. **Self-repair governance:** controlled repair workflow, canary, rollback, regression suite and separate authorization for high-impact changes.
8. **Broad-source research policy:** credibility, access legality, privacy and corroboration recorded separately; inaccessible-source gaps retained.
9. **Quantitative acceptance criteria:** thresholds must remain undecided until task population, strong baseline, independent ground truth and protocol are specified.
10. **Historical decision provenance:** exact pivot point from OpenClaw bootstrap work to the broader Master Brain concept is not fully reconstructed because the complete referenced chat threads were not retrieved.

These are gaps in the *current baseline document*, not proof that the concepts never existed elsewhere.

## 5. CTP prototype status — keep separate from recovered source

A detached experimental Python CTP scaffold is reported in the project records:
- Python compilation passed.
- 31 local unit tests passed.
- Demo and analysis used artificial fixtures.
- All 21 `MB-PROOF-002A` cases remain `NOT_RUN` against the live/original system.
- A limited review of one verdict-gate fragment returned zero issues; this was not a full-package independent validation.

The prototype is **not** the original implementation, is not integrated with OpenClaw, and is not production-ready. Its tests show only that encoded local expectations pass. They do not establish truth, provenance authenticity, independent-source identity, or real-world performance.

## 6. Recovery and access constraints

Until the user permits the next live connection (recorded target date: **2026-11-01**):
- Do not attempt live Codespaces/Desktop Commander reconnection.
- Do not reset, rebuild, delete, revoke credentials, overwrite or migrate the existing environment.
- Work only with accessible documents, public repository evidence and isolated artifacts.
- Preserve existing Notion/Library documents as separate sources.

At the first permitted live session:
1. Inspect the original workspace read-only.
2. Snapshot and hash the whole workspace and `.git`, including modified, untracked, ignored files, branches, stashes and reflogs.
3. Separately inventory OpenClaw workspace, memory/skills, runtime/session databases, redacted config, agent-local/native Codex homes and backups.
4. Verify the snapshots; inspect copies only.
5. Map recovered source files to architecture components and tests.
6. Lock the benchmark protocol and independent ground truth.
7. Only then run `MB-PROOF-002A` and report each result as `PASS`, `FAIL`, `HOLD` or `INVALID`.
8. Migrate only by **Copy → Verify → Reproduce → only then Retire**.

## 7. Recommended architecture direction

Treat the existing GitHub baseline as the **implementation-safety shell**, and the earlier Master Brain / Opportunity Engine documents as the **broader product and scientific-proof requirements**. Merge them only after a source-to-requirement map and decision review.

Do not start a rewrite or claim production readiness. First establish what original code exists, what is only specified, what is implemented, and what has been tested. Use explicit maturity states:

`PROPOSED → SPECIFIED → IMPLEMENTED → TESTED → INDEPENDENTLY_VALIDATED → PRODUCTION-VERIFIED`

Model agreement is not ground truth. A fixture pass is not a live-system pass. **Lab PASS + Reality FAIL = final FAIL.**

## 8. Free-tool operating strategy

To reduce dependence on paid coding assistants:
- Use ChatGPT's available file/repository tools for document search, comparison, review and planning.
- Use the existing GitHub repository and a dedicated feature branch as the shared source of truth.
- Use GitHub's browser-based repository views/editor for small, reviewable text changes when practical; do not use `main` for drafts.
- Treat Claude/Cursor as optional reviewers/editors when their limits allow, not as required project infrastructure.
- Keep credentials and private memory out of the public repository.
- Do not treat GitHub web access as access to private/uncommitted Codespace files; these remain separate recovery targets.

## 9. Next work item

Create a source-to-requirement matrix from the mother document, continuation/recovery audit, current baseline, and the recovered source tree once available. Mark every requirement with source, maturity state, evidence, conflict, and next verification step. Do not code against the missing source by guesswork.
