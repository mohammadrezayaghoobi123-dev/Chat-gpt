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
