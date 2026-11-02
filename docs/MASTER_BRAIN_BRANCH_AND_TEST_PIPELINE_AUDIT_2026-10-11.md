# Master Brain — Historical Branch Comparison & Test-Pipeline Audit
**Audit date:** 2026-10-11  
**Repository:** `mohammadrezayaghoobi123-dev/Chat-gpt`  
**Compared refs:** `master-brain/planning-baseline` → `master-brain/integrated-mvp`  
**Purpose:** Record the repository evidence that is currently accessible, and distinguish configured automation from executed tests.

## 1. Branch and ancestry findings

The GitHub branch endpoint exposed:
- `main` at `090a1850b5a06a16c8d7ae2e004cd08112b11ae5`
- `master-brain/planning-baseline` at `b1de3c4d3f83181795b4d9291716f83fbb1f1fe5`
- `master-brain/integrated-mvp` at `65c9c42124f167d653f594d7010e64e337d358a7`

GitHub's compare endpoint reports `master-brain/integrated-mvp` is **33 commits ahead and 0 behind** `master-brain/planning-baseline`, with the planning baseline as the merge base. The compare returned the following principal additions/changes:
- Integrated architecture and MVP README
- Meta-Intelligence and contradiction-driven proof specifications
- Scope document for blockchain/digital economy/crypto/betting analysis
- Legacy recovery, implementation gap, requirements traceability, and source-of-truth audit documents
- Python package configuration
- `src/master_brain/` modules: `core.py`, `archipelago.py`, `meta_intelligence.py`, `ctp.py`, `demo.py`
- Four unit-test files
- A GitHub Actions workflow for tests

**Interpretation:** the integration branch adds a documented Python MVP scaffold on top of the planning baseline. This comparison does not reveal the reported earlier ~3,000-line source; the baseline tree inspected here is primarily OpenClaw/Codespaces setup and architecture-reconciliation documentation. This does not prove the older source never existed elsewhere.

## 2. Test automation is configured, but execution is not established

The file `.github/workflows/master-brain-tests.yml` is present. Its declared job:
1. checks out the repository,
2. sets up Python 3.11,
3. installs the project with `python -m pip install -e .`,
4. runs `python -m unittest discover -s tests -v`,
5. runs `python -m master_brain.demo`.

The package metadata in `pyproject.toml` declares Python `>=3.11`, no runtime dependencies, and the package source under `src`.

For commit `65c9c42124f167d653f594d7010e64e337d358a7`, the available commit-workflow-runs query returned an empty list. That query wrapper only returns pull-request-triggered runs and its first page; therefore this empty result is **not** evidence that no workflow ever ran. It also does not establish a passing run. No test command was executed by this audit.

### Current test status
- Test source: **PRESENT**
- CI workflow definition: **PRESENT**
- Passing run for current HEAD: **NOT VERIFIED**
- Local test execution in this audit: **NOT RUN**
- Live `MB-PROOF-002A` cases: remain **NOT_RUN** per the previously recorded continuity status; no new live execution was performed.

## 3. Important distinction: repository branches vs runtime workspace

The repository history can be inspected through GitHub without starting or modifying the Codespace. It cannot reveal uncommitted, ignored, local-only, or runtime/session data that was never committed. A clean Git tree in a remote view would not be a substitute for a workspace snapshot.

The current access hold and preserve-first policy remain in effect. Do not reset, rebuild, clean, revoke, overwrite, or repair the live environment before permitted access and an external snapshot.

## 4. Next actions, ordered by risk

1. **Read-only:** continue collecting exact branch/tree/commit identifiers and inspect the planning baseline's architecture/reconciliation files for requirements or pointers absent from the MVP.
2. **Read-only:** inspect the workflow's recent run history through an endpoint that supports all relevant run types, if available; record run ID, event, head SHA, conclusion, and timestamps.
3. **Recovery gate:** acquire the original implementation/archive bytes, if accessible, and hash them before comparing or importing.
4. **Test gate:** after recovery and on a disposable copy, run the declared test and demo commands. Preserve full stdout/stderr, exit codes, Python version, installed package list, and commit SHA.
5. **Implementation gate:** define versioned canonical mission/evidence/test/audit contracts and compatibility tests before refactoring overlapping planner entry points.
6. **No production claim:** do not describe a capability as operational until a reproducible test or direct runtime observation supports that claim.

## 5. Audit conclusion

The integration branch contains a testable-looking package and a configured CI workflow, but current test success has not been established in this audit. The branch comparison confirms the MVP scaffold is an addition over the planning baseline; it does not recover or replace the inaccessible legacy implementation. The safest next progress is further read-only historical inspection and recovery of original artifacts, followed by a reproducible test baseline on an isolated copy.
