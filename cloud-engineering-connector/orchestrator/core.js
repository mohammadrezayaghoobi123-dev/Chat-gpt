function notImplemented(name) {
  const error = new Error(name + " is not implemented.");
  error.code = "NOT_IMPLEMENTED";
  throw error;
}
export async function intakeTask() { return notImplemented("intakeTask"); }
export async function scheduleTask() { return notImplemented("scheduleTask"); }
export async function processAgentMessage() { return notImplemented("processAgentMessage"); }
export async function requestCancellation() { return notImplemented("requestCancellation"); }
export async function runDispatchCycle() { return notImplemented("runDispatchCycle"); }
