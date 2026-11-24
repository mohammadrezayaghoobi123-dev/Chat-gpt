export { TenantDirectory } from "./identity/tenant-directory.js";
export { OrchestratorLedger } from "./orchestrator-ledger.js";
import { runScheduledAdmission } from "./orchestrator-scheduler-admission.js";

export default Object.freeze({
  async scheduled(controller, env) {
    return runScheduledAdmission(controller, env);
  },
});
