export function isPreservedCounterexample(result) {
  return Boolean(
    result &&
    result.diverges === true &&
    result.fixedDiffers === false &&
    result.base?.outcome === "completed" &&
    result.candidate?.outcome === "completed" &&
    result.fixed?.outcome === "completed" &&
    result.base?.matched === true &&
    result.candidate?.matched === false &&
    result.fixed?.matched === result.base?.matched
  );
}
