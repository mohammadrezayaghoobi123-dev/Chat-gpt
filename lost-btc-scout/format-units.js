export function formatUnits(rawValue, decimals = 18, maxFractionDigits = 8) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new RangeError("decimals must be an integer between 0 and 255");
  }
  if (!Number.isInteger(maxFractionDigits) || maxFractionDigits < 0 || maxFractionDigits > decimals) {
    throw new RangeError("maxFractionDigits must be between 0 and decimals");
  }
  const raw = BigInt(rawValue);
  const negative = raw < 0n;
  const absolute = negative ? -raw : raw;
  const scale = 10n ** BigInt(decimals);
  const whole = absolute / scale;
  const remainder = absolute % scale;
  const fraction = maxFractionDigits === 0
    ? ""
    : remainder.toString().padStart(decimals, "0").slice(0, maxFractionDigits).replace(/0+$/, "");
  const wholeText = new Intl.NumberFormat("fa-IR", { maximumFractionDigits: 0 }).format(whole);
  const fractionText = fraction ? "٫" + fraction.replace(/[0-9]/g, digit => "۰۱۲۳۴۵۶۷۸۹"[Number(digit)]) : "";
  return (negative ? "−" : "") + wholeText + fractionText;
}
