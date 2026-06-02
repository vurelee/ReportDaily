import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { sendWecomImage } from "./wecom-send.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportDir = process.env.TEMU_REPORT_DIR || path.join(rootDir, "temu-reports");
const args = process.argv.slice(2);
const reportWidth = 780;

function getFlagValue(name) {
  const index = args.indexOf(name);
  return index === -1 ? "" : args[index + 1] || "";
}

async function findLatestOperationStatusReport() {
  const entries = await fs.readdir(reportDir);
  const matches = entries
    .filter((name) => /^temu-operation-status-.+\.json$/.test(name))
    .map((name) => path.join(reportDir, name));

  const stats = await Promise.all(
    matches.map(async (filePath) => ({ filePath, stat: await fs.stat(filePath) })),
  );
  stats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  if (!stats[0]) throw new Error(`No operation status report found in ${reportDir}`);
  return stats[0].filePath;
}

function htmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatShanghaiSecond(date) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function reportTime(report) {
  const date = report.generatedAt ? new Date(report.generatedAt) : new Date();
  return Number.isNaN(date.getTime()) ? formatShanghaiSecond(new Date()) : formatShanghaiSecond(date);
}

function missingProducts(shop) {
  if (Array.isArray(shop.missingInSaleProducts)) return shop.missingInSaleProducts;
  if (Array.isArray(shop.missingInSaleSpus)) {
    return shop.missingInSaleSpus.map((spuId) => ({ spuId }));
  }
  return [];
}

function briefProductName(value, maxLength = 32) {
  const compact = String(value || "").replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
}

function collectRows(report) {
  const rows = [];
  for (const result of report.results || []) {
    if (!result.ok) {
      rows.push({
        shopName: result.account?.label || result.account?.id || "账号",
        error: result.error || "检查失败",
      });
      continue;
    }

    for (const shop of result.shops || []) {
      const counts = shop.regionCounts || {};
      const missing = missingProducts(shop);
      rows.push({
        shopName: shop.shopName || "-",
        eu: counts.eu || 0,
        uk: counts.uk || 0,
        us: counts.us || 0,
        inSaleSpuCount: shop.inSaleSpuCount || 0,
        totalSpuCount: shop.totalSpuCount || 0,
        missingCount: missing.length,
        missing,
      });
    }
  }
  return rows;
}

function buildMissingDetails(rows) {
  return rows
    .filter((row) => row.missingCount > 0)
    .map((row) => {
      const details = row.missing
        .slice(0, 8)
        .map((product) => {
          const name = briefProductName(product.productName);
          return `${product.spuId || "-"}${name ? ` ${name}` : ""}`;
        })
        .join("、");
      const more = row.missing.length > 8 ? `，另${row.missing.length - 8}个` : "";
      return `<div class="warning-line"><strong>${htmlEscape(row.shopName)}</strong> 下架SPU：${htmlEscape(details)}${htmlEscape(more)}</div>`;
    })
    .join("");
}

function buildTableRows(rows) {
  return rows
    .map((row) => {
      if (row.error) {
        return `
          <tr>
            <td class="shop">${htmlEscape(row.shopName)}</td>
            <td colspan="5" class="error">${htmlEscape(row.error)}</td>
          </tr>
        `;
      }

      const missingClass = row.missingCount > 0 ? "missing bad" : "missing";
      return `
        <tr>
          <td class="shop">${htmlEscape(row.shopName)}</td>
          <td>${row.eu}</td>
          <td>${row.uk}</td>
          <td>${row.us}</td>
          <td>${row.inSaleSpuCount}/${row.totalSpuCount}</td>
          <td class="${missingClass}">${row.missingCount}</td>
        </tr>
      `;
    })
    .join("");
}

