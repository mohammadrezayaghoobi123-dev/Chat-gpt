import { canonicalJson } from "./orchestrator-protocol.js";

const ISSUER = "chat-gpt111-owner-webhook";
const AUDIENCE = "orchestrator-ledger";
const MAX_LIFETIME_SECONDS = 30;
const CLOCK_SKEW_SECONDS = 5;
const CLAIM_KEYS = ["actorId", "aud", "commandHash", "commentId", "deliveryId", "exp", "iat", "iss", "jti", "operation", "repositoryId", "role", "taskId", "v"];
const KID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const ACTOR_ID = /^[0-9]{1,20}$/;
const COMMENT_ID = /^[0-9]{1,20}$/;
const DELIVERY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const OPERATIONS = new Set(["cancel", "quarantine", "release"]);
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function reject() {
  return Object.assign(new Error("Owner assertion rejected."), { code: "OWNER_ASSERTION_REJECTED" });
}

function decodeBase64Url(value) {
  if (typeof value !== "string" || !BASE64URL.test(value) || value.length % 4 === 1) throw reject();
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
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

function validateContext(context) {
  if (!context || typeof context !== "object" || Array.isArray(context) ||
      typeof context.actorId !== "string" || !ACTOR_ID.test(context.actorId) ||
      !Number.isSafeInteger(context.repositoryId) || context.repositoryId < 1 ||
      typeof context.taskId !== "string" || !ID.test(context.taskId) ||
      !OPERATIONS.has(context.operation) ||
      typeof context.deliveryId !== "string" || !DELIVERY_ID.test(context.deliveryId) ||
      typeof context.commentId !== "string" || !COMMENT_ID.test(context.commentId) ||
      typeof context.commandHash !== "string" || !SHA256.test(context.commandHash)) throw reject();
}

function validateNow(nowMs) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 1) throw reject();
}

async function verifyMac(keyBytes, input, signature) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, signature, new TextEncoder().encode(input));
}

export async function createOwnerAssertion(keySet, activeKid, context, nowMs) {
  try {
    validateContext(context);
    validateNow(nowMs);
    const keyBytes = loadKey(keySet, activeKid);
    const issuedAt = Math.floor(nowMs / 1000);
    const claims = {
      v: 1,
      iss: ISSUER,
      aud: AUDIENCE,
      role: "owner",
      actorId: context.actorId,
      repositoryId: context.repositoryId,
      taskId: context.taskId,
      operation: context.operation,
      deliveryId: context.deliveryId,
      commentId: context.commentId,
      commandHash: context.commandHash,
      iat: issuedAt,
      exp: issuedAt + MAX_LIFETIME_SECONDS,
      jti: "owner-jti-" + encodeBase64Url(crypto.getRandomValues(new Uint8Array(24))),
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

export async function verifyOwnerAssertion(keySet, token, expected) {
  try {
    validateContext(expected);
    validateNow(expected.nowMs);
    if (typeof token !== "string" || token.length > 4096) throw reject();
    const parts = token.split(".");
    if (parts.length !== 4 || parts[0] !== "v1" || !KID.test(parts[1])) throw reject();
    const keyBytes = loadKey(keySet, parts[1]);
    const payloadBytes = decodeBase64Url(parts[2]);
    if (payloadBytes.byteLength > 2048) throw reject();
    const payloadText = new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes);
    const claims = JSON.parse(payloadText);
    if (canonicalJson(claims) !== payloadText || !claims || typeof claims !== "object" || Array.isArray(claims)) throw reject();
    const keys = Object.keys(claims).sort();
    if (keys.length !== CLAIM_KEYS.length || keys.some((key, index) => key !== CLAIM_KEYS[index])) throw reject();
    if (claims.v !== 1 || claims.iss !== ISSUER || claims.aud !== AUDIENCE || claims.role !== "owner" ||
        claims.actorId !== expected.actorId || claims.repositoryId !== expected.repositoryId ||
        claims.taskId !== expected.taskId || claims.operation !== expected.operation ||
        claims.deliveryId !== expected.deliveryId || claims.commentId !== expected.commentId ||
        claims.commandHash !== expected.commandHash || !ID.test(claims.jti) || claims.jti.length < 22 ||
        !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp)) throw reject();
    const nowSeconds = Math.floor(expected.nowMs / 1000);
    if (claims.exp <= claims.iat || claims.exp - claims.iat > MAX_LIFETIME_SECONDS ||
        claims.iat > nowSeconds + CLOCK_SKEW_SECONDS ||
        claims.exp < nowSeconds - CLOCK_SKEW_SECONDS) throw reject();
    const supplied = decodeBase64Url(parts[3]);
    if (supplied.byteLength !== 32 ||
        !(await verifyMac(keyBytes, parts.slice(0, 3).join("."), supplied))) throw reject();
    return Object.freeze({ ...claims, kid: parts[1] });
  } catch {
    throw reject();
  }
}
