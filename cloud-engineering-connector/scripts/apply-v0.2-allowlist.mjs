#!/usr/bin/env node
/**
 * Atomic recovery builder for cloud-engineering-connector v0.2.0
 * Reads a 0.1.0-style monolithic worker from stdin or BASE_WORKER_PATH,
 * applies surgical allowlist patches, writes worker.js
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const srcPath = process.env.BASE_WORKER_PATH || process.argv[2];
if (!srcPath) {
  console.error("Usage: BASE_WORKER_PATH=path node scripts/apply-v0.2-allowlist.mjs");
  process.exit(2);
}
let src = readFileSync(resolve(srcPath), "utf8");

if (!src.includes('const VERSION = "0.1.0";') && !src.includes('const VERSION = "0.2.0";')) {
  console.error("Unexpected worker baseline (VERSION marker missing)");
  process.exit(1);
}

src = src.replace('const VERSION = "0.1.0";', 'const VERSION = "0.2.0";');

const oldDefaults = 'const ALLOWED_BASE_BRANCH = "feature/cloud-engineering-connector";';
const newDefaults = `const DEFAULT_ALLOWED_BASE_BRANCH = "feature/cloud-engineering-connector";
const DEFAULT_ALLOWED_REPOSITORIES = ["mohammadrezayaghoobi123-dev/Chat-gpt"];`;
if (src.includes(oldDefaults)) src = src.replace(oldDefaults, newDefaults);

const oldBlock = `const ALLOWED_REPOSITORY="mohammadrezayaghoobi123-dev/Chat-gpt";
function repoPath(owner,repo){if(!validSlug(owner)||!validSlug(repo))throw new Error("Invalid GitHub owner or repository name.");if((owner+"/"+repo).toLowerCase()!==ALLOWED_REPOSITORY.toLowerCase())throw new Error("Repository is not in the connector allowlist.");return"/repos/"+encodeURIComponent("mohammadrezayaghoobi123-dev")+"/"+encodeURIComponent("Chat-gpt")}`;

const newBlock = `function parseAllowlist(env){const raw=typeof env?.ALLOWED_REPOSITORIES==="string"?env.ALLOWED_REPOSITORIES:"";const items=raw.split(",").map(s=>s.trim().toLowerCase()).filter(Boolean);const list=items.length?items:DEFAULT_ALLOWED_REPOSITORIES.map(x=>x.toLowerCase());for(const item of list){const parts=item.split("/");if(parts.length!==2||!validSlug(parts[0])||!validSlug(parts[1]))throw new Error("Invalid ALLOWED_REPOSITORIES entry: "+item);}return new Set(list);}
function allowedBaseBranch(env){const v=typeof env?.ALLOWED_BASE_BRANCH==="string"&&env.ALLOWED_BASE_BRANCH.trim()?env.ALLOWED_BASE_BRANCH.trim():DEFAULT_ALLOWED_BASE_BRANCH;if(!validBranchName(v))throw new Error("Invalid ALLOWED_BASE_BRANCH configuration.");return v;}
function repoPath(owner,repo,env){if(!validSlug(owner)||!validSlug(repo))throw new Error("Invalid GitHub owner or repository name.");const key=(owner+"/"+repo).toLowerCase();if(!parseAllowlist(env||{}).has(key))throw new Error("Repository is not in the connector allowlist.");return"/repos/"+encodeURIComponent(owner)+"/"+encodeURIComponent(repo);}`;

if (src.includes(oldBlock)) {
  src = src.replace(oldBlock, newBlock);
  src = src.replaceAll("repoPath(args.owner,args.repo)", "repoPath(args.owner,args.repo,env)");
  src = src.replace("args.base_branch!==ALLOWED_BASE_BRANCH", "args.base_branch!==allowedBaseBranch(env)");
}

if (!src.includes("parseAllowlist") || !src.includes('VERSION = "0.2.0"')) {
  console.error("Patch failed validation");
  process.exit(1);
}

const out = resolve("worker.js");
writeFileSync(out, src);
console.log("wrote", out, "bytes=" + src.length);
