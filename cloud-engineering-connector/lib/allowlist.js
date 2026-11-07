export const DEFAULT_ALLOWED_BASE_BRANCH = "feature/cloud-engineering-connector";
export const DEFAULT_ALLOWED_REPOSITORIES = ["mohammadrezayaghoobi123-dev/Chat-gpt"];

export function validSlug(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,100}$/.test(value) && value !== "." && value !== "..";
}

export function validBranchName(value) {
  return typeof value === "string" && value.length <= 200 && /^[A-Za-z0-9._/-]+$/.test(value)
    && !value.startsWith("/") && !value.endsWith("/") && !value.includes("//")
    && !value.split("/").some((p) => !p || p === "." || p === ".." || p.endsWith(".lock"));
}

export function parseAllowlist(env) {
  const raw = typeof env?.ALLOWED_REPOSITORIES === "string" ? env.ALLOWED_REPOSITORIES : "";
  const items = raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const list = items.length ? items : DEFAULT_ALLOWED_REPOSITORIES.map((x) => x.toLowerCase());
  for (const item of list) {
    const parts = item.split("/");
    if (parts.length !== 2 || !validSlug(parts[0]) || !validSlug(parts[1])) {
      throw new Error("Invalid ALLOWED_REPOSITORIES entry: " + item);
    }
  }
  return new Set(list);
}

export function allowedBaseBranch(env) {
  const v = typeof env?.ALLOWED_BASE_BRANCH === "string" && env.ALLOWED_BASE_BRANCH.trim()
    ? env.ALLOWED_BASE_BRANCH.trim()
    : DEFAULT_ALLOWED_BASE_BRANCH;
  if (!validBranchName(v)) throw new Error("Invalid ALLOWED_BASE_BRANCH configuration.");
  return v;
}

export function repoPath(owner, repo, env) {
  if (!validSlug(owner) || !validSlug(repo)) throw new Error("Invalid GitHub owner or repository name.");
  const key = (owner + "/" + repo).toLowerCase();
  if (!parseAllowlist(env || {}).has(key)) throw new Error("Repository is not in the connector allowlist.");
  return "/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repo);
}
