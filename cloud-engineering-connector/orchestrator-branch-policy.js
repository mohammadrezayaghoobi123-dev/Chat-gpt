// Single source of truth for branch targets that an automated agent must never write to.
// Deployment workflows in this repository are triggered by pushes to the release branch
// namespaces below, so creating such a branch is equivalent to requesting a release.
const PROTECTED_EXACT = new Set(["main", "master", "production", "release/production"]);
const PROTECTED_PREFIXES = Object.freeze([
  "main/",
  "master/",
  "production/",
  "release/",
  "integration/staging-release-",
  "integration/production-release-",
  "refs/",
]);

const AGENT_WRITABLE_PREFIXES = Object.freeze(["task/", "ops/"]);

export function isAllowedAgentTargetBranch(name) {
  if (typeof name !== "string" || name.length === 0) return false;
  const lower = name.toLowerCase();
  return AGENT_WRITABLE_PREFIXES.some(prefix => lower.startsWith(prefix) && lower.length > prefix.length);
}

export function isProtectedAgentTargetBranch(name) {
  if (typeof name !== "string" || name.length === 0) return true;
  const lower = name.toLowerCase();
  return PROTECTED_EXACT.has(lower) || PROTECTED_PREFIXES.some(prefix => lower.startsWith(prefix));
}
