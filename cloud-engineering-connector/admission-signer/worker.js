const MAX_JSON_BYTES = 65_536;
const MAX_MESSAGE_BYTES = 32_768;
const TENANT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ENVELOPE_VERSION = 1;
const ED25519 = Object.freeze({ name: "Ed25519" });
const textEncoder = new TextEncoder();

function jsonError(status, code, message) {
  return Response.json({ error: { code, message } }, { status });
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validIdentifier(value, pattern = TENANT_PATTERN) {
  return typeof value === "string" && pattern.test(value);
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

function base64ToBytes(value, expectedLength = null, maxLength = 65_536) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > Math.ceil(maxLength / 3) * 4 + 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new TypeError("Invalid base64 value.");
  }
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  if (bytes.length > maxLength || (expectedLength !== null && bytes.length !== expectedLength)) {
    bytes.fill(0);
    throw new TypeError("Invalid base64 byte length.");
  }
  return bytes;
}

async function readJsonLimited(request) {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > MAX_JSON_BYTES) {
      throw Object.assign(new Error("Request body exceeds the allowed size."), { status: 413 });
    }
  }
  if (!request.body) throw Object.assign(new Error("A JSON body is required."), { status: 400 });

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_JSON_BYTES) {
        await reader.cancel();
        throw Object.assign(new Error("Request body exceeds the allowed size."), { status: 413 });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    if (!isRecord(parsed)) throw new TypeError("A JSON object is required.");
    return parsed;
  } catch {
    throw Object.assign(new Error("Request body must be a valid UTF-8 JSON object."), { status: 400 });
  } finally {
    body.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}

function parseMasterKeyRing(env) {
  const raw = env?.ADMISSION_SIGNER_MASTER_KEYS;
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 16_384) {
    throw Object.assign(new Error("Signer key material is unavailable."), { code: "SIGNER_NOT_CONFIGURED" });
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw Object.assign(new Error("Signer key material is malformed."), { code: "SIGNER_NOT_CONFIGURED" });
  }

  if (!isRecord(parsed) || !validIdentifier(parsed.activeKeyId, KEY_ID_PATTERN) || !isRecord(parsed.keys)) {
    throw Object.assign(new Error("Signer key material is malformed."), { code: "SIGNER_NOT_CONFIGURED" });
  }

  const keys = new Map();
  for (const [keyId, encodedKey] of Object.entries(parsed.keys)) {
    if (!validIdentifier(keyId, KEY_ID_PATTERN)) {
      throw Object.assign(new Error("Signer key identifiers are malformed."), { code: "SIGNER_NOT_CONFIGURED" });
    }
    try {
      const keyBytes = base64ToBytes(encodedKey, 32, 32);
      keys.set(keyId, keyBytes);
    } catch {
      for (const keyBytes of keys.values()) keyBytes.fill(0);
      throw Object.assign(new Error("Signer key material is malformed."), { code: "SIGNER_NOT_CONFIGURED" });
    }
  }

  if (!keys.has(parsed.activeKeyId)) {
    for (const keyBytes of keys.values()) keyBytes.fill(0);
    throw Object.assign(new Error("The active signer key is unavailable."), { code: "SIGNER_NOT_CONFIGURED" });
  }

  return { activeKeyId: parsed.activeKeyId, keys };
}

function envelopeAssociatedData(envelope) {
  return textEncoder.encode(JSON.stringify({
    version: ENVELOPE_VERSION,
    tenantId: envelope.tenantId,
    keyId: envelope.keyId,
    wrappingKeyId: envelope.wrappingKeyId,
    publicKey: envelope.publicKey,
    kdfSalt: envelope.kdfSalt,
  }));
}

function wrappingKeyInfo(envelope) {
  return textEncoder.encode(
    "master-brain/admission-private-key-wrap/v1/" +
    envelope.tenantId + "/" + envelope.keyId + "/" + envelope.wrappingKeyId,
  );
}

async function deriveWrappingKey(masterKeyBytes, envelope, usages) {
  const kdfSalt = base64ToBytes(envelope.kdfSalt, 32, 32);
  try {
    const baseKey = await crypto.subtle.importKey(
      "raw",
      masterKeyBytes,
      "HKDF",
      false,
      ["deriveKey"],
    );
    return await crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: kdfSalt,
        info: wrappingKeyInfo(envelope),
      },
      baseKey,
      { name: "AES-GCM", length: 256 },
      false,
      usages,
    );
  } finally {
    kdfSalt.fill(0);
  }
}

async function createTenantKey(env, body) {
  const tenantId = body.tenantId;
  const keyId = body.keyId ?? crypto.randomUUID();
  if (!validIdentifier(tenantId)) {
    return jsonError(400, "INVALID_TENANT_ID", "A valid tenant identifier is required.");
  }
  if (!validIdentifier(keyId, KEY_ID_PATTERN)) {
    return jsonError(400, "INVALID_KEY_ID", "A valid signing key identifier is required.");
  }

  const ring = parseMasterKeyRing(env);
  let privateKeyBytes;
  try {
    const keyPair = await crypto.subtle.generateKey(ED25519, true, ["sign", "verify"]);
    privateKeyBytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
    const publicKeyBytes = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
    const envelope = {
      version: ENVELOPE_VERSION,
      tenantId,
      keyId,
      wrappingKeyId: ring.activeKeyId,
      publicKey: bytesToBase64(publicKeyBytes),
      kdfSalt: bytesToBase64(crypto.getRandomValues(new Uint8Array(32))),
    };
    const wrappingKeyBytes = ring.keys.get(ring.activeKeyId);
    const wrappingKey = await deriveWrappingKey(wrappingKeyBytes, envelope, ["encrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const wrappedPrivateKey = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: envelopeAssociatedData(envelope),
        tagLength: 128,
      },
      wrappingKey,
      privateKeyBytes,
    );
    publicKeyBytes.fill(0);
    return Response.json({
      ...envelope,
      iv: bytesToBase64(iv),
      wrappedPrivateKey: bytesToBase64(new Uint8Array(wrappedPrivateKey)),
    }, { status: 201 });
  } finally {
    if (privateKeyBytes) privateKeyBytes.fill(0);
    for (const keyBytes of ring.keys.values()) keyBytes.fill(0);
  }
}

