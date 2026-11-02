import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

for (const file of ["index.html", "multichain.html"]) {
  test(`inline JavaScript parses in ${file}`, () => {
    const html = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    const scripts = [...html.matchAll(/<script(?:\s+type="module")?>([\s\S]*?)<\/script>/gi)]
      .map(match => match[1])
      .filter(source => source.trim());
    assert.ok(scripts.length > 0, "expected at least one inline script");
    for (const source of scripts) {
      const result = spawnSync(process.execPath, ["--check", "--input-type=module"], {
        input: source,
        encoding: "utf8"
      });
      assert.equal(result.status, 0, result.stderr || "inline script syntax check failed");
    }
  });
}

test("Bitcoin recent transactions are fetched once and reused", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)][0]?.[1] ?? "";
  assert.equal((script.match(/fetchWithTimeout\(base\+'\/txs'/g) ?? []).length, 1);
});

test("EVM balance rendering avoids floating-point conversion", () => {
  const html = readFileSync(new URL("../multichain.html", import.meta.url), "utf8");
  assert.match(html, /formatUnits\(BigInt\(bal\)\.toString\(\),18\)/);
  assert.doesNotMatch(html, /Number\(BigInt\(bal\)\)/);
});
