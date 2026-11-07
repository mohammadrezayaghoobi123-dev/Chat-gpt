/**
 * FAIL-CLOSED stub for engineering/hardening-v0.2.0
 *
 * The monolithic worker was temporarily replaced by a source-parts assemble
 * pipeline that is NOT yet complete on this branch. Deploying or merging this
 * file as a production Worker would remove all MCP tools and safety logic.
 *
 * Recovery gate: sequential lib/source-parts/part0.js..partN.js must assemble
 * to worker.generated.js, pass npm test (105), then replace this stub.
 * Until then every request is rejected.
 */
const VERSION = "0.2.0-incomplete";

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
          "engineering/hardening-v0.2.0 source-parts assembly is incomplete. Do not deploy or merge until worker.generated.js is produced and tests pass.",
      });
    }
    return json({
      error: "service_unavailable",
      message:
        "Connector runtime on this branch is intentionally unavailable (fail-closed). See BRANCH_STATUS.md.",
      version: VERSION,
    });
  },
};
