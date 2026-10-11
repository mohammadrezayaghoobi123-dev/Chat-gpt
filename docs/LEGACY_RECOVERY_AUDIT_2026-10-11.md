# Legacy Research and Code Recovery Audit — 2026-10-11

## Purpose

Record what can be verified from the repository before attempting to recover earlier Master Brain research and implementation. This audit is intentionally non-destructive: it does not reset branches, rewrite history, delete files, or claim that unavailable work has been recovered.

## Verified repository state

- The repository exposes these branches through the GitHub connector: `main`, `master-brain/integrated-mvp`, and `master-brain/planning-baseline`.
- The current integration branch contains the integrated architecture, Meta-Intelligence specification, contradiction-driven proof charter, and the domain-scope document for blockchain, digital economy, crypto, and betting/platform analysis.
- The branch also contains an implementation skeleton under `src/master_brain/`, including `core.py`, `archipelago.py`, `meta_intelligence.py`, and `ctp.py`, with corresponding tests.
- The default `main` tree at commit `090a1850b5a06a16c8d7ae2e004cd08112b11ae5` is focused on OpenClaw/Codespaces/Tailscale setup. The inspected commit changes `.devcontainer/install-openclaw.sh` to turn off OpenClaw's built-in Tailscale mode and use external Tailscale Serve, while preserving token-based gateway authentication without printing the token.
- The visible recent commit history is dominated by OpenClaw infrastructure setup and reliability fixes. Searches of commit messages for `blockchain`, `crypto`, `betting`, `digital economy`, `Master Brain`, and `research` did not return matching commits.
- The GitHub connector's code search is documented as searching the default branch. Therefore, empty search results are not proof that legacy work never existed.
- The inspected repository trees do not currently show a clearly named, dedicated legacy blockchain/crypto/betting implementation package. The current domain-scope document is a roadmap/scope artifact, not proof that those capabilities are implemented.

## Recovery classification (provisional)

1. **Preserve and reuse:** current architecture documents, contradiction charter, Meta-Intelligence spec, MVP source and tests.
2. **Inspect before reuse:** `src/master_brain/ctp.py` and its tests; older OpenClaw architecture/bootstrap files; all historical commits and any local Codespaces workspace if it becomes accessible.
3. **Not yet located:** the user's earlier detailed blockchain, digital-economy, crypto-market, and betting-platform research/code. No claim is made that this material has been restored.
4. **Do not infer:** no conclusion that the old work is lost, or that it exists only in Codespaces. The evidence gathered so far is incomplete.

## Safe recovery procedure

1. Keep `main` unchanged; continue only on `master-brain/integrated-mvp` or a dedicated recovery feature branch.
2. Enumerate historical commits and inspect their trees/diffs, including older commits predating the OpenClaw setup sequence.
3. Compare the complete file tree at the oldest relevant commits against the current integration branch.
4. When Codespaces access returns, inspect the workspace and Git status before any pull, checkout, reset, rebuild, or cleanup. Copy/export uncommitted files first.
5. Create a legacy inventory with one record per artifact: path/source, timestamp or commit, purpose, dependencies, implementation status, tests, evidence quality, security concerns, and target architecture island.
6. Integrate only after review. Preserve provenance and original artifacts; add adapters or migration commits rather than silently overwriting.
7. Verify tests and CI explicitly before describing any capability as working.

## Architectural integration target

Recovered material should be routed through the integrated A+B design:
- Supreme Command Core: mission policy, priority, approval, and budget.
- Strategic/Meta-Intelligence: domain discovery, decomposition, model/tool routing, and replanning.
- Specialist islands: blockchain engineering, digital-economy/platform analysis, crypto markets/risk, betting/gambling platform analysis, and other relevant domains.
- Cross-cutting Proof Plane: provenance, counterevidence, contradiction handling, falsifiable checks, uncertainty, and audit trail.
- Cross-cutting controls: security, permissions, cost limits, tests, and rollback.

