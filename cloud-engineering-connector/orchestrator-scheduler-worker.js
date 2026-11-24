export { TenantDirectory } from "./identity/tenant-directory.js";
export { OrchestratorLedger } from "./orchestrator-ledger.js";

import { WorkflowEntrypoint } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import {
  admitPreparedScheduledTask,
  prepareScheduledAdmission,
  scheduledWorkflowId,
  verifyPreparedScheduledAdmission,
} from "./orchestrator-scheduler-admission.js";

const WORKFLOW_STEP_RETRIES = Object.freeze({
  limit: 6,
  delay: "10 seconds",
  backoff: "exponential",
});

const NON_RETRYABLE_ADMISSION_CODES = new Set([
  "SCHEDULED_ADMISSION_SNAPSHOT_INVALID",
  "SCHEDULED_ADMISSION_BINDINGS_UNAVAILABLE",
  "TASK_ADMISSION_DENIED",
  "TASK_ADMISSION_REAUTHORIZATION_DENIED",
  "TASK_ADMISSION_IDEMPOTENCY_CONFLICT",
  "TASK_ADMISSION_TASK_ID_CONFLICT",
  "TASK_ADMISSION_RECEIPT_MISMATCH",
  "TASK_ADMISSION_RECEIPT_INTEGRITY_ERROR",
  "TASK_ADMISSION_RECEIPT_CONFLICT",
  "TASK_ADMISSION_RECEIPT_INVALID",
  "TASK_ADMISSION_RESERVATION_INVALID",
  "TASK_ADMISSION_RESERVATION_NOT_FOUND",
  "TASK_ADMISSION_SNAPSHOT_STALE",
  "TASK_ADMISSION_REQUIRED",
  "TASK_ADMISSION_REPLAY_CONFLICT",
  "INVALID_TENANT_DIRECTORY_INPUT",
]);

const ACTIVE_WORKFLOW_STATUSES = new Set([
  "queued",
  "running",
  "waiting",
  "waitingForPause",
  "complete",
]);

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function accepted(workflowId, status, extra = {}) {
  return {
    accepted: true,
    workflowId,
    status: status.status,
    ...extra,
  };
}

export class ScheduledTaskAdmissionWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const schedule = await verifyPreparedScheduledAdmission(event?.payload);
    const admissions = [];
    let created = 0;
    let replayed = 0;

    for (let index = 0; index < schedule.tasks.length; index += 1) {
      const item = schedule.tasks[index];
      const stepName = "admit-task-" + String(index + 1).padStart(2, "0");
      const result = await step.do(
        stepName,
        {
          retries: WORKFLOW_STEP_RETRIES,
          timeout: "2 minutes",
        },
        async () => {
          try {
            return await admitPreparedScheduledTask(schedule, item, this.env);
          } catch (error) {
            if (NON_RETRYABLE_ADMISSION_CODES.has(error?.code)) {
              throw new NonRetryableError(
                typeof error?.message === "string" ? error.message : "Scheduled Task admission was rejected.",
              );
            }
            throw error;
          }
        },
      );

      if (result.outcome === "created") created += 1;
      else if (result.outcome === "replayed") replayed += 1;
      admissions.push(result);
    }

    return {
      version: 1,
      cron: schedule.cron,
      scheduledTime: schedule.scheduledTime,
      processed: admissions.length,
      created,
      replayed,
      admissions,
    };
  }
}

export default Object.freeze({
  async scheduled(controller, env) {
    const workflowBinding = env?.SCHEDULED_TASK_ADMISSION;
    if (!workflowBinding || typeof workflowBinding.create !== "function" ||
        typeof workflowBinding.get !== "function") {
      throw fail("SCHEDULED_WORKFLOW_BINDING_UNAVAILABLE", "The durable Scheduled Task Workflow binding is unavailable.");
    }

    const snapshot = await prepareScheduledAdmission(controller, env);
    const workflowId = await scheduledWorkflowId(snapshot);

    try {
      const instance = await workflowBinding.create({ id: workflowId, params: snapshot });
      const status = await instance.status();
      return accepted(workflowId, status, { created: true, duplicate: false });
    } catch (createError) {
      let existing;
      try {
        existing = await workflowBinding.get(workflowId);
      } catch {
        throw createError;
      }

      const status = await existing.status();
      if (status.status === "errored" && status.error?.name !== "NonRetryableError") {
        try {
          await existing.restart();
          const restarted = await existing.status();
          return accepted(workflowId, restarted, {
            created: false,
            duplicate: true,
            restarted: true,
          });
        } catch (restartError) {
          const latest = await existing.status();
          if (ACTIVE_WORKFLOW_STATUSES.has(latest.status)) {
            return accepted(workflowId, latest, {
              created: false,
              duplicate: true,
              restartRace: true,
            });
          }
          throw fail(
            "SCHEDULED_WORKFLOW_RESTART_FAILED",
            "The existing errored Workflow could not be restarted safely.",
          );
        }
      }

      if (ACTIVE_WORKFLOW_STATUSES.has(status.status) || status.status === "errored" ||
          status.status === "paused" || status.status === "terminated") {
        return accepted(workflowId, status, {
          created: false,
          duplicate: true,
          terminal: status.status === "errored" || status.status === "terminated",
          paused: status.status === "paused",
        });
      }

      throw fail("SCHEDULED_WORKFLOW_STATE_UNKNOWN", "The existing Workflow is in an unknown state; automatic replay was refused.");
    }
  },
});
