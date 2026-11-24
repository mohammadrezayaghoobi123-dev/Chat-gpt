export { TenantDirectory } from "./identity/tenant-directory.js";
export { OrchestratorLedger } from "./orchestrator-ledger.js";

import { WorkflowEntrypoint } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import {
  admitPreparedScheduledTask,
  prepareScheduledAdmission,
  verifyPreparedScheduledAdmission,
} from "./orchestrator-scheduler-admission.js";

const WORKFLOW_STEP_RETRIES = Object.freeze({
  limit: 6,
  delay: "10 seconds",
  backoff: "exponential",
});

const NON_RETRYABLE_ADMISSION_CODES = new Set([
  "SCHEDULED_EVENT_INVALID",
  "SCHEDULED_ADMISSION_POLICY_UNAVAILABLE",
  "SCHEDULED_ADMISSION_POLICY_INVALID",
  "SCHEDULED_ADMISSION_CRON_NOT_CONFIGURED",
  "SCHEDULED_ADMISSION_SIGNER_CONFIG_INVALID",
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

function toWorkflowError(error, fallbackMessage) {
  return new NonRetryableError(
    typeof error?.message === "string" ? error.message : fallbackMessage,
  );
}

export class ScheduledTaskAdmissionWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const cron = event?.schedule?.cron;
    const scheduledTime = event?.schedule?.scheduledTime;
    if (typeof cron !== "string" || !Number.isSafeInteger(scheduledTime) || scheduledTime < 1) {
      throw new NonRetryableError(
        "Workflow event is missing trusted Cron schedule metadata.",
      );
    }

    const snapshot = await step.do(
      "prepare-scheduled-admission",
      {
        retries: WORKFLOW_STEP_RETRIES,
        timeout: "2 minutes",
      },
      async () => {
        try {
          const prepared = await prepareScheduledAdmission({ cron, scheduledTime }, this.env);
          return await verifyPreparedScheduledAdmission(prepared);
        } catch (error) {
          if (NON_RETRYABLE_ADMISSION_CODES.has(error?.code)) {
            throw toWorkflowError(error, "Scheduled admission preflight was rejected.");
          }
          throw error;
        }
      },
    );

    const schedule = await verifyPreparedScheduledAdmission(snapshot);
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
              throw toWorkflowError(error, "Scheduled Task admission was rejected.");
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

export default Object.freeze({});