The principle “reach proof through contradiction” must remain operational: a contradiction can weaken or refute a scoped claim but does not prove its opposite; lack of a detected contradiction is not proof; model agreement is not independent corroboration.

## Current conclusion

The current architecture and MVP artifacts are present in GitHub, but the old domain-specific research/code has **not yet been located or restored**. The next recovery step is historical tree/commit inspection, then workspace inspection if Codespaces becomes available. This report is an evidence log, not a claim of completed recovery.


## Additional historical inspection (2026-10-11)

- The repository-wide commit endpoint currently returns 25 commits, with the oldest visible commit dated 2026-10-01 and titled `first commit`. The subsequent visible history is the OpenClaw/Codespaces setup sequence through 2026-10-04. No older domain-research commit history was returned by that endpoint.
- The default `main` tree at `090a1850b5a06a16c8d7ae2e004cd08112b11ae5` contains the OpenClaw bootstrap and Tailscale/Codespaces configuration, not the current Python Master Brain package. The current integration branch contains the later Master Brain MVP and architecture documents.
- `src/master_brain/ctp.py` is a real but small **planning/validation scaffold**: it defines rival hypotheses, falsifiers, proposed discriminating tests, status tracking, and structural validation. It explicitly does not run experiments or convert unexecuted tests into evidence. Its unit tests are source code only; they have not been executed in this inspection.
- The architecture reconciliation document says the reported earlier ~3,000-line implementation remains inaccessible/recovery pending, not confirmed lost. It also distinguishes the current scaffold from the original implementation.
- Therefore, based on the GitHub history currently exposed, the old detailed domain research is **not present in the visible commit history inspected so far**. Next sources to investigate are the connected Notion/ChatGPT Library artifacts mentioned in the reconciliation document, followed by the Codespaces workspace when access is permitted. This is a stronger finding than the earlier commit-message search, but it still does not establish that the research was lost.


## Connected Notion and Library source discovery (2026-10-11)

The recovery sweep has now located and read the connected Notion continuity records and Library audit artifacts. These provide better historical requirements, but they are not the missing original implementation:

- Notion contains a **central conceptual architecture** page, an **integrated mother document**, a **continuity archive**, and a **2026-10-10 continuation / CTP gate review**. They consistently state that the full “گپ درباره موتور فرصت” threads 1–32 and “دسترسی آسترولوژی” transcript were not retrieved in full.
- The Notion continuation record says the reported original ~3,000-line source remains inaccessible/recovery pending, not confirmed lost. It records a separate detached CTP prototype and reports 31 local prototype unit tests passed, while all 21 `MB-PROOF-002A` cases remain `NOT_RUN` against the live Master Brain. Those results are historical claims recorded in the source document; they were not rerun in this audit.
- The Library contains `MASTER_BRAIN_DETAILED_ARCHITECTURE_FA.md`, multiple versions of `MASTER_BRAIN_PROJECT_MASTER_2026-10-09/10.md`, `MASTER_BRAIN_TIMELINE_RECOVERY_AUDIT_2026-10-10.md`, and `MASTER_BRAIN_CONTINUATION_SUMMARY_2026-10-10.md`. Several similarly named project-master files are duplicate/versioned copies; preserve them separately until hashes/content comparison establishes which sections differ.
- The mother/continuity records point to a Library file described as `MASTER_BRAIN_PROJECT_MASTER_2026-10-10.md` (about 73 KB) and to a detached prototype archive named `MASTER_BRAIN_CTP_PROTOTYPE_0.1.0.zip`. Their presence in a document reference does not by itself mean the original live implementation is restored.
- The recovered documents describe the intended architecture in more detail: separate Intelligence and Proof planes, Opportunity Engine, contradiction-driven testing, evidence maturity/reproducibility, benchmark/evaluator governance, controlled self-repair, and a preserve-first migration rule. These requirements should be used to evaluate recovered source, not substituted for it.

