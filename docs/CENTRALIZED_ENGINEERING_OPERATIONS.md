# Centralized Engineering Operations Workflow

## Purpose

This document defines the operational workflow for the Master Brain / Cloud Engineering Connector project. Notion is the management cockpit; GitHub remains the source of truth for code, reviews, CI, and release evidence; Cloudflare remains the runtime control plane.

## Systems of record

| System | Authoritative for |
|---|---|
| Notion Operations Hub | Portfolio view, task ownership, priorities, decisions, blockers, meeting/decision logs |
| GitHub | Source code, branches, pull requests, review approvals, CI checks, immutable commit evidence |
| Cloudflare | Worker configuration, Staging/Production runtime state, deployment and scheduled triggers |
| Claude | Independent review input, only when connected and attributable |
| ChatGPT | Architecture, implementation, test analysis, operational coordination |

A Notion status is a management projection, not proof that code or deployment changed. Link every engineering task to its GitHub Issue/PR and exact commit SHA.

## Standard lifecycle

1. **Intake** — create a GitHub Issue using the engineering task form and a matching Notion task. Define the problem, scope, acceptance criteria, risk, owner, and dependencies.
2. **Triage** — classify severity and priority; identify the service and release gate affected.
3. **Plan** — record the intended design, threat-model impact, test strategy, rollback plan, and reviewer requirements.
4. **Implement** — work on a dedicated branch. Do not push directly to `main`. Keep changes focused and auditable.
5. **Validate** — run relevant unit, integration, security, contract, and CI checks. Record exact SHA and run URLs.
6. **Independent review** — request Claude review only through a configured, attributable integration. A comment is not an approval. A GitHub APPROVE review from an independent identity is required where policy says so.
7. **Resolve** — address every blocking finding; rerun checks on the final exact SHA.
8. **Staging** — deploy only through the guarded Staging workflow after required approvals and preflight checks. Perform live acceptance and rollback validation.
9. **Production** — require Staging acceptance, security sign-off, exact-SHA independent approval, owner authorization, and production release gates. Until then Production is NO-GO.
10. **Closeout** — record outcome, links, residual risks, rollback evidence, and update Notion status.

## Required status vocabulary

- `Backlog`: not triaged.
- `Ready`: scope and acceptance criteria are clear.
- `In progress`: active implementation or investigation.
- `Blocked`: dependency or approval prevents progress; blocker and owner are explicit.
- `In review`: PR opened; review pending.
- `Validated`: required CI and acceptance checks passed for the exact SHA.
- `Done`: merged/closed with evidence and follow-up recorded.
- `NO-GO`: release gate failed or evidence is insufficient.

Do not mark a task Done based only on a comment, local test, or stale CI run.

## Agent collaboration contract

- GitHub PR comments and the handoff document are the shared communication channel.
- Each agent message must carry a unique message ID, role, timestamp, repository, branch, exact head SHA, related message IDs, findings, evidence, and requested action.
- Claude findings are advisory until independently checked. Identity must be attributable; a shared GitHub account does not prove agent identity.
- ChatGPT must reply to actionable findings with ACCEPTED, DISPUTED (with evidence), or NEEDS-INFO, then record the resulting code/test change.
- No agent may approve its own changes or represent a normal issue comment as a GitHub review approval.
- If Claude automation is not connected, state that review is pending; do not simulate a Claude response.

## Safety and authorization gates

- Never read, print, commit, or copy secret values into Notion, GitHub comments, logs, or reports.
- No direct pushes to `main`, force pushes, branch deletion, merge, Production deployment, secret mutation, or traffic shift without explicit owner authorization and required policy approvals.
- Keep Staging and Production credentials and resources separate.
- Prefer read-only audits until a change is explicitly authorized.
- Report uncertainty and missing evidence as unknown, not as success.
- Every deployment claim must cite the workflow run, commit SHA, environment, and live acceptance evidence.

## Current project release gates (snapshot 2026-11-04)

- PR #145 is the Staging candidate. Prior recorded CI passed on its then-current head, but independent exact-SHA approval and live Staging acceptance remain open.
- PR #146 contains the proposed AI handoff protocol. ChatGPT's response was posted, but protocol status remains PROPOSED pending owner acceptance and appropriate review.
- Recent Staging audit found no provisioned KnowledgeStore Durable Object namespace and an empty Cron schedule. Recheck before any release action.
- Main branch protection/rulesets require verification and remediation.
- Production remains NO-GO.

## Automation boundary

The currently configured daily operations monitor is read-only. It checks repository/PR/CI and recorded infrastructure evidence but does not provision resources, create Claude reviews, merge PRs, or deploy. A true Claude review loop requires an explicitly connected Claude/GitHub integration and, depending on implementation, a valid Anthropic authorization method. Do not claim autonomous two-agent execution until an end-to-end test proves it.

## Operational reporting

Every report should include:
- timestamp and scope;
- changed PRs/branches and exact SHAs;
- CI status and run URLs;
- new Claude findings and their attributable source;
- open blockers, owner, and next action;
- Staging/Production gate status;
- explicit statement of any actions not performed.

The daily report should be concise when nothing material changed.
