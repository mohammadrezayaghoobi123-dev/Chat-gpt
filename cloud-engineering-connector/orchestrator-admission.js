import { TASK_STATES } from "./orchestrator-core.js";
import { canonicalJson, sha256Canonical } from "./orchestrator-protocol.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const SECRET_FIELD = /(?:secret|token|password|credential|api[_-]?key|private[_-]?key)/i;
const MAX_KEY_RING_BYTES = 8192;
const MAX_GRANT_BYTES = 4096;
const MAX_TASK_BYTES = 32768;
const MAX_GRANT_LIFETIME_SECONDS = 300;
const MAX_FUTURE_SKEW_SECONDS = 30;

const CLAIM_KEYS = Object.freeze([
  "admissionId",
  "aud",
  "exp",
  "iat",
  "idempotencyKeyDigest",
  "inputHash",
  "iss",
  "jti",
  "membershipId",
  "membershipVersion",
  "policyDecisionId",
  "policyRuleResourceDigest",
  "policyRuleVersion",
  "policyScopeEpoch",
  "projectId",
  "sub",
  "taskDigest",
  "taskId",
  "tenantId",
  "v",
]);

function reject() {
  return Object.assign(new Error("Task admission grant rejected."), {
    code: "TASK_ADMISSION_INVALID",
  });
}

function invalidTask(message) {
  return Object.assign(new TypeError(message), { code: "INVALID_TASK" });
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireIdentifier(value) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw reject();
  return value;
}

function requireDigest(value) {
  if (typeof value !== "string" || !SHA256.test(value)) throw reject();
  return value;
}

function requirePositiveInteger(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw reject();
  return value;
}

function requireNonNegativeInteger(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw reject();
  return value;
}

function assertNoSecretFields(value, path = "task") {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assertNoSecretFields(value[index], path + "[" + index + "]");
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_FIELD.test(key)) {
      throw Object.assign(new TypeError(path + " contains a sensitive field."), {
        code: "SENSITIVE_FIELD_REJECTED",
      });
    }
    assertNoSecretFields(child, path + "." + key);
  }
}

function assertPlainDataObject(value) {
  if (!isRecord(value)) throw invalidTask("Task must be a plain JSON object.");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalidTask("Task must be a plain JSON object.");
  }
  const ownKeys = Reflect.ownKeys(value);
  const enumerableKeys = Object.keys(value);
  if (ownKeys.length !== enumerableKeys.length || ownKeys.some(key => typeof key !== "string")) {
    throw invalidTask("Task contains unsupported own properties.");
  }
  for (const key of enumerableKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable ||
        !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      throw invalidTask("Task properties must be enumerable data properties.");
    }
  }
}

export function normalizeTaskForAdmission(task) {
  try {
    assertPlainDataObject(task);
    if (!IDENTIFIER.test(task.taskId ?? "") ||
        !IDENTIFIER.test(task.tenantId ?? "") ||
        !IDENTIFIER.test(task.projectId ?? "") ||
        !TASK_STATES.includes(task.state) ||
        !Number.isSafeInteger(task.version) || task.version < 1 ||
        !Number.isSafeInteger(task.createdAt) || task.createdAt < 1 ||
        !Number.isSafeInteger(task.updatedAt) || task.updatedAt < task.createdAt) {
      throw invalidTask("Task projection is invalid.");
    }

    const normalized = { ...task, agentRound: task.agentRound ?? 0 };
    if (!Number.isSafeInteger(normalized.agentRound) ||
        normalized.agentRound < 0 || normalized.agentRound > 4) {
      throw Object.assign(new TypeError("agentRound must be an integer from zero through four."), {
        code: "INVALID_AGENT_ROUND",
      });
    }

    assertNoSecretFields(normalized);
    const serialized = canonicalJson(normalized);
    if (new TextEncoder().encode(serialized).byteLength > MAX_TASK_BYTES) {
      throw Object.assign(new TypeError("Task exceeds the 32 KiB admission limit."), {
        code: "RECORD_TOO_LARGE",
      });
    }
    return JSON.parse(serialized);
  } catch (error) {
    if (error?.code) throw error;
    throw invalidTask("Task projection is not canonical JSON.");
  }
}

export async function taskAdmissionDigest(task) {
  const normalized = normalizeTaskForAdmission(task);
  return sha256Canonical(normalized);
}

