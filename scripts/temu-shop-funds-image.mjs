import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { sendWecomImage } from "./wecom-send.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportDir = process.env.TEMU_REPORT_DIR || path.join(rootDir, "temu-reports");
const args = process.argv.slice(2);
const imageWidth = 880;

function getFlagValue(name) {
  const index = args.indexOf(name);
  return index === -1 ? "" : args[index + 1] || "";
}

function getFlagValues(name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1]) values.push(args[index + 1]);
  }
  return values;
}

function htmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function amountValue(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? amount : 0;
}

function formatAmount(cents) {
  return (cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function collectRows(reports) {
  const rows = [];
  for (const report of reports) {
    for (const result of report.results || []) {
      for (const shop of result.shops || []) {
        const withdrawableCents = amountValue(shop.settledFunds?.amountInCents);
        const pendingCents = amountValue(shop.pendingFunds?.totalAmount?.value);
        rows.push({
          shopName: shop.shopName || "-",
          withdrawableCents,
          pendingCents,
          totalCents: withdrawableCents + pendingCents,
        });
      }
    }
  }
  return rows;
}

function rowsWithTotal(reports) {
  const rows = collectRows(reports);
  const withdrawableCents = rows.reduce((sum, row) => sum + row.withdrawableCents, 0);
  const pendingCents = rows.reduce((sum, row) => sum + row.pendingCents, 0);
  const totalCents = rows.reduce((sum, row) => sum + row.totalCents, 0);
  return [...rows, { shopName: "合计", withdrawableCents, pendingCents, totalCents, isTotal: true }];
}

function buildTextPreview(rows) {
  const lines = ["店铺资金明细（CNY）", "店铺名 | 可提现金额 | 待处理/待结算 | 资金合计"];
  for (const row of rows) {
    lines.push(
      `${row.shopName} | ${formatAmount(row.withdrawableCents)} | ${formatAmount(row.pendingCents)} | ${formatAmount(row.totalCents)}`,
    );
  }
  return lines.join("\n");
}

function buildHtml(rows) {
  const bodyRows = rows
    .map(
      (row) => `
        <tr class="${row.isTotal ? "total" : ""}">
          <td class="shop">${htmlEscape(row.shopName)}</td>
          <td class="amount">${htmlEscape(formatAmount(row.withdrawableCents))}</td>
          <td class="amount">${htmlEscape(formatAmount(row.pendingCents))}</td>
          <td class="amount">${htmlEscape(formatAmount(row.totalCents))}</td>
        </tr>`,
    )
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
            display: inline-block;
            padding: 28px 32px 30px;
            background: #fff;
            border: 1px solid #e5e8ee;
            border-radius: 12px;
          }
          .title {
            font-size: 34px;
            line-height: 44px;
            font-weight: 800;
            letter-spacing: 0;
            margin-bottom: 22px;
          }
          .table {
            border: 1px solid #dfe3ea;
            border-radius: 10px;
            overflow: hidden;
            display: inline-block;
          }
          table {
            border-collapse: separate;
            border-spacing: 0;
            table-layout: auto;
          }
          col.withdrawable {
            width: 150px;
          }
          col.pending {
            width: 174px;
          }
          col.total-amount {
            width: 156px;
          }
          thead tr {
            min-height: 60px;
            background: #f7f9fc;
            color: #2c3138;
            font-weight: 800;
          }
          tr:last-child td {
            border-bottom: 0;
          }
          .total {
            background: #f3f6fa;
            font-weight: 800;
          }
          .shop,
          .amount {
            height: 56px;
            padding: 0 14px;
            font-size: 21px;
            line-height: 28px;
            white-space: nowrap;
            vertical-align: middle;
            border-bottom: 1px solid #e6e9ee;
          }
          .shop {
            text-align: left;
            border-right: 1px solid #e1e5eb;
            padding-right: 18px;
          }
          .amount {
            text-align: right;
            border-right: 1px solid #e1e5eb;
            font-variant-numeric: tabular-nums;
          }
          .amount:last-child,
          .header-amount:last-child {
            border-right: 0;
          }
          th.shop,
          th.amount {
            height: 60px;
            font-size: 20px;
            font-weight: 800;
          }
        </style>
      </head>
      <body>
        <section class="report">
          <div class="title">店铺资金明细（CNY）</div>
          <div class="table">
            <table>
              <colgroup>
                <col class="shop-col" />
                <col class="withdrawable" />
                <col class="pending" />
                <col class="total-amount" />
              </colgroup>
              <thead>
                <tr>
                  <th class="shop">店铺名</th>
                  <th class="amount">可提现金额</th>
                  <th class="amount">待处理/待结算</th>
                  <th class="amount">资金合计</th>
                </tr>
              </thead>
              <tbody>
                ${bodyRows}
              </tbody>
            </table>
          </div>
        </section>
      </body>
    </html>`;
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

async function renderImage(rows, outputPath) {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({
      viewport: { width: imageWidth + 40, height: 120 + rows.length * 62 },
      deviceScaleFactor: 1,
    });
    await page.setContent(buildHtml(rows), { waitUntil: "load" });
    await page.locator(".report").screenshot({ path: outputPath });
  } finally {
    await browser.close();
  }
}

async function main() {
  const inputPaths = getFlagValues("--input").map((inputPath) => path.resolve(inputPath));
  if (inputPaths.length === 0) throw new Error("At least one --input shop funds JSON is required");

  const reports = await Promise.all(
    inputPaths.map(async (inputPath) => JSON.parse(await fs.readFile(inputPath, "utf8"))),
  );
  const rows = rowsWithTotal(reports);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputPath = path.resolve(getFlagValue("--output") || path.join(reportDir, `temu-shop-funds-${stamp}.png`));

  await renderImage(rows, outputPath);

  let sentWecom = false;
  if (args.includes("--send-wecom") && process.env.TEMU_SEND_WECOM !== "0") {
    await sendWecomImage(outputPath);
    sentWecom = true;
  }

  for (const inputPath of inputPaths) console.log(`Input JSON: ${inputPath}`);
  console.log(`Saved image: ${outputPath}`);
  if (args.includes("--print") || args.includes("--print-wecom-markdown")) {
    console.log("Text preview:");
    console.log(buildTextPreview(rows));
  }
  if (sentWecom) console.log("Sent Enterprise WeChat shop funds image.");
}

await main();
