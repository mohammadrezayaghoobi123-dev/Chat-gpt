import test from "node:test";
import assert from "node:assert/strict";
import { formatUnits } from "../format-units.js";

test("formats a large wei balance without IEEE-754 precision loss", () => {
  assert.equal(formatUnits("123456789012345678901234567890"), "۱۲۳٬۴۵۶٬۷۸۹٬۰۱۲٫۳۴۵۶۷۸۹");
});

test("formats a value below one token", () => {
  assert.equal(formatUnits("123456789012345678"), "۰٫۱۲۳۴۵۶۷۸");
});

test("trims trailing fractional zeroes", () => {
  assert.equal(formatUnits("1000000000000000000"), "۱");
});

test("supports zero-decimal quantities", () => {
  assert.equal(formatUnits("123456", 0, 0), "۱۲۳٬۴۵۶");
});

test("rejects invalid decimal parameters", () => {
  assert.throws(() => formatUnits("1", -1), RangeError);
  assert.throws(() => formatUnits("1", 2, 3), RangeError);
});


test("formats six-decimal tokens with the default precision", () => {
  assert.equal(formatUnits("1234567", 6), "۱٫۲۳۴۵۶۷");
});

test("formats zero-decimal tokens with the default precision", () => {
  assert.equal(formatUnits("123456", 0), "۱۲۳٬۴۵۶");
});
