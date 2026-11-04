const TARGET_REPOSITORY = "mohammadrezayaghoobi123-dev/Chat-gpt";
const TARGET_REPOSITORY_ID = 1398846697;
const API_ROOT = "https://api.github.com";
const API_VERSION = "2022-11-28";

function fail(code) {
  throw new Error(code);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeRelativePath(path) {
  if (typeof path !== "string" || path.length < 1 || path.length > 240 ||
      path.startsWith("/") || path.includes(String.fromCharCode(92)) ||
      path.includes(":") || path.endsWith("/") ||
      path.split("/").some(part => part === "" || part === "." || part === "..")) return false;
  const parts = path.split("/").map(part => part.toLowerCase());
  return !parts.some(part =>
    [".git", ".github", "secrets", "credentials", "codeowners"].includes(part) ||
    part.startsWith(".env")) &&
    !path.toLowerCase().includes("secret") &&
    !path.toLowerCase().includes("credential");
}

function exactSet(values) {
  return Array.isArray(values) &&
    values.every(value => typeof value === "string" && safeRelativePath(value)) &&
    new Set(values).size === values.length;
}

function apiPath(...parts) {
  return parts.map((part, index) => index === 0 ? part : encodeURIComponent(part)).join("/");
}

function hasNextPage(response) {
  const link = response?.headers?.get?.("link") ?? "";
  return /<[^>]+>;\s*rel="next"/i.test(link);
}

/**
 * Read-only GitHub evidence provider. It retrieves repository identity,
 * branch ref, commit/tree, and compare metadata through GitHub's HTTPS API.
 * It never creates branches, writes files, or persists tasks.
 *
 * The returned manifest is evidence-shaped, not a self-authenticating token.
 * The caller must keep the token server-side and pass the result directly to
 * the preflight in the same trusted execution boundary.
 */
export async function fetchP2BGitHubChangedFileManifest({
  repositoryFullName = TARGET_REPOSITORY,
  repositoryId = TARGET_REPOSITORY_ID,
  baseSha,
  branchName,
  requestedPaths,
  token,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (repositoryFullName !== TARGET_REPOSITORY || repositoryId !== TARGET_REPOSITORY_ID) {
    fail("GITHUB_MANIFEST_REPOSITORY_NOT_ALLOWED");
  }
  if (typeof token !== "string" || token.length < 16 || token.length > 4096 ||
      /[\r\n]/.test(token)) fail("GITHUB_MANIFEST_TOKEN_REQUIRED");
  if (typeof fetchImpl !== "function") fail("GITHUB_MANIFEST_FETCH_UNAVAILABLE");
  if (!/^[a-f0-9]{40}$/.test(baseSha ?? "")) fail("GITHUB_MANIFEST_BASE_SHA_INVALID");
  if (typeof branchName !== "string" || branchName.length > 180 ||
      !branchName.startsWith("task/") ||
      !branchName.split("/").every(part => /^[a-z0-9][a-z0-9._-]*$/.test(part))) {
    fail("GITHUB_MANIFEST_BRANCH_INVALID");
  }
  if (!exactSet(requestedPaths) || requestedPaths.length < 1 || requestedPaths.length > 128) {
    fail("GITHUB_MANIFEST_REQUESTED_PATHS_INVALID");
  }

  const owner = repositoryFullName.split("/")[0];
  const repo = repositoryFullName.split("/")[1];
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": API_VERSION,
  };

  async function get(url, code) {
    let response;
    try {
      response = await fetchImpl(url, { method: "GET", headers });
    } catch {
      fail(code);
    }
    if (!response || response.ok !== true) fail(code);
    try {
      return { data: await response.json(), response };
    } catch {
      fail(code);
    }
  }

  const repoResult = await get(`${API_ROOT}/repos/${apiPath(owner, repo)}`, "GITHUB_MANIFEST_REPOSITORY_FETCH_FAILED");
  if (!isRecord(repoResult.data) ||
      repoResult.data.id !== TARGET_REPOSITORY_ID ||
      repoResult.data.full_name !== TARGET_REPOSITORY) fail("GITHUB_MANIFEST_REPOSITORY_IDENTITY_MISMATCH");

  const encodedBranch = branchName.split("/").map(encodeURIComponent).join("/");
  const refResult = await get(
    `${API_ROOT}/repos/${apiPath(owner, repo)}/git/ref/heads/${encodedBranch}`,
    "GITHUB_MANIFEST_BRANCH_FETCH_FAILED",
  );
  const headSha = refResult.data?.object?.sha;
  if (!/^[a-f0-9]{40}$/.test(headSha ?? "") || refResult.data?.object?.type !== "commit") {
    fail("GITHUB_MANIFEST_BRANCH_REF_INVALID");
  }

  const commitResult = await get(
    `${API_ROOT}/repos/${apiPath(owner, repo)}/git/commits/${headSha}`,
    "GITHUB_MANIFEST_COMMIT_FETCH_FAILED",
  );
  if (commitResult.data?.sha !== headSha ||
      !/^[a-f0-9]{40}$/.test(commitResult.data?.tree?.sha ?? "")) {
    fail("GITHUB_MANIFEST_COMMIT_IDENTITY_INVALID");
  }
  const treeSha = commitResult.data.tree.sha;

  let compareData;
  const compareFiles = [];
  for (let page = 1; page <= 5; page += 1) {
    const compareResult = await get(
      `${API_ROOT}/repos/${apiPath(owner, repo)}/compare/${baseSha}...${headSha}?per_page=100&page=${page}`,
      "GITHUB_MANIFEST_COMPARE_FETCH_FAILED",
    );
    if (!isRecord(compareResult.data)) fail("GITHUB_MANIFEST_COMPARE_INVALID");
    if (page === 1) compareData = compareResult.data;
    if (!Array.isArray(compareResult.data.files)) fail("GITHUB_MANIFEST_COMPARE_FILES_INVALID");
    compareFiles.push(...compareResult.data.files);
    if (!hasNextPage(compareResult.response)) break;
    if (page === 5) fail("GITHUB_MANIFEST_COMPARE_PAGINATION_LIMIT");
  }

  if (compareData?.status !== "ahead" ||
      !Number.isSafeInteger(compareData?.ahead_by) || compareData.ahead_by < 1 ||
      compareData?.base_commit?.sha !== baseSha ||
      compareData?.head_commit?.sha !== headSha) fail("GITHUB_MANIFEST_COMPARE_SHA_MISMATCH");
  if (compareFiles.length !== requestedPaths.length) fail("GITHUB_MANIFEST_DIFF_PATH_SET_MISMATCH");

  const changed = new Set();
  for (const file of compareFiles) {
    if (!isRecord(file) || !safeRelativePath(file.filename) ||
        !["added", "modified"].includes(file.status) ||
        file.previous_filename !== undefined) fail("GITHUB_MANIFEST_DIFF_ENTRY_UNSUPPORTED");
    changed.add(file.filename);
  }
  if (changed.size !== requestedPaths.length ||
      requestedPaths.some(path => !changed.has(path))) fail("GITHUB_MANIFEST_DIFF_PATH_SET_MISMATCH");

  const treeResult = await get(
    `${API_ROOT}/repos/${apiPath(owner, repo)}/git/trees/${treeSha}?recursive=1`,
    "GITHUB_MANIFEST_TREE_FETCH_FAILED",
  );
  if (!isRecord(treeResult.data) || treeResult.data.sha !== treeSha ||
      treeResult.data.truncated !== false || !Array.isArray(treeResult.data.tree)) {
    fail("GITHUB_MANIFEST_TREE_INVALID_OR_TRUNCATED");
  }

  const treeEntries = treeResult.data.tree.map(entry => {
    if (!isRecord(entry) || typeof entry.path !== "string" ||
        !["blob", "tree", "commit"].includes(entry.type) ||
        typeof entry.mode !== "string") fail("GITHUB_MANIFEST_TREE_ENTRY_INVALID");
    return { path: entry.path, mode: entry.mode, type: entry.type };
  });
  const treeMap = new Map(treeEntries.map(entry => [entry.path, entry]));
  if (treeMap.size !== treeEntries.length) fail("GITHUB_MANIFEST_TREE_DUPLICATE_PATH");

  const files = requestedPaths.map(path => {
    const entry = treeMap.get(path);
    if (!entry || entry.type !== "blob" || !["100644", "100755"].includes(entry.mode)) {
      fail("GITHUB_MANIFEST_NON_REGULAR_FILE");
    }
    return { path, mode: entry.mode, type: entry.type };
  });

  return {
    repositoryId: TARGET_REPOSITORY_ID,
    baseSha,
    branchName,
    headSha,
    files,
    treeEntries,
  };
}
