import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("TenantDirectory verification key lookup", () => {
  it("fails closed for an unknown key without provisioning signing material", async () => {
    const tenantId = "directory-admission-key-unprovisioned";
    const stub = env.TENANT_DIRECTORY.get(env.TENANT_DIRECTORY.idFromName(tenantId));
    const outcome = await runInDurableObject(stub, async instance => {
      try {
        await instance.getAdmissionVerificationKey({ tenantId, keyId: "unknown-key-id" });
        return "UNEXPECTED_SUCCESS";
      } catch (error) {
        return error.code;
      }
    });
    expect(outcome).toBe("ADMISSION_SIGNING_KEY_NOT_FOUND");
    const stored = await runInDurableObject(stub, instance =>
      instance.ctx.storage.get("admission:signing-key:v1:" + tenantId),
    );
    const pending = await runInDurableObject(stub, instance =>
      instance.ctx.storage.get("admission:signing-key-pending:v1:" + tenantId),
    );
    expect(stored).toBeUndefined();
    expect(pending).toBeUndefined();
  });
});