export async function admissionTextDigest(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 ||
      value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw reject();
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function decodeBase64Url(value, expectedLength) {
  if (typeof value !== "string" || !BASE64URL.test(value) || value.length % 4 === 1) {
    throw reject();
  }
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  if (encodeBase64Url(bytes) !== value ||
      (expectedLength !== undefined && bytes.byteLength !== expectedLength)) {
    throw reject();
  }
  return bytes;
}

function parseKeyRing(keySet) {
  if (typeof keySet !== "string" || keySet.length > MAX_KEY_RING_BYTES) throw reject();
  let parsed;
  try {
    parsed = JSON.parse(keySet);
  } catch {
    throw reject();
  }
  if (!isRecord(parsed)) throw reject();
  const entries = Object.entries(parsed);
  if (entries.length < 1 || entries.length > 4 ||
      entries.some(([kid]) => !KEY_ID.test(kid))) throw reject();
  return parsed;
}

function validateJwkShape(jwk, privateKey) {
  if (!isRecord(jwk) || jwk.kty !== "OKP" || jwk.crv !== "Ed25519" ||
      typeof jwk.x !== "string" || !BASE64URL.test(jwk.x)) throw reject();
  decodeBase64Url(jwk.x, 32);
  if (privateKey) {
    if (typeof jwk.d !== "string" || !BASE64URL.test(jwk.d)) throw reject();
    decodeBase64Url(jwk.d, 32);
  } else if (Object.prototype.hasOwnProperty.call(jwk, "d")) {
    throw reject();
  }
  if (jwk.key_ops !== undefined) {
    if (!Array.isArray(jwk.key_ops) || jwk.key_ops.some(value => typeof value !== "string")) {
      throw reject();
    }
    const requiredUsage = privateKey ? "sign" : "verify";
    if (!jwk.key_ops.includes(requiredUsage)) throw reject();
  }
}

function validateClaimsInput(expected) {
  if (!isRecord(expected)) throw reject();
  const now = expected.nowMs;
  if (now !== undefined && (!Number.isSafeInteger(now) || now < 1)) throw reject();

  requireIdentifier(expected.principalId);
  requireIdentifier(expected.tenantId);
  requireIdentifier(expected.projectId);
  requireIdentifier(expected.taskId);
  requireDigest(expected.taskDigest);
  requireDigest(expected.idempotencyKeyDigest);
  requireDigest(expected.inputHash);
  requireIdentifier(expected.membershipId);
  requirePositiveInteger(expected.membershipVersion);
  requireNonNegativeInteger(expected.policyScopeEpoch);
  requirePositiveInteger(expected.policyRuleVersion);
  requireIdentifier(expected.policyDecisionId);
  requireIdentifier(expected.admissionId);
  if (typeof expected.jti !== "string" || !IDENTIFIER.test(expected.jti) || expected.jti.length < 16) {
    throw reject();
  }
  if (expected.policyRuleResourceDigest !== "*" &&
      expected.policyRuleResourceDigest !== expected.taskDigest) throw reject();
  requirePositiveInteger(expected.issuedAt);
  requirePositiveInteger(expected.expiresAt);
  if (expected.expiresAt <= expected.issuedAt ||
      expected.expiresAt - expected.issuedAt > MAX_GRANT_LIFETIME_SECONDS) {
    throw reject();
  }
  if (now !== undefined) {
    const nowSeconds = Math.floor(now / 1000);
    if (expected.issuedAt > nowSeconds + MAX_FUTURE_SKEW_SECONDS ||
        expected.expiresAt <= nowSeconds) throw reject();
  }
}

function claimsForSigning(expected) {
  validateClaimsInput(expected);
  return {
    v: 1,
    iss: "tenant-directory",
    aud: "orchestrator-ledger",
    sub: expected.principalId,
    tenantId: expected.tenantId,
    projectId: expected.projectId,
    taskId: expected.taskId,
    taskDigest: expected.taskDigest,
    idempotencyKeyDigest: expected.idempotencyKeyDigest,
    inputHash: expected.inputHash,
    membershipId: expected.membershipId,
    membershipVersion: expected.membershipVersion,
    policyScopeEpoch: expected.policyScopeEpoch,
    policyRuleVersion: expected.policyRuleVersion,
    policyRuleResourceDigest: expected.policyRuleResourceDigest,
    policyDecisionId: expected.policyDecisionId,
    admissionId: expected.admissionId,
    jti: expected.jti,
    iat: expected.issuedAt,
    exp: expected.expiresAt,
  };
}

async function importPrivateKey(jwk) {
  try {
    validateJwkShape(jwk, true);
    return await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"]);
  } catch {
    throw reject();
  }
}

async function importPublicKey(jwk) {
  try {
    validateJwkShape(jwk, false);
    return await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["verify"]);
  } catch {
    throw reject();
  }
}