function validateEnvelope(body) {
  if (
    body.version !== ENVELOPE_VERSION ||
    !validIdentifier(body.tenantId) ||
    !validIdentifier(body.keyId, KEY_ID_PATTERN) ||
    !validIdentifier(body.wrappingKeyId, KEY_ID_PATTERN) ||
    typeof body.publicKey !== "string" ||
    typeof body.kdfSalt !== "string" ||
    typeof body.iv !== "string" ||
    typeof body.wrappedPrivateKey !== "string"
  ) {
    throw new TypeError("Invalid signing key envelope.");
  }
  const publicKey = base64ToBytes(body.publicKey, 32, 32);
  publicKey.fill(0);
  const kdfSalt = base64ToBytes(body.kdfSalt, 32, 32);
  kdfSalt.fill(0);
  const iv = base64ToBytes(body.iv, 12, 12);
  iv.fill(0);
  base64ToBytes(body.wrappedPrivateKey, null, 4_096).fill(0);
}

async function signWithTenantKey(env, body) {
  const envelope = {
    version: body.version,
    tenantId: body.tenantId,
    keyId: body.keyId,
    wrappingKeyId: body.wrappingKeyId,
    publicKey: body.publicKey,
    kdfSalt: body.kdfSalt,
    iv: body.iv,
    wrappedPrivateKey: body.wrappedPrivateKey,
  };
  try {
    validateEnvelope(envelope);
  } catch {
    return jsonError(400, "SIGNING_KEY_INVALID", "The signing key envelope is invalid.");
  }

  if (body.tenantId !== envelope.tenantId || !validIdentifier(body.tenantId)) {
    return jsonError(400, "SIGNING_KEY_INVALID", "The signing key envelope is invalid.");
  }
  if (typeof body.message !== "string") {
    return jsonError(400, "SIGNING_MESSAGE_INVALID", "A base64-encoded signing message is required.");
  }

  let messageBytes;
  try {
    messageBytes = base64ToBytes(body.message, null, MAX_MESSAGE_BYTES);
  } catch {
    return jsonError(400, "SIGNING_MESSAGE_INVALID", "The signing message is invalid or too large.");
  }

  const ring = parseMasterKeyRing(env);
  const masterKeyBytes = ring.keys.get(envelope.wrappingKeyId);
  if (!masterKeyBytes) {
    messageBytes.fill(0);
    for (const keyBytes of ring.keys.values()) keyBytes.fill(0);
    return jsonError(409, "WRAPPING_KEY_RETIRED", "The envelope wrapping key is no longer available.");
  }

  let privateKeyBytes;
  try {
    const wrappingKey = await deriveWrappingKey(masterKeyBytes, envelope, ["decrypt"]);
    const iv = base64ToBytes(envelope.iv, 12, 12);
    const ciphertext = base64ToBytes(envelope.wrappedPrivateKey, null, 4_096);
    try {
      const plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv,
          additionalData: envelopeAssociatedData(envelope),
          tagLength: 128,
        },
        wrappingKey,
        ciphertext,
      );
      privateKeyBytes = new Uint8Array(plaintext);
    } finally {
      iv.fill(0);
      ciphertext.fill(0);
    }

    const privateKey = await crypto.subtle.importKey(
      "pkcs8",
      privateKeyBytes,
      ED25519,
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign(ED25519, privateKey, messageBytes);
    return Response.json({
      keyId: envelope.keyId,
      algorithm: "Ed25519",
      signature: bytesToBase64(new Uint8Array(signature)),
    });
  } catch {
    return jsonError(400, "SIGNING_KEY_INVALID", "The signing key envelope is invalid.");
  } finally {
    if (privateKeyBytes) privateKeyBytes.fill(0);
    messageBytes.fill(0);
    for (const keyBytes of ring.keys.values()) keyBytes.fill(0);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const recognizedPath =
      url.pathname === "/internal/v1/tenant-keys" ||
      url.pathname === "/internal/v1/sign";
    if (!recognizedPath) return jsonError(404, "NOT_FOUND", "The requested route does not exist.");
    if (request.method !== "POST") {
      return jsonError(405, "METHOD_NOT_ALLOWED", "Only POST is supported for this route.");
    }
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      return jsonError(415, "UNSUPPORTED_MEDIA_TYPE", "A JSON request body is required.");
    }

    let body;
    try {
      body = await readJsonLimited(request);
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 400;
      return jsonError(status, status === 413 ? "REQUEST_TOO_LARGE" : "INVALID_JSON", error.message);
    }

    let ring;
    try {
      ring = parseMasterKeyRing(env);
      for (const keyBytes of ring.keys.values()) keyBytes.fill(0);
    } catch {
      return jsonError(503, "SIGNER_NOT_CONFIGURED", "The admission signer is not configured.");
    }

    try {
      if (url.pathname === "/internal/v1/tenant-keys") return await createTenantKey(env, body);
      return await signWithTenantKey(env, body);
    } catch {
      return jsonError(503, "SIGNER_UNAVAILABLE", "The admission signer is unavailable.");
    }
  },
};
