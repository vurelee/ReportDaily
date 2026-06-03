import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const checks = [
  ["abnormal-orders", "scripts/temu-abnormal-orders.mjs"],
  ["operation-status", "scripts/temu-operation-status.mjs"],
];

function runChild(label, script, args = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: rootDir,
      env: process.env,
      stdio: ["ignore", "inherit", "inherit"],
    });

    child.on("close", (code) => {
      resolve({ label, code: code ?? 1 });
    });
  });
}

console.log("Running agentseller checks sequentially");

const results = [];
for (const [label, script] of checks) {
  const result = await runChild(label, script);
  results.push(result);
  if (result.code !== 0) break;
}

for (const result of results) {
  console.log(`${result.label}: exit ${result.code}`);
}

const failed = results.filter((result) => result.code !== 0);
if (failed.length > 0) {
  process.exitCode = failed[0].code || 1;
}
