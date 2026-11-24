import { runScheduledAdmission } from "./orchestrator-scheduler-admission.js";

export default Object.freeze({
  async scheduled(controller, env, ctx) {
    return runScheduledAdmission(controller, env, ctx);
  },
});
