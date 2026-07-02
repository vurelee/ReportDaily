import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportDate = normalizeReportDate(process.env.TEMU_REPORT_DATE);

function normalizeReportDate(value) {
  const normalized = String(value || "today").trim().toLowerCase();
  if (["today", "yesterday"].includes(normalized)) return normalized;
  throw new Error("TEMU_REPORT_DATE must be today or yesterday");
}

function runNode(label, script, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    console.log(`Running ${label}: ${["node", script, ...args].join(" ")}`);
    const child = spawn(process.execPath, [script, ...args], {
      cwd: rootDir,
      env: { ...process.env, ...(options.env || {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${label} failed with exit code ${code || 1}`));
    });
  });
}

function savedJsonPath(output, pattern, label) {
  const paths = [...output.matchAll(/^Saved JSON:\s*(.+)$/gm)]
    .map((match) => match[1].trim())
    .filter((filePath) => pattern.test(path.basename(filePath)));

  const filePath = paths.at(-1) || "";
  if (!filePath) throw new Error(`${label} did not print a Saved JSON path`);
  return filePath;
}

const reportResult = await runNode("multi-account report", "scripts/temu-run-all.mjs");
const combinedJson = savedJsonPath(reportResult.stdout, /^temu-all-accounts-.+\.json$/, "multi-account report");

if (reportDate === "today") {
  const checksResult = await runNode("agentseller checks", "scripts/temu-run-agentseller-checks.mjs");
  const abnormalJson = savedJsonPath(checksResult.stdout, /^temu-abnormal-orders-.+\.json$/, "abnormal orders");
  const operationJson = savedJsonPath(checksResult.stdout, /^temu-operation-status-.+\.json$/, "operation status");

  await runNode("summary image delivery", "scripts/temu-summary-image.mjs", [
    "--input",
    combinedJson,
    "--send-wecom",
    "--include-abnormal",
    "--abnormal-input",
    abnormalJson,
    "--include-operation-status",
    "--operation-status-input",
    operationJson,
  ]);
} else {
  const shopFundsJsons = [];
  for (const accountId of ["setonr", "whitine-leeev", "wonder"]) {
    const shopFundsResult = await runNode(`shop funds ${accountId}`, "scripts/temu-shop-funds.mjs", [], {
      env: {
        TEMU_ACCOUNT_ID: accountId,
        TEMU_CDP_HEADLESS: process.env.TEMU_CDP_HEADLESS || "1",
      },
    });
    shopFundsJsons.push(savedJsonPath(shopFundsResult.stdout, /^temu-shop-funds-.+\.json$/, `shop funds ${accountId}`));
  }

  await runNode("summary image delivery", "scripts/temu-summary-image.mjs", [
    "--input",
    combinedJson,
    "--send-wecom",
  ]);
  await runNode("shop funds image delivery", "scripts/temu-shop-funds-image.mjs", [
    ...shopFundsJsons.flatMap((shopFundsJson) => ["--input", shopFundsJson]),
    "--send-wecom",
  ]);
}