## Revised recovery decision

1. **Do not refactor or replace the live/original project yet.** The recorded project stop point explicitly requires recovery and external snapshot before refactoring.
2. Use the accessible Notion/Library artifacts now to establish a source-of-truth inventory and a discrepancy ledger; retain all versions and record their actual content hashes before deduplicating.
3. The connected records state that live Codespaces/Desktop Commander reconnection is deferred until **2026-11-01**. Respect that constraint: do not attempt live connection, reset, rebuild, delete, revoke, or workspace mutation before then.
4. At the permitted session, snapshot the existing Codespace and OpenClaw runtime/state before starting or repairing anything. Include Git metadata, dirty/untracked/ignored files, stashes/reflogs, OpenClaw workspace and session/runtime state, and Codex task/home data where accessible. Inspect copies only.
5. After the original source is actually found, map it against the preserved architecture, then decide what to retain, adapt, test, or replace. Do not treat the detached CTP scaffold as the recovered ~3,000-line implementation.

This update supersedes any implication that Notion/Library had not yet been searched in the current recovery pass. It does **not** change the conclusion that the original implementation and full historical conversations remain unrecovered.

## 2026-10-11 — focused Notion source inspection and scope check

### Canonical Notion mother document
- Page: [MASTER BRAIN — سند مادر یکپارچه و مرجع قابل‌حمل — 2026-10-09](https://app.notion.com/p/3f4ccfc54a30813eab6ef8723f99c85a?pvs=204).
- The connected fetch returned **46,445 characters / 527 content lines** in this pass. It includes the consolidated project master, cross-project continuity archive, historical infrastructure inventory, status/decision ledgers, migration plan, and the MB-EVAL-CONTRACT-001 draft.
- The document itself explicitly says it does **not** contain the missing full ChatGPT conversation archive or inaccessible local Codespace files. It marks the original reported ~3,000-line implementation as **INACCESSIBLE / RECOVERY PENDING**, not confirmed lost.
- A focused term check of the fetched mother document found no direct occurrences of “blockchain”, “crypto”, “betting”, or “digital economy”. This does not show that no such work exists elsewhere; it means this document alone is not evidence that those specialist implementations/research files have been recovered.

### Other accessible Notion records
- [Continuation Update & CTP Gate Review — 2026-10-10](https://app.notion.com/p/3f4ccfc54a308155abb3d8d56ff8bd79?pvs=204): 8,077 characters fetched. Reaffirms source recovery and external snapshot before refactoring; preserves the user-stated access hold through 2026-11-01; states all 21 live MB-PROOF-002A cases remain NOT_RUN.
- [Master Brain / Opportunity Engine — central reference](https://app.notion.com/p/3f4ccfc54a308176a2abd611d30ca894?pvs=204) and [conversation continuity archive](https://app.notion.com/p/3f4ccfc54a3081c5a2ccee7f792f4697?pvs=204) are relevant indexes/syntheses, not substitutes for the original runtime source or full transcripts.
- Focused Notion searches for “blockchain digital economy crypto betting platform analysis”, “گپ درباره موتور فرصت”, and “آسترولوژی دسترسی” returned the same four broad project/continuity pages rather than distinct domain research pages or full transcripts. Search coverage is not exhaustive and cannot prove absence.

### Recovery interpretation
1. The project’s **requirements and architecture are substantially documented** in accessible records; the original implementation and full historical chat evidence remain unrecovered.
2. Do not confuse a detailed specification, a synthetic fixture, or the isolated CTP scaffold with the original runtime implementation.
3. Keep a separate inventory of (a) architecture/specification, (b) prototype source and tests, (c) original implementation, (d) specialist-domain research/code, and (e) raw chat/task/runtime archives. Each has a different recovery status.
4. Continue non-destructive document/source inventory while the stated access hold remains in force. At the first permitted connection, snapshot and hash the original environment before any startup, repair, import, migration, or refactor.
