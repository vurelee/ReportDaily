import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { sendWecomImage, sendWecomMarkdown } from "./wecom-send.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportDir = process.env.TEMU_REPORT_DIR || path.join(rootDir, "temu-reports");
const productImageDir = process.env.TEMU_PRODUCT_IMAGE_DIR || path.join(reportDir, "product-images");
const args = process.argv.slice(2);
const reportWidth = 780;
const productImageFetchTimeoutMs = positiveInteger(
  process.env.TEMU_PRODUCT_IMAGE_FETCH_TIMEOUT_MS,
  12000,
);
const productDetailLimit = positiveInteger(process.env.TEMU_PRODUCT_DETAIL_LIMIT, 5);

function getFlagValue(name) {
  const index = args.indexOf(name);
  return index === -1 ? "" : args[index + 1] || "";
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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

async function findLatestAbnormalReport() {
  const entries = await fs.readdir(reportDir);
  const matches = entries
    .filter((name) => /^temu-abnormal-orders-.+\.json$/.test(name))
    .map((name) => path.join(reportDir, name));

  const stats = await Promise.all(
    matches.map(async (filePath) => ({ filePath, stat: await fs.stat(filePath) })),
  );
  stats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  return stats[0]?.filePath || "";
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
  return stats[0]?.filePath || "";
}

function htmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function reportResults(report) {
  if (Array.isArray(report.results)) return report.results;
  if (Array.isArray(report.shops)) {
    return [
      {
        account: { label: report.accountLabel || "" },
        ok: report.ok !== false,
        partial: report.partial === true,
        report,
        error: "",
      },
    ];
  }
  return [];
}

function shopSummaryRow(shop) {
  const total = shop.total || shop.rows?.[0] || {};
  const amount = total.displaySales || total.netSales || total.sales || "￥0.00";
  const quantityValue = parseInteger(total.quantity);
  const amountValue = parseCurrency(amount);
  return {
    shop: shop.shopName,
    updateTime: shop.updateTime || "",
    quantity: String(quantityValue),
    quantityValue,
    amount: formatCurrency(amountValue),
    amountValue,
  };
}

function collectRows(report) {
  const rows = reportResults(report).flatMap((result) =>
    (result.report?.shops || []).map(shopSummaryRow),
  );

  if (rows.length === 0) {
    throw new Error("No shop summary rows found in report");
  }

  return rows;
}

function collectShopSections(report) {
  const sections = [];

  for (const result of reportResults(report)) {
    for (const shop of result.report?.shops || []) {
      const products = (shop.rows || [])
        .filter((row) => String(row.productId || "").trim())
        .map((row) => productRow(row))
        .filter((row) => row.amountValue > 0)
        .sort((a, b) => b.amountValue - a.amountValue)
        .slice(0, productDetailLimit);
      if (products.length > 0) {
        sections.push({ summary: shopMetricSummary(shop), products });
      }
    }
  }

  if (sections.length === 0) {
    throw new Error("No shop sections found in report");
  }

  return sections;
}

function shopMetricSummary(shop) {
  const total = shop.total || shop.rows?.[0] || {};
  const netQuantity = total.netQuantity || total.quantity || "0";
  const netSales = total.netSales || total.displaySales || total.sales || "￥0.00";
  return {
    shop: shop.shopName || "",
    totalCost: total.totalCost || "￥0.00",
    netQuantity,
    netSales,
    impressions: total.impressions || "0",
    ctr: total.ctr || "",
    cvr: total.cvr || "",
    quantityValue: parseInteger(netQuantity),
    amountValue: parseCurrency(netSales),
  };
}

function productRow(row) {
  const amount = row.displaySales || row.netSales || row.sales || "￥0.00";
  const quantityValue = parseInteger(row.quantity);
  const amountValue = parseCurrency(amount);
  return {
    productId: String(row.productId || ""),
    imageUrl: productImageUrl(row),
    totalCost: row.totalCost || "￥0.00",
    netQuantity: row.netQuantity || row.quantity || "0",
    netSales: row.netSales || row.displaySales || row.sales || "￥0.00",
    impressions: row.impressions || "0",
    ctr: row.ctr || "",
    cvr: row.cvr || "",
    quantityValue,
    amountValue,
  };
}

function productImageUrl(row) {
  return String(row.imageUrl || row.goodsImageUrl || row.raw?.goods_image_url || "").trim();
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

function imageExtensionFromUrl(imageUrl) {
  try {
    const ext = path.extname(new URL(imageUrl).pathname).toLowerCase();
    if ([".jpg", ".jpeg", ".png", ".webp"].includes(ext)) return ext;
  } catch {
    return ".jpg";
  }
  return ".jpg";
}

function imageMimeFromExtension(ext) {
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

async function cachedImageDataUri(imageUrl, cache = new Map()) {
  const url = String(imageUrl || "").trim();
  if (!/^https?:\/\//i.test(url)) return "";
  if (cache.has(url)) return cache.get(url);

  const ext = imageExtensionFromUrl(url);
  const digest = createHash("sha256").update(url).digest("hex").slice(0, 32);
  const imagePath = path.join(productImageDir, `${digest}${ext}`);

  try {
    await fs.access(imagePath);
  } catch {
    await fs.mkdir(productImageDir, { recursive: true });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), productImageFetchTimeoutMs);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari/537.36",
      },
    }).finally(() => clearTimeout(timeout));
    if (!response.ok) {
      cache.set(url, "");
      return "";
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(imagePath, buffer);
  }

  const buffer = await fs.readFile(imagePath);
  const dataUri = `data:${imageMimeFromExtension(ext)};base64,${buffer.toString("base64")}`;
  cache.set(url, dataUri);
  return dataUri;
}

