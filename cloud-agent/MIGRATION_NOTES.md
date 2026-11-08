# Worker Migration Notes (config + observability)

## Status on branch `hardening/cloud-production-readiness-2026-11-07`

Completed:
- `src/config.js` — single source of truth for VERSION, MODEL, REPO_*, SYSTEM_PROMPT, TOOL_DEFINITIONS, SECURITY_HEADERS, neuron rates, bounds.
- `src/observability.js` — structured, secret-free logging helpers.
- `src/core.js` — re-exports bounds from config (backward compatible).
- `PRODUCTION_READINESS.md` — hard gates for production.
- `package.json` — version 0.1.1 + check for new modules.

## Remaining safe steps for `src/worker.js`

Because `worker.js` is large and under active test coverage, the recommended sequence is:

1. Replace the top-level constants block:

```js
import {
  VERSION,
  MODEL,
  REPO_OWNER as OWNER,
  REPO_NAME as REPO,
  DEFAULT_REF,
  SYSTEM_PROMPT,
  TOOL_DEFINITIONS,
  SECURITY_HEADERS,
  INPUT_NEURONS_PER_MILLION,
  OUTPUT_NEURONS_PER_MILLION,
  MAX_COMPLETION_TOKENS
} from "./config.js";
import { logAuthFailure, logBudget, logToolCall, logModelInvocation } from "./observability.js";
```

2. Delete the now-duplicate local `const VERSION / MODEL / OWNER / REPO / SYSTEM_PROMPT / TOOL_DEFINITIONS / SECURITY_HEADERS / INPUT_...` declarations.

3. In `githubJson` user-agent use `` `master-brain-cloud-agent/${VERSION}` ``.

4. In `readRawFile` and `executeTool` use `DEFAULT_REF` instead of the hardcoded string `"master-brain/integrated"`.

5. Improve `/healthz` (inside `handleFetch`) to return:

```js
{
  service: "master-brain-cloud-agent",
  version: VERSION,
  model: MODEL,
  repository: `${OWNER}/${REPO}`,
  bindings: {
    ai: Boolean(env.AI),
    sessions: Boolean(env.AGENT_SESSIONS),
    budget: Boolean(env.AGENT_BUDGET),
    rate_limiter: Boolean(env.AGENT_RATE_LIMITER)
  },
  read_only: true
}
```

Do **not** include any secret presence flags that could leak configuration.

6. Call `logAuthFailure` on 401/503 auth paths and `logModelInvocation` / `logToolCall` around the model and tool loops.

7. Run locally:

```sh
cd cloud-agent
npm test
npm run check
npx wrangler@4.155.0 deploy --dry-run
```

8. Only after green CI on this branch, open a PR titled:
   `hardening: production readiness (config, observability, health)`.

## Budget module

`budget.js` currently defines its own `DAILY_NEURON_BUDGET`. Prefer:

```js
export { DAILY_NEURON_BUDGET } from "./config.js";
```

or keep the local constant and assert equality in a test so the two sources cannot drift.

## Acceptance after migration

- `GET /healthz` returns the enriched payload.
- Authenticated session + chat still works.
- Neuron reservation/settlement still works.
- No secrets appear in logs or health response.
