# OpenClaw Forensic Recovery Audit — 2026-10-11
**Branch:** `master-brain/integrated-mvp`  
**Mode:** Read-only evidence review; no runtime, config, process, device, or workspace changes performed.

## Executive conclusion
OpenClaw is a credible recovery location and must be investigated before treating the original Master Brain source as missing. However, **the live OpenClaw workspace and session store were not accessible during this audit**: every registered Desktop Commander device was offline. This audit therefore reviews the public bootstrap repository, its commit history, and saved project records; it does **not** claim to have inspected the actual `~/.openclaw` runtime.

The original ~3,000-line source remains **INACCESSIBLE / RECOVERY PENDING**, not confirmed lost.

## 1. Live access status
Desktop Commander reported all five registered Codespaces offline:
- `codespaces-b46139` — last seen about 117 hours earlier.
- `codespaces-107000` — about 168 hours.
- `codespaces-c48400` — about 169 hours.
- `codespaces-08e620` — about 171 hours.
- `codespaces-7fa280` — about 229 hours.

The expected historical target is `codespaces-08e620`, associated with `/workspaces/Chat-gpt`. Because it is offline, no read of `~/.openclaw/workspace`, agent session databases, configuration, shell history, or local Codex artifacts was possible. No attempt was made to reset/rebuild the Codespace, revoke any device, or run a bootstrap/install script.

## 2. What the repository proves—and does not prove
Repository: https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt

The current public `main` branch contains reproducible OpenClaw bootstrap/runtime configuration, not the private runtime state. Its architecture document explicitly says that runtime credentials and private memory are outside the public bootstrap repository:
https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/blob/main/openclaw/OPENCLAW_ARCHITECTURE.md

Reviewed files:
- `openclaw/bootstrap/AGENTS.md`: general tool-use, research, memory, and security policy.
- `openclaw/bootstrap/USER.md`: short non-sensitive user preferences.
- `openclaw/bootstrap/MEMORY.md`: deliberately conservative starter memory; only a short note that OpenClaw is being configured in Codespaces and runtime state/secrets should remain outside the public repository.
- `openclaw/bootstrap/skills/README.md`: skill review policy.
- `.devcontainer/install-openclaw.sh`, `.devcontainer/bootstrap-openclaw.sh`, `.devcontainer/start-openclaw-gateway.sh`, `.devcontainer/keep-openclaw-alive.sh`.

The public bootstrap `MEMORY.md` does **not** contain the expanded Master Brain architecture or the reported original code. This is expected if the substantial work was kept in local workspace files, session transcripts, or uncommitted artifacts; it is not evidence that those items never existed.

## 3. Relevant repository history
The OpenClaw-related commit history is primarily infrastructure work:
- 2026-10-01: initialize OpenClaw baseline and bootstrap `AGENTS.md`, `USER.md`, `MEMORY.md`, skills notes, and workspace.
- 2026-10-01: harden bootstrap by appending policy sections to existing workspace files when a marker is absent.
- 2026-10-02: add automatic Gateway startup.
- 2026-10-03: add a Gateway watchdog that attempts to restart the process if port 18789 stops responding.
- 2026-10-04: persist Tailscale environment and Gateway token configuration; subsequently adjust startup ordering to reduce a watchdog race.

Searches of commit messages for `Master Brain`, `Codex`, and `workspace` did not reveal a separate committed implementation of the original ~3,000-line Master Brain source. Commit-message search is not exhaustive proof of absence: code may be in local/untracked files, other repos, private task artifacts, or OpenClaw sessions.

## 4. Configuration and recovery hazards identified
These are static-code observations, not proof of current runtime state:

### A. Do not rerun the installer/bootstrap during recovery
`.devcontainer/install-openclaw.sh` installs OpenClaw, calls `openclaw setup --baseline`, edits `~/.openclaw/openclaw.json` to set Gateway-related values, then invokes the workspace bootstrap. Running it now could change runtime configuration and workspace files before the source is captured.

