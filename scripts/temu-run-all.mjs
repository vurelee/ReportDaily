import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const accountsPath = process.env.TEMU_ACCOUNTS_CONFIG || path.join(rootDir, "temu-accounts.json");
const reportDir = process.env.TEMU_REPORT_DIR || path.join(rootDir, "temu-reports");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const combinedJsonPath = path.join(reportDir, `temu-all-accounts-${stamp}.json`);
const reportDate = normalizeReportDate(process.env.TEMU_REPORT_DATE);
const productSource = normalizeProductSource(process.env.TEMU_PRODUCT_SOURCE);
const reportDateLabels = {
  today: "今日",
  yesterday: "昨日",
};
const reportDateLabel = reportDateLabels[reportDate];

await fs.mkdir(reportDir, { recursive: true });

function normalizeReportDate(value) {
  const normalized = String(value || "today").trim().toLowerCase();
  if (["today", "yesterday"].includes(normalized)) return normalized;
  throw new Error("TEMU_REPORT_DATE must be today or yesterday");
}

function normalizeProductSource(value) {
  const normalized = String(value || "api").trim().toLowerCase();
  if (normalized === "api") return normalized;
  throw new Error("TEMU_PRODUCT_SOURCE must be api");
}

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

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function accountAttemptLimit(account) {
  return positiveInteger(account.retryAttempts || process.env.TEMU_ACCOUNT_RETRY_ATTEMPTS, 2);
}

function runAccountOnce(account) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      TEMU_ACCOUNT_LABEL: account.label || account.id,
      TEMU_CDP_PROFILE_DIR: account.cdpProfileDir,
      TEMU_CDP_PORT: String(account.cdpPort),
      TEMU_SHOPS: account.shops.join(","),
      TEMU_KNOWN_SHOPS: account.knownShops.join(","),
      TEMU_REGION: account.region || process.env.TEMU_REGION || "欧区",
      TEMU_REPORT_DATE: reportDate,
      TEMU_PRODUCT_SOURCE: productSource,
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
      const networkCapturePath = stdout.match(/Network capture:\s*(.+)\s*$/m)?.[1]?.trim() || "";
      if (!savedJson) {
        resolve({
          account,
          ok: false,
          stdout,
          stderr,
          networkCapturePath,
          error: summarizeError(stdout, stderr, code),
        });
        return;
      }

      try {
        const report = JSON.parse(await fs.readFile(savedJson, "utf8"));
        const shopCount = report.shops?.length || 0;
        const failures = report.failures || [];
        const failed = code !== 0 || report.partial === true || failures.length > 0 || shopCount === 0;
        resolve({
          account,
          ok: !failed,
          partial: failed && shopCount > 0,
          stdout,
          stderr,
          jsonPath: savedJson,
          networkCapturePath,
          report,
          error: failures.map((failure) => `${failure.shopName}: ${failure.error}`).join(" / ") || (code === 0 ? "" : summarizeError(stdout, stderr, code)),
        });
      } catch (error) {
        resolve({
          account,
          ok: false,
          stdout,
          stderr,
          networkCapturePath,
          error: `无法读取账号报告 JSON：${error instanceof Error ? error.message : String(error)}`,
        });
      }
    });
  });
}

async function runAccount(account) {
  const maxAttempts = accountAttemptLimit(account);
  const previousErrors = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await runAccountOnce(account);
    if (result.ok || attempt === maxAttempts) {
      return {
        ...result,
        attempts: attempt,
        previousErrors,
      };
    }

    previousErrors.push(result.error || `attempt ${attempt} failed`);
    console.error(
      `Retrying account: ${account.label || account.id} attempt ${attempt + 1}/${maxAttempts}: ${result.error || "unknown error"}`,
    );
  }

  return {
    account,
    ok: false,
    attempts: maxAttempts,
    previousErrors,
    error: previousErrors[previousErrors.length - 1] || "account retry failed",
  };
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

for (const account of (accountConfig.accounts || []).filter((item) => item.dailyReportEnabled !== false)) {
  console.log(`Running account: ${account.label || account.id}`);
  results.push(await runAccount(account));
}

const reportsWithData = results.filter((result) => result.report?.shops?.length > 0).map((result) => result.report);
const updateTimes = [
  ...new Set(
    reportsWithData.flatMap((report) =>
      report.shops.map((shop) => shop.updateTime).filter(Boolean),
    ),
  ),
];
const sortMetrics = [
  ...new Set(
    reportsWithData.flatMap((report) =>
      report.shops.map((shop) => shop.sortMetricUsed).filter(Boolean),
    ),
  ),
];

const header = [
  `Temu 欧区${reportDateLabel}商品数据`,
  updateTimes.length ? `更新时间：${updateTimes.join(" / ")}` : null,
  sortMetrics.length ? `排序：${sortMetrics.join(" / ")} 从高到低` : null,
].filter((line) => line !== null).join("\n");

const accountBlocks = results.map((result) => {
    if (!result.report?.shops?.length) {
      return [`【账号：${result.account.label || result.account.id}】`, `失败：${result.error}`].join("\n");
    }

    const failureLines = (result.report.failures || []).map(
      (failure) => `【${failure.shopName}】\n失败：${failure.error}`,
    );
    return [
      `【账号：${result.account.label || result.account.id}】`,
      result.report.shops.map(formatShopSummary).join("\n\n"),
      ...failureLines,
    ].join("\n");
  });

const message = [header, ...accountBlocks].join("\n\n");

await fs.writeFile(
  combinedJsonPath,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      accountsPath,
      reportDate,
      reportDateLabel,
      productSource,
      apiDomFallback: false,
      message,
      results: results.map((result) =>
        result.report
          ? {
              account: result.account,
              ok: result.ok,
              partial: result.partial === true,
              attempts: result.attempts || 1,
              previousErrors: result.previousErrors || [],
              jsonPath: result.jsonPath,
              networkCapturePath: result.networkCapturePath || "",
              report: result.report,
              error: result.error || "",
            }
          : {
              account: result.account,
              ok: false,
              attempts: result.attempts || 1,
              previousErrors: result.previousErrors || [],
              networkCapturePath: result.networkCapturePath || "",
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
