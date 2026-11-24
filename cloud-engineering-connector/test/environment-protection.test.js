import test from "node:test";
import assert from "node:assert/strict";

const repository = "mohammadrezayaghoobi123-dev/Chat-gpt";
const token = "mock-github-actions-read-token";

async function loadVerifier() {
  try {
    return await import("../scripts/verify-environment-protection.mjs");
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      assert.fail("The release Environment protection verifier is not implemented yet.");
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
  environmentData = environment("staging"),
  branchPages = [{ total_count: 1, branch_policies: [{ id: 21, name: "integration/staging-release-*" }] }],
  environmentStatus = 200,
  branchStatus = 200,
  invalidEnvironmentJson = false,
  invalidBranchJson = false,
} = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    calls.push({
      url: parsed.toString(),
      path: parsed.pathname,
      method: init.method ?? "GET",
      authorization: init.headers?.authorization ?? init.headers?.Authorization,
      accept: init.headers?.accept ?? init.headers?.Accept,
    });
    if (parsed.pathname.endsWith("/deployment-branch-policies")) {
      const page = Number(parsed.searchParams.get("page") ?? "1");
      return jsonResponse(branchStatus, branchPages[page - 1] ?? { total_count: 0, branch_policies: [] }, invalidBranchJson);
    }
    return jsonResponse(environmentStatus, environmentData, invalidEnvironmentJson);
  };
  return { fetchImpl, calls };
}

async function expectRejected(options, pattern) {
  const { verifyEnvironmentProtection } = await loadVerifier();
  let caught;
  try {
    await verifyEnvironmentProtection({
      repository,
      releaseEnvironment: "staging",
      token,
      ...options,
    });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error, "invalid release environment metadata must block the release");
  assert.match(caught.message, pattern);
  assert.doesNotMatch(caught.message, /mock-github-actions-read-token/, "failure messages must not disclose the GitHub token");
}

test("accepts the exact protected Staging Environment and reads metadata only", async () => {
  const { verifyEnvironmentProtection } = await loadVerifier();
  const { fetchImpl, calls } = makeFetch();
  const result = await verifyEnvironmentProtection({
    repository,
    releaseEnvironment: "staging",
    token,
    fetchImpl,
  });

  assert.equal(result.environment, "staging");
  assert.equal(result.branchPattern, "integration/staging-release-*");
  assert.equal(result.requiredReviewerCount, 1);
  assert.deepEqual(result.authorizedReviewerUserIds, [335530603]);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.method === "GET"));
  assert.ok(calls.every(call => call.authorization === "Bearer " + token));
  assert.ok(calls.every(call => !/secrets|variables/i.test(call.path)));
});

test("accepts the exact protected Production Environment and release pattern", async () => {
  const { verifyEnvironmentProtection } = await loadVerifier();
  const { fetchImpl } = makeFetch({
    environmentData: environment("production"),
    branchPages: [{
      total_count: 1,
      branch_policies: [{ id: 22, name: "integration/production-release-*" }],
    }],
  });
  const result = await verifyEnvironmentProtection({
    repository,
    releaseEnvironment: "production",
    token,
    fetchImpl,
  });
  assert.equal(result.environment, "production");
  assert.equal(result.branchPattern, "integration/production-release-*");
});

test("rejects an Environment with administrator bypass enabled", async () => {
  const { fetchImpl } = makeFetch({
    environmentData: environment("staging", { can_admins_bypass: true }),
  });
  await expectRejected({ fetchImpl }, /administrator bypass/i);
});

test("rejects an Environment with no required reviewer", async () => {
  const { fetchImpl } = makeFetch({
    environmentData: environment("staging", {
      protection_rules: [{ id: 12, type: "branch_policy" }],
    }),
  });
  await expectRejected({ fetchImpl }, /reviewer/i);
});

test("rejects required reviewers when self-review prevention is disabled", async () => {
  const { fetchImpl } = makeFetch({
    environmentData: environment("staging", {
      protection_rules: [
        {
          id: 11,
          type: "required_reviewers",
          prevent_self_review: false,
          reviewers: [{ type: "User", reviewer: { id: 335530603 } }],
        },
      ],
    }),
  });
  await expectRejected({ fetchImpl }, /self.review/i);
});

