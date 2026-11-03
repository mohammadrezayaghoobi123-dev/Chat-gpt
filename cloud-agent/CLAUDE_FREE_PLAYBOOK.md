# Claude Free operating playbook

This playbook reduces avoidable context and tool consumption. It does not bypass, reset, or increase Anthropic's account limits.

## Operating rules

1. Keep the original Master Brain mother mission as the governing instruction. Do not rewrite or resend it on every turn.
2. Keep one Claude conversation for one active project stage while it remains useful. Resume from the last checkpoint after a session reset; do not ask Claude to repeat completed work.
3. Send one complete, bounded task per message. Include the exact stage, objective, files/PR/commit scope, acceptance criteria, and required evidence.
4. Ask Claude to inspect the current GitHub state before relying on an earlier report.
5. Ask for concise evidence, not a long narrative: commit SHA, changed paths, exact test command, result, CI run ID, failures, and remaining blockers.
6. Require Claude to update a small checkpoint at the end of each work session. The checkpoint must record completed work, current blocker, next single action, and the last verified commit.
7. Do not repeat large logs, full source files, or the entire mother mission when a short reference to the prior context or a repository path is enough.
8. Disable Extended Thinking for routine lookups and mechanical tasks if the Free interface exposes that setting. Reserve the most expensive reasoning mode for architecture, security, statistical, and root-cause decisions.
9. Turn off unrelated connectors, web research, and other tools when the task does not need them. Batch closely related questions into one well-scoped request.
10. Never ask Claude to claim tests passed unless it has actual execution output. A report, plan, or code review is not test evidence.

## Free-plan constraints

- Claude Free has a usage limit that resets on a five-hour session window; the amount available varies with message length, conversation length, model, tools, and service demand.
- Do not assume a fixed number of messages.
- Do not depend on Projects for this workflow; the current plan comparison lists Projects as unavailable on Free.
- Do not assume the optional "Reset for free" offer is available to every Free account.
- Do not use account switching, automation, or other mechanisms intended to evade usage limits.

## Compact task template

Use this in the existing project conversation; replace the bracketed fields.

> Continue under the original Master Brain Cloud mother mission. Current authorized stage: [STAGE]. Read the latest repository state and the latest checkpoint before acting. Perform only this bounded task: [ONE TASK]. Preserve main and all existing work. Do not merge, deploy, alter secrets, or weaken controls. Return only the evidence required for the task: exact commit, changed paths, commands actually executed, complete test result, CI run ID, failures, and next blocker. Update the checkpoint. Do not advance the stage unless its original hard gate is fully VERIFIED_COMPLETE.

## Checkpoint format

```text
Project: Master Brain Cloud
Governing mission: original Master Brain Cloud mother command
Current stage:
Stage gate: VERIFIED_COMPLETE | NOT_COMPLETE
Last verified commit:
Current branch:
Completed in this session:
Tests actually executed:
CI run IDs and conclusions:
Open defects / blockers:
Next single action:
Forbidden actions still requiring owner approval:
```

## Evidence discipline

Claude Free optimization is not a substitute for independent verification. The GitHub commit, CI result, deployed version, and live smoke test must each be checked at their actual source. Never mark a stage complete based on a summarized chat response alone.