function buildHtml(report, rows, inputPath) {
  const totalInSale = rows.reduce((sum, row) => sum + (row.inSaleSpuCount || 0), 0);
  const totalSpu = rows.reduce((sum, row) => sum + (row.totalSpuCount || 0), 0);
  const totalMissing = rows.reduce((sum, row) => sum + (row.missingCount || 0), 0);
  const warningDetails = buildMissingDetails(rows);
  const sourceName = path.basename(inputPath);
  const rule = report.inSaleStatusRule || "skcSiteStatus=1";

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: #eef1f5;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      color: #172033;
    }
    .report {
      width: ${reportWidth}px;
      background: #ffffff;
      padding: 24px 26px 26px;
    }
    .top {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 16px;
      margin-bottom: 16px;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 27px;
      line-height: 1.25;
      font-weight: 800;
      letter-spacing: 0;
    }
    .meta {
      color: #697386;
      font-size: 14px;
      line-height: 1.6;
    }
    .summary {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      min-width: 220px;
    }
    .pill {
      border: 1px solid #d9e1ec;
      border-radius: 8px;
      padding: 9px 10px;
      background: #f7f9fc;
      text-align: center;
    }
    .pill-label {
      color: #697386;
      font-size: 13px;
      margin-bottom: 3px;
    }
    .pill-value {
      font-size: 20px;
      font-weight: 800;
      line-height: 1.2;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
      border: 1px solid #dbe3ef;
      border-radius: 8px;
      overflow: hidden;
      font-size: 18px;
    }
    th, td {
      border: 1px solid #dbe3ef;
      padding: 12px 10px;
      text-align: center;
      line-height: 1.28;
      vertical-align: middle;
    }
    th {
      background: #edf3fb;
      color: #39465e;
      font-size: 15px;
      font-weight: 800;
    }
    td {
      background: #ffffff;
      font-weight: 700;
    }
    tbody tr:nth-child(even) td {
      background: #f8fafc;
    }
    .shop {
      width: 220px;
      text-align: left;
      font-weight: 800;
      word-break: break-word;
    }
    .missing.bad {
      color: #b42318;
      background: #fff2f1;
    }
    .error {
      color: #b42318;
      text-align: left;
    }
    .warnings {
      margin-top: 14px;
      color: #b42318;
      font-size: 15px;
      line-height: 1.55;
    }
    .warning-line {
      padding: 8px 10px;
      background: #fff2f1;
      border: 1px solid #ffd0cc;
      border-radius: 8px;
      margin-top: 8px;
    }
    .source {
      margin-top: 12px;
      color: #8a95a8;
      font-size: 12px;
      line-height: 1.4;
      word-break: break-all;
    }
  </style>
</head>
<body>
  <main class="report">
    <section class="top">
      <div>
        <h1>店铺运营状态</h1>
        <div class="meta">数据时间：${htmlEscape(reportTime(report))}</div>
        <div class="meta">在售规则：${htmlEscape(rule)}</div>
      </div>
      <div class="summary">
        <div class="pill">
          <div class="pill-label">在售SPU</div>
          <div class="pill-value">${totalInSale}/${totalSpu}</div>
        </div>
        <div class="pill">
          <div class="pill-label">下架异常</div>
          <div class="pill-value">${totalMissing}</div>
        </div>
      </div>
    </section>
    <table>
      <thead>
        <tr>
          <th class="shop">店铺</th>
          <th>欧区</th>
          <th>英区</th>
          <th>美区</th>
          <th>在售/总SPU</th>
          <th>下架异常</th>
        </tr>
      </thead>
      <tbody>
        ${buildTableRows(rows)}
      </tbody>
    </table>
    ${warningDetails ? `<section class="warnings">${warningDetails}</section>` : ""}
    <div class="source">来源：${htmlEscape(sourceName)}</div>
  </main>
</body>
</html>`;
}

async function renderImage(report, inputPath, outputPath) {
  const rows = collectRows(report);
  if (rows.length === 0) throw new Error("No operation status rows found");

  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({
      viewport: { width: reportWidth + 40, height: 1200 },
      deviceScaleFactor: 1,
    });
    await page.setContent(buildHtml(report, rows, inputPath), { waitUntil: "load" });
    await page.locator(".report").screenshot({ path: outputPath });
  } finally {
    await browser.close();
  }
}

async function launchBrowser() {
  try {
    return await chromium.launch({ headless: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("Executable doesn't exist")) throw error;
    return await chromium.launch({ channel: "chrome", headless: true });
  }
}

async function main() {
  const inputPath = path.resolve(getFlagValue("--input") || (await findLatestOperationStatusReport()));
  const report = JSON.parse(await fs.readFile(inputPath, "utf8"));
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const outputPath = path.resolve(
    getFlagValue("--output") || path.join(reportDir, `temu-operation-status-summary-${timestamp}.png`),
  );

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await renderImage(report, inputPath, outputPath);

  let sentWecom = false;
  if (args.includes("--send-wecom") && process.env.TEMU_SEND_WECOM !== "0") {
    await sendWecomImage(outputPath);
    sentWecom = true;
  }

  console.log(`Input JSON: ${inputPath}`);
  console.log(`Saved image: ${outputPath}`);
  if (sentWecom) console.log("Sent Enterprise WeChat operation status image.");
}

await main();
