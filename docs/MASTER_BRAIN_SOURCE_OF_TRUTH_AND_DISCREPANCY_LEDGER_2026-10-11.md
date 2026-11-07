# Master Brain — Source-of-Truth Inventory & Discrepancy Ledger
**Prepared:** 2026-10-11  
**Branch:** `master-brain/integrated-mvp`  
**Purpose:** Preserve recovered sources and make uncertainty explicit before code changes. This is a documentation-only record; it does not assert that missing files were recovered or that tests ran.

## 1. Source classes — do not conflate them

| Class | Known artifact(s) | Current status | What it proves | What it does not prove |
|---|---|---|---|---|
| Architecture / requirements | `MASTER_BRAIN_INTEGRATED_ARCHITECTURE.md`; `docs/META_INTELLIGENCE_LAYER_SPEC.md`; `docs/CONTRADICTION_DRIVEN_PROOF_CHARTER.md`; connected Notion mother and continuity pages | ACCESSIBLE | Intended system design and stated constraints | Runtime implementation or correct behavior |
| Current MVP source | `src/master_brain/core.py`; `archipelago.py`; `meta_intelligence.py`; `ctp.py` | ACCESSIBLE IN REPOSITORY | A deterministic routing/planning/validation scaffold exists | Live provider calls, durable persistence, production execution, or the original reported ~3,000-line implementation |
| MVP tests | `tests/test_core.py`; `test_archipelago.py`; `test_meta_intelligence.py`; `test_ctp.py` | SOURCE ACCESSIBLE; EXECUTION NOT VERIFIED HERE | Test cases are authored | That they pass on the current commit/environment |
| Detached CTP prototype | `MASTER_BRAIN_CTP_PROTOTYPE_0.1.0.zip` referenced by continuity records | REFERENCED; BYTES/HASH NOT VERIFIED IN THIS AUDIT | A source record says an archive exists or was previously available | Current accessibility, identity with live CTP, or reproducible test results |
| Reported original implementation (~3,000 lines) | Referred to in continuity records | INACCESSIBLE / RECOVERY PENDING | The user reported an earlier implementation | That it is lost, or that the current MVP replaces it |
| Specialist-domain research/code | Blockchain, digital economy, crypto markets/risk, betting/platform analysis and related work | PARTIAL SCOPE DOCUMENTATION; ORIGINAL ARTIFACTS NOT LOCATED IN SOURCES REVIEWED | Some desired domains are named in scope documents | Completed specialist implementations or recovered full research |
| Historical ChatGPT conversation archive | User's requested data export / full project discussions | NOT AVAILABLE IN THIS repository audit | Continuity notes identify missing threads and archive request | That every prior conversation has been searched or restored |
| OpenClaw/Codespaces runtime | `main` and .devcontainer/OpenClaw setup history | READ-ONLY REPOSITORY EVIDENCE; LIVE WORKSPACE NOT INSPECTED | Infrastructure configuration is present in Git history | Current running state, uncommitted files, ignored data, or local-only work |

## 2. Evidence hierarchy

Use these labels in future project reports:
- **VERIFIED_ARTIFACT** — file or commit was fetched and its identity recorded.
- **SOURCE_REVIEWED** — code/spec text inspected; no runtime claim implied.
- **TEST_EXECUTED** — command, environment, commit SHA, exit status, and output retained.
- **RUNTIME_OBSERVED** — a live behavior was directly observed with time and method recorded.
- **HISTORICAL_RECORDED** — a connected record reports a prior event, but it was not repeated in this audit.
- **INACCESSIBLE / RECOVERY_PENDING** — source cannot currently be inspected; never label it lost without evidence.
- **NOT_RUN** — a proposed test has not been executed.
- **UNKNOWN** — evidence is insufficient to classify.

Do not promote one evidence class to another by inference. In particular, source presence is not test success, test success is not production readiness, and agreement among models is not independent corroboration.

## 3. Discrepancy and uncertainty ledger

