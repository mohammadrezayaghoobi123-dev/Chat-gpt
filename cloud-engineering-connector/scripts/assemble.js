import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const root = join(dir, "..");
const parts = [];
for (let i = 0; i < 32; i++) {
  try {
    const mod = await import(`../lib/source-parts/part${i}.js`);
    parts.push(mod.default);
  } catch {
    break;
  }
}
if (parts.length < 2) throw new Error("assemble: expected multiple source parts, found " + parts.length);
const bundled = parts.join("");
if (!bundled.includes('VERSION = "0.2.0"')) throw new Error("assemble: missing VERSION 0.2.0 marker");
if (!bundled.includes("parseAllowlist")) throw new Error("assemble: missing parseAllowlist");
if (!bundled.includes("export default")) throw new Error("assemble: missing export default");
const out = join(root, "worker.generated.js");
writeFileSync(out, bundled);
console.log("assembled", out, "bytes=" + bundled.length + " parts=" + parts.length);
