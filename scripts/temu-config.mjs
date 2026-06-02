import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function normalizeReportDate(value) {
  const normalized = String(value || "today").trim().toLowerCase();
  if (["today", "yesterday"].includes(normalized)) return normalized;
  throw new Error("TEMU_REPORT_DATE must be today or yesterday");
}

function normalizeProductSource(value) {
  const normalized = String(value || "dom").trim().toLowerCase();
  if (["dom", "api"].includes(normalized)) return normalized;
  throw new Error("TEMU_PRODUCT_SOURCE must be dom or api");
}

const reportDate = normalizeReportDate(process.env.TEMU_REPORT_DATE);
const reportDateLabels = {
  today: "今日",
  yesterday: "昨日",
};

export const config = {
  rootDir,
  profileDir: process.env.TEMU_PROFILE_DIR || path.join(rootDir, "temu-playwright-profile"),
  cdpProfileDir: process.env.TEMU_CDP_PROFILE_DIR || path.join(rootDir, "temu-chrome-cdp-profile"),
  cdpPort: Number(process.env.TEMU_CDP_PORT || 9222),
  reportDir: process.env.TEMU_REPORT_DIR || path.join(rootDir, "temu-reports"),
  wecomWebhookUrl: process.env.WECOM_WEBHOOK_URL || "",
  temuHomeUrl: process.env.TEMU_HOME_URL || "https://ads.temu.com/",
  temuReportUrl: process.env.TEMU_REPORT_URL || "https://ads.temu.com/data-report.html",
  targetRegion: process.env.TEMU_REGION || "欧区",
  reportDate,
  reportDateLabel: reportDateLabels[reportDate],
  productSource: normalizeProductSource(process.env.TEMU_PRODUCT_SOURCE),
  apiDomFallback: process.env.TEMU_API_DOM_FALLBACK !== "0",
  accountLabel: process.env.TEMU_ACCOUNT_LABEL || "",
  reportPrefix: process.env.TEMU_REPORT_PREFIX || "temu-eu-today",
  shopNames: (process.env.TEMU_SHOPS || "SETONR Products,SETONR Origin")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean),
  knownShopNames: (process.env.TEMU_KNOWN_SHOPS || "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean),
  sortMetric: process.env.TEMU_SORT_METRIC || "净申报价销售额（全店）",
};
