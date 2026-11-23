import { canonicalJson } from "./orchestrator-protocol.js";

const EXECUTOR_PRINCIPAL = "orchestrator-executor";
const EXECUTOR_ROLE = "agent";
const EXECUTOR_OPERATIONS = Object.freeze(["claimTask", "renewLease", "releaseLease"]);
const ISSUER = "orchestrator-executor";
const AUDIENCE = "orchestrator-ledger";
const MAX_LIFETIME_SECONDS = 60;
const CLOCK_SKEW_SECONDS = 5;
const MAX_KEY_SET_BYTES = 8192;
const MAX_KEYS = 4;
const CLAIM_KEYS = ["aud", "exp", "iat", "iss", "jti", "op", "role", "sub", "v"];
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const KID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const encoder = new TextEncoder();

function reject() {
  return Object.assign(new Error("Executor assertion rejected."), {
    code: "AUTHENTICATED_WORKER_REQUIRED",
  });
}

function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function decodeBase64Url(value, maxBytes) {
  if (typeof value !== "string" || !BASE64URL.test(value) || value.length % 4 === 1) {
    throw reject();
  }
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  if (bytes.byteLength > maxBytes || encodeBase64Url(bytes) !== value) throw reject();
  return bytes;
}

function assertSignerOptions(expected) {
  if (!expected || typeof expected !== "object" || Array.isArray(expected) ||
      ![1, 2].includes(Object.keys(expected).length) ||
      !Number.isSafeInteger(expected.nowMs) || expected.nowMs < 1 ||
      Object.keys(expected).some(key => !["nowMs", "operation"].includes(key))) {
    throw reject();
  }
  const operation = expected.operation ?? "claimTask";
  if (!EXECUTOR_OPERATIONS.includes(operation)) throw reject();
  return operation;
}

function assertNowOnly(expected) {
  if (!expected || typeof expected !== "object" || Array.isArray(expected) ||
      Object.keys(expected).length !== 1 || !Number.isSafeInteger(expected.nowMs) ||
      expected.nowMs < 1) {
    throw reject();
  }
}

function parsePublicKeySet(keySet) {
  if (typeof keySet !== "string" || keySet.length > MAX_KEY_SET_BYTES) throw reject();
  let keys;
  try { keys = JSON.parse(keySet); } catch { throw reject(); }
  if (!keys || typeof keys !== "object" || Array.isArray(keys)) throw reject();
  const kids = Object.keys(keys);
  if (kids.length < 1 || kids.length > MAX_KEYS || kids.some(kid => !KID.test(kid))) {
    throw reject();
  }
  for (const kid of kids) validateKeyPolicy(keys[kid]);
  return keys;
}

function validateKeyPolicy(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw reject();
  const fields = Object.keys(entry).sort();
  if (fields.length !== 4 ||
      fields[0] !== "operations" || fields[1] !== "publicKey" ||
      fields[2] !== "role" || fields[3] !== "subject") {
    throw reject();
  }
  if (entry.subject !== EXECUTOR_PRINCIPAL || entry.role !== EXECUTOR_ROLE ||
      !Array.isArray(entry.operations) || entry.operations.length !== EXECUTOR_OPERATIONS.length ||
      new Set(entry.operations).size !== EXECUTOR_OPERATIONS.length ||
      EXECUTOR_OPERATIONS.some(operation => !entry.operations.includes(operation)) ||
      typeof entry.publicKey !== "string") {
    throw reject();
  }
  return decodeBase64Url(entry.publicKey, 32);
}

function validateClaims(claims, nowMs) {
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) throw reject();
  const fields = Object.keys(claims).sort();
  if (fields.length !== CLAIM_KEYS.length ||
      fields.some((field, index) => field !== CLAIM_KEYS[index])) throw reject();
  if (claims.v !== 2 || claims.iss !== ISSUER || claims.aud !== AUDIENCE ||
      claims.sub !== EXECUTOR_PRINCIPAL || claims.role !== EXECUTOR_ROLE ||
      !EXECUTOR_OPERATIONS.includes(claims.op) || !ID.test(claims.sub) ||
      typeof claims.jti !== "string" || !/^jti-[A-Za-z0-9_-]{22}$/.test(claims.jti) ||
      !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp)) {
    throw reject();
  }
  const nowSeconds = Math.floor(nowMs / 1000);
  if (claims.exp <= claims.iat || claims.exp - claims.iat > MAX_LIFETIME_SECONDS ||
      claims.iat > nowSeconds + CLOCK_SKEW_SECONDS ||
      claims.exp < nowSeconds - CLOCK_SKEW_SECONDS) {
    throw reject();
  }
}

export async function createExecutorWorkerAssertion(privateKeyPkcs8, activeKid, expected) {
  try {
    const operation = assertSignerOptions(expected);
    if (typeof activeKid !== "string" || !KID.test(activeKid)) throw reject();
    const privateKeyBytes = decodeBase64Url(privateKeyPkcs8, 256);
    const privateKey = await crypto.subtle.importKey(
      "pkcs8",
      privateKeyBytes,
      { name: "Ed25519" },
      false,
      ["sign"],
    );
    const issuedAt = Math.floor(expected.nowMs / 1000);
    const claims = {
      v: 2,
      iss: ISSUER,
      aud: AUDIENCE,
      sub: EXECUTOR_PRINCIPAL,
      role: EXECUTOR_ROLE,
      op: operation,
      iat: issuedAt,
      exp: issuedAt + MAX_LIFETIME_SECONDS,
      jti: "jti-" + encodeBase64Url(crypto.getRandomValues(new Uint8Array(16))),
    };
    const payload = encodeBase64Url(encoder.encode(canonicalJson(claims)));
    const signingInput = "v2." + activeKid + "." + payload;
    const signature = new Uint8Array(await crypto.subtle.sign(
      { name: "Ed25519" },
      privateKey,
      encoder.encode(signingInput),
    ));
    if (signature.byteLength !== 64) throw reject();
    return signingInput + "." + encodeBase64Url(signature);
  } catch {
    throw reject();
  }
}

export async function verifyExecutorWorkerAssertion(publicKeySet, token, expected) {
  try {
    assertNowOnly(expected);
    if (typeof token !== "string" || token.length > 4096) throw reject();
    const parts = token.split(".");
    if (parts.length !== 4 || parts[0] !== "v2" ||
        typeof parts[1] !== "string" || !KID.test(parts[1])) throw reject();
    const keys = parsePublicKeySet(publicKeySet);
    const entry = keys[parts[1]];
    if (!entry) throw reject();
    const rawPublicKey = validateKeyPolicy(entry);
    const payloadBytes = decodeBase64Url(parts[2], 2048);
    const payloadText = new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes);
    const claims = JSON.parse(payloadText);
    if (canonicalJson(claims) !== payloadText) throw reject();
    validateClaims(claims, expected.nowMs);
    const signature = decodeBase64Url(parts[3], 64);
    if (signature.byteLength !== 64) throw reject();
    const publicKey = await crypto.subtle.importKey(
      "raw",
      rawPublicKey,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      { name: "Ed25519" },
      publicKey,
      signature,
      encoder.encode(parts.slice(0, 3).join(".")),
    );
    if (!valid) throw reject();
    return Object.freeze({
      jti: claims.jti,
      subject: claims.sub,
      role: claims.role,
      operation: claims.op,
      kid: parts[1],
      issuedAt: claims.iat,
      expiresAt: claims.exp,
    });
  } catch {
    throw reject();
  }
}