test("rejects an empty or malformed reviewer identity set", async () => {
  const { fetchImpl } = makeFetch({
    environmentData: environment("staging", {
      protection_rules: [
        {
          id: 11,
          type: "required_reviewers",
          prevent_self_review: true,
          reviewers: [{ type: "User", reviewer: {} }],
        },
      ],
    }),
  });
  await expectRejected({ fetchImpl }, /reviewer/i);
});

test("rejects an Environment that allows every branch to deploy", async () => {
  const { fetchImpl } = makeFetch({
    environmentData: environment("staging", {
      deployment_branch_policy: null,
    }),
  });
  await expectRejected({ fetchImpl }, /deployment branch polic/i);
});

test("rejects a branch policy that does not exactly match the Staging release namespace", async () => {
  const { fetchImpl } = makeFetch({
    branchPages: [{
      total_count: 1,
      branch_policies: [{ id: 21, name: "integration/*" }],
    }],
  });
  await expectRejected({ fetchImpl }, /branch[- ]polic/i);
});

test("rejects additional branch policies rather than silently widening release eligibility", async () => {
  const { fetchImpl } = makeFetch({
    branchPages: [{
      total_count: 2,
      branch_policies: [
        { id: 21, name: "integration/staging-release-*" },
        { id: 22, name: "main" },
      ],
    }],
  });
  await expectRejected({ fetchImpl }, /exactly one|additional|branch policy/i);
});

test("fails closed when GitHub denies Environment metadata access", async () => {
  const { fetchImpl } = makeFetch({ environmentStatus: 403 });
  await expectRejected({ fetchImpl }, /HTTP 403/i);
});

test("fails closed when the Environment does not exist", async () => {
  const { fetchImpl } = makeFetch({ environmentStatus: 404 });
  await expectRejected({ fetchImpl }, /HTTP 404/i);
});

test("fails closed on malformed GitHub metadata JSON", async () => {
  const { fetchImpl } = makeFetch({ invalidEnvironmentJson: true });
  await expectRejected({ fetchImpl }, /JSON|metadata/i);
});

test("reads every branch-policy page before accepting an exact allowlist", async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
    name: index === 0 ? "integration/staging-release-*" : "synthetic/unexpected-" + index,
  }));
  const { verifyEnvironmentProtection } = await loadVerifier();
  const { fetchImpl, calls } = makeFetch({
    branchPages: [
      { total_count: 101, branch_policies: firstPage },
      { total_count: 101, branch_policies: [{ id: 101, name: "main" }] },
    ],
  });
  let caught;
  try {
    await verifyEnvironmentProtection({
      repository,
      releaseEnvironment: "staging",
      token,
      fetchImpl,
    });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error, "unexpected policies on later pages must block release");
  assert.match(caught.message, /branch policy|exactly one|additional/i);
  assert.equal(calls.filter(call => call.path.endsWith("/deployment-branch-policies")).length, 2);
});


test("rejects Team reviewers when their membership cannot be bound to the PR review identity", async () => {
  const { fetchImpl } = makeFetch({
    environmentData: environment("staging", {
      protection_rules: [
        {
          id: 11,
          type: "required_reviewers",
          prevent_self_review: true,
          reviewers: [{ type: "Team", reviewer: { id: 24680 } }],
        },
        { id: 12, type: "branch_policy" },
      ],
    }),
  });
  await expectRejected({ fetchImpl }, /User reviewer identity/i);
});

test("rejects disabled custom branch policies before requesting the branch-policy endpoint", async () => {
  const { verifyEnvironmentProtection } = await loadVerifier();
  const { fetchImpl, calls } = makeFetch({
    environmentData: environment("staging", {
      deployment_branch_policy: {
        protected_branches: true,
        custom_branch_policies: false,
      },
    }),
  });

  await assert.rejects(
    verifyEnvironmentProtection({
      repository,
      releaseEnvironment: "staging",
      token,
      fetchImpl,
    }),
    /explicit custom deployment branch policies/i,
  );

  assert.equal(
    calls.filter(call => call.path.endsWith("/deployment-branch-policies")).length,
    0,
    "the branch-policy endpoint must not be queried when Environment metadata disables custom policies",
  );
});
