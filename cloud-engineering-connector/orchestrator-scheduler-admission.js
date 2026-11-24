export async function runScheduledAdmission() {
  throw Object.assign(new Error("Scheduled Task admission is not implemented."), {
    code: "SCHEDULED_ADMISSION_NOT_IMPLEMENTED",
  });
}