export async function createTaskAdmissionGrant(privateKeySet, activeKid, expected) {
  try {
    if (typeof activeKid !== "string" || !KEY_ID.test(activeKid)) throw reject();
    const keyRing = parseKeyRing(privateKeySet);
    const keyJwk = keyRing[activeKid];
    if (!keyJwk) throw reject();
    const claims = claimsForSigning(expected);
    const payload = encodeBase64Url(new TextEncoder().encode(canonicalJson(claims)));
    const signingInput = "ad1." + activeKid + "." + payload;
    const key = await importPrivateKey(keyJwk);
    const signature = new Uint8Array(await crypto.subtle.sign(
      { name: "Ed25519" }, key, new TextEncoder().encode(signingInput),
    ));
    const token = signingInput + "." + encodeBase64Url(signature);
    if (token.length > MAX_GRANT_BYTES) throw reject();
    return token;
  } catch {
    throw reject();
  }
}

/**
 * Decode the canonical payload for claim binding only.
 * The returned claims are untrusted until verifyTaskAdmissionGrant succeeds.
 */
export function decodeTaskAdmissionGrantClaims(token) {
  try {
    if (typeof token !== "string" || token.length > MAX_GRANT_BYTES) throw reject();
    const parts = token.split(".");
    if (parts.length !== 4 || parts[0] !== "ad1" || !KEY_ID.test(parts[1])) throw reject();
    const payloadBytes = decodeBase64Url(parts[2]);
    if (payloadBytes.byteLength > 2048) throw reject();
    const payloadText = new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes);
    const claims = JSON.parse(payloadText);
    if (!isRecord(claims) || canonicalJson(claims) !== payloadText) throw reject();
    const keys = Object.keys(claims).sort();
    if (keys.length !== CLAIM_KEYS.length ||
        keys.some((key, index) => key !== CLAIM_KEYS[index]) ||
        claims.v !== 1 || claims.iss !== "tenant-directory" ||
        claims.aud !== "orchestrator-ledger") throw reject();
    validateClaimsInput({
      principalId: claims.sub,
      tenantId: claims.tenantId,
      projectId: claims.projectId,
      taskId: claims.taskId,
      taskDigest: claims.taskDigest,
      idempotencyKeyDigest: claims.idempotencyKeyDigest,
      inputHash: claims.inputHash,
      membershipId: claims.membershipId,
      membershipVersion: claims.membershipVersion,
      policyScopeEpoch: claims.policyScopeEpoch,
      policyRuleVersion: claims.policyRuleVersion,
      policyRuleResourceDigest: claims.policyRuleResourceDigest,
      policyDecisionId: claims.policyDecisionId,
      admissionId: claims.admissionId,
      jti: claims.jti,
      issuedAt: claims.iat,
      expiresAt: claims.exp,
    });
    return Object.freeze({ keyId: parts[1], claims: Object.freeze({ ...claims }) });
  } catch {
    throw reject();
  }
}

function verifyExpectedClaims(claims, expected) {
  validateClaimsInput(expected);
  const expectedClaims = claimsForSigning(expected);
  for (const key of CLAIM_KEYS) {
    if (claims[key] !== expectedClaims[key]) throw reject();
  }
}

export async function verifyTaskAdmissionGrant(publicKeySet, token, expected) {
  try {
    if (typeof token !== "string" || token.length > MAX_GRANT_BYTES) throw reject();
    if (!isRecord(expected) || !Number.isSafeInteger(expected.nowMs) || expected.nowMs < 1) {
      throw reject();
    }
    const parts = token.split(".");
    if (parts.length !== 4 || parts[0] !== "ad1" || !KEY_ID.test(parts[1])) throw reject();

    const keyRing = parseKeyRing(publicKeySet);
    const keyJwk = keyRing[parts[1]];
    if (!keyJwk) throw reject();

    const payloadBytes = decodeBase64Url(parts[2]);
    if (payloadBytes.byteLength > 2048) throw reject();
    const payloadText = new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes);
    const claims = JSON.parse(payloadText);
    if (!isRecord(claims) || canonicalJson(claims) !== payloadText) throw reject();
    const claimKeys = Object.keys(claims).sort();
    if (claimKeys.length !== CLAIM_KEYS.length ||
        claimKeys.some((key, index) => key !== CLAIM_KEYS[index])) throw reject();
    if (claims.v !== 1 || claims.iss !== "tenant-directory" ||
        claims.aud !== "orchestrator-ledger") throw reject();

    verifyExpectedClaims(claims, expected);

    const signature = decodeBase64Url(parts[3], 64);
    const key = await importPublicKey(keyJwk);
    const valid = await crypto.subtle.verify(
      { name: "Ed25519" }, key, signature, new TextEncoder().encode(parts.slice(0, 3).join(".")),
    );
    if (!valid) throw reject();

    const nowSeconds = Math.floor(expected.nowMs / 1000);
    if (claims.exp <= nowSeconds ||
        claims.iat > nowSeconds + MAX_FUTURE_SKEW_SECONDS ||
        claims.exp <= claims.iat ||
        claims.exp - claims.iat > MAX_GRANT_LIFETIME_SECONDS) throw reject();

    return Object.freeze({ ...claims });
  } catch {
    throw reject();
  }
}
