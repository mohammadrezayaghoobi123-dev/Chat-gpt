import { canonicalJson } from "./orchestrator-protocol.js";

const ISSUER = "tenant-directory";
const AUDIENCE = "orchestrator-ledger";
const ACTION = "project.task.create";
const MAX_LIFETIME_SECONDS = 60;
const CLOCK_SKEW_SECONDS = 5;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const CRON = /^[A-Za-z0-9*/ ,\\-]{5,64}$/;

const HEADER_KEYS = ["alg", "kid", "typ", "v"];
const CLAIM_KEYS = [
  "v", "iss", "aud", "iat", "exp", "admissionId", "jti",
  "principalId", "membershipId", "tenantId", "projectId", "action",
  "membershipVersion", "policyScopeEpoch", "policyRuleId",
  "policyRuleVersion", "decisionId", "policyVersion",
  "resourceDigest", "taskDigest", "taskId", "idempotencyKeyDigest",
  "schedulerInvocationId", "cron", "scheduledTime",
];

function isPlainDataRecord(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expectedKeys.length || keys.some(key => typeof key !== "string")) return false;
  const actual = keys.slice().sort();
  const expected = expectedKeys.slice().sort();
  if (actual.some((key, index) => key !== expected[index])) return false;
  return actual.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && descriptor.enumerable &&
      Object.prototype.hasOwnProperty.call(descriptor, "value");
  });
}

function decodeCanonicalBase64Url(value, expectedLength) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    return null;
  }
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    let encoded = "";
    for (const byte of bytes) encoded += String.fromCharCode(byte);
    const canonical = btoa(encoded).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    if (canonical !== value || (expectedLength !== undefined && bytes.byteLength !== expectedLength)) {
      return null;
    }
    return bytes;
  } catch {
    return null;
  }
}

function validPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validBoundedText(value, maxLength) {
  return typeof value === "string" && value.length > 0 &&
    value.length <= maxLength && value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

export async function verifyAdmissionReceipt(receipt, {
  now,
  expectedTenantId,
  expectedProjectId,
  expectedTaskId,
  expectedTaskDigest,
  expectedResourceDigest,
  expectedScheduledTime,
  resolvePublicKey,
} = {}) {
  try {
    if (!Number.isSafeInteger(now) || now < 1 ||
        typeof resolvePublicKey !== "function" ||
        !IDENTIFIER.test(expectedTenantId ?? "") ||
        !IDENTIFIER.test(expectedProjectId ?? "") ||
        !IDENTIFIER.test(expectedTaskId ?? "") ||
        !SHA256.test(expectedTaskDigest ?? "") ||
        !SHA256.test(expectedResourceDigest ?? "") ||
        !Number.isSafeInteger(expectedScheduledTime) || expectedScheduledTime < 1) {
      return null;
    }
    if (!isPlainDataRecord(receipt, ["header", "claims", "signature"])) return null;
    if (!isPlainDataRecord(receipt.header, HEADER_KEYS)) return null;
    if (!isPlainDataRecord(receipt.claims, CLAIM_KEYS)) return null;

    const { header, claims } = receipt;
    if (header.alg !== "Ed25519" || header.typ !== "AdmissionReceipt" ||
        header.v !== 1 || !KEY_ID.test(header.kid ?? "")) return null;

    if (claims.v !== 1 || claims.iss !== ISSUER || claims.aud !== AUDIENCE ||
        claims.action !== ACTION) return null;
    const identifierClaims = [
      claims.admissionId, claims.jti, claims.principalId, claims.membershipId,
      claims.tenantId, claims.projectId, claims.policyRuleId, claims.decisionId,
      claims.taskId, claims.schedulerInvocationId,
    ];
    if (!identifierClaims.every(value => IDENTIFIER.test(value ?? ""))) return null;
    if (!validPositiveInteger(claims.membershipVersion) ||
        !validPositiveInteger(claims.policyScopeEpoch) ||
        !validPositiveInteger(claims.policyRuleVersion) ||
        !Number.isSafeInteger(claims.iat) || claims.iat < 1 ||
        !Number.isSafeInteger(claims.exp) || claims.exp <= claims.iat ||
        claims.exp - claims.iat > MAX_LIFETIME_SECONDS ||
        claims.iat > Math.floor(now / 1000) + CLOCK_SKEW_SECONDS ||
        claims.exp <= Math.floor(now / 1000) ||
        !Number.isSafeInteger(claims.scheduledTime) || claims.scheduledTime < 1) return null;
    if (!validBoundedText(claims.policyVersion, 128) ||
        typeof claims.cron !== "string" || !CRON.test(claims.cron) ||
        !SHA256.test(claims.resourceDigest ?? "") ||
        !SHA256.test(claims.taskDigest ?? "") ||
        !SHA256.test(claims.idempotencyKeyDigest ?? "")) return null;

    if (claims.tenantId !== expectedTenantId ||
        claims.projectId !== expectedProjectId ||
        claims.taskId !== expectedTaskId ||
        claims.taskDigest !== expectedTaskDigest ||
        claims.resourceDigest !== expectedResourceDigest ||
        claims.scheduledTime !== expectedScheduledTime) return null;

    const keyRecord = await resolvePublicKey({
      tenantId: claims.tenantId,
      keyId: header.kid,
      now,
    });
    if (!keyRecord || keyRecord.tenantId !== claims.tenantId ||
        keyRecord.keyId !== header.kid || keyRecord.algorithm !== "Ed25519" ||
        !["active", "verify_only"].includes(keyRecord.status) ||
        !Number.isSafeInteger(keyRecord.notBefore) ||
        !Number.isSafeInteger(keyRecord.notAfter) ||
        keyRecord.notBefore > now || keyRecord.notAfter <= now) return null;

    const publicKeyBytes = decodeCanonicalBase64Url(keyRecord.publicKey, 32);
    const signatureBytes = decodeCanonicalBase64Url(receipt.signature, 64);
    if (!publicKeyBytes || !signatureBytes) return null;

    const publicKey = await crypto.subtle.importKey(
      "raw", publicKeyBytes, { name: "Ed25519" }, false, ["verify"],
    );
    const signingBytes = new TextEncoder().encode(canonicalJson({ header, claims }));
    const valid = await crypto.subtle.verify(
      { name: "Ed25519" }, publicKey, signatureBytes, signingBytes,
    );
    if (!valid) return null;

    return Object.freeze({
      header: Object.freeze({ ...header }),
      claims: Object.freeze({ ...claims }),
      publicKeyId: keyRecord.keyId,
      publicKeyVersion: keyRecord.version,
    });
  } catch {
    return null;
  }
}
