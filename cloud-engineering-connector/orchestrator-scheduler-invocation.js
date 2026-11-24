import { canonicalJson } from "./orchestrator-protocol.js";

const ISSUER = "chat-gpt111-scheduler";
const AUDIENCE = "tenant-directory-admission";
const TOKEN_PREFIX = "si1";
const MAX_LIFETIME_SECONDS = 60;
const CLOCK_SKEW_SECONDS = 5;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const CRON = /^[0-9*/,-]+(?:\s+[0-9*/?,-]+){4}$/;
const CLAIM_KEYS = [
  "aud",
  "cron",
  "exp",
  "iat",
  "invocationId",
  "iss",
  "jti",
  "scheduledTime",
  "sub",
  "v",
];

function reject() {
  return Object.assign(new Error("Scheduler invocation assertion rejected."), {
    code: "SCHEDULER_INVOCATION_REQUIRED",
  });
}

function decodeBase64Url(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    throw reject();
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

function loadKey(keySet, keyId) {
  if (typeof keySet !== "string" || keySet.length > 4096 || !KEY_ID.test(keyId)) throw reject();
  let values;
  try {
    values = JSON.parse(keySet);
  } catch {
    throw reject();
  }
  if (
    !values ||
    typeof values !== "object" ||
    Array.isArray(values) ||
    Object.keys(values).length < 1 ||
    Object.keys(values).length > 2 ||
    Object.keys(values).some(key => !KEY_ID.test(key))
  ) throw reject();

  const encoded = values[keyId];
  if (typeof encoded !== "string") throw reject();
  let bytes;
  if (/^[a-f0-9]{64,128}$/.test(encoded)) {
    bytes = Uint8Array.from(encoded.match(/.{2}/g), pair => Number.parseInt(pair, 16));
  } else {
    bytes = decodeBase64Url(encoded);
  }
  if (bytes.byteLength < 32 || bytes.byteLength > 64) {
    bytes.fill(0);
    throw reject();
  }
  return bytes;
}

function validateExpected(expected) {
  if (
    !expected ||
    !IDENTIFIER.test(expected.invocationId) ||
    typeof expected.cron !== "string" ||
    !CRON.test(expected.cron) ||
    !Number.isSafeInteger(expected.scheduledTime) ||
    expected.scheduledTime < 1 ||
    !Number.isSafeInteger(expected.nowMs) ||
    expected.nowMs < 1
  ) throw reject();
}

function validateClaims(claims, expected) {
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) throw reject();
  const keys = Object.keys(claims).sort();
  if (keys.length !== CLAIM_KEYS.length || keys.some((key, index) => key !== CLAIM_KEYS[index])) {
    throw reject();
  }
  if (
    claims.v !== 1 ||
    claims.iss !== ISSUER ||
    claims.aud !== AUDIENCE ||
    claims.sub !== "orchestrator-scheduler" ||
    !IDENTIFIER.test(claims.jti) ||
    claims.jti.length < 22 ||
    claims.invocationId !== expected.invocationId ||
    claims.cron !== expected.cron ||
    claims.scheduledTime !== expected.scheduledTime ||
    !Number.isSafeInteger(claims.iat) ||
    !Number.isSafeInteger(claims.exp)
  ) throw reject();

  const nowSeconds = Math.floor(expected.nowMs / 1000);
  if (
    claims.exp <= claims.iat ||
    claims.exp - claims.iat > MAX_LIFETIME_SECONDS ||
    claims.iat > nowSeconds + CLOCK_SKEW_SECONDS ||
    claims.exp < nowSeconds - CLOCK_SKEW_SECONDS ||
    Math.abs(claims.scheduledTime - expected.scheduledTime) > 0
  ) throw reject();
}

async function signHmac(keyBytes, signingInput) {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signingInput),
  ));
}

async function verifyHmac(keyBytes, signingInput, signature) {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    new TextEncoder().encode(signingInput),
  );
}

export async function createSchedulerInvocationAssertion(keySet, activeKeyId, input) {
  let keyBytes;
  try {
    validateExpected(input);
    if (!KEY_ID.test(activeKeyId)) throw reject();
    keyBytes = loadKey(keySet, activeKeyId);
    const issuedAt = Math.floor(input.nowMs / 1000);
    const claims = {
      v: 1,
      iss: ISSUER,
      aud: AUDIENCE,
      sub: "orchestrator-scheduler",
      iat: issuedAt,
      exp: issuedAt + MAX_LIFETIME_SECONDS,
      jti: "jti-" + encodeBase64Url(crypto.getRandomValues(new Uint8Array(16))),
      invocationId: input.invocationId,
      cron: input.cron,
      scheduledTime: input.scheduledTime,
    };
    const payload = encodeBase64Url(new TextEncoder().encode(canonicalJson(claims)));
    const signingInput = TOKEN_PREFIX + "." + activeKeyId + "." + payload;
    const signature = await signHmac(keyBytes, signingInput);
    return signingInput + "." + encodeBase64Url(signature);
  } catch {
    throw reject();
  } finally {
    if (keyBytes) keyBytes.fill(0);
  }
}

export async function verifySchedulerInvocationAssertion(keySet, token, expected) {
  let keyBytes;
  let payloadBytes;
  let signatureBytes;
  try {
    validateExpected(expected);
    if (typeof token !== "string" || token.length > 4096) throw reject();
    const parts = token.split(".");
    if (parts.length !== 4 || parts[0] !== TOKEN_PREFIX || !KEY_ID.test(parts[1])) throw reject();
    keyBytes = loadKey(keySet, parts[1]);
    payloadBytes = decodeBase64Url(parts[2]);
    signatureBytes = decodeBase64Url(parts[3]);
    if (payloadBytes.byteLength > 2048 || signatureBytes.byteLength !== 32) throw reject();
    const payloadText = new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes);
    const claims = JSON.parse(payloadText);
    if (canonicalJson(claims) !== payloadText) throw reject();
    validateClaims(claims, expected);
    if (!(await verifyHmac(keyBytes, parts.slice(0, 3).join("."), signatureBytes))) throw reject();
    return Object.freeze({
      issuer: claims.iss,
      audience: claims.aud,
      subject: claims.sub,
      invocationId: claims.invocationId,
      cron: claims.cron,
      scheduledTime: claims.scheduledTime,
      jti: claims.jti,
      issuedAt: claims.iat,
      expiresAt: claims.exp,
      keyId: parts[1],
    });
  } catch {
    throw reject();
  } finally {
    if (keyBytes) keyBytes.fill(0);
    if (payloadBytes) payloadBytes.fill(0);
    if (signatureBytes) signatureBytes.fill(0);
  }
}
