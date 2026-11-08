import { isAuthorized } from "./core.js";

export function createSessionCapability() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function hashSessionCapability(capability) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(capability));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function constantTimeHexEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" ||
      !/^[0-9a-f]{64}$/.test(left) || !/^[0-9a-f]{64}$/.test(right)) return false;
  let difference = 0;
  for (let i = 0; i < 64; i += 1) difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return difference === 0;
}

export function isValidPrincipalId(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(value);
}

export function parseUserKeyRegistry(value) {
  if (value === undefined || value === null || value === "") return { ok: true, users: [] };
  if (typeof value !== "string") return { ok: false, users: [] };
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { ok: false, users: [] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, users: [] };
  const entries = Object.entries(parsed);
  if (entries.length > 100) return { ok: false, users: [] };
  const seenHashes = new Set();
  for (const [principalId, hash] of entries) {
    if (!isValidPrincipalId(principalId) || principalId === "owner" ||
        typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash) || seenHashes.has(hash)) {
      return { ok: false, users: [] };
    }
    seenHashes.add(hash);
  }
  return { ok: true, users: entries };
}

export async function resolvePrincipal(request, env) {
  const registry = parseUserKeyRegistry(env.AGENT_USER_KEYS);
  if (!registry.ok) return { ok: false, status: 503, error: "User identity registry is invalid." };

  const authorization = request.headers.get("authorization");
  if (isAuthorized(authorization, env.AGENT_AUTH_TOKEN)) {
    return { ok: true, principalId: "owner", principalAuthHash: await hashSessionCapability(env.AGENT_AUTH_TOKEN) };
  }

  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization || "");
  if (!match) return { ok: false, status: 401, error: "Unauthorized" };
  const tokenHash = await hashSessionCapability(match[1]);
  let principalId = null;
  for (const [candidate, expectedHash] of registry.users) {
    if (constantTimeHexEqual(tokenHash, expectedHash)) principalId = candidate;
  }
  return principalId
    ? { ok: true, principalId, principalAuthHash: tokenHash }
    : { ok: false, status: 401, error: "Unauthorized" };
}

export async function consumePrincipalRequestLimit(env, principalId) {
  const stub = env.AGENT_BUDGET.get(env.AGENT_BUDGET.idFromName("global"));
  const response = await stub.fetch(new Request("https://agent-budget.internal/request-limit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ request_id: crypto.randomUUID(), principal_id: principalId })
  }));
  if (response.status === 429) {
    return { allowed: false, retryAfter: response.headers.get("retry-after") || "60" };
  }
  if (!response.ok) throw new Error("Strict request limiter unavailable.");
  return { allowed: true };
}
