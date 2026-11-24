import { default as admissionSigner } from "../admission-signer/worker.js";
import { describe, expect, it } from "vitest";

function toBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value) {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}

async function createEnvironment(
  keyIds = ["kek-v1"],
  activeKeyId = "kek-v1",
  previousKeys = {},
) {
  const keys = {};
  for (const keyId of keyIds) {
    keys[keyId] = previousKeys[keyId] ?? toBase64(crypto.getRandomValues(new Uint8Array(32)));
  }
  return {
    ADMISSION_SIGNER_MASTER_KEYS: JSON.stringify({ activeKeyId, keys }),
    __testKeyMaterial: keys,
  };
}

async function post(path, body, env) {
  return admissionSigner.fetch(new Request("https://admission-signer.internal" + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }), env);
}

async function createWrappedKey(env, tenantId = "tenant-alpha") {
  const response = await post("/internal/v1/tenant-keys", { tenantId }, env);
  expect(response.status).toBe(201);
  return response.json();
}

async function sign(env, wrappedKey, tenantId, message) {
  return post("/internal/v1/sign", {
    ...wrappedKey,
    tenantId,
    message: toBase64(new TextEncoder().encode(message)),
  }, env);
}

async function verifySignature(publicKeyBase64, message, signatureBase64) {
  const publicKey = await crypto.subtle.importKey(
    "raw",
    fromBase64(publicKeyBase64),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    { name: "Ed25519" },
    publicKey,
    fromBase64(signatureBase64),
    new TextEncoder().encode(message),
  );
}

describe("Admission signer", () => {
  it("creates tenant-bound wrapped Ed25519 keys and signs without returning private key material", async () => {
    const env = await createEnvironment();
    const wrappedKey = await createWrappedKey(env);
    expect(wrappedKey).toMatchObject({
      version: 1,
      tenantId: "tenant-alpha",
      wrappingKeyId: "kek-v1",
    });
    expect(typeof wrappedKey.keyId).toBe("string");
    expect(typeof wrappedKey.publicKey).toBe("string");
    expect(typeof wrappedKey.iv).toBe("string");
    expect(typeof wrappedKey.wrappedPrivateKey).toBe("string");
    expect(wrappedKey.privateKey).toBeUndefined();
    expect(wrappedKey.pkcs8).toBeUndefined();

    const message = "master-brain:admission-receipt:v1:test-payload";
    const signed = await sign(env, wrappedKey, "tenant-alpha", message);
    expect(signed.status).toBe(200);
    const result = await signed.json();
    expect(typeof result.signature).toBe("string");
    await expect(verifySignature(wrappedKey.publicKey, message, result.signature)).resolves.toBe(true);
  });

  it("rejects tenant substitution and ciphertext tampering", async () => {
    const env = await createEnvironment();
    const wrappedKey = await createWrappedKey(env);
    const message = "tenant-bound-signature";
    const substituted = await sign(env, wrappedKey, "tenant-beta", message);
    expect(substituted.status).toBe(400);
    expect(await substituted.json()).toMatchObject({
      error: { code: "SIGNING_KEY_INVALID" },
    });

    const tampered = {
      ...wrappedKey,
      wrappedPrivateKey: (wrappedKey.wrappedPrivateKey[0] === "A" ? "B" : "A") + wrappedKey.wrappedPrivateKey.slice(1),
    };
    const tamperedResponse = await sign(env, tampered, "tenant-alpha", message);
    expect(tamperedResponse.status).toBe(400);
    expect(await tamperedResponse.json()).toMatchObject({
      error: { code: "SIGNING_KEY_INVALID" },
    });
  });

  it("supports master-key rotation overlap and rejects removed wrapping keys", async () => {
    const oldEnvironment = await createEnvironment(["kek-v1"], "kek-v1");
    const wrappedKey = await createWrappedKey(oldEnvironment, "tenant-rotation");

    const rotatedEnvironment = await createEnvironment(
      ["kek-v1", "kek-v2"],
      "kek-v2",
      oldEnvironment.__testKeyMaterial,
    );
    const message = "rotation-overlap";
    const duringOverlap = await sign(rotatedEnvironment, wrappedKey, "tenant-rotation", message);
    expect(duringOverlap.status).toBe(200);
    const result = await duringOverlap.json();
    await expect(verifySignature(wrappedKey.publicKey, message, result.signature)).resolves.toBe(true);

    const retiredEnvironment = await createEnvironment(["kek-v2"], "kek-v2");
    const afterRetirement = await sign(retiredEnvironment, wrappedKey, "tenant-rotation", message);
    expect(afterRetirement.status).toBe(409);
    expect(await afterRetirement.json()).toMatchObject({
      error: { code: "WRAPPING_KEY_RETIRED" },
    });
  });

  it("fails closed when signer key material is absent or malformed", async () => {
    const body = await createEnvironment();
    const missing = await post("/internal/v1/tenant-keys", { tenantId: "tenant-alpha" }, {});
    expect(missing.status).toBe(503);
    expect(await missing.json()).toMatchObject({
      error: { code: "SIGNER_NOT_CONFIGURED" },
    });

    const malformed = await post(
      "/internal/v1/tenant-keys",
      { tenantId: "tenant-alpha" },
      { ADMISSION_SIGNER_MASTER_KEYS: "{not-json" },
    );
    expect(malformed.status).toBe(503);
    expect(await malformed.json()).toMatchObject({
      error: { code: "SIGNER_NOT_CONFIGURED" },
    });
    expect(body.ADMISSION_SIGNER_MASTER_KEYS).toBeTruthy();
  });

  it("rejects unrecognized paths, methods, and oversized request payloads", async () => {
    const env = await createEnvironment();
    const getResponse = await admissionSigner.fetch(
      new Request("https://admission-signer.internal/internal/v1/tenant-keys"),
      env,
    );
    expect(getResponse.status).toBe(405);

    const unknownResponse = await post("/public/v1/sign", {}, env);
    expect(unknownResponse.status).toBe(404);

    const oversized = await admissionSigner.fetch(new Request(
      "https://admission-signer.internal/internal/v1/sign",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payload: "x".repeat(150_000) }),
      },
    ), env);
    expect(oversized.status).toBe(413);
  });
});
