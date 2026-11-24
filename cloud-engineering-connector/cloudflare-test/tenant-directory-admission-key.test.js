import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createTenantDirectoryAdminAssertion } from "../identity/tenant-directory-assertion.js";
import { createTenantDirectoryAdapters } from "../identity/tenant-directory-adapter.js";

const TENANT = "tenant-admission-keys";
const KEY_SET = JSON.stringify({ test: "a".repeat(64) });

function adaptersFor(tenantId = TENANT) {
  return createTenantDirectoryAdapters(env.TENANT_DIRECTORY, tenantId);
}

async function configure(tenantId = TENANT) {
  const stub = env.TENANT_DIRECTORY.get(env.TENANT_DIRECTORY.idFromName(tenantId));
  await runInDurableObject(stub, instance => {
    instance.env.TENANT_DIRECTORY_ADMIN_ASSERTION_KEYS = KEY_SET;
  });
  return stub;
}

async function adminAssertion(operation, tenantId, now, target) {
  return createTenantDirectoryAdminAssertion(KEY_SET, "test", {
    subject: "tenant-directory-provisioner",
    operation,
    tenantId,
    projectId: null,
    nowMs: now,
    target,
  });
}

function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function generateEd25519PublicKey() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { pair, publicKey: encodeBase64Url(raw) };
}

describe("TenantDirectory admission verification key registry", () => {
  it("registers, resolves, ages, and revokes a tenant-scoped Ed25519 public key", async () => {
    const tenantId = TENANT + "-lifecycle";
    const now = 1_800_200_000_000;
    const notBefore = now - 1_000;
    const notAfter = now + 86_400_000;
    const keyId = "admission-key-1";
    const { publicKey } = await generateEd25519PublicKey();
    const adapters = adaptersFor(tenantId);
    const stub = await configure(tenantId);

    const createTarget = {
      keyId,
      algorithm: "Ed25519",
      publicKey,
      status: "active",
      notBefore,
      notAfter,
      expectedVersion: 0,
    };
    const created = await adapters.provisioningStore.upsertAdmissionVerificationKey({
      assertion: await adminAssertion("upsertAdmissionVerificationKey", tenantId, now, createTarget),
      tenantId,
      ...createTarget,
      now,
    });

    expect(created).toMatchObject({
      created: true,
      key: {
        tenantId,
        keyId,
        algorithm: "Ed25519",
        publicKey,
        status: "active",
        version: 1,
      },
    });
    await expect(adapters.admissionVerificationKeyStore.getAdmissionVerificationKey({
      tenantId, keyId, now,
    })).resolves.toMatchObject({
      tenantId, keyId, algorithm: "Ed25519", publicKey, status: "active", version: 1,
    });
    await expect(adapters.admissionVerificationKeyStore.getAdmissionVerificationKey({
      tenantId, keyId, now: notAfter,
    })).resolves.toBeNull();

    const verifyOnlyTarget = { ...createTarget, status: "verify_only", expectedVersion: 1 };
    const verifyOnly = await adapters.provisioningStore.upsertAdmissionVerificationKey({
      assertion: await adminAssertion("upsertAdmissionVerificationKey", tenantId, now + 1, verifyOnlyTarget),
      tenantId,
      ...verifyOnlyTarget,
      now: now + 1,
    });
    expect(verifyOnly.key).toMatchObject({ status: "verify_only", version: 2 });
    await expect(adapters.admissionVerificationKeyStore.getAdmissionVerificationKey({
      tenantId, keyId, now: now + 1,
    })).resolves.toMatchObject({ status: "verify_only", version: 2 });

    const revokeTarget = { ...createTarget, status: "revoked", expectedVersion: 2 };
    const revoked = await adapters.provisioningStore.upsertAdmissionVerificationKey({
      assertion: await adminAssertion("upsertAdmissionVerificationKey", tenantId, now + 2, revokeTarget),
      tenantId,
      ...revokeTarget,
      now: now + 2,
    });
    expect(revoked.key).toMatchObject({ status: "revoked", version: 3 });
    await expect(adapters.admissionVerificationKeyStore.getAdmissionVerificationKey({
      tenantId, keyId, now: now + 2,
    })).resolves.toBeNull();

    const otherTenant = adaptersFor(tenantId + "-other");
    await expect(otherTenant.admissionVerificationKeyStore.getAdmissionVerificationKey({
      tenantId: tenantId + "-other", keyId, now: now + 2,
    })).resolves.toBeNull();
    await expect(stub.ping()).resolves.toMatchObject({ ok: true, schemaVersion: 3 });
  });

  it("rejects malformed keys, key-id rebinding, and revoked-key resurrection", async () => {
    const tenantId = TENANT + "-invalid";
    const now = 1_800_210_000_000;
    const adapters = adaptersFor(tenantId);
    await configure(tenantId);
    const { publicKey } = await generateEd25519PublicKey();
    const base = {
      keyId: "admission-key-immutable",
      algorithm: "Ed25519",
      publicKey,
      status: "active",
      notBefore: now - 1_000,
      notAfter: now + 86_400_000,
      expectedVersion: 0,
    };

    const malformed = { ...base, keyId: "admission-key-bad", publicKey: "AA" };
    await expect(adapters.provisioningStore.upsertAdmissionVerificationKey({
      assertion: await adminAssertion("upsertAdmissionVerificationKey", tenantId, now, malformed),
      tenantId, ...malformed, now,
    })).rejects.toMatchObject({ code: "INVALID_ADMISSION_VERIFICATION_KEY" });

    const created = await adapters.provisioningStore.upsertAdmissionVerificationKey({
      assertion: await adminAssertion("upsertAdmissionVerificationKey", tenantId, now + 1, base),
      tenantId, ...base, now: now + 1,
    });
    expect(created.key.version).toBe(1);

    const secondKey = await generateEd25519PublicKey();
    const rebound = { ...base, publicKey: secondKey.publicKey, expectedVersion: 1 };
    await expect(adapters.provisioningStore.upsertAdmissionVerificationKey({
      assertion: await adminAssertion("upsertAdmissionVerificationKey", tenantId, now + 2, rebound),
      tenantId, ...rebound, now: now + 2,
    })).rejects.toMatchObject({ code: "TENANT_DIRECTORY_KEY_ID_IMMUTABLE" });

    const revokedTarget = { ...base, status: "revoked", expectedVersion: 1 };
    await adapters.provisioningStore.upsertAdmissionVerificationKey({
      assertion: await adminAssertion("upsertAdmissionVerificationKey", tenantId, now + 3, revokedTarget),
      tenantId, ...revokedTarget, now: now + 3,
    });
    const resurrected = { ...base, status: "active", expectedVersion: 2 };
    await expect(adapters.provisioningStore.upsertAdmissionVerificationKey({
      assertion: await adminAssertion("upsertAdmissionVerificationKey", tenantId, now + 4, resurrected),
      tenantId, ...resurrected, now: now + 4,
    })).rejects.toMatchObject({ code: "TENANT_DIRECTORY_KEY_REVOKED_IMMUTABLE" });
  });

  it("fails closed when a schema-v3 directory has lost its verification key table", async () => {
    const tenantId = TENANT + "-corrupt";
    const stub = await configure(tenantId);
    await runInDurableObject(stub, instance => {
      instance.ensureSchema();
      instance.ctx.storage.sql.exec("DROP TABLE tenant_admission_verification_keys");
    });
    await expect(runInDurableObject(stub, instance => instance.ensureSchema()))
      .rejects.toMatchObject({ code: "TENANT_DIRECTORY_SCHEMA_CORRUPT" });
  });
});
