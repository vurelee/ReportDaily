import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const accountsPath = process.env.TEMU_ACCOUNTS_CONFIG || path.join(rootDir, "temu-accounts.json");
const reportDir = process.env.TEMU_REPORT_DIR || path.join(rootDir, "temu-reports");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const combinedJsonPath = path.join(reportDir, `temu-all-accounts-${stamp}.json`);

await fs.mkdir(reportDir, { recursive: true });

function briefProductName(value, maxLength = 26) {
  const compact = String(value || "").replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
}

function formatShopSummary(shopReport) {
  const { shopName, total, top } = shopReport;
  return [
    `【${shopName}】`,
    `合计：件数 ${total.quantity}｜${total.displaySalesLabel} ${total.displaySales}`,
    ...top.map(
      (row, index) =>
        `${index + 1}. ${briefProductName(row.productName)}\n` +
        `   件数 ${row.quantity}｜${row.displaySalesLabel} ${row.displaySales}`,
    ),
  ].join("\n");
}

function runAccount(account) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      TEMU_ACCOUNT_LABEL: account.label || account.id,
      TEMU_CDP_PROFILE_DIR: account.cdpProfileDir,
      TEMU_CDP_PORT: String(account.cdpPort),
      TEMU_SHOPS: account.shops.join(","),
      TEMU_KNOWN_SHOPS: account.knownShops.join(","),
      TEMU_REGION: account.region || process.env.TEMU_REGION || "欧区",
      TEMU_REPORT_PREFIX: `temu-${account.id}`,
    };

    const child = spawn(process.execPath, ["scripts/temu-report.mjs"], {
      cwd: rootDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", async (code) => {
      const savedJson = stdout.match(/Saved JSON:\s*(.+)\s*$/m)?.[1]?.trim() || "";
      if (code !== 0 || !savedJson) {
        resolve({
          account,
          ok: false,
          stdout,
          stderr,
          error: summarizeError(stdout, stderr, code),
        });
        return;
      }

      try {
        const report = JSON.parse(await fs.readFile(savedJson, "utf8"));
        resolve({ account, ok: true, stdout, stderr, jsonPath: savedJson, report });
      } catch (error) {
        resolve({
          account,
          ok: false,
          stdout,
          stderr,
          error: `无法读取账号报告 JSON：${error instanceof Error ? error.message : String(error)}`,
        });
      }
    });
  });
}

function summarizeError(stdout, stderr, code) {
  const text = `${stderr}\n${stdout}`;
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const reportError = lines.find((line) => line.includes("TemuReportError:"));
  if (reportError) return reportError.replace(/^.*TemuReportError:\s*/, "");

  const regularError = lines.find((line) => /^Error:|^[A-Z_]+:/.test(line));
  if (regularError) return regularError.replace(/^Error:\s*/, "");

  return lines.slice(-6).join(" / ") || `exit code ${code}`;
}

const accountConfig = JSON.parse(await fs.readFile(accountsPath, "utf8"));
const results = [];

for (const account of accountConfig.accounts || []) {
  console.log(`Running account: ${account.label || account.id}`);
  results.push(await runAccount(account));
}

const successfulReports = results.filter((result) => result.ok).map((result) => result.report);
const updateTimes = [
  ...new Set(
    successfulReports.flatMap((report) =>
      report.shops.map((shop) => shop.updateTime).filter(Boolean),
    ),
  ),
];
const sortMetrics = [
  ...new Set(
    successfulReports.flatMap((report) =>
      report.shops.map((shop) => shop.sortMetricUsed).filter(Boolean),
    ),
  ),
];

const header = [
  "Temu 欧区今日商品数据",
  updateTimes.length ? `更新时间：${updateTimes.join(" / ")}` : null,
  sortMetrics.length ? `排序：${sortMetrics.join(" / ")} 从高到低` : null,
].filter((line) => line !== null).join("\n");

const accountBlocks = results.map((result) => {
    if (!result.ok) {
      return [`【账号：${result.account.label || result.account.id}】`, `失败：${result.error}`].join("\n");
    }

    return [
      `【账号：${result.account.label || result.account.id}】`,
      result.report.shops.map(formatShopSummary).join("\n\n"),
    ].join("\n");
  });

const message = [header, ...accountBlocks].join("\n\n");

await fs.writeFile(
  combinedJsonPath,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      accountsPath,
      message,
      results: results.map((result) =>
        result.ok
          ? {
              account: result.account,
              ok: true,
              jsonPath: result.jsonPath,
              report: result.report,
            }
          : {
              account: result.account,
              ok: false,
              error: result.error,
            },
      ),
    },
    null,
    2,
  ),
);

console.log(message);
console.log(`Saved JSON: ${combinedJsonPath}`);

if (results.some((result) => !result.ok)) {
  process.exitCode = 1;
}
