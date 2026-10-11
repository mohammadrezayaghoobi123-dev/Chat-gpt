# Master Brain — Experience and Visual Design System
**Status:** Product design baseline; implementation pending  
**Date:** 2026-10-11  
**Branch:** `master-brain/proof-protocol-v0`  
**Companion:** `docs/MASTER_BRAIN_PRODUCT_PLATFORM_ARCHITECTURE.md`

> This document specifies product behavior and visual design principles. It does not claim that a UI has already been implemented or tested.

## 1. Design objective

Master Brain should feel like a premium scientific instrument and a calm command environment—not a generic chatbot, noisy analytics dashboard, or science-fiction decoration. It must communicate intelligence, uncertainty, control, and trust through both interaction and visual hierarchy.

The interface is successful only if it is simultaneously:
- scientifically honest;
- visually refined and memorable;
- clear to a non-specialist user;
- efficient for expert workflows;
- accessible and responsive;
- consistent across web, iOS, Android, and any later desktop shell.

## 2. Experience principles

1. **Evidence before confidence styling.** Never use green checkmarks, completion badges, or confident language to imply scientific validation without the required evidence.
2. **Progressive disclosure.** Show the key decision and current state first; let users open evidence, methods, provenance, rival hypotheses, and raw audit details when needed.
3. **One clear next action.** Each screen should make the next safe and useful step obvious.
4. **Honest state language.** Separate proposed, awaiting clarification, awaiting approval, queued, running, completed, failed, cancelled, and independently verified.
5. **Human control for consequential actions.** Show scope, consequences, cost, and relevant evidence before asking for approval.
6. **Quiet visual confidence.** Use whitespace, typographic hierarchy, restrained color, carefully aligned data, and consistent spacing. Avoid excessive glow, gradients, animated decoration, and card overload.
7. **Information density by context.** Expert audit views may be dense; the default mission overview should be calm and readable.
8. **Continuity across devices.** A mission opened on mobile should be recognizable on desktop, with the same ID, status, decisions, and evidence.
9. **Persian-first quality.** Support Persian and RTL layouts deliberately, including mixed Persian/English technical terms, code, timestamps, tables, and charts. Do not simply mirror every control mechanically.
10. **Motion with purpose.** Use subtle transitions only to communicate state change or hierarchy; respect reduced-motion preferences.

## 3. Visual direction

### Brand character
- Precise, intelligent, composed, premium, quietly futuristic.
- Scientific credibility rather than theatrical "AI magic".
- Warm enough to be approachable; serious enough for industrial, research, and business decisions.

### Color system
Define semantic design tokens rather than scattering literal colors through components:
- primary action;
- neutral surfaces and text;
- information;
- caution / pending review;
- destructive / failed;
- positive / completed operation;
- evidence status categories.

Color must never be the only signal. Pair it with text, iconography, and accessible contrast. Do not use a single green state to represent all of "passed", "supported", "verified", and "completed". Those are distinct concepts.

### Typography and layout
- Use a small, consistent type scale with clear heading, body, label, and metadata roles.
- Use tabular numerals for costs, scores, durations, and identifiers where appropriate.
- Use readable line lengths and generous spacing for mission summaries.
- Dense evidence tables should support sorting, filtering, source grouping, and expandable detail rather than shrinking text.
- Establish responsive breakpoints and a consistent spacing scale as shared tokens.
- Provide proper font fallback and line-height for Persian and Latin text together.

### Components
Create reusable, documented components for:
- app shell and navigation;
- mission composer;
- mission status timeline;
- approval and risk review;
- evidence/provenance row;
- claim assessment panel;
- competing hypothesis comparison;
- test outcome table;
- audit event timeline;
- budget/usage summary;
- empty, loading, offline, error, permission-denied, and stale-data states;
- dialogs, forms, search, filters, and notifications.

Each component should define accessibility behavior, loading/error states, mobile behavior, and design tokens—not just a static appearance.

## 4. Information architecture

Recommended primary navigation:
1. **Command Center** — active missions, requests needing attention, system health, recent decisions.
2. **Missions** — create, filter, inspect, resume, cancel, and review mission history.
3. **Research & Evidence** — claims, source provenance, counterevidence, tests, unknowns, and rival hypotheses.
4. **Specialist Islands** — domain capabilities, current availability, boundaries, and performance.
5. **Models & Tools** — provider adapters, availability, permissions, latency, and cost controls.
6. **Memory & Knowledge** — inspectable records, provenance, correction and retention controls.
7. **Audit & Evaluation** — immutable-style event history, decision changes, test runs, and evaluation results.
8. **Administration** — identity, roles, budgets, security settings, data handling, and system configuration.

The initial release should not expose empty pages for every future area. Use a focused navigation subset and label unavailable capabilities honestly.

## 5. Command Center layout

The desktop command center should prioritize:
- a concise "what needs attention" area;
- active mission list with real status and last update;
- a compact system/worker/provider health summary;
- budget and recent usage, where data is available;
- recent decisions and unresolved contradictions;
- a prominent but not oversized mission composer.

Avoid making charts the centerpiece before meaningful operational data exists. Never fill the UI with fabricated sample metrics in a live environment. If demo data is shown, label it explicitly as demonstration data.

