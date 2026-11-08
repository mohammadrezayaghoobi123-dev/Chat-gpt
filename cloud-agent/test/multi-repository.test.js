import test from "node:test";
import assert from "node:assert/strict";

await import("./helpers/load-worker.js");
const { executeTool } = await import("../src/tools.js");
const { TOOL_DEFINITIONS, REPO_FULL, DEFAULT_REF } = await import("../src/config.js");
const { REPOSITORY_ALLOWLIST } = await import("../src/repository-policy.js");

const HUB = "mohammadrezayaghoobi123-dev/Master-Brain-MCP-Hub";
const SHA = "b".repeat(40);

async function withGitHub(handler, run) {
  const urls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    urls.push(String(url));
    return Response.json(handler(String(url)));
  };
  try { await run(urls); } finally { globalThis.fetch = realFetch; }
  return urls;
}

const fileBody = text => ({ type: "file", encoding: "base64", content: Buffer.from(text).toString("base64") });

const standard = url => {
  if (/\/repos\/[^/]+\/[^/]+$/.test(url)) return { default_branch: "trunk" };
  if (url.includes("/branches/")) return { commit: { sha: SHA } };
  if (url.includes("/git/trees/")) return { tree: [{ type: "blob", path: "README.md" }] };
  if (url.includes("/contents/")) return fileBody("hello");
  throw new Error("unexpected GitHub URL " + url);
};

test("both repository tools advertise an optional repository restricted to the allowlist", () => {
  for (const name of ["project_inspect", "read_project_file"]) {
    const def = TOOL_DEFINITIONS.find(tool => tool.function.name === name).function.parameters;
    assert.deepEqual(def.properties.repository.enum, [...REPOSITORY_ALLOWLIST], name);
    assert.equal(def.additionalProperties, false);
    assert.equal((def.required || []).includes("repository"), false, "repository stays optional");
  }
});

test("without a repository the default repository is used and no extra GitHub request is made", async () => {
  const urls = await withGitHub(standard, async () => {
    const out = await executeTool("project_inspect", "{}");
    assert.equal(out.repository, REPO_FULL);
    assert.equal(out.branch, DEFAULT_REF);
  });
  assert.equal(urls.length, 2);
  for (const url of urls) assert.ok(url.startsWith("https://api.github.com/repos/" + REPO_FULL + "/"), url);
});

test("project_inspect on the second repository only touches that repository and uses its default branch", async () => {
  const urls = await withGitHub(standard, async () => {
    const out = await executeTool("project_inspect", JSON.stringify({ repository: HUB }));
    assert.equal(out.repository, HUB);
    assert.equal(out.branch, "trunk");
    assert.equal(out.commit_sha, SHA);
  });
  assert.ok(urls.length >= 3);
  for (const url of urls) assert.ok(url.startsWith("https://api.github.com/repos/" + HUB), url);
  assert.equal(urls.some(url => url.includes(REPO_FULL)), false, "no request may leak to the default repository");
});

test("an explicit branch on the second repository skips default-branch discovery", async () => {
  const urls = await withGitHub(standard, async () => {
    const out = await executeTool("project_inspect", JSON.stringify({ repository: HUB, branch: "release/1" }));
    assert.equal(out.branch, "release/1");
  });
  assert.equal(urls.some(url => /\/repos\/[^/]+\/[^/]+$/.test(url)), false);
});

test("read_project_file on the second repository reads from it and reports it", async () => {
  const urls = await withGitHub(standard, async () => {
    const out = await executeTool("read_project_file", JSON.stringify({ repository: HUB, path: "README.md", ref: "main" }));
    assert.equal(out.repository, HUB);
    assert.equal(out.content, "hello");
  });
  assert.equal(urls.length, 1);
  assert.ok(urls[0].startsWith("https://api.github.com/repos/" + HUB + "/contents/README.md"), urls[0]);
  const defaultRef = await withGitHub(standard, async () => {
    const out = await executeTool("read_project_file", JSON.stringify({ repository: HUB, path: "README.md" }));
    assert.equal(out.ref, "trunk");
  });
  assert.ok(defaultRef.some(url => url.includes("ref=trunk")), "default branch of the second repository is used");
});

test("repositories outside the allowlist, case tricks and non-strings are rejected before any GitHub request", async () => {
  const bad = ["octocat/Hello-World", "mohammadrezayaghoobi123-dev/verbose-funicular", HUB + "-fork", "../" + HUB, HUB + "/../x", 5, {}, [], true];
  for (const tool of ["project_inspect", "read_project_file"]) {
    for (const repository of bad) {
      const urls = await withGitHub(standard, async () => {
        await assert.rejects(() => executeTool(tool, JSON.stringify({ repository, path: "README.md" })), /Invalid arguments|Repository is not allowed/, tool + " " + JSON.stringify(repository));
      });
      assert.equal(urls.length, 0, "no GitHub request for " + JSON.stringify(repository));
    }
  }
});

test("path and ref safety rules still apply on the second repository", async () => {
  for (const args of [{ path: ".env" }, { path: "../Chat-gpt/README.md" }, { path: "a/../../b" }, { path: "README.md", ref: "../main" }, { path: "README.md", ref: "-x" }]) {
    const urls = await withGitHub(standard, async () => {
      await assert.rejects(() => executeTool("read_project_file", JSON.stringify({ repository: HUB, ...args })));
    });
    assert.equal(urls.length, 0, JSON.stringify(args));
  }
});

test("an unsafe default branch reported by GitHub is refused and nothing further is requested", async () => {
  for (const bad of ["../x", "", 5, null, "a b", "-x"]) {
    const urls = await withGitHub(url => (/\/repos\/[^/]+\/[^/]+$/.test(url) ? { default_branch: bad } : standard(url)), async () => {
      await assert.rejects(() => executeTool("project_inspect", JSON.stringify({ repository: HUB })), /default branch/i, String(bad));
    });
    assert.equal(urls.length, 1, "only the repository lookup may run");
  }
});

test("engineering_standards takes no repository argument", async () => {
  await assert.rejects(() => executeTool("engineering_standards", JSON.stringify({ repository: HUB })), /Invalid arguments/);
});
