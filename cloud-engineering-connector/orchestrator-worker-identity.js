import { canonicalJson } from "./orchestrator-protocol.js";

const ISSUER = "chat-gpt111-worker";
const AUDIENCE = "orchestrator-ledger";
const MAX_LIFETIME_SECONDS = 60;
const CLOCK_SKEW_SECONDS = 5;
const CLAIM_KEYS = ["aud", "exp", "iat", "iss", "jti", "op", "role", "sub", "v"];
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const KID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function reject() {
  return Object.assign(new Error("Worker assertion rejected."), { code: "AUTHENTICATED_WORKER_REQUIRED" });
}

function decodeBase64Url(value) {
  if (typeof value !== "string" || !BASE64URL.test(value) || value.length % 4 === 1) throw reject();
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}


function loadKey(keySet, kid) {
  if (typeof keySet !== "string" || keySet.length > 4096 || !KID.test(kid)) throw reject();
  let keys;
  try { keys = JSON.parse(keySet); } catch { throw reject(); }
  if (!keys || typeof keys !== "object" || Array.isArray(keys) ||
      Object.keys(keys).length < 1 || Object.keys(keys).length > 2 ||
      Object.keys(keys).some(key => !KID.test(key))) throw reject();
  const encoded = keys[kid];
  if (typeof encoded !== "string") throw reject();
  const raw = /^[a-f0-9]{64,128}$/.test(encoded)
    ? Uint8Array.from(encoded.match(/.{2}/g), pair => Number.parseInt(pair, 16))
    : decodeBase64Url(encoded);
  if (raw.byteLength < 32 || raw.byteLength > 64) throw reject();
  return raw;
}

function validClaims(claims, expected) {
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) throw reject();
  const keys = Object.keys(claims).sort();
  if (keys.length !== CLAIM_KEYS.length || keys.some((key, index) => key !== CLAIM_KEYS[index])) throw reject();
  if (claims.v !== 1 || claims.iss !== ISSUER || claims.aud !== AUDIENCE ||
      claims.sub !== expected.subject || claims.role !== expected.role ||
      claims.op !== expected.operation || !ID.test(claims.sub) ||
      !ID.test(claims.jti) || claims.jti.length < 22 ||
      !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp)) throw reject();
  const nowSeconds = Math.floor(expected.nowMs / 1000);
  if (claims.exp <= claims.iat || claims.exp - claims.iat > MAX_LIFETIME_SECONDS ||
      claims.iat > nowSeconds + CLOCK_SKEW_SECONDS ||
      claims.exp < nowSeconds - CLOCK_SKEW_SECONDS) throw reject();
}

async function verifyMac(keyBytes, input, signature) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, signature, new TextEncoder().encode(input));
}


export async function verifyWorkerAssertion(keySet, token, expected) {
  try {
    if (typeof token !== "string" || token.length > 4096 ||
        !expected || !ID.test(expected.subject) || !ID.test(expected.operation) ||
        !["agent", "publisher", "system", "consumer"].includes(expected.role) ||
        !Number.isSafeInteger(expected.nowMs)) throw reject();
    const parts = token.split(".");
    if (parts.length !== 4 || parts[0] !== "v1" || !KID.test(parts[1])) throw reject();
    const key = loadKey(keySet, parts[1]);
    const payloadBytes = decodeBase64Url(parts[2]);
    if (payloadBytes.byteLength > 2048) throw reject();
    const payloadText = new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes);
    const claims = JSON.parse(payloadText);
    if (canonicalJson(claims) !== payloadText) throw reject();
    validClaims(claims, expected);
    const supplied = decodeBase64Url(parts[3]);
    if (supplied.byteLength !== 32 || !(await verifyMac(key, parts.slice(0, 3).join("."), supplied))) throw reject();
    return Object.freeze({ jti: claims.jti, subject: claims.sub, role: claims.role, operation: claims.op, kid: parts[1], issuedAt: claims.iat, expiresAt: claims.exp });
  } catch {
    throw reject();
  }
}

const SCHEDULED_SIGNER_POLICY = Object.freeze({
  "orchestrator-scheduler": Object.freeze({ system: Object.freeze(["createTask"]) }),
  "orchestrator-outbox-publisher": Object.freeze({
    publisher: Object.freeze(["claimOutbox", "failOutbox", "completeOutbox"]),
  }),
  "orchestrator-outbox-consumer": Object.freeze({
    consumer: Object.freeze(["recordOutboxReceipt"]),
  }),
});

function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/**
 * Mint assertions only for fixed principals whose authority comes from the
 * Cloudflare scheduled-event execution path. This deliberately cannot mint
 * agent assertions from MCP arguments or webhook payloads.
 */
export async function createScheduledWorkerAssertion(keySet, activeKid, expected) {
  try {
    if (!expected || !Number.isSafeInteger(expected.nowMs) || expected.nowMs < 1 ||
        !ID.test(expected.subject) || !ID.test(expected.operation) || !KID.test(activeKid)) {
      throw reject();
    }
    const permittedOperations = SCHEDULED_SIGNER_POLICY[expected.subject]?.[expected.role];
    if (!permittedOperations || !permittedOperations.includes(expected.operation)) throw reject();
    const keyBytes = loadKey(keySet, activeKid);
    const issuedAt = Math.floor(expected.nowMs / 1000);
    const claims = {
      v: 1,
      iss: ISSUER,
      aud: AUDIENCE,
      sub: expected.subject,
      role: expected.role,
      op: expected.operation,
      iat: issuedAt,
      exp: issuedAt + MAX_LIFETIME_SECONDS,
      jti: "jti-" + encodeBase64Url(crypto.getRandomValues(new Uint8Array(16))),
    };
    const payload = encodeBase64Url(new TextEncoder().encode(canonicalJson(claims)));
    const signingInput = "v1." + activeKid + "." + payload;
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput)));
    return signingInput + "." + encodeBase64Url(signature);
  } catch {
    throw reject();
  }
}

export function validateWorkerAssertionSigningConfig(keySet, activeKid) {
  try {
    if (typeof activeKid !== "string" || !KID.test(activeKid)) throw reject();
    loadKey(keySet, activeKid);
    return true;
  } catch {
    return false;
  }
}