### B. Workspace bootstrap can append to pre-existing files
`.devcontainer/bootstrap-openclaw.sh` copies starter files if destinations do not exist. If `AGENTS.md`, `SOUL.md`, or `USER.md` already exists and lacks its marker, the script appends the repository policy to that file. It does not first create a backup of the existing file. This is not destructive deletion, but it can alter a historical workspace; do not rerun it before preserving the current files.

### C. Gateway settings are not proof of successful remote access
The installer sets the Gateway bind to loopback and `gateway.tailscale.mode` to `off`, while configuring token auth. The start script launches `openclaw gateway run` on port 18789 and a watchdog. These scripts establish intended startup behavior only; they do not prove that the current Gateway is running, that Tailscale Serve/TLS is configured, or that iPhone access works.

### D. Watchdog can obscure repeated startup failures
The watchdog loops and attempts to restart the Gateway when its HTTP health probe fails. A running watchdog is not equivalent to a healthy authenticated Gateway. When runtime access returns, capture its logs and process state before restarting anything.

## 5. High-priority recovery targets inside the old environment
The next permitted live inspection should inventory these targets without editing them. Exact paths and storage formats must be verified against the installed OpenClaw version (historically reported as 2026.9.7):

1. **Primary workspace:** `~/.openclaw/workspace/` — all files, hidden files, `memory/`, `skills/`, `AGENTS.md`, `MEMORY.md`, daily notes, project folders, scripts, and any files with unusually high line counts.
2. **Agent state and sessions:** `~/.openclaw/agents/` and any associated SQLite/session transcript files; preserve database, WAL and SHM files or use a consistent SQLite backup method before querying.
3. **OpenClaw state/config:** `~/.openclaw/openclaw.json`, `~/.openclaw/state/`, logs, task/run history, plugin state, and backup/sidecar files. Redact secrets in any report.
4. **Project workspace:** `/workspaces/Chat-gpt/`, including `.git`, `git status`, all branches, stashes, reflogs, untracked/ignored files, alternate worktrees, and any ignored source folders.
5. **Codex-local state:** relevant `~/.codex/` and any explicit `CODEX_HOME` location, task/session metadata, local patches, and generated artifacts. Do not assume that Codex data is stored only in the Git repository.
6. **Other recovery evidence:** shell history, temporary folders, editor backups/swap files, ZIP/tar archives, notebooks, patches, and files matching likely code extensions or the 2,600–2,700-line / 700-line artifact clues.

Search by content and size, not only filenames: original files may have generic names or live under OpenClaw rather than a directory named Master Brain.

## 6. Required safe sequence when access becomes available
1. Record device identity, hostname, installed OpenClaw version, repository HEAD, and current process/status.
2. Create an external, dated snapshot of the entire relevant workspace and repository metadata before further exploration. Verify file counts, sizes, and hashes.
3. Preserve OpenClaw session databases consistently; include WAL/SHM and associated metadata where applicable. Keep the original snapshot untouched.
4. Work only on a separate copy/staging directory. Do not run `openclaw doctor --fix`, `setup`, install/bootstrap scripts, migrations, cleanup, or gateway restarts before the snapshot.
5. Produce a file inventory (path, size, modification time, SHA-256, line count, file type) and search for source-code candidates.
6. Search historical session transcripts and memory for Master Brain/Opportunity Engine/CTP references, source paths, task IDs, code blocks, and names of the 2,600–2,700-line and 700-line artifacts.
7. Compare candidate code against the conceptual architecture and CTP prototype; do not overwrite or merge into `main`.
8. Only after source capture, inspect/test copies and map each confirmed capability to actual code and tests.

## 7. Evidence boundary
- **Confirmed:** public bootstrap and runtime-management scripts are committed; current public bootstrap memory is minimal; relevant infrastructure commits exist.
- **Not confirmed:** current Gateway status/config, actual contents of the old workspace, existence of uncommitted source, session transcript contents, Codex task artifacts, or the exact location of the original implementation.
- **Not concluded:** the original code was deleted, lost, or never existed.

## Next action
Continue recovery from the live OpenClaw workspace and its persistent state as soon as the registered device can be accessed under the user's access constraints. Until then, do not substitute public bootstrap files or the CTP prototype for the original source.