| ID | Question / discrepancy | Evidence currently available | Safe conclusion | Closure condition |
|---|---|---|---|---|
| D-001 | Where is the reported original ~3,000-line implementation? | Current MVP source and continuity notes; no recovered original artifact in reviewed repository tree | INACCESSIBLE / RECOVERY PENDING; not confirmed lost | Locate original archive/workspace/commit; preserve read-only copy; record SHA-256 and source location |
| D-002 | Is detached CTP the same as the live/original CTP? | Continuity record references a detached archive; repository has a smaller CTP scaffold | Identity not established | Retrieve archive bytes, hash them, list archive contents, compare file-by-file against all relevant commits |
| D-003 | Do current unit tests pass? | Test source files exist; current audit did not execute them | NOT VERIFIED in this audit | Run on a disposable copy; record Python version, dependency versions, commit SHA, command, complete output, and exit code |
| D-004 | Did the detached prototype pass 31 tests? | Historical continuity record reports 31 passed | HISTORICAL_RECORDED only; not rerun here | Obtain original test output/environment or rerun recovered prototype reproducibly |
| D-005 | What is the state of the 21 MB-PROOF-002A live cases? | Continuity record says 21 cases are NOT_RUN | NOT_RUN per recorded status; no live execution claimed | Execute only after authorized, isolated environment and test data are available; preserve raw artifacts |
| D-006 | Are requested specialist islands implemented? | Some scope/roadmap documents; reviewed MVP registry is incomplete | Scope exists; implementation coverage is unverified or absent for several islands | Inventory source modules, interfaces, tests, and evidence separately per island |
| D-007 | Are model/provider adapters, retrieval and durable persistence wired? | Reviewed MVP source/README does not show complete live integration | Not implemented in the reviewed MVP evidence; do not infer about inaccessible source | Inspect recovered original source and dependency/config inventory; run isolated integration tests |
| D-008 | Is the live Codespace safe to repair now? | Continuity record says reconnection is deferred until 2026-11-01 and requires snapshot first | Do not connect, reset, rebuild, revoke, clean, or mutate before the hold expires and authorization is clear | At/after permitted access: inspect state read-only, snapshot and hash before any repair |
| D-009 | Which duplicate/versioned master documents are canonical? | Several similarly named Library versions are referenced | Do not deduplicate or overwrite based on title alone | Materialize accessible copies; compute hashes; compare content and record a version map |
| D-010 | Have all prior conversations and research threads been searched? | Notion records explicitly note missing full conversation threads and an outstanding archive path | No; search coverage is incomplete | Obtain export/archive, inventory files, hash originals, index them, and log failed/unavailable items |

## 4. Preserve-first recovery sequence

1. **Freeze destructive work:** no reset, cleanup, overwrite, refactor, or live repair while source recovery is incomplete.
2. **Inventory repository history:** record branch names, commit SHAs, dates, parent relationships, and relevant file trees; inspect historical trees without checking them out into a live workspace.
3. **Inventory connected records:** collect accessible Notion/Library references, preserve every version, and note retrieval limits.
4. **Acquire bytes before comparing:** a title or reference to an archive is not a recovered archive. For each acquired artifact, record original path, size, timestamp if available, SHA-256, and access method.
5. **Compare duplicates and legacy code on copies only:** generate a file-level diff and dependency map; retain originals.
6. **Run tests on a disposable copy:** only after obtaining the source and dependencies. Save raw test logs; distinguish unit tests, integration tests, live cases, and benchmarks.
7. **Create migration mapping:** legacy artifact → preserved location/hash → current requirement → proposed island/interface → compatibility test → decision and rationale.
8. **Only then implement:** define canonical contracts and write compatibility tests before refactoring overlapping planners or evidence records.

## 5. Required artifact record template

For each source artifact, capture:
- `artifact_id` (stable, never reused)
- original name and path / URL
- source class and owner/repository/page
- retrieved_at (UTC) and retrieval method
- byte size and SHA-256 (when bytes are available)
- commit SHA or document version, if applicable
- purpose and dependencies
- evidence class and verification status
- test names, environment, raw log location, and exit code
- sensitive data / secrets handling notes
- target architecture island and migration decision
- reviewer, review timestamp, and unresolved questions

## 6. Immediate next action

Continue read-only history and source discovery while the live-access hold remains in force. Do not create implementation code to stand in for missing legacy work. The next code milestone is gated on (a) a preserved copy of recovered originals, (b) a source/version map, and (c) a reproducible test baseline. Until then, architecture and audit documents are planning/evidence artifacts, not proof of operational readiness.
