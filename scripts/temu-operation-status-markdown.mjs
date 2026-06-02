import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sendWecomMarkdownV2 } from "./wecom-send.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportDir = process.env.TEMU_REPORT_DIR || path.join(rootDir, "temu-reports");
const args = process.argv.slice(2);
const shopDisplayNames = {
  "Whitine Products Global": "Whitine Global",
  "LEEEV Global Outlet": "LEEEV Outlet",
};

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

function escapeMarkdownTableCell(value) {
  return String(value ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\|/g, "\\|")
    .trim() || "-";
}

function operationAbnormalSpuIds(shop) {
  const ids = Array.isArray(shop.newAbnormalSpuIds)
    ? shop.newAbnormalSpuIds
    : (shop.missingInSaleProducts || []).map((product) => product.spuId);
  return [...new Set(ids.map((id) => String(id || "").trim()).filter(Boolean))];
}

function shopDisplayName(shopName) {
  return shopDisplayNames[shopName] || shopName;
}

function collectRows(report) {
  const rows = [];
  for (const result of report.results || []) {
    if (!result.ok) {
      rows.push({
        shopName: result.account?.label || result.account?.id || "账号",
        inSaleSpuCount: "-",
        abnormalSpuIds: [],
        error: result.error || "检查失败",
      });
      continue;
    }

    for (const shop of result.shops || []) {
      const shopName = shop.shopName || "-";
      rows.push({
        shopName,
        displayShopName: shopDisplayName(shopName),
        inSaleSpuCount: String(shop.inSaleSpuCount || 0),
        abnormalSpuIds: operationAbnormalSpuIds(shop),
        error: "",
      });
    }
  }
  return rows;
}

function buildOperationStatusMarkdownV2(report) {
  const rows = collectRows(report);
  const lines = [
    "# 店铺运营状态",
    "",
  ];

  lines.push(
    "| 店铺 | 在售SPU数 |",
    "| :----- | :----: |",
  );

  for (const row of rows) {
    lines.push(
      `| ${escapeMarkdownTableCell(row.displayShopName || row.shopName)} | ${escapeMarkdownTableCell(row.error || row.inSaleSpuCount)} |`,
    );
  }

  if (rows.length === 0) {
    lines.push("| - | 0 |");
  }

  const abnormalRows = rows.flatMap((row) =>
    row.abnormalSpuIds.map((spuId) => ({
      shopName: row.shopName,
      displayShopName: row.displayShopName || row.shopName,
      spuId,
    })),
  );
  if (abnormalRows.length > 0) {
    lines.push("", "## 今日新增异常SPU", "", "| 店铺 | SPU ID |", "| :----- | :----- |");
    for (const row of abnormalRows) {
      lines.push(`| ${escapeMarkdownTableCell(row.displayShopName)} | ${escapeMarkdownTableCell(row.spuId)} |`);
    }
  }

  return lines.join("\n");
}

async function main() {
  const inputPath = path.resolve(getFlagValue("--input") || (await findLatestOperationStatusReport()));
  const report = JSON.parse(await fs.readFile(inputPath, "utf8"));
  const markdownV2 = buildOperationStatusMarkdownV2(report);

  let sentWecom = false;
  if (args.includes("--send-wecom") && process.env.TEMU_SEND_WECOM !== "0") {
    await sendWecomMarkdownV2(markdownV2);
    sentWecom = true;
  }

  console.log(`Input JSON: ${inputPath}`);
  if (args.includes("--print") || args.includes("--print-wecom-markdown")) {
    console.log("WeCom markdown_v2:");
    console.log(markdownV2);
  }
  if (sentWecom) console.log("Sent Enterprise WeChat operation status markdown.");
}

await main();
