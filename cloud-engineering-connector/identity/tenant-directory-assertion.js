const MAX_ASSERTION_LIFETIME_MS = 5 * 60 * 1000;

function reject() {
  const error = new Error("Tenant Directory admin assertion rejected.");
  error.code = "TENANT_DIRECTORY_ADMIN_ASSERTION_REJECTED";
  throw error;
}

function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").split("+").join("-").split("/").join("_");
}

function decodeBase64Url(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) reject();
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  try {
    return Uint8Array.from(atob(base64), character => character.charCodeAt(0));
  } catch {
    reject();
  }
}

function parseKeySet(keySetJson) {
  let keys;
  try {
    keys = JSON.parse(keySetJson);
  } catch {
    reject();
  }
  if (!keys || typeof keys !== "object" || Array.isArray(keys)) reject();
  return keys;
}

function validText(value, max = 256) {
  return typeof value === "string" && value.length > 0 && value.length <= max &&
    value.trim() === value && !/[\\u0000-\\u001f\\u007f]/.test(value);
}

async function signingKey(secret, usage) {
  if (!validText(secret, 512) || secret.length < 32) reject();
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usage
  );
}

export async function createTenantDirectoryAdminAssertion(keySetJson, keyId, claims) {
  const keys = parseKeySet(keySetJson);
  const secret = keys[keyId];
  if (!validText(keyId, 64) || !validText(secret, 512) || !claims || typeof claims !== "object") reject();
  const nowMs = claims.nowMs;
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0 ||
      !validText(claims.subject) || !validText(claims.operation, 80) ||
      !validText(claims.tenantId) ||
      (claims.projectId !== null && claims.projectId !== undefined && !validText(claims.projectId))) reject();

  const payload = {
    version: 1,
    keyId,
    subject: claims.subject,
    operation: claims.operation,
    tenantId: claims.tenantId,
    projectId: claims.projectId ?? null,
    issuedAtMs: nowMs,
    expiresAtMs: nowMs + MAX_ASSERTION_LIFETIME_MS,
  };
  const encodedPayload = encodeBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signingInput = "td-admin-v1." + encodedPayload;
  const key = await signingKey(secret, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput));
  return signingInput + "." + encodeBase64Url(new Uint8Array(signature));
}

export async function verifyTenantDirectoryAdminAssertion(token, keySetJson, expected, nowMs = Date.now()) {
  try {
    if (!validText(token, 4096) || !Number.isSafeInteger(nowMs)) reject();
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== "td-admin-v1") reject();
    const payloadBytes = decodeBase64Url(parts[1]);
    const payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes));
    const keys = parseKeySet(keySetJson);
    const secret = keys[payload.keyId];
    if (payload.version !== 1 || !validText(payload.keyId, 64) || !validText(secret, 512) ||
        payload.subject !== "tenant-directory-provisioner" ||
        payload.operation !== expected.operation ||
        payload.tenantId !== expected.tenantId ||
        (payload.projectId ?? null) !== (expected.projectId ?? null) ||
        !Number.isSafeInteger(payload.issuedAtMs) ||
        !Number.isSafeInteger(payload.expiresAtMs) ||
        payload.expiresAtMs <= nowMs ||
        payload.issuedAtMs > nowMs ||
        payload.expiresAtMs - payload.issuedAtMs > MAX_ASSERTION_LIFETIME_MS) reject();

    const key = await signingKey(secret, ["verify"]);
    const signature = decodeBase64Url(parts[2]);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      signature,
      new TextEncoder().encode(parts[0] + "." + parts[1])
    );
    if (!valid) reject();
    return Object.freeze({ ...payload });
  } catch {
    reject();
  }
}
