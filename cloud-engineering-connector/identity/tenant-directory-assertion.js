const ISSUER = "tenant-directory-admin";
const AUDIENCE = "tenant-directory";
const MAX_LIFETIME_SECONDS = 60;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KID = /^[A-Za-z0-9_-]{1,32}$/;
const HEX_KEY = /^[a-fA-F0-9]{64,128}$/;
const OPERATIONS = new Set(["upsertMembership", "revokeMembership", "upsertProjectPolicy"]);
const CLAIM_KEYS = ["aud", "exp", "iat", "iss", "jti", "op", "projectId", "role", "sub", "targetDigest", "tenantId", "v"];

function reject() {
  return Object.assign(new Error("Tenant Directory admin assertion rejected."), { code: "TENANT_DIRECTORY_ADMIN_ASSERTION_REJECTED" });
}
function canonicalJson(value) {
  const keys = Object.keys(value).sort();
  return "{" + keys.map(key => JSON.stringify(key) + ":" + JSON.stringify(value[key])).join(",") + "}";
}
async function fingerprintTarget(target) {
  if (!target || typeof target !== "object" || Array.isArray(target) ||
      (Object.getPrototypeOf(target) !== Object.prototype && Object.getPrototypeOf(target) !== null)) throw reject();
  const keys = Reflect.ownKeys(target);
  if (keys.length < 1 || keys.length > 16 || keys.some(key => typeof key !== "string")) throw reject();
  for (const key of keys) {
    const value = target[key];
    if (!(value === null || typeof value === "string" || typeof value === "boolean" ||
          (typeof value === "number" && Number.isSafeInteger(value)))) throw reject();
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(target)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function decodeBase64Url(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw reject();
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}
function parseKeySet(keySet, activeKid) {
  let parsed;
  try { parsed = typeof keySet === "string" ? JSON.parse(keySet) : keySet; } catch { throw reject(); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw reject();
  const entries = Object.entries(parsed);
  if (entries.length < 1 || entries.length > 2 || !KID.test(activeKid)) throw reject();
  const keys = new Map();
  for (const [kid, value] of entries) {
    if (!KID.test(kid) || typeof value !== "string" || !HEX_KEY.test(value)) throw reject();
    keys.set(kid, Uint8Array.from(value.match(/.{2}/g), pair => Number.parseInt(pair, 16)));
  }
  if (!keys.has(activeKid)) throw reject();
  return keys;
}
function validateScope(expected) {
  if (!expected || expected.subject !== "tenant-directory-provisioner" ||
      !IDENTIFIER.test(expected.tenantId ?? "") || !OPERATIONS.has(expected.operation)) throw reject();
  if (expected.operation === "upsertProjectPolicy") {
    if (!IDENTIFIER.test(expected.projectId ?? "")) throw reject();
  } else if (expected.projectId !== null) throw reject();
}
export async function createTenantDirectoryAdminAssertion(keySet, activeKid, expected) {
  try {
    validateScope(expected);
    if (!Number.isSafeInteger(expected.nowMs) || expected.nowMs < 1) throw reject();
    const targetDigest = await fingerprintTarget(expected.target);
    const keys = parseKeySet(keySet, activeKid);
    const iat = Math.floor(expected.nowMs / 1000);
    const claims = {
      v: 1, iss: ISSUER, aud: AUDIENCE, sub: expected.subject, role: "system",
      op: expected.operation, tenantId: expected.tenantId, projectId: expected.projectId,
      targetDigest, iat, exp: iat + MAX_LIFETIME_SECONDS,
      jti: "td-admin-" + encodeBase64Url(crypto.getRandomValues(new Uint8Array(16))),
    };
    const payload = encodeBase64Url(new TextEncoder().encode(canonicalJson(claims)));
    const signingInput = "v1." + activeKid + "." + payload;
    const key = await crypto.subtle.importKey("raw", keys.get(activeKid), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput)));
    return signingInput + "." + encodeBase64Url(signature);
  } catch { throw reject(); }
}
export async function verifyTenantDirectoryAdminAssertion(keySet, token, expected) {
  try {
    validateScope(expected);
    if (!Number.isSafeInteger(expected.nowMs) || expected.nowMs < 1 ||
        typeof token !== "string" || token.length > 4096) throw reject();
    const expectedTargetDigest = await fingerprintTarget(expected.target);
    const parts = token.split(".");
    if (parts.length !== 4 || parts[0] !== "v1" || !KID.test(parts[1])) throw reject();
    const keys = parseKeySet(keySet, parts[1]);
    const claims = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64Url(parts[2])));
    if (!claims || typeof claims !== "object" || Array.isArray(claims)) throw reject();
    const claimKeys = Object.keys(claims).sort();
    if (claimKeys.length !== CLAIM_KEYS.length || claimKeys.some((key, index) => key !== CLAIM_KEYS[index])) throw reject();
    if (claims.v !== 1 || claims.iss !== ISSUER || claims.aud !== AUDIENCE ||
        claims.sub !== expected.subject || claims.role !== "system" ||
        claims.op !== expected.operation || claims.tenantId !== expected.tenantId ||
        claims.projectId !== expected.projectId || claims.targetDigest !== expectedTargetDigest ||
        typeof claims.jti !== "string" || !/^td-admin-[A-Za-z0-9_-]{20,64}$/.test(claims.jti) ||
        !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp)) throw reject();
    const nowSeconds = Math.floor(expected.nowMs / 1000);
    if (claims.exp <= claims.iat || claims.exp - claims.iat > MAX_LIFETIME_SECONDS ||
        claims.iat > nowSeconds + 5 || claims.exp < nowSeconds - 5) throw reject();
    const key = await crypto.subtle.importKey("raw", keys.get(parts[1]), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify("HMAC", key, decodeBase64Url(parts[3]), new TextEncoder().encode(parts.slice(0, 3).join(".")));
    if (!valid) throw reject();
    return Object.freeze({ jti: claims.jti, subject: claims.sub, operation: claims.op, tenantId: claims.tenantId, projectId: claims.projectId, targetDigest: claims.targetDigest });
  } catch { throw reject(); }
}
