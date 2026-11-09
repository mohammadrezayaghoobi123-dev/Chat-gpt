import test from "node:test";
import assert from "node:assert/strict";
import {
  collectReleaseDeploymentEvidence,
  assertCandidateDeploymentIsActive,
} from "../scripts/release-deployment-evidence.mjs";

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const message = "release-evidence:v1;environment=staging;sha=" + "a".repeat(40) + ";run_id=123456;run_attempt=1";

test("release evidence searches every deployment page and associates the exact candidate independently from active traffic", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    const page = Number(new URL(String(url)).searchParams.get("page"));
    if (page === 1) {
      return response({
        success: true,
        result_info: { total_pages: 2 },
        result: { deployments: [{
          id: "deployment-active",
          annotations: { "workers/message": "different-release" },
          versions: [{ version_id: "active-version", percentage: 100 }],
        }] },
      });
    }
    return response({
      success: true,
      result_info: { total_pages: 2 },
      result: { deployments: [{
        id: "deployment-candidate",
        annotations: { "workers/message": message },
        versions: [{ version_id: "candidate-version", percentage: 100 }],
      }] },
    });
  };

  const result = await collectReleaseDeploymentEvidence({
    fetchImpl,
    deploymentsUrl: "https://api.cloudflare.test/deployments",
    headers: { authorization: "Bearer test-only" },
    expectedMessage: message,
  });

  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[0].url).searchParams.get("per_page"), "100");
  assert.equal(new URL(calls[1].url).searchParams.get("page"), "2");
  assert.equal(calls[0].options.headers.authorization, "Bearer test-only");
  assert.equal(result.candidate_deployment_id, "deployment-candidate");
  assert.deepEqual(result.candidate_version_ids, ["candidate-version"]);
  assert.equal(result.candidate_deployment_association, "verified");
  assert.equal(result.active_deployment_id, "deployment-active");
  assert.equal(result.active_version_id, "active-version");
  assert.equal(result.active_traffic_verification, "verified");
  assert.equal(result.candidate_active_verification, "not_active");
  assert.throws(() => assertCandidateDeploymentIsActive(result), /candidate deployment is not the active 100% deployment/i);
});

test("release evidence fails closed when exact candidate annotation is absent", async () => {
  const result = await collectReleaseDeploymentEvidence({
    fetchImpl: async () => response({
      success: true,
      result_info: { total_pages: 1 },
      result: { deployments: [{
        id: "deployment-other",
        annotations: { "workers/message": message + ";suffix" },
        versions: [{ version_id: "other-version", percentage: 100 }],
      }] },
    }),
    deploymentsUrl: "https://api.cloudflare.test/deployments",
    headers: {},
    expectedMessage: message,
  }).catch(error => error);

  assert.match(result.message, /no deployment matches the exact release identity/i);
});

test("release evidence fails closed when exact candidate annotation is duplicated across pages", async () => {
  const result = await collectReleaseDeploymentEvidence({
    fetchImpl: async url => response({
      success: true,
      result_info: { total_pages: 2 },
      result: { deployments: [{
        id: new URL(String(url)).searchParams.get("page") === "1" ? "duplicate-one" : "duplicate-two",
        annotations: { "workers/message": message },
        versions: [{ version_id: "candidate-version", percentage: 100 }],
      }] },
    }),
    deploymentsUrl: "https://api.cloudflare.test/deployments",
    headers: {},
    expectedMessage: message,
  }).catch(error => error);

  assert.match(result.message, /multiple deployments match the exact release identity/i);
});

test("release evidence rejects malformed pagination and Cloudflare API failures", async t => {
  await t.test("missing pagination total", async () => {
    await assert.rejects(
      collectReleaseDeploymentEvidence({
        fetchImpl: async () => response({ success: true, result: { deployments: [] } }),
        deploymentsUrl: "https://api.cloudflare.test/deployments",
        headers: {},
        expectedMessage: message,
      }),
      /pagination metadata/i,
    );
  });
  await t.test("API failure", async () => {
    await assert.rejects(
      collectReleaseDeploymentEvidence({
        fetchImpl: async () => response({ success: false, errors: [{ message: "denied" }] }, 403),
        deploymentsUrl: "https://api.cloudflare.test/deployments",
        headers: {},
        expectedMessage: message,
      }),
      /Cloudflare deployment metadata request failed/i,
    );
  });
});

test("candidate is active only when exact deployment is newest and routes one version to 100 percent", async () => {
  const result = await collectReleaseDeploymentEvidence({
    fetchImpl: async () => response({
      success: true,
      result_info: { total_pages: 1 },
      result: { deployments: [{
        id: "deployment-candidate",
        annotations: { "workers/message": message },
        versions: [{ version_id: "candidate-version", percentage: 100 }],
      }] },
    }),
    deploymentsUrl: "https://api.cloudflare.test/deployments",
    headers: {},
    expectedMessage: message,
  });
  assert.equal(result.candidate_active_verification, "verified");
  assert.doesNotThrow(() => assertCandidateDeploymentIsActive(result));
});
