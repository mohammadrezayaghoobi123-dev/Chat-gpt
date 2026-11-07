import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)][0]?.[1] ?? "";

test("inline JavaScript parses", () => {
  assert.ok(script.length > 0);
  const result = process.getBuiltinModule("node:child_process").spawnSync(
    process.execPath,
    ["--check", "--input-type=module"],
    { input: script, encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
});

test("user-controlled text is escaped before HTML interpolation", () => {
  const start = script.indexOf("const esc=");
  const end = script.indexOf(";const statuses=", start);
  assert.ok(start >= 0 && end > start, "escape helper must be present");
  const esc = vm.runInNewContext(script.slice(start, end + 1) + "; esc");
  assert.equal(
    esc('<img src=x onerror="alert(1)"> & "quoted"'),
    "&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &quot;quoted&quot;"
  );
});

test("prototype remains local-only and marks evidence unverified", () => {
  assert.doesNotMatch(script, /\bfetch\s*\(/);
  assert.doesNotMatch(script, /\b(?:localStorage|sessionStorage)\b/);
  assert.match(script, /verified_fixed:false/);
  assert.match(html, /No network requests are made/);
});
