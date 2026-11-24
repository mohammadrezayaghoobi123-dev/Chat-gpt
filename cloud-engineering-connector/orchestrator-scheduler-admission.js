import { admissionTextDigest, normalizeTaskForAdmission, taskAdmissionDigest } from "./orchestrator-admission.js";
import { canonicalJson } from "./orchestrator-protocol.js";
import { createScheduledWorkerAssertion } from "./orchestrator-worker-identity.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_POLICY_BYTES = 64 * 1024;
const MAX_TASKS_PER_INVOCATION = 20;
const SCHEDULER_SUBJECT = "orchestrator-scheduler";
const SCHEDULER_ROLE = "system";
const SCHEDULER_OPERATION = "createTask";

function fail(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

function isRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every(key => allowed.includes(key));
}

function requireIdentifier(value, field) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw fail("SCHEDULED_ADMISSION_POLICY_INVALID", field + " must be a valid identifier.");
  }
  return value;
}

function readSchedulePolicy(controller, env) {
  if (!controller || typeof controller.cron !== "string" ||
      controller.cron.length < 1 || controller.cron.length > 128 ||
      /[\u0000-\u001f\u007f]/.test(controller.cron) ||
      !Number.isSafeInteger(controller.scheduledTime) || controller.scheduledTime < 1) {
    throw fail("SCHEDULED_EVENT_INVALID", "The ScheduledController fields are invalid.");
  }

  const raw = env?.SCHEDULED_ADMISSION_POLICIES;
  if (typeof raw !== "string" || raw.length < 1 ||
      new TextEncoder().encode(raw).byteLength > MAX_POLICY_BYTES) {
    throw fail("SCHEDULED_ADMISSION_POLICY_UNAVAILABLE", "Scheduled admission policy is unavailable.");
  }

  let policies;
  try {
    policies = JSON.parse(raw);
  } catch {
    throw fail("SCHEDULED_ADMISSION_POLICY_INVALID", "Scheduled admission policy is not valid JSON.");
  }
  if (!isRecord(policies) || !Object.prototype.hasOwnProperty.call(policies, controller.cron)) {
    throw fail("SCHEDULED_ADMISSION_CRON_NOT_CONFIGURED", "No admission policy is configured for this Cron expression.");
  }

  const policy = policies[controller.cron];
  if (!isRecord(policy) || !hasOnlyKeys(policy, ["servicePrincipalId", "tasks"])) {
    throw fail("SCHEDULED_ADMISSION_POLICY_INVALID", "The selected Cron policy has an invalid shape.");
  }
  const servicePrincipalId = requireIdentifier(policy.servicePrincipalId, "servicePrincipalId");
  if (!Array.isArray(policy.tasks) || policy.tasks.length < 1 ||
      policy.tasks.length > MAX_TASKS_PER_INVOCATION) {
    throw fail("SCHEDULED_ADMISSION_POLICY_INVALID", "Cron policy tasks must contain between one and twenty entries.");
  }

  const scheduledTime = controller.scheduledTime;
  const seenTaskScopes = new Set();
  const seenIdempotencyScopes = new Set();
  const tasks = policy.tasks.map((entry, index) => {
    if (!isRecord(entry) ||
        !hasOnlyKeys(entry, ["tenantId", "projectId", "taskIdPrefix", "idempotencyPrefix", "taskTemplate"])) {
      throw fail("SCHEDULED_ADMISSION_POLICY_INVALID", "Cron task entry " + index + " has an invalid shape.");
    }

    const tenantId = requireIdentifier(entry.tenantId, "tenantId");
    const projectId = requireIdentifier(entry.projectId, "projectId");
    const taskIdPrefix = requireIdentifier(entry.taskIdPrefix, "taskIdPrefix");
    const idempotencyPrefix = requireIdentifier(entry.idempotencyPrefix, "idempotencyPrefix");
    if (!isRecord(entry.taskTemplate)) {
      throw fail("SCHEDULED_ADMISSION_POLICY_INVALID", "Cron task entry " + index + " requires a plain taskTemplate object.");
    }

    const taskId = taskIdPrefix + "-" + scheduledTime;
    const idempotencyKey = idempotencyPrefix + ":" + scheduledTime + ":" + taskId;
    if (!IDENTIFIER.test(taskId) || !IDENTIFIER.test(idempotencyKey)) {
      throw fail("SCHEDULED_ADMISSION_POLICY_INVALID", "Generated Task and idempotency identifiers exceed their supported bounds.");
    }

    const taskScope = tenantId + "\u0000" + projectId + "\u0000" + taskId;
    const idempotencyScope = tenantId + "\u0000" + projectId + "\u0000" + idempotencyKey;
    if (seenTaskScopes.has(taskScope) || seenIdempotencyScopes.has(idempotencyScope)) {
      throw fail("SCHEDULED_ADMISSION_POLICY_INVALID", "Cron policy contains duplicate Task or idempotency identities.");
    }
    seenTaskScopes.add(taskScope);
    seenIdempotencyScopes.add(idempotencyScope);

    const proposedTask = {
      ...entry.taskTemplate,
      taskId,
      tenantId,
      projectId,
      state: "SCHEDULED",
      version: 1,
      createdAt: scheduledTime,
      updatedAt: scheduledTime,
      scheduleCron: controller.cron,
      scheduledAt: scheduledTime,
    };

    let task;
    try {
      task = normalizeTaskForAdmission(proposedTask);
    } catch {
      throw fail("SCHEDULED_ADMISSION_POLICY_INVALID", "Cron task entry " + index + " does not produce a canonical, admissible Task.");
    }

    return { tenantId, projectId, taskId, idempotencyKey, task };
  });

  return { servicePrincipalId, scheduledTime, cron: controller.cron, tasks };
}

