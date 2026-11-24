import test from "node:test";
import assert from "node:assert/strict";

const repository = "mohammadrezayaghoobi123-dev/Chat-gpt";
const token = "mock-github-actions-read-token";

async function loadAudit() {
  try {
    return await import("../scripts/audit-environment-protection.mjs");
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      assert.fail("The read-only GitHub Environment preflight audit is not implemented yet.");
    }
    throw error;
  }
}

function environment(name, overrides = {}) {
  return {
    name,
    can_admins_bypass: false,
    protection_rules: [
      {
        id: 11,
        type: "required_reviewers",
        prevent_self_review: true,
        reviewers: [{ type: "User", reviewer: { id: 335530603 } }],
      },
      { id: 12, type: "branch_policy" },
    ],
    deployment_branch_policy: {
      protected_branches: false,
      custom_branch_policies: true,
    },
    ...overrides,
  };
}

function jsonResponse(status, body, invalidJson = false) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      if (invalidJson) throw new Error("synthetic invalid JSON");
      return body;
    },
  };
}

function makeFetch({
  staging = {
    environmentStatus: 200,
    environmentData: environment("staging"),
    branchStatus: 200,
    branchBody: { total_count: 1, branch_policies: [{ id: 21, name: "integration/staging-release-*" }] },
  },
  production = {
    environmentStatus: 200,
    environmentData: environment("production"),
    branchStatus: 200,
    branchBody: { total_count: 1, branch_policies: [{ id: 22, name: "integration/production-release-*" }] },
  },
} = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(String(url));
    calls.push({
      url: parsed.toString(),
      path: parsed.pathname,
      method: init.method ?? "GET",
      authorization: init.headers?.authorization,
    });
    const target = parsed.pathname.includes("/environments/staging")
      ? staging
      : parsed.pathname.includes("/environments/production")
        ? production
        : null;
    assert.ok(target, "audit must call only the fixed Staging or Production Environment resources");
    if (target.error) throw target.error;
    if (parsed.pathname.endsWith("/deployment-branch-policies")) {
      return jsonResponse(
        target.branchStatus ?? 200,
        target.branchBody ?? { total_count: 0, branch_policies: [] },
        target.invalidBranchJson === true,
      );
    }
    return jsonResponse(
      target.environmentStatus ?? 200,
      target.environmentData ?? {},
      target.invalidEnvironmentJson === true,
    );
  };
  return { fetchImpl, calls };
}

test("audits both protected Environments and returns READY only when both exact release contracts pass", async () => {
  const { auditEnvironmentProtection } = await loadAudit();
  const { fetchImpl, calls } = makeFetch();
  const report = await auditEnvironmentProtection({ repository, token, fetchImpl });

  assert.equal(report.ready, true);
  assert.deepEqual(
    report.environments.map(item => [item.environment, item.status, item.branchPattern, item.requiredReviewerCount]),
    [
      ["staging", "READY", "integration/staging-release-*", 1],
      ["production", "READY", "integration/production-release-*", 1],
    ],
  );
  assert.equal(calls.length, 4);
  assert.ok(calls.every(call => call.method === "GET"));
  assert.ok(calls.every(call => call.authorization === "Bearer " + token));
  assert.ok(calls.every(call => !/secrets|variables/i.test(call.path)));
});

test("continues auditing Production after Staging is blocked by an unsafe policy", async () => {
  const { auditEnvironmentProtection } = await loadAudit();
  const { fetchImpl, calls } = makeFetch({
    staging: {
      environmentStatus: 200,
      environmentData: environment("staging", { can_admins_bypass: true }),
      branchStatus: 200,
      branchBody: { total_count: 1, branch_policies: [{ id: 21, name: "integration/staging-release-*" }] },
    },
  });
  const report = await auditEnvironmentProtection({ repository, token, fetchImpl });

  assert.equal(report.ready, false);
  assert.equal(report.environments[0].status, "BLOCKED");
  assert.equal(report.environments[1].status, "READY");
  assert.ok(calls.some(call => call.path.endsWith("/environments/production")));
  assert.match(report.environments[0].reason, /administrator bypass/i);
});

test("reports a missing Production Environment without attempting to create or configure it", async () => {
  const { auditEnvironmentProtection } = await loadAudit();
  const { fetchImpl, calls } = makeFetch({
    production: { environmentStatus: 404 },
  });
  const report = await auditEnvironmentProtection({ repository, token, fetchImpl });

  assert.equal(report.ready, false);
  assert.equal(report.environments[1].status, "MISSING");
  assert.match(report.environments[1].reason, /404/i);
  assert.ok(!calls.some(call => call.path.endsWith("/environments/production/deployment-branch-policies")));
  assert.ok(calls.every(call => call.method === "GET"));
});

