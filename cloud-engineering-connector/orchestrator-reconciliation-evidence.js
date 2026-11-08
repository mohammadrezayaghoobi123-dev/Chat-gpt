import { canonicalJson } from "./orchestrator-protocol.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const KID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const MAX_EVIDENCE_LIFETIME_MS = 300_000;
const CLOCK_SKEW_MS = 30_000;
const EVIDENCE_FIELDS = [
  "evidenceId", "expiresAt", "issuedAt", "issuer", "priorGeneration",
  "signature", "taskId",
];

function decodeBase64Url(value) {
  if (typeof value !== "string" || !BASE64URL.test(value) || value.length % 4 === 1) {
    throw new TypeError("Invalid reconciliation signature.");
  }
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function parseKeySet(keySet) {
  if (typeof keySet !== "string" || keySet.length > 4096) {
    throw new TypeError("Reconciliation key unavailable.");
  }
  const keys = JSON.parse(keySet);
  if (!keys || typeof keys !== "object" || Array.isArray(keys) ||
      Object.keys(keys).length < 1 || Object.keys(keys).length > 4 ||
      Object.keys(keys).some(key => !KID.test(key) ||
        typeof keys[key] !== "string" || !/^[a-f0-9]{64,128}$/.test(keys[key]))) {
    throw new TypeError("Invalid reconciliation key set.");
  }
  return keys;
}

function loadKey(keySet, kid) {
  if (!KID.test(kid)) throw new TypeError("Reconciliation key unavailable.");
  const encoded = parseKeySet(keySet)[kid];
  if (typeof encoded !== "string") throw new TypeError("Reconciliation key unavailable.");
  return Uint8Array.from(encoded.match(/.{2}/g), pair => Number.parseInt(pair, 16));
}

export function validateReconciliationEvidenceConfig(keySet, issuerPolicy) {
  try {
    parseKeySet(keySet);
    allowedIssuers(issuerPolicy);
    return true;
  } catch {
    return false;
  }
}

function allowedIssuers(value) {
  if (typeof value !== "string" || value.length > 2048) throw new TypeError("Issuer policy unavailable.");
  const issuers = JSON.parse(value);
  if (!Array.isArray(issuers) || issuers.length < 1 || issuers.length > 16 ||
      issuers.some(issuer => typeof issuer !== "string" || !ID.test(issuer))) {
    throw new TypeError("Invalid issuer policy.");
  }
  return new Set(issuers);
}

export async function verifyReconciliationEvidence(keySet, issuerPolicy, evidence, expected) {
  try {
    if (!evidence || typeof evidence !== "object" || Array.isArray(evidence) ||
        !expected || !Number.isSafeInteger(expected.nowMs) || expected.nowMs < 1) {
      throw new TypeError("Invalid reconciliation evidence.");
    }
    const keys = Object.keys(evidence).sort();
    const expectedKeys = [...EVIDENCE_FIELDS].sort();
    if (keys.length !== expectedKeys.length ||
        keys.some((key, index) => key !== expectedKeys[index])) {
      throw new TypeError("Unexpected reconciliation evidence fields.");
    }

    const {
      taskId, priorGeneration, evidenceId, issuer, issuedAt, expiresAt, signature,
    } = evidence;
    if (typeof taskId !== "string" || !ID.test(taskId) ||
        (expected.taskId !== undefined && taskId !== expected.taskId) ||
        !Number.isSafeInteger(priorGeneration) || priorGeneration < 1 ||
        typeof evidenceId !== "string" || evidenceId.length < 16 || !ID.test(evidenceId) ||
        typeof issuer !== "string" || !ID.test(issuer) ||
        !Number.isSafeInteger(issuedAt) || issuedAt < 1 ||
        !Number.isSafeInteger(expiresAt) || expiresAt <= issuedAt ||
        expiresAt - issuedAt > MAX_EVIDENCE_LIFETIME_MS ||
        issuedAt > expected.nowMs + CLOCK_SKEW_MS ||
        expiresAt < expected.nowMs ||
        typeof signature !== "string" || signature.length > 256) {
      throw new TypeError("Invalid reconciliation evidence claims.");
    }

    if (!allowedIssuers(issuerPolicy).has(issuer)) throw new TypeError("Unauthorized reconciliation issuer.");

    const parts = signature.split(".");
    if (parts.length !== 3 || parts[0] !== "v1" || !KID.test(parts[1])) {
      throw new TypeError("Invalid reconciliation signature format.");
    }
    const keyBytes = loadKey(keySet, parts[1]);
    const signedPayload = {
      v: 1, taskId, priorGeneration, evidenceId, issuer, issuedAt, expiresAt,
    };
    const payload = encodeBase64Url(new TextEncoder().encode(canonicalJson(signedPayload)));
    const signingInput = "v1." + parts[1] + "." + payload;
    const supplied = decodeBase64Url(parts[2]);
    if (supplied.byteLength !== 32) throw new TypeError("Invalid reconciliation MAC.");
    const key = await crypto.subtle.importKey(
      "raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["verify"],
    );
    const valid = await crypto.subtle.verify(
      "HMAC", key, supplied, new TextEncoder().encode(signingInput),
    );
    if (!valid) throw new TypeError("Invalid reconciliation MAC.");

    return Object.freeze({
      taskId, priorGeneration, evidenceId, issuer, issuedAt, expiresAt, kid: parts[1],
    });
  } catch {
    return null;
  }
}