On mobile:
- prioritize active missions, approvals, alerts, and a simple command composer;
- use a compact bottom navigation or a clear collapsible navigation pattern;
- keep high-risk approval details readable without horizontal scrolling;
- defer dense audit tables to an optimized detail view while preserving all information.

## 6. Scientific interaction patterns

### Claim assessment
Display:
- claim text and operational scope;
- current assessment state;
- what evidence supports and opposes it;
- independence and provenance limitations;
- rival hypotheses;
- tests run, not run, and unresolved;
- what evidence would change the decision;
- timestamp and method/version.

Do not turn heuristic evidence weights into percentage probabilities unless calibrated and validated. If a numeric score is displayed, state what it means and what it does not mean.

### Evidence
Every evidence item should make provenance inspectable: source identity/type, date, retrieval/observation method, verification state, relation to the claim, independence group, limitations, and relevant artifact/test reference. Missing metadata must be shown as unknown, not silently inferred.

### Mission state
Keep planning separate from execution. "Plan prepared" does not mean "mission executed"; "completed" does not mean "scientifically verified"; "no contradiction found" does not mean "proven true".

### Approval
Approval UI must present:
- exact action and scope;
- mission ID and contract version/digest;
- expected external effects and risk tier;
- cost/time limits where known;
- unresolved questions and relevant evidence;
- authenticated approver and expiry/replay context.
The client must not be able to grant approval by changing a visual toggle or request payload. Server-side authorization remains authoritative.

### Audit timeline
Show the actor/system, event, timestamp, associated mission/contract version, outcome, and link to supporting evidence. Distinguish event recorded from event independently verified. Provide redacted views based on role.

## 7. Accessibility and usability requirements

- WCAG 2.2 AA is the target baseline for web surfaces, subject to appropriate testing.
- All interactive controls need keyboard access, visible focus, meaningful labels, and sensible focus order.
- Screen readers must receive semantic headings, status announcements, field errors, and accessible names.
- Maintain readable contrast and do not rely on color alone.
- Respect reduced-motion settings and browser text scaling.
- Touch targets must be usable on small mobile screens.
- RTL must support navigation, forms, dialogs, data tables, mixed-direction text, and charts.
- Use localized date/time/number presentation while preserving unambiguous machine-readable timestamps in APIs.
- Error messages should explain the problem and a safe recovery action without exposing secrets or internal stack traces.

## 8. Product states that must be designed before release

Every primary flow must include:
- initial / empty state;
- loading state;
- success state;
- validation error;
- server error;
- permission denied;
- disconnected / reconnecting;
- stale data;
- cancelled or interrupted mission;
- unknown outcome;
- audit persistence failure;
- budget or rate limit reached;
- unsupported or unavailable provider;
- session expired.

A failed write must not be presented as a successful action. A timeout after submission should show an unknown/confirmable outcome and offer safe status reconciliation, not blindly repeat a non-idempotent action.

## 9. Design system delivery

Before broad UI implementation:
1. Establish semantic tokens for color, typography, spacing, radii, elevation, motion, and responsive breakpoints.
2. Define component behavior and variants, including disabled, pending, error, and high-risk states.
3. Create wireframes for desktop and mobile command center, mission detail, claim/evidence review, and approval flow.
4. Validate Persian/RTL alongside English and technical content.
5. Build one production-shaped vertical slice with real API contracts, not a disconnected visual mock.
6. Add visual regression, accessibility, and responsive tests.
7. Review usability with real tasks: create mission, resolve clarification, inspect evidence, approve a safe operation, recover after disconnect, and inspect an audit event.

## 10. Acceptance criteria

- **UX-001:** Users can distinguish planned, running, completed, failed, and verified states without relying on color.
- **UX-002:** A user can find the next required action for an active mission without searching unrelated screens.
- **UX-003:** Evidence, limitations, unknowns, and counterevidence remain accessible from a claim's assessment.
- **UX-004:** Mobile approval screens show the exact scope and risk without hiding critical information.
- **UX-005:** Desktop and mobile clients show consistent server-authoritative mission state.
- **UX-006:** Persian/RTL and mixed-direction technical content are readable and operable.
- **UX-007:** Loading, error, offline, stale, permission-denied, and unknown-outcome states are implemented and tested.
- **UX-008:** Keyboard and assistive-technology access is verified for critical workflows.
- **UX-009:** No fabricated operational data is shown as live data.
- **UX-010:** Visual polish does not override scientific accuracy or safety requirements.

## 11. Explicit non-goals

- Decorative 3D effects or animated "AI brain" graphics that do not improve task performance.
- A giant dashboard full of unvalidated metrics.
- Percent confidence displays derived from uncalibrated heuristics.
- Pixel-perfect duplication of a particular commercial product.
- Shipping all navigation sections before the underlying capability exists.
- Treating a beautiful mockup as proof of a working product.

## 12. Next step

Reconcile this design baseline with the product platform architecture and the existing requirement traceability record. Then create a small set of screen-level wireframes and component contracts for the first vertical slice. Only after the real mission/API contract is clear should a connected UI implementation begin.