function resolveBindings(env, task) {
  const directoryNamespace = env?.TENANT_DIRECTORY;
  const ledgerNamespace = env?.ORCHESTRATOR_LEDGER;
  if (!directoryNamespace || typeof directoryNamespace.idFromName !== "function" ||
      typeof directoryNamespace.get !== "function" ||
      !ledgerNamespace || typeof ledgerNamespace.idFromName !== "function" ||
      typeof ledgerNamespace.get !== "function") {
    throw fail("SCHEDULED_ADMISSION_BINDINGS_UNAVAILABLE", "TenantDirectory or OrchestratorLedger binding is unavailable.");
  }

  // The canonical Ledger shard key for this adapter is the tenant ID.
  const directory = directoryNamespace.get(directoryNamespace.idFromName(task.tenantId));
  const ledger = ledgerNamespace.get(ledgerNamespace.idFromName(task.tenantId));
  if (!directory || typeof directory.prepareTaskAdmission !== "function" ||
      !ledger || typeof ledger.createTask !== "function") {
    throw fail("SCHEDULED_ADMISSION_BINDINGS_UNAVAILABLE", "TenantDirectory or OrchestratorLedger RPC methods are unavailable.");
  }
  return { directory, ledger };
}

async function makeWorkerAssertion(keySet, activeKid, nowMs) {
  try {
    return await createScheduledWorkerAssertion(keySet, activeKid, {
      subject: SCHEDULER_SUBJECT,
      role: SCHEDULER_ROLE,
      operation: SCHEDULER_OPERATION,
      nowMs,
    });
  } catch {
    throw fail("SCHEDULED_ADMISSION_SIGNER_UNAVAILABLE", "The isolated Scheduler worker assertion signer is unavailable.");
  }
}

/**
 * Each Task is admitted through two independent Durable Object transactions:
 * TenantDirectory reservation, then OrchestratorLedger persistence. The
 * deterministic event identity makes completed Tasks safe to replay, but a
 * multi-Task batch is deliberately not represented as a distributed transaction.
 */
