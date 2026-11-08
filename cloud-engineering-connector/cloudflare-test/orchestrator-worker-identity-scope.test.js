import { describe, expect, it } from "vitest";
import {
  createAgentWorkerAssertion,
  verifyWorkerAssertion,
} from "../orchestrator-worker-identity.js";

describe("task-scoped agent worker assertions", () => {
  const keySet = JSON.stringify({ test: "8".repeat(64) });
  const base = {
    subject: "agent-alpha",
    role: "agent",
    operation: "transitionTask",
    tenantId: "tenant-alpha",
    projectId: "project-red",
    taskId: "task-42",
    nowMs: 1_800_000_000_000,
  };

  it("binds an agent assertion to the exact tenant, project, task, subject, and operation", async () => {
    const token = await createAgentWorkerAssertion(keySet, "test", base);
    const verified = await verifyWorkerAssertion(keySet, token, base);
    expect(verified).toMatchObject({
      subject: "agent-alpha",
      role: "agent",
      operation: "transitionTask",
      tenantId: "tenant-alpha",
      projectId: "project-red",
      taskId: "task-42",
    });
  });

  it.each([
    ["tenant", { tenantId: "tenant-beta" }],
    ["project", { projectId: "project-blue" }],
    ["task", { taskId: "task-43" }],
    ["operation", { operation: "releaseLease" }],
    ["subject", { subject: "agent-beta" }],
  ])("rejects a token replayed with a different %s binding", async (_label, override) => {
    const token = await createAgentWorkerAssertion(keySet, "test", base);
    await expect(verifyWorkerAssertion(keySet, token, { ...base, ...override }))
      .rejects.toMatchObject({ code: "AUTHENTICATED_WORKER_REQUIRED" });
  });

  it("permits a tenant/project-scoped claim capability only for claimTask without a selected task", async () => {
    const claim = {
      ...base,
      operation: "claimTask",
      taskId: null,
    };
    const token = await createAgentWorkerAssertion(keySet, "test", claim);
    await expect(verifyWorkerAssertion(keySet, token, claim)).resolves.toMatchObject({
      tenantId: "tenant-alpha",
      projectId: "project-red",
      taskId: null,
    });
    await expect(createAgentWorkerAssertion(keySet, "test", {
      ...base,
      operation: "transitionTask",
      taskId: null,
    })).rejects.toMatchObject({ code: "AUTHENTICATED_WORKER_REQUIRED" });
  });
});
