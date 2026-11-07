/**
 * FAIL-CLOSED placeholder for engineering/hardening-v0.2.0
 *
 * The committed blob on this branch is intentionally NOT the full MCP runtime.
 * CI builds the real worker before tests:
 *   curl main worker → scripts/apply-v0.2-allowlist.mjs → worker.js (37042 bytes)
 *
 * Deploy gate: only deploy after that build step (or an equivalent pipeline step).
 * See BRANCH_STATUS.md.
 */
const VERSION = "0.2.0-build-required";

function json(data, status = 503) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return json({
        status: "degraded",
        service: "cloud-engineering-connector",
        version: VERSION,
        execution: "cloudflare-workers",
        laptop_dependency: false,
        deployable: false,
        message:
          "Committed worker.js is a fail-closed placeholder. Run scripts/apply-v0.2-allowlist.mjs against main baseline before deploy. See BRANCH_STATUS.md.",
      });
    }
    return json({
      error: "service_unavailable",
      message:
        "Connector runtime is intentionally unavailable until the deterministic build produces the full worker. See BRANCH_STATUS.md.",
      version: VERSION,
    });
  },
};