export async function runScheduledAdmission(controller, env) {
  const schedule = readSchedulePolicy(controller, env);
  const keySet = env?.LEDGER_WORKER_ASSERTION_KEYS;
  const activeKid = env?.LEDGER_WORKER_ASSERTION_ACTIVE_KID;
  if (typeof keySet !== "string" || typeof activeKid !== "string") {
    throw fail("SCHEDULED_ADMISSION_SIGNER_UNAVAILABLE", "Scheduler worker assertion signing configuration is unavailable.");
  }

  // Validate signer configuration before the first Directory reservation.
  await makeWorkerAssertion(keySet, activeKid, Date.now());

  const prepared = [];
  for (const item of schedule.tasks) {
    const digest = await taskAdmissionDigest(item.task);
    const inputHash = await admissionTextDigest(canonicalJson({
      version: 1,
      cron: schedule.cron,
      scheduledTime: schedule.scheduledTime,
      principalId: schedule.servicePrincipalId,
      tenantId: item.tenantId,
      projectId: item.projectId,
      taskId: item.taskId,
      taskDigest: digest,
      idempotencyKey: item.idempotencyKey,
    }));
    const bindings = resolveBindings(env, item);
    prepared.push({ ...item, taskDigest: digest, inputHash, ...bindings });
  }

  const admissions = [];
  let created = 0;
  let replayed = 0;

  for (const item of prepared) {
    let directoryReserved = false;
    try {
      const reservation = await item.directory.prepareTaskAdmission({
        tenantId: item.tenantId,
        projectId: item.projectId,
        principalId: schedule.servicePrincipalId,
        taskId: item.taskId,
        taskDigest: item.taskDigest,
        idempotencyKey: item.idempotencyKey,
        inputHash: item.inputHash,
      });
      directoryReserved = true;

      if (!reservation || typeof reservation.grant !== "string" ||
          reservation.taskId !== item.taskId ||
          reservation.taskDigest !== item.taskDigest) {
        throw fail("TASK_ADMISSION_RESERVATION_INVALID", "TenantDirectory returned a reservation that does not match the scheduled Task.");
      }

      const workerNow = Date.now();
      const workerAssertion = await makeWorkerAssertion(keySet, activeKid, workerNow);
      const result = await item.ledger.createTask({
        task: item.task,
        idempotencyKey: item.idempotencyKey,
        inputHash: item.inputHash,
        now: workerNow,
        workerId: SCHEDULER_SUBJECT,
        workerAssertion,
        admissionGrant: reservation.grant,
      });

      if (result?.created === true) {
        created += 1;
        admissions.push({
          tenantId: item.tenantId,
          projectId: item.projectId,
          taskId: item.taskId,
          admissionId: reservation.admissionId,
          outcome: "created",
        });
      } else if (result?.created === false && result?.replay === true) {
        replayed += 1;
        admissions.push({
          tenantId: item.tenantId,
          projectId: item.projectId,
          taskId: item.taskId,
          admissionId: reservation.admissionId,
          outcome: "replayed",
        });
      } else {
        throw fail(
          typeof result?.reason === "string" ? result.reason : "TASK_ADMISSION_REJECTED",
          "OrchestratorLedger rejected the scheduled Task admission.",
        );
      }
    } catch (error) {
      const causeCode = typeof error?.code === "string" ? error.code : "UNCLASSIFIED_ADMISSION_FAILURE";
      throw fail("SCHEDULED_ADMISSION_PARTIAL_FAILURE", "Scheduled Task admission stopped at the first failed Task.", {
        completed: admissions.length,
        failedTaskId: item.taskId,
        directoryReserved,
        causeCode,
      });
    }
  }

  return {
    cron: schedule.cron,
    scheduledTime: schedule.scheduledTime,
    processed: admissions.length,
    created,
    replayed,
    admissions,
  };
}
