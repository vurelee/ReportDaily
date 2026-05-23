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

async function findCombinedReportPaths() {
  const entries = await fs.readdir(reportDir);
  const matches = entries
    .filter((name) => /^temu-all-accounts-.+\.json$/.test(name))
    .map((name) => path.join(reportDir, name));

  const stats = await Promise.all(
    matches.map(async (filePath) => ({ filePath, stat: await fs.stat(filePath) })),
  );
  stats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  return stats.map((entry) => entry.filePath);
}

async function findLatestCombinedReport() {
  const matches = await findCombinedReportPaths();
  if (matches.length === 0) {
    throw new Error(`No combined Temu report found in ${reportDir}`);
  }
  return matches[0];
}

function htmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function collectRows(report) {
  const rows = [];

  for (const result of report.results || []) {
    if (!result.ok) {
      throw new Error(`${result.account?.label || result.account?.id || "account"} failed: ${result.error}`);
    }

    for (const shop of result.report?.shops || []) {
      const total = shop.total || shop.rows?.[0] || {};
      const amount = total.displaySales || total.netSales || total.sales || "￥0.00";
      const quantityValue = parseInteger(total.quantity);
      const amountValue = parseCurrency(amount);
      rows.push({
        shop: shop.shopName,
        updateTime: shop.updateTime || "",
        quantity: String(quantityValue),
        quantityValue,
        amount: formatCurrency(amountValue),
        amountValue,
      });
    }
  }

  if (rows.length === 0) {
    throw new Error("No shop summary rows found in report");
  }

  return rows;
}

