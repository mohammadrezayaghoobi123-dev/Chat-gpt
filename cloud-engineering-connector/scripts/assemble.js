import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const root = join(dir, "..");
const partsDir = join(root, "lib", "source-parts");
const names = readdirSync(partsDir)
  .filter((n) => /^part\d+\.b64$/.test(n))
  .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));

if (names.length < 2) {
  throw new Error("assemble: need partN.b64 files, found " + names.length);
}
for (let i = 0; i < names.length; i++) {
  const expect = `part${i}.b64`;
  if (names[i] !== expect) throw new Error(`assemble: expected ${expect}, found ${names[i]}`);
}
const bundled = names
  .map((n) => Buffer.from(readFileSync(join(partsDir, n), "utf8").trim(), "base64").toString("utf8"))
  .join("");
if (!bundled.includes("export default")) throw new Error("assemble: missing export default");
if (!bundled.includes('VERSION = "0.2.0"')) throw new Error("assemble: missing VERSION 0.2.0");
const outPath = join(root, "worker.generated.js");
writeFileSync(outPath, bundled);
console.log("assembled", outPath, "bytes=" + bundled.length, "parts=" + names.length, "version=0.2.0");
