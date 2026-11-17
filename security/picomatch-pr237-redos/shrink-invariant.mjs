export function isPreservedCounterexample(result) {
  return Boolean(
    result &&
    result.diverges === true &&
    result.base?.outcome === "completed" &&
    result.base?.matched === true &&
    result.candidate?.outcome === "completed" &&
    result.candidate?.matched === false
  );
}
