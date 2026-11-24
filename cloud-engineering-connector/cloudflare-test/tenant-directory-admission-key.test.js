import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

function directoryFor(tenantId) {
  return env.TENANT_DIRECTORY.get(env.TENANT_DIRECTORY.idFromName(tenantId));
}

function toBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value) {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
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

describe("TenantDirectory admission signing key integration", () => {
  it("persists one encrypted tenant key under concurrency and signs canonical bytes through the service binding", async () => {
    const tenantId = "directory-admission-key-tenant";
    const stub = directoryFor(tenantId);
    const firstMessage = "master-brain:admission:v1:first-message";
    const secondMessage = "master-brain:admission:v1:second-message";

    const [first, second] = await Promise.all([
      stub.signAdmissionMessage({ tenantId, message: firstMessage }),
      stub.signAdmissionMessage({ tenantId, message: secondMessage }),
    ]);

    expect(first).toMatchObject({ tenantId, algorithm: "Ed25519" });
    expect(second).toMatchObject({ tenantId, algorithm: "Ed25519" });
    expect(first.keyId).toBe(second.keyId);
    expect(first.publicKey).toBe(second.publicKey);
    expect(typeof first.signature).toBe("string");
    expect(typeof second.signature).toBe("string");
    await expect(verifySignature(first.publicKey, firstMessage, first.signature)).resolves.toBe(true);
    await expect(verifySignature(first.publicKey, secondMessage, second.signature)).resolves.toBe(true);

    const stored = await runInDurableObject(stub, async instance =>
      instance.ctx.storage.get("admission:signing-key:v1:" + tenantId),
    );
    expect(stored).toMatchObject({
      version: 1,
      tenantId,
      keyId: first.keyId,
      publicKey: first.publicKey,
    });
    expect(typeof stored.wrappingKeyId).toBe("string");
    expect(typeof stored.kdfSalt).toBe("string");
    expect(typeof stored.iv).toBe("string");
    expect(typeof stored.wrappedPrivateKey).toBe("string");
    expect(Object.keys(stored)).not.toContain("privateKey");
    expect(Object.keys(stored)).not.toContain("pkcs8");
    expect(Object.keys(stored)).not.toContain("masterKey");

    const verificationKey = await stub.getAdmissionVerificationKey({
      tenantId,
      keyId: first.keyId,
    });
    expect(verificationKey).toEqual({
      tenantId,
      keyId: first.keyId,
      algorithm: "Ed25519",
      publicKey: first.publicKey,
    });

    const repeated = await stub.signAdmissionMessage({ tenantId, message: firstMessage });
    expect(repeated.keyId).toBe(first.keyId);
    await expect(verifySignature(verificationKey.publicKey, firstMessage, repeated.signature)).resolves.toBe(true);

    await expect(stub.getAdmissionVerificationKey({
      tenantId,
      keyId: "unknown-key-id",
    })).rejects.toMatchObject({ code: "ADMISSION_SIGNING_KEY_NOT_FOUND" });
  });

  it("isolates signing key identity and verification material across tenant objects", async () => {
    const tenantA = "directory-admission-isolation-a";
    const tenantB = "directory-admission-isolation-b";
    const [a, b] = await Promise.all([
      directoryFor(tenantA).signAdmissionMessage({ tenantId: tenantA, message: "tenant-a-message" }),
      directoryFor(tenantB).signAdmissionMessage({ tenantId: tenantB, message: "tenant-b-message" }),
    ]);

    expect(a.keyId).not.toBe(b.keyId);
    expect(a.publicKey).not.toBe(b.publicKey);
    await expect(verifySignature(a.publicKey, "tenant-a-message", a.signature)).resolves.toBe(true);
    await expect(verifySignature(b.publicKey, "tenant-b-message", b.signature)).resolves.toBe(true);

    await expect(directoryFor(tenantB).getAdmissionVerificationKey({
      tenantId: tenantB,
      keyId: a.keyId,
    })).rejects.toMatchObject({ code: "ADMISSION_SIGNING_KEY_NOT_FOUND" });
  });
});