test("classifies permission denial as UNKNOWN rather than misreporting an unsafe policy", async () => {
  const { auditEnvironmentProtection } = await loadAudit();
  const { fetchImpl } = makeFetch({
    staging: { environmentStatus: 403 },
  });
  const report = await auditEnvironmentProtection({ repository, token, fetchImpl });

  assert.equal(report.environments[0].status, "UNKNOWN");
  assert.match(report.environments[0].reason, /403/i);
  assert.equal(report.ready, false);
});

test("classifies transport errors and malformed metadata as UNKNOWN", async () => {
  const { auditEnvironmentProtection } = await loadAudit();
  const { fetchImpl } = makeFetch({
    staging: { error: new Error("synthetic network failure") },
    production: { environmentStatus: 200, invalidEnvironmentJson: true },
  });
  const report = await auditEnvironmentProtection({ repository, token, fetchImpl });

  assert.equal(report.environments[0].status, "UNKNOWN");
  assert.equal(report.environments[1].status, "UNKNOWN");
  assert.equal(report.ready, false);
});

test("sanitized summary includes per-Environment status without exposing reviewer IDs or token values", async () => {
  const { auditEnvironmentProtection, renderEnvironmentAuditSummary } = await loadAudit();
  const { fetchImpl } = makeFetch({
    production: { environmentStatus: 404 },
  });
  const report = await auditEnvironmentProtection({ repository, token, fetchImpl });
  const summary = renderEnvironmentAuditSummary(report);

  assert.match(summary, /GitHub Environment read-only preflight/i);
  assert.match(summary, /staging/i);
  assert.match(summary, /production/i);
  assert.match(summary, /MISSING/);
  assert.match(summary, /BLOCKED|UNKNOWN|MISSING|READY/);
  assert.doesNotMatch(summary, /335530603/);
  assert.doesNotMatch(summary, /mock-github-actions-read-token/);
  assert.doesNotMatch(summary, /Bearer\s+\S+/i);
});

test("rejects missing repository or token before calling GitHub", async () => {
  const { auditEnvironmentProtection } = await loadAudit();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse(200, {});
  };

  await assert.rejects(
    auditEnvironmentProtection({ repository: "", token, fetchImpl }),
    /GITHUB_REPOSITORY/i,
  );
  await assert.rejects(
    auditEnvironmentProtection({ repository, token: "", fetchImpl }),
    /GITHUB_TOKEN/i,
  );
  assert.equal(calls, 0);
});

test("classifies disabled custom branch policies as BLOCKED before querying their endpoint", async () => {
  const { auditEnvironmentProtection } = await loadAudit();
  const { fetchImpl, calls } = makeFetch({
    staging: {
      environmentStatus: 200,
      environmentData: environment("staging", {
        deployment_branch_policy: {
          protected_branches: true,
          custom_branch_policies: false,
        },
      }),
      branchStatus: 200,
      branchBody: { total_count: 1, branch_policies: [{ id: 21, name: "integration/staging-release-*" }] },
    },
  });

  const report = await auditEnvironmentProtection({ repository, token, fetchImpl });

  assert.equal(report.environments[0].status, "BLOCKED");
  assert.match(report.environments[0].reason, /explicit custom deployment branch policies/i);
  assert.equal(
    calls.filter(call =>
      call.path.includes("/environments/staging/deployment-branch-policies")
    ).length,
    0,
    "an unsafe Environment policy flag must be reported without a branch-policy endpoint request",
  );
});

test("classifies branch-policy endpoint 404 as UNKNOWN after Environment metadata confirms custom policies are enabled", async () => {
  const { auditEnvironmentProtection } = await loadAudit();
  const { fetchImpl, calls } = makeFetch({
    staging: {
      environmentStatus: 200,
      environmentData: environment("staging", {
        deployment_branch_policy: {
          protected_branches: false,
          custom_branch_policies: true,
        },
      }),
      branchStatus: 404,
    },
  });

  const report = await auditEnvironmentProtection({ repository, token, fetchImpl });

  assert.equal(report.environments[0].status, "UNKNOWN");
  assert.match(report.environments[0].reason, /custom_branch_policies=true/i);
  assert.equal(
    calls.filter(call =>
      call.path.includes("/environments/staging/deployment-branch-policies")
    ).length,
    1,
  );
});