function parseInteger(value) {
  const parsed = Number.parseInt(String(value || "0").replace(/,/g, ""), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseCurrency(value) {
  const parsed = Number.parseFloat(String(value || "0").replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatCurrency(value) {
  return `￥${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function appendTotalRow(rows) {
  const totalQuantity = rows.reduce((sum, row) => sum + row.quantityValue, 0);
  const totalAmount = rows.reduce((sum, row) => sum + row.amountValue, 0);
  return [
    ...rows,
    {
      shop: "合计",
      quantity: String(totalQuantity),
      quantityValue: totalQuantity,
      amount: formatCurrency(totalAmount),
      amountValue: totalAmount,
      isTotal: true,
    },
  ];
}

function rowsByShop(rows) {
  return new Map(rows.map((row) => [row.shop, row]));
}

function latestUpdateDate(report) {
  const dates = (report.results || [])
    .flatMap((result) => result.report?.shops || [])
    .map((shop) => parseShanghaiDateTime(shop.updateTime))
    .filter(Boolean)
    .sort((a, b) => a.getTime() - b.getTime());

  if (dates.length > 0) return dates[dates.length - 1];
  if (!report.generatedAt) return null;

  const generatedAt = new Date(report.generatedAt);
  return Number.isNaN(generatedAt.getTime()) ? null : generatedAt;
}

function latestUpdateTime(report) {
  const date = latestUpdateDate(report);
  return date ? formatShanghaiMinute(date) : new Date().toLocaleString("zh-CN", { hour12: false });
}

function buildTitle(report) {
  return `Temu 欧区今日汇总 ${latestUpdateTime(report)}`;
}

function parseShanghaiDateTime(value) {
  const match = String(value || "").match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/,
  );
  if (!match) return null;

  const [, year, month, day, hour, minute, second = "0"] = match;
  const date = new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour) - 8,
      Number(minute),
      Number(second),
    ),
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatShanghaiParts(date) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function formatShanghaiDate(date) {
  const value = formatShanghaiParts(date);
  return `${value.year}-${value.month}-${value.day}`;
}

function formatShanghaiMinute(date) {
  const value = formatShanghaiParts(date);
  return `${value.year}-${value.month}-${value.day} ${value.hour}:${value.minute}`;
}

async function findComparisonReport(inputPath, report) {
  const overridePath = getFlagValue("--compare-input");
  if (overridePath) {
    const comparisonPath = path.resolve(overridePath);
    const comparisonReport = JSON.parse(await fs.readFile(comparisonPath, "utf8"));
    return {
      inputPath: comparisonPath,
      report: comparisonReport,
      rows: appendTotalRow(collectRows(comparisonReport)),
      updateTime: latestUpdateTime(comparisonReport),
    };
  }

  const currentDate = latestUpdateDate(report);
  if (!currentDate) return null;

  const targetDate = new Date(currentDate.getTime() - 24 * 60 * 60 * 1000);
  const targetLocalDay = formatShanghaiDate(targetDate);
  const reportPaths = await findCombinedReportPaths();
  const candidates = [];

  for (const candidatePath of reportPaths) {
    if (candidatePath === inputPath) continue;

    let candidateReport;
    let candidateRows;
    try {
      candidateReport = JSON.parse(await fs.readFile(candidatePath, "utf8"));
      candidateRows = appendTotalRow(collectRows(candidateReport));
    } catch {
      continue;
    }

    const candidateDate = latestUpdateDate(candidateReport);
    if (!candidateDate || formatShanghaiDate(candidateDate) !== targetLocalDay) continue;

    candidates.push({
      inputPath: candidatePath,
      report: candidateReport,
      rows: candidateRows,
      updateTime: formatShanghaiMinute(candidateDate),
      distanceMs: Math.abs(candidateDate.getTime() - targetDate.getTime()),
    });
  }

  candidates.sort((a, b) => a.distanceMs - b.distanceMs);
  return candidates[0] || null;
}

function percentChange(currentValue, previousValue) {
  if (previousValue === undefined || previousValue === null) {
    return { text: "--", kind: "flat" };
  }

  if (previousValue === 0) {
    if (currentValue === 0) return { text: "0.00%", kind: "flat" };
    return { text: "新增", kind: "up" };
  }

  const value = ((currentValue - previousValue) / previousValue) * 100;
  return {
    text: `${value > 0 ? "+" : ""}${value.toFixed(2)}%`,
    kind: value > 0 ? "up" : value < 0 ? "down" : "flat",
  };
}

function deltaHtml(change) {
  if (change.kind === "flat") {
    return `<span class="delta flat"><span class="arrow">-</span>${htmlEscape(change.text)}</span>`;
  }

  return `<span class="delta ${change.kind}"><span class="arrow">${
    change.kind === "up" ? "▲" : "▼"
  }</span>${htmlEscape(change.text)}</span>`;
}

function buildHtml(rows, report, comparison) {
  const displayRows = appendTotalRow(rows);
  const comparisonRows = comparison ? rowsByShop(comparison.rows) : new Map();
  const comparisonText = comparison
    ? `每项百分比对比：${comparison.updateTime}`
    : "每项百分比对比：未找到昨日同时间数据";
  const bodyRows = displayRows
    .map((row) => {
      const previous = comparisonRows.get(row.shop);
      const quantityDelta = percentChange(row.quantityValue, previous?.quantityValue);
      const amountDelta = percentChange(row.amountValue, previous?.amountValue);

      return `
        <tr${row.isTotal ? ' class="total-row"' : ""}>
          <td class="shop">${htmlEscape(row.shop)}</td>
          <td class="metric quantity">
            <div class="value">${htmlEscape(row.quantity)}</div>
            ${deltaHtml(quantityDelta)}
          </td>
          <td class="metric amount">
            <div class="value">${htmlEscape(row.amount)}</div>
            ${deltaHtml(amountDelta)}
          </td>
        </tr>`;
    })
    .join("");

  return `<!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <style>
          :root {
            color: #202328;
            background: #fff;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
              "Hiragino Sans GB", "Microsoft YaHei", Arial, sans-serif;
          }
          * {
            box-sizing: border-box;
          }
          body {
            margin: 0;
            background: #fff;
            display: inline-block;
          }
          .report {
            width: ${reportWidth}px;
            background: #fff;
            border: 1px solid #eceef2;
            overflow: hidden;
          }
          .header {
            padding: 18px 20px 12px;
            border-bottom: 1px solid #e8ebf0;
          }
          .title {
            font-size: 25px;
            line-height: 32px;
            font-weight: 800;
            letter-spacing: 0;
            white-space: nowrap;
          }
          .sub {
            margin-top: 4px;
            font-size: 16px;
            line-height: 23px;
            color: #707782;
            white-space: nowrap;
          }
          table {
            width: 100%;
            border-collapse: collapse;
            table-layout: fixed;
          }
          th {
            height: 50px;
            padding: 0 20px;
            background: #f7f8fa;
            color: #4c535c;
            font-size: 20px;
            font-weight: 750;
            text-align: left;
            border-bottom: 1px solid #e8ebf0;
          }
          td {
            height: 76px;
            padding: 0 20px;
            border-bottom: 1px solid #eceef2;
            vertical-align: middle;
          }
          tr:last-child td {
            border-bottom: none;
          }
          .shop {
            width: 345px;
            font-size: 22px;
            font-weight: 650;
            color: #24272c;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
          }
          .quantity {
            width: 150px;
            text-align: right;
          }
          .amount {
            width: 285px;
            text-align: right;
          }
          th.quantity,
          th.amount {
            text-align: right;
          }
          .value {
            font-size: 24px;
            line-height: 30px;
            font-weight: 780;
            color: #171a1f;
            white-space: nowrap;
          }
          .delta {
            display: inline-flex;
            align-items: center;
            justify-content: flex-end;
            gap: 4px;
            margin-top: 3px;
            font-size: 17px;
            line-height: 22px;
            font-weight: 760;
            white-space: nowrap;
          }
          .delta .arrow {
            font-size: 12px;
            line-height: 14px;
            transform: translateY(-1px);
          }
          .delta.up {
            color: #13a538;
          }
          .delta.down {
            color: #f04438;
          }
          .delta.flat {
            color: #89909b;
          }
          .total-row td {
            background: #fbfcfd;
          }
          .total-row .shop,
          .total-row .value {
            font-weight: 850;
          }
        </style>
      </head>
      <body>
        <div class="report">
          <div class="header">
            <div class="title">${htmlEscape(buildTitle(report))}</div>
            <div class="sub">${htmlEscape(comparisonText)}</div>
          </div>
          <table>
            <thead>
              <tr>
                <th class="shop">店铺</th>
                <th class="quantity">件数</th>
                <th class="amount">销售额</th>
              </tr>
            </thead>
            <tbody>${bodyRows}</tbody>
          </table>
        </div>
      </body>
    </html>`;
}

async function main() {
  if (args.includes("--send")) {
    throw new Error("Unsupported flag --send; use --send-wecom for Enterprise WeChat webhook delivery");
  }

  const inputPath = path.resolve(getFlagValue("--input") || (await findLatestCombinedReport()));
  const report = JSON.parse(await fs.readFile(inputPath, "utf8"));
  const rows = collectRows(report);
  const comparison = await findComparisonReport(inputPath, report);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputPath =
    getFlagValue("--output") || path.join(reportDir, `temu-summary-${stamp}.png`);

  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({
      viewport: { width: reportWidth + 40, height: 140 + (rows.length + 1) * 76 },
      deviceScaleFactor: 1,
    });
    await page.setContent(buildHtml(rows, report, comparison), { waitUntil: "load" });
    await page.locator(".report").screenshot({ path: outputPath });
  } finally {
    await browser.close();
  }

  const sendErrors = [];
  let sentWecom = false;
  if (args.includes("--send-wecom") && process.env.TEMU_SEND_WECOM !== "0") {
    try {
      await sendWecomImage(outputPath);
      sentWecom = true;
    } catch (error) {
      sendErrors.push(
        `Enterprise WeChat: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  console.log(`Input JSON: ${inputPath}`);
  if (comparison) console.log(`Comparison JSON: ${comparison.inputPath}`);
  else console.log("Comparison JSON: none");
  console.log(`Saved image: ${outputPath}`);
  if (sentWecom) console.log("Sent Enterprise WeChat image.");

  if (sendErrors.length > 0) {
    throw new Error(`Delivery failed: ${sendErrors.join(" / ")}`);
  }
}

await main();

async function launchBrowser() {
  try {
    return await chromium.launch({ headless: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("Executable doesn't exist")) throw error;
    return await chromium.launch({ channel: "chrome", headless: true });
  }
}