async function attachProductImages(sections) {
  const cache = new Map();
  for (const section of sections) {
    for (const product of section.products) {
      product.imageDataUri = await cachedImageDataUri(product.imageUrl, cache);
    }
  }
  return sections;
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

function comparisonRowsByShop(currentRows, comparison) {
  if (!comparison) return new Map();

  const comparisonShopRows = comparison.rows.filter((row) => !row.isTotal);
  const comparisonMap = rowsByShop(comparisonShopRows);
  if (currentRows.every((row) => comparisonMap.has(row.shop))) {
    const totalQuantity = currentRows.reduce(
      (sum, row) => sum + comparisonMap.get(row.shop).quantityValue,
      0,
    );
    const totalAmount = currentRows.reduce(
      (sum, row) => sum + comparisonMap.get(row.shop).amountValue,
      0,
    );
    comparisonMap.set("合计", {
      shop: "合计",
      quantityValue: totalQuantity,
      amountValue: totalAmount,
      isTotal: true,
    });
  }

  return comparisonMap;
}

function latestUpdateDate(report) {
  const dates = reportResults(report)
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
  return `Temu 欧区${reportDateLabel(report)}汇总 ${latestUpdateTime(report)}`;
}

function buildImageTitleWithTime(report, inputPath) {
  return `欧区销量汇总 ${actualSalesDateTime(report, inputPath)}`;
}

function reportDateLabel(report) {
  if (report.reportDateLabel) return report.reportDateLabel;
  if (report.dateLabel) return report.dateLabel;

  const reportDate = report.reportDate || report.date;
  if (reportDate === "yesterday") return "昨日";
  return "今日";
}

function actualSalesDateTime(report, inputPath = "") {
  const baseDate = reportStartDate(report, inputPath) || latestUpdateDate(report);
  if (!baseDate) return formatShanghaiSecond(new Date());

  const offsetDays = isYesterdayReport(report) ? -1 : 0;
  const actualDate = new Date(baseDate.getTime() + offsetDays * 24 * 60 * 60 * 1000);
  return formatShanghaiSecond(actualDate);
}

function reportStartDate(report, inputPath = "") {
  return reportStartDateFromPath(inputPath) || reportGeneratedDate(report);
}

function reportStartDateFromPath(inputPath = "") {
  const filename = path.basename(String(inputPath || ""));
  const match = filename.match(
    /^temu-all-accounts-(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.json$/,
  );
  if (!match) return null;

  const [, dateHour, minute, second, millisecond] = match;
  const date = new Date(`${dateHour}:${minute}:${second}.${millisecond}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function reportGeneratedDate(report) {
  if (!report.generatedAt) return null;

  const date = new Date(report.generatedAt);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isYesterdayReport(report) {
  const reportDate = report.reportDate || report.date || "";
  return reportDate === "yesterday" || report.reportDateLabel === "昨日" || report.dateLabel === "昨日";
}

function buildWecomMarkdownTitle(report) {
  return `### ${buildTitle(report)}`;
}

function abnormalCountValue(shop) {
  const value = Number.parseInt(String(shop?.abnormalCount ?? "0"), 10);
  return Number.isFinite(value) ? value : 0;
}

function buildAbnormalMarkdown(abnormalReport) {
  if (!abnormalReport) return "";

  const warningLines = [];
  let checkedShopCount = 0;
  let positiveCount = 0;

  for (const result of abnormalReport.results || []) {
    if (!result.ok) {
      warningLines.push(
        `${result.account?.label || result.account?.id || "账号"} 出库单异常附加检查未完成，不影响销售汇总：${result.error || "未知错误"}`,
      );
      continue;
    }

    for (const shop of result.shops || []) {
      if (shop.hasPermission === false) {
        warningLines.push(`${shop.shopName} 无权限访问出库单异常页。`);
        continue;
      }

      checkedShopCount += 1;
      const count = abnormalCountValue(shop);
      if (count > 0) {
        positiveCount += count;
        warningLines.push(`${shop.shopName} 出库单异常<font color="warning">${count}</font>条。`);
      }
    }
  }

  if (warningLines.length === 0 && checkedShopCount > 0 && positiveCount === 0) {
    return "今日出库单异常0条。";
  }

  return warningLines.join("\n");
}

async function loadAbnormalReport() {
  if (!args.includes("--include-abnormal")) return null;

  const selectedPath = getFlagValue("--abnormal-input") || (await findLatestAbnormalReport());
  if (!selectedPath) return null;

  const inputPath = path.resolve(selectedPath);
  return JSON.parse(await fs.readFile(inputPath, "utf8"));
}

async function loadOperationStatusReport() {
  if (!args.includes("--include-operation-status")) return null;

  const selectedPath = getFlagValue("--operation-status-input") || (await findLatestOperationStatusReport());
  if (!selectedPath) return null;

  const inputPath = path.resolve(selectedPath);
  return JSON.parse(await fs.readFile(inputPath, "utf8"));
}

function operationAbnormalSpuIds(shop) {
  const ids = Array.isArray(shop.newAbnormalSpuIds)
    ? shop.newAbnormalSpuIds
    : (shop.missingInSaleProducts || []).map((product) => product.spuId);
  return [...new Set(ids.map((id) => String(id || "").trim()).filter(Boolean))];
}

function operationAbnormalSpuMarkdown(shop) {
  const ids = operationAbnormalSpuIds(shop);
  if (ids.length === 0) return "-";
  return `<font color="warning">${ids.join("、")}</font>`;
}

function buildOperationStatusMarkdown(operationReport) {
  if (!operationReport) return "";

  const rows = [];
  for (const result of operationReport.results || []) {
    if (!result.ok) {
      rows.push(
        `${result.account?.label || result.account?.id || "账号"} / - / <font color="warning">检查失败：${result.error || "未知错误"}</font>`,
      );
      continue;
    }

    for (const shop of result.shops || []) {
      rows.push(
        `${shop.shopName} / ${shop.inSaleSpuCount || 0} / ${operationAbnormalSpuMarkdown(shop)}`,
      );
    }
  }

  const body = rows.length > 0 ? rows.join("\n") : "暂无巡店结果";
  return `### 店铺运营状态\n\n**店铺 / 在售SPU数 / 新增异常SPU**\n${body}`;
}

function buildWecomMarkdown(report, abnormalReport, operationReport) {
  return [
    buildWecomMarkdownTitle(report),
    buildPartialReportMarkdown(report),
    buildAbnormalMarkdown(abnormalReport),
    buildOperationStatusMarkdown(operationReport),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildPartialReportMarkdown(report) {
  const lines = [];
  for (const result of reportResults(report)) {
    if (result.partial) {
      lines.push(`${result.account?.label || result.account?.id || "账号"} 部分店铺采集失败，已发送成功店铺数据。`);
    } else if (!result.ok) {
      lines.push(`${result.account?.label || result.account?.id || "账号"} 采集失败：${result.error || "未知错误"}`);
    }

    for (const failure of result.report?.failures || []) {
      lines.push(`${failure.shopName} 采集失败：${failure.error || "未知错误"}`);
    }
  }

  return lines.join("\n");
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
    second: "2-digit",
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

function formatShanghaiSecond(date) {
  const value = formatShanghaiParts(date);
  return `${value.year}-${value.month}-${value.day} ${value.hour}:${value.minute}:${value.second}`;
}

function formatShanghaiTime(date) {
  const value = formatShanghaiParts(date);
  return `${value.hour}:${value.minute}:${value.second}`;
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

  const currentReportDate = report.reportDate || report.date || "";
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

    const candidateReportDate = candidateReport.reportDate || candidateReport.date || "";
    const reportDateRank = !currentReportDate
      ? 0
      : candidateReportDate === currentReportDate
        ? 0
        : candidateReportDate
          ? 2
          : 1;

    candidates.push({
      inputPath: candidatePath,
      report: candidateReport,
      rows: candidateRows,
      updateTime: formatShanghaiMinute(candidateDate),
      distanceMs: Math.abs(candidateDate.getTime() - targetDate.getTime()),
      reportDateRank,
    });
  }

  candidates.sort((a, b) => a.reportDateRank - b.reportDateRank || a.distanceMs - b.distanceMs);
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

function comparisonSubtitle(comparison, report, inputPath) {
  const comparisonDate = comparison
    ? reportStartDate(comparison.report, comparison.inputPath) || latestUpdateDate(comparison.report)
    : reportStartDate(report, inputPath);
  return `对比日期：上一日 ${comparisonDate ? formatShanghaiTime(comparisonDate) : "--:--:--"}`;
}

function buildHtml(sections, rows, report, comparison, inputPath) {
  const displayRows = appendTotalRow(rows);
  const grandTotal = displayRows.find((row) => row.isTotal);
  const comparisonRows = comparisonRowsByShop(rows, comparison);
  const comparisonText = comparisonSubtitle(comparison, report, inputPath);

  const grandPrevious = grandTotal ? comparisonRows.get(grandTotal.shop) : null;
  const grandTotalHtml = grandTotal
    ? `
      <div class="grand-total">
        <div class="total-card">
          <div class="total-label">总件数（合计）</div>
          <div class="total-line">
            <div class="total-value">${htmlEscape(grandTotal.quantity)}</div>
            ${deltaHtml(percentChange(grandTotal.quantityValue, grandPrevious?.quantityValue))}
          </div>
        </div>
        <div class="total-card">
          <div class="total-label">总销售额（合计）</div>
          <div class="total-line">
            <div class="total-value">${htmlEscape(grandTotal.amount)}</div>
            ${deltaHtml(percentChange(grandTotal.amountValue, grandPrevious?.amountValue))}
          </div>
        </div>
      </div>`
    : "";

  const productTableHtml = `
    <div class="product-table">
      <div class="product-header">
        <div>商品图</div>
        <div>总花费</div>
        <div>净件数</div>
        <div>净销售额</div>
        <div>曝光量</div>
        <div>点击率</div>
        <div>转化率</div>
      </div>
      <div class="products">${sections.map((section) => shopSectionHtml(section, comparisonRows)).join("")}</div>
    </div>`;

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
          .grand-total {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 16px;
            padding: 18px 20px;
            background: #fff;
            border-bottom: 1px solid #e8ebf0;
          }
          .total-card {
            min-height: 118px;
            padding: 20px 22px;
            border: 1px solid #dfe6ef;
            border-radius: 8px;
            background: #f8fafc;
            overflow: hidden;
          }
          .total-label {
            color: #667085;
            font-size: 17px;
            line-height: 22px;
            font-weight: 760;
            white-space: nowrap;
          }
          .total-line {
            display: flex;
            flex-wrap: nowrap;
            align-items: flex-end;
            gap: 8px;
            margin-top: 26px;
            min-width: 0;
          }
          .total-value {
            color: #101828;
            font-size: 32px;
            line-height: 36px;
            font-weight: 900;
            white-space: nowrap;
            max-width: 100%;
          }
          .total-card .delta {
            flex: 0 0 auto;
            margin-top: 0;
            padding: 4px 7px;
            font-size: 14px;
            line-height: 17px;
          }
          .shop-section {
            border-bottom: 1px solid #e8ebf0;
          }
          .shop-section:last-child {
            border-bottom: none;
          }
          .delta {
            display: inline-flex;
            align-items: center;
            justify-content: flex-end;
            gap: 5px;
            padding: 5px 8px;
            border-radius: 6px;
            font-size: 16px;
            line-height: 19px;
            font-weight: 820;
            white-space: nowrap;
          }
          .delta .arrow {
            font-size: 10px;
            line-height: 12px;
            transform: translateY(-1px);
          }
          .delta.up {
            color: #13a538;
            background: #e8f7ed;
          }
          .delta.down {
            color: #f04438;
            background: #fee4e2;
          }
          .delta.flat {
            color: #89909b;
            background: #eef1f5;
          }
          .product-table {
            border-top: 1px solid #e8ebf0;
          }
          .product-header,
          .product-row,
          .shop-subtotal {
            display: grid;
            grid-template-columns: repeat(7, minmax(0, 1fr));
            column-gap: 0;
            align-items: center;
          }
          .product-header > div,
          .product-row > div,
          .shop-subtotal > div {
            min-width: 0;
            padding: 0 6px;
          }
          .product-header {
            min-height: 38px;
            padding: 0 14px;
            background: #f7f8fa;
            border-bottom: 1px solid #eceef2;
            color: #59616c;
            font-size: 13px;
            line-height: 16px;
            font-weight: 780;
          }
          .product-header div:nth-child(n + 2) {
            text-align: right;
          }
          .shop-subtotal {
            min-height: 62px;
            padding: 8px 14px;
            background: #e8edf4;
            border-bottom: 1px solid #d3dbe6;
            border-top: 1px solid #d9e1eb;
          }
          .subtotal-shop {
            grid-column: 1 / span 2;
            color: #171a1f;
            font-size: 15px;
            line-height: 18px;
            font-weight: 850;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
          }
          .product-row {
            min-height: 54px;
            padding: 6px 14px;
            border-bottom: 1px solid #f0f2f5;
          }
          .product-row:last-child {
            border-bottom: none;
          }
          .thumb,
          .thumb-placeholder {
            width: 42px;
            height: 42px;
            border: 1px solid #e5e8ee;
            background: #f4f6f8;
          }
          .thumb {
            object-fit: cover;
          }
          .thumb-placeholder {
            display: flex;
            align-items: center;
            justify-content: center;
            color: #a0a7b2;
            font-size: 12px;
            font-weight: 700;
          }
          .metric-cell {
            text-align: right;
            color: #202328;
            font-size: 14px;
            line-height: 17px;
            font-weight: 780;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
          }
          .shop-subtotal .metric-cell {
            font-size: 14px;
            font-weight: 900;
            overflow: visible;
          }
          .metric-main {
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
          }
          .shop-subtotal .delta {
            margin-top: 4px;
            padding: 0;
            border-radius: 0;
            background: transparent;
            font-size: 11px;
            line-height: 14px;
            font-weight: 850;
          }
        </style>
      </head>
      <body>
        <div class="report">
          <div class="header">
            <div class="title">${htmlEscape(buildImageTitleWithTime(report, inputPath))}</div>
            <div class="sub">${htmlEscape(comparisonText)}</div>
          </div>
          ${grandTotalHtml}
          ${productTableHtml}
        </div>
      </body>
    </html>`;
}

function shopSectionHtml(section, comparisonRows = new Map()) {
  const summary = section.summary;
  const previous = comparisonRows.get(summary.shop);
  return `
    <section class="shop-section">
      <div class="shop-subtotal">
        <div class="subtotal-shop">${htmlEscape(summary.shop)}</div>
        <div class="metric-cell">
          <div class="metric-main">${htmlEscape(summary.netQuantity)}</div>
          ${deltaHtml(percentChange(summary.quantityValue, previous?.quantityValue))}
        </div>
        <div class="metric-cell">
          <div class="metric-main">${htmlEscape(summary.netSales)}</div>
          ${deltaHtml(percentChange(summary.amountValue, previous?.amountValue))}
        </div>
      </div>
      ${section.products.map(productHtml).join("")}
    </section>`;
}

function productHtml(product) {
  const imageHtml = product.imageDataUri
    ? `<img class="thumb" src="${htmlEscape(product.imageDataUri)}" />`
    : `<div class="thumb-placeholder">图</div>`;

  return `
    <div class="product-row">
      <div>${imageHtml}</div>
      <div class="metric-cell">${htmlEscape(product.totalCost)}</div>
      <div class="metric-cell">${htmlEscape(product.netQuantity)}</div>
      <div class="metric-cell">${htmlEscape(product.netSales)}</div>
      <div class="metric-cell">${htmlEscape(product.impressions)}</div>
      <div class="metric-cell">${htmlEscape(product.ctr)}</div>
      <div class="metric-cell">${htmlEscape(product.cvr)}</div>
    </div>`;
}

async function main() {
  if (args.includes("--send")) {
    throw new Error("Unsupported flag --send; use --send-wecom for Enterprise WeChat webhook delivery");
  }

  const inputPath = path.resolve(getFlagValue("--input") || (await findLatestCombinedReport()));
  const report = JSON.parse(await fs.readFile(inputPath, "utf8"));
  const abnormalReport = await loadAbnormalReport();
  const operationStatusReport = await loadOperationStatusReport();
  const rows = collectRows(report);
  const sections = await attachProductImages(collectShopSections(report));
  const comparison = await findComparisonReport(inputPath, report);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputPath =
    getFlagValue("--output") || path.join(reportDir, `temu-summary-${stamp}.png`);
  const productCount = sections.reduce((sum, section) => sum + section.products.length, 0);

  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({
      viewport: { width: reportWidth + 40, height: 270 + sections.length * 64 + productCount * 56 },
      deviceScaleFactor: 1,
    });
    await page.setContent(buildHtml(sections, rows, report, comparison, inputPath), { waitUntil: "load" });
    await page.locator(".report").screenshot({ path: outputPath });
  } finally {
    await browser.close();
  }

  const sendErrors = [];
  let sentWecom = false;
  if (args.includes("--send-wecom") && process.env.TEMU_SEND_WECOM !== "0") {
    try {
      await sendWecomMarkdown(buildWecomMarkdown(report, abnormalReport, operationStatusReport));
      await sendWecomImage(outputPath);
      sentWecom = true;
    } catch (error) {
      sendErrors.push(
        `Enterprise WeChat: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  console.log(`Input JSON: ${inputPath}`);
  if (abnormalReport) console.log(`Abnormal JSON: ${path.resolve(getFlagValue("--abnormal-input") || (await findLatestAbnormalReport()))}`);
  if (operationStatusReport) console.log(`Operation status JSON: ${path.resolve(getFlagValue("--operation-status-input") || (await findLatestOperationStatusReport()))}`);
  if (comparison) console.log(`Comparison JSON: ${comparison.inputPath}`);
  else console.log("Comparison JSON: none");
  console.log(`Saved image: ${outputPath}`);
  if (args.includes("--print-wecom-markdown")) {
    console.log("WeCom markdown:");
    console.log(buildWecomMarkdown(report, abnormalReport, operationStatusReport));
  }
  if (sentWecom) console.log("Sent Enterprise WeChat markdown title and image.");

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
