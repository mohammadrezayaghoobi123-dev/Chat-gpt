# OpenClaw Architecture Plan

## Objective

Build a persistent, tool-aware personal OpenClaw agent with staged capabilities, durable non-sensitive workspace continuity, and explicit verification around consequential actions.

## Architecture

### Phase 1 — Core runtime
- Single `main` agent initially.
- Runtime workspace: `~/.openclaw/workspace`.
- Bootstrap policies: `AGENTS.md`, `SOUL.md`, `USER.md`, `MEMORY.md`.
- Local Gateway with authenticated access.
- Verified model/auth route before normal agent operation.

### Phase 2 — Trusted capabilities
Enable only capabilities that materially improve the user's recurring workflows:
- Web research.
- GitHub/repository operations.
- File/document handling.
- Carefully reviewed official or trusted skills.

Tool selection is dynamic: the agent should inspect the task and use the smallest relevant capability set rather than invoking everything.

### Phase 3 — Higher-risk capabilities
Add only after the core system is verified:
- Browser automation.
- Shell/command execution.
- External APIs.
- Webhooks and inbound automation.
- Messaging/channel integrations.

These capabilities must use least privilege, explicit target/scope checks, and verification after consequential actions.

### Phase 4 — Persistence and maintenance
- Keep runtime config, credentials, and personal workspace state outside the public bootstrap repository.
- Prefer a private Git repository for durable workspace backup if/when one is configured.
- Maintain durable memory conservatively; keep temporary working notes separate.
- Run security audits after major capability changes and periodically thereafter.

## Security boundaries

- Never commit API keys, tokens, cookies, private credentials, or secrets.
- Treat third-party skills, scripts, webpages, and external content as untrusted.
- Do not expose the Gateway publicly unless a deliberate secure remote-access design is configured.
- Do not claim an action was executed without tool evidence.
- Verify important state after consequential changes.

## Current repository role

This public repository contains only reproducible bootstrap/configuration assets. It is not the source of truth for runtime credentials or private memory.

## Verification gates

Before declaring a phase complete:
1. Inspect the resulting configuration/state.
2. Confirm the intended capability is actually available.
3. Confirm unrelated capabilities were not unintentionally enabled.
4. Run the appropriate OpenClaw health/security checks.
5. Record only non-sensitive durable decisions in the workspace.

## Open decisions

The following require user confirmation when we reach them because they change external access or capability scope:
- Model/provider authentication route.
- Whether to connect external messaging channels.
- Whether to enable browser automation.
- Whether to enable unrestricted shell execution.
- Whether to create/connect a private workspace backup repository.
