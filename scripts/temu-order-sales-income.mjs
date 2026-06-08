import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeCdpChromeProcess, closeCdpPages } from "./cdp-page-cleanup.mjs";
import { connectCdpChrome } from "./chrome-cdp.mjs";
import {
  enterAgentAuthenticationIfShown,
  loginSellerIfNeeded,
} from "./temu-login-helper.mjs";
import { temuPageApiPost, temuPageRequest } from "./temu-page-api-client.mjs";
import { extractMallList, resolveMallByExactName } from "./temu-mall-resolver.mjs";
import { closeTemuPopups } from "./temu-popup-cleaner.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const accountsPath = process.env.TEMU_ACCOUNTS_CONFIG || path.join(rootDir, "temu-accounts.json");
const reportDir = process.env.TEMU_REPORT_DIR || path.join(rootDir, "temu-reports");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

const ORDER_TARGET_PATH = "/mmsos/orders.html";
const ORDER_REGIONS = parseOrderRegions();
let activeOrderRegion = ORDER_REGIONS[0];
const RECENT_ORDER_LIST_ENDPOINT = "/kirogi/bg/mms/recentOrderList?is_back=1";
const ORDER_DETAIL_ENDPOINT = "/mmsos/order-detail.html";
const MALL_DETAIL_ENDPOINT = "/api/v1/coconut/mall/query_mall_detail";
const MALL_LIST_ENDPOINTS = ["/bg/quiet/api/mms/userInfo", "/api/seller/auth/userInfo"];
const ORDER_LIST_PAGE_SIZE = parsePositiveInteger(process.env.TEMU_ORDER_SALES_PAGE_SIZE, 500);
const ORDER_LIMIT = parsePositiveInteger(process.env.TEMU_ORDER_SALES_LIMIT, 5);
const ORDER_LIMIT_PER_SHOP = parsePositiveInteger(process.env.TEMU_ORDER_SALES_LIMIT_PER_SHOP, 0);
const ORDER_FULFILLMENT_MODE = parseOptionalInteger(process.env.TEMU_ORDER_SALES_FULFILLMENT_MODE);
const MAX_LIST_PAGES = parsePositiveInteger(process.env.TEMU_ORDER_SALES_MAX_LIST_PAGES, 20);
const MAX_DETAIL_ATTEMPTS = parsePositiveInteger(process.env.TEMU_ORDER_SALES_MAX_DETAIL_ATTEMPTS, 80);
const REQUESTED_DETAIL_CONCURRENCY = parsePositiveInteger(process.env.TEMU_ORDER_SALES_DETAIL_CONCURRENCY, 1);
const DETAIL_HARD_CONCURRENCY_CAP = 4;
const DETAIL_CONCURRENCY_CAP = Math.min(
  parsePositiveInteger(process.env.TEMU_ORDER_SALES_DETAIL_CONCURRENCY_CAP, DETAIL_HARD_CONCURRENCY_CAP),
  DETAIL_HARD_CONCURRENCY_CAP,
);
const DETAIL_CONCURRENCY = Math.min(REQUESTED_DETAIL_CONCURRENCY, DETAIL_CONCURRENCY_CAP);
const DETAIL_TIMEOUT_MS = parsePositiveInteger(process.env.TEMU_ORDER_SALES_DETAIL_TIMEOUT_MS, 10000);
const API_TIMEOUT_MS = parsePositiveInteger(process.env.TEMU_ORDER_SALES_API_TIMEOUT_MS, 15000);
const DETAIL_PROGRESS_EVERY = parsePositiveInteger(process.env.TEMU_ORDER_SALES_PROGRESS_EVERY, 25);
const DOM_SWITCH_ENABLED = process.env.TEMU_ORDER_SALES_DOM_SWITCH !== "0";
const TIME_ZONE = "UTC+8";
const ORDER_STATUS_ALL = 0;
const ORDER_TYPE_ALL = "ALL";
const SHIPPED_RE = /已发货|已签收|已送达|已完成|待收货|shipped|delivered|completed/i;
const UNSHIPPED_RE = /待发货|未发货|待履约|待处理|pending|unshipped/i;

const INCOME_FIELDS = [
  { key: "salesRepayment", detailType: "sales_repayment", label: "销售回款", rawKeys: [/sales.*repayment/i] },
  { key: "orderPayment", detailType: "order_payment", label: "订单货款", rawKeys: [/order.*payment/i, /orderAmountResult/i, /originalSupplierTotalAmount/i] },
  { key: "secondaryCharge", detailType: "secondary_charge", label: "二次收费", aliases: ["二次收款"], rawKeys: [/secondary.*charge/i] },
  { key: "salesChargeback", detailType: "sales_chargeback", label: "销售冲回", rawKeys: [/sales.*chargeback/i] },
  { key: "shippingRepayment", detailType: "shipping_repayment", label: "运费回款", rawKeys: [/shipping.*repayment/i] },
  { key: "shippingChargeback", detailType: "shipping_chargeback", label: "运费冲回", rawKeys: [/shipping.*chargeback/i] },
  { key: "estimatedIncome", detailType: "estimated_income", label: "预计收入", aliases: ["实际收入"], rawKeys: [/estimated.*income/i, /estimatedSettlementAmount/i] },
];
const INCOME_LABELS = INCOME_FIELDS.flatMap((field) => [field.label, ...(field.aliases || [])]);
const MONEY_REGEX = /[-−]?\s*(?:CNY|USD|EUR|GBP|JPY|HKD|AUD|CAD|RMB)?\s*(?:[¥￥$€£])?\s*[\d,]+(?:\.\d+)?/g;

await fs.mkdir(reportDir, { recursive: true });

class TemuOrderSalesIncomeError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "TemuOrderSalesIncomeError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new TemuOrderSalesIncomeError(code, message);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseOrderRegions() {
  const originOverride = String(process.env.TEMU_ORDER_SALES_ORIGIN || "").trim().replace(/\/+$/, "");
  if (originOverride) {
    return [{ code: "custom", label: "自定义区域", origin: originOverride }];
  }

  const known = {
    eu: { code: "eu", label: "欧区", origin: "https://agentseller-eu.temu.com" },
    us: { code: "us", label: "美区", origin: "https://agentseller-us.temu.com" },
  };
  const requested = String(process.env.TEMU_ORDER_SALES_REGIONS || "eu,us")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const regions = requested.map((code) => {
    const region = known[code];
    if (!region) throw new Error(`不支持的订单收入区域：${code}；支持 eu,us`);
    return region;
  });
  return regions.length > 0 ? regions : [known.eu, known.us];
}

function orderOrigin() {
  return activeOrderRegion.origin;
}

function targetUrlFor(region = activeOrderRegion) {
  return process.env.TEMU_ORDER_SALES_URL || `${region.origin}${ORDER_TARGET_PATH}`;
}

function parseOptionalInteger(value) {
  const text = String(value ?? "").trim();
  if (!text || /^all|omit|null$/i.test(text)) return null;
  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function selectedAccountIds() {
  return String(process.env.TEMU_ACCOUNT_ID || process.env.TEMU_ACCOUNT_IDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function shopListForAccount(account) {
  const override = String(process.env.TEMU_ORDER_SALES_SHOPS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return override.length > 0 ? override : account.shops || [];
}

function shanghaiTodayKey() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function dateRangeFromEnv() {
  const singleDate = String(process.env.TEMU_ORDER_SALES_DATE || "").trim();
  const startDate = String(process.env.TEMU_ORDER_SALES_START || singleDate || shanghaiTodayKey()).trim();
  const endDate = String(process.env.TEMU_ORDER_SALES_END || singleDate || startDate).trim();
  return { startDate, endDate };
}

function parseDateKey(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) fail("INVALID_DATE", `日期必须是 YYYY-MM-DD：${value}`);
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

function unixStartOfShanghaiDay(value) {
  const { year, month, day } = parseDateKey(value);
  return Math.floor(Date.UTC(year, month - 1, day, -8, 0, 0) / 1000);
}

function unixEndOfShanghaiDay(value) {
  const { year, month, day } = parseDateKey(value);
  return Math.floor(Date.UTC(year, month - 1, day + 1, -8, 0, -1) / 1000);
}

function isOrdersPage(page) {
  if (!page || page.isClosed()) return false;
  try {
    const url = new URL(page.url());
    const target = new URL(targetUrlFor());
    return url.origin === target.origin && url.pathname === target.pathname;
  } catch {
    return false;
  }
}

function preferredOrdersPage(context, fallbackPage) {
  const pages = [...context.pages()].reverse().filter((candidate) => !candidate.isClosed());
  return (
    pages.find(isOrdersPage) ||
    pages.find((candidate) => candidate.url().startsWith(orderOrigin()) && !candidate.url().includes("/auth/authentication")) ||
    pages.find((candidate) => candidate.url().startsWith("https://seller.kuajingmaihuo.com/")) ||
    pages.find((candidate) => candidate.url().startsWith(orderOrigin())) ||
    (fallbackPage && !fallbackPage.isClosed() ? fallbackPage : pages[0])
  );
}

async function bodyText(page, timeout = 10000) {
  return await page.locator("body").innerText({ timeout }).catch(() => "");
}

async function waitSettled(page) {
  if (!page || page.isClosed()) return;
  await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
  if (page.isClosed()) return;
  await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
  if (page.isClosed()) return;
  await page.waitForTimeout(700).catch(() => {});
}

async function ensureOrdersPage(context, page) {
  let activePage = page && !page.isClosed() ? page : await context.newPage();
  await activePage.goto(targetUrlFor(), { waitUntil: "domcontentloaded" }).catch(() => {});
  await waitSettled(activePage);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    activePage = preferredOrdersPage(context, activePage);
    await activePage.bringToFront().catch(() => {});
    await waitSettled(activePage);
    await closeTemuPopups(activePage).catch(() => {});

    if (isOrdersPage(activePage)) return activePage;

    const authenticatedPage = await enterAgentAuthenticationIfShown(context, activePage);
    if (authenticatedPage) {
      activePage = preferredOrdersPage(context, authenticatedPage);
      await waitSettled(activePage);
      continue;
    }

    activePage = (await loginSellerIfNeeded(context, activePage, { fail })) || activePage;
    activePage = preferredOrdersPage(context, activePage);
    await waitSettled(activePage);

    if (isOrdersPage(activePage)) return activePage;

    const text = await bodyText(activePage).catch(() => "");
    if (activePage.url().startsWith(orderOrigin()) || activePage.url().startsWith("https://seller.kuajingmaihuo.com/") || text.includes("TEMU Agent Center")) {
      await activePage.goto(targetUrlFor(), { waitUntil: "domcontentloaded" }).catch(() => {});
      await waitSettled(activePage);
    }
  }

  fail("ORDER_PAGE_NOT_READY", `完成登录/授权后仍未进入订单页：${targetUrlFor()}`);
}

function apiFailureMessage(body) {
  return body?.errorMsg || body?.error_msg || body?.message || "";
}

function assertApiBody(response, label) {
  if (!response?.ok) {
    fail("API_HTTP_FAILED", `${label} HTTP ${response?.status || "unknown"}：${(response?.bodyText || "").slice(0, 1000)}`);
  }

  const body = response.json;
  if (!body || typeof body !== "object") {
    fail("API_RESPONSE_NOT_JSON", `${label} 返回非 JSON：${(response.bodyText || "").slice(0, 1000)}`);
  }

  const errorCode = body.errorCode ?? body.error_code;
  const numericErrorCode = Number(errorCode);
  const successErrorCodes = new Set([0, 1000000]);
  if (body.success === false || (errorCode !== undefined && !successErrorCodes.has(numericErrorCode))) {
    fail("API_RESPONSE_FAILED", `${label} 返回失败：code=${errorCode ?? "unknown"} msg=${apiFailureMessage(body) || "unknown"}`);
  }

  return body;
}

async function orderApiBody(page, endpoint, body = {}, { mallId, label } = {}) {
  const response = await temuPageApiPost(page, {
    origin: orderOrigin(),
    endpoint,
    body,
    mallId,
    label,
    timeoutMs: API_TIMEOUT_MS,
  });
  return assertApiBody(response, label || endpoint);
}

async function orderApiResult(page, endpoint, body = {}, options = {}) {
  return (await orderApiBody(page, endpoint, body, options)).result || {};
}

async function orderMallList(page) {
  const errors = [];
  for (const endpoint of MALL_LIST_ENDPOINTS) {
    try {
      const body = await orderApiBody(page, endpoint, {}, { label: `店铺列表接口 ${endpoint}` });
      const malls = extractMallList(body);
      if (Array.isArray(malls) && malls.length > 0) {
        return { endpoint, malls };
      }
      errors.push(`${endpoint}: empty`);
    } catch (error) {
      errors.push(errorMessage(error));
    }
  }
  fail("API_MALL_LIST_EMPTY", `订单页店铺列表接口没有返回可切换店铺：${errors.join("；")}`);
}

function mallInfoForShop(malls, shopName) {
  try {
    const resolved = resolveMallByExactName(malls, shopName);
    return {
      mallId: resolved.mallId,
      mallName: resolved.mallName,
      raw: resolved.raw,
    };
  } catch (error) {
    const message = errorMessage(error);
    if (message.includes("缺少 mallId")) fail("SHOP_MALL_ID_MISSING", message);
    fail("SHOP_TARGET_NOT_FOUND", message);
  }
}

async function verifyMallScopeByApi(page, shopName, mallInfo) {
  try {
    const result = await orderApiResult(
      page,
      MALL_DETAIL_ENDPOINT,
      {},
      { mallId: mallInfo.mallId, label: `${shopName} 当前店铺详情接口` },
    );
    const currentMallId = String(result.mall_id || result.mallId || result.mall?.mall_id || result.mall?.mallId || "");
    if (currentMallId && currentMallId !== mallInfo.mallId) {
      fail("SHOP_MALL_SCOPE_MISMATCH", `${shopName} mallId 校验失败；期望=${mallInfo.mallId}，实际=${currentMallId}`);
    }
    return {
      source: "mallid-header",
      endpoint: `${orderOrigin()}${MALL_DETAIL_ENDPOINT}`,
      mallId: mallInfo.mallId,
      currentMallId,
    };
  } catch (error) {
    return {
      source: "mallid-header",
      endpoint: `${orderOrigin()}${MALL_DETAIL_ENDPOINT}`,
      mallId: mallInfo.mallId,
      currentMallId: "",
      verificationError: errorMessage(error),
    };
  }
}

function disambiguateExactShopMatches(candidates) {
  const unique = [...new Set(candidates.filter(Boolean))];
  if (unique.length <= 1) return unique[0] || "";
  const longest = [...unique].sort((a, b) => b.length - a.length)[0];
  return unique.every((name) => name === longest || longest.includes(name)) ? longest : "";
}

async function currentShopName(page, knownShops) {
  const names = await page.evaluate((knownShops) => {
    const visibleText = (node) => (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
    const shopLabelText = (text) => String(text || "").replace(/\s+/g, " ").trim().replace(/\s*(半托管|全托管)\s*$/, "");
    const isVisible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const visibleNodes = Array.from(document.querySelectorAll("*")).filter(isVisible);
    const currentRow = visibleNodes
      .map(visibleText)
      .find((text) => /(当前登录店铺|当前店铺)/.test(text));
    if (currentRow) {
      const current = knownShops.find((shopName) => currentRow.includes(shopName));
      if (current) return [current];
    }
    const exactMatches = knownShops.filter((shopName) => visibleNodes.some((node) => visibleText(node) === shopName));
    if (exactMatches.length > 0) return exactMatches;
    return knownShops.filter((shopName) =>
      visibleNodes.some((node) => shopLabelText(visibleText(node)) === shopName),
    );
  }, knownShops);
  return disambiguateExactShopMatches(names);
}

async function isShopSwitcherOpen(page, knownShops) {
  return await page.evaluate((knownShops) => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const isVisible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const visibleTexts = Array.from(document.querySelectorAll("*"))
      .filter(isVisible)
      .map((node) => clean(node.innerText || node.textContent || ""));
    const visibleCount = knownShops.filter((name) =>
      visibleTexts.some((text) => text === name || text.replace(/\s*(半托管|全托管)\s*$/, "") === name),
    ).length;
    const hasSwitcherTitle = visibleTexts.some((text) => text === "切换店铺" || text.startsWith("切换店铺 "));
    return hasSwitcherTitle || visibleCount >= 2;
  }, knownShops).catch(() => false);
}

async function clickCdpPoint(page, x, y) {
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
    await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  } finally {
    await client.detach().catch(() => {});
  }
  await page.waitForTimeout(300).catch(() => {});
}

async function clickVisibleTextPoint(page, targetText) {
  const point = await page.evaluate((targetText) => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const shopLabelText = (value) => clean(value).replace(/\s*(半托管|全托管)\s*$/, "");
    const isVisible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const candidates = Array.from(document.querySelectorAll("button, a, div, span"))
      .filter(isVisible)
      .map((node) => ({ text: clean(node.innerText || node.textContent || ""), rect: node.getBoundingClientRect() }))
      .filter(({ text, rect }) => rect.width <= 360 && rect.height <= 100 && (text === targetText || shopLabelText(text) === targetText))
      .sort((a, b) => a.rect.top - b.rect.top || b.rect.right - a.rect.right || a.rect.width * a.rect.height - b.rect.width * b.rect.height);
    const match = candidates[0];
    return match ? { x: match.rect.x + match.rect.width / 2, y: match.rect.y + match.rect.height / 2 } : null;
  }, targetText);
  if (!point) return false;
  await clickCdpPoint(page, point.x, point.y);
  return true;
}

async function openShopSwitcher(page, knownShops) {
  if (await isShopSwitcherOpen(page, knownShops)) return;
  await closeTemuPopups(page);
  const current = await currentShopName(page, knownShops);
  if (!current) fail("SHOP_CURRENT_UNKNOWN", "无法识别当前店铺");

  if (!(await clickVisibleTextPoint(page, current))) {
    await page.getByText(current, { exact: true }).last().click({ timeout: 8000 });
  }
  await page.waitForTimeout(500);
  if (!(await clickVisibleTextPoint(page, "切换"))) {
    await page.getByText("切换", { exact: true }).last().click({ timeout: 8000 });
  }

  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await isShopSwitcherOpen(page, knownShops)) return;
    await page.waitForTimeout(300);
  }
  fail("SHOP_SWITCHER_NOT_OPEN", "店铺切换面板未打开");
}

async function clickShopSwitchButton(page, shopName) {
  const clickPoint = await page.evaluate((shopName) => {
    const normalizedText = (node) => (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
    const shopLabelText = (node) => normalizedText(node).replace(/\s*(半托管|全托管)\s*$/, "");
    const isVisible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const center = (rect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
    const switchButtonCandidates = () =>
      Array.from(document.querySelectorAll("button, div, span, a"))
        .map((node) => ({ node, text: normalizedText(node), rect: node.getBoundingClientRect() }))
        .filter(({ text, rect, node }) => isVisible(node) && /^切换\s*[>›»]?$/.test(text) && rect.width > 0 && rect.height > 0);
    const labelNodes = Array.from(document.querySelectorAll("*"))
      .filter((node) => isVisible(node) && shopLabelText(node) === shopName)
      .sort((a, b) => {
        const aRect = a.getBoundingClientRect();
        const bRect = b.getBoundingClientRect();
        return aRect.width * aRect.height - bRect.width * bRect.height;
      });
    for (const labelNode of labelNodes) {
      labelNode.scrollIntoView({ block: "center", inline: "nearest" });
      const labelRect = labelNode.getBoundingClientRect();
      const labelCenter = center(labelRect);
      const button = switchButtonCandidates()
        .filter(({ rect }) => Math.abs(center(rect).y - labelCenter.y) <= Math.max(56, labelRect.height * 1.5) && rect.left > labelRect.right)
        .sort((a, b) => a.rect.left - b.rect.left)[0];
      if (button) return center(button.rect);
    }
    return null;
  }, shopName);
  if (!clickPoint) return false;
  await clickCdpPoint(page, clickPoint.x, clickPoint.y);
  return true;
}

async function switchShopByDom(context, page, shopName, knownShops) {
  let activePage = page;
  const current = await currentShopName(activePage, knownShops);
  if (current !== shopName) {
    await openShopSwitcher(activePage, knownShops);
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      if (await clickShopSwitchButton(activePage, shopName)) break;
      await page.waitForTimeout(1500);
    }
    await waitSettled(activePage);
  }
  await activePage.goto(targetUrlFor(), { waitUntil: "domcontentloaded" }).catch(() => {});
  await waitSettled(activePage);
  activePage = await ensureOrdersPage(context, activePage);
  const after = await currentShopName(activePage, knownShops);
  if (after !== shopName) {
    fail("SHOP_SWITCH_VERIFY_FAILED", `切换后店铺不匹配；目标=${shopName}，当前=${after || "unknown"}`);
  }
  return activePage;
}

function orderListRequest(pageNumber, dateRange) {
  const request = {
    pageNumber,
    pageSize: ORDER_LIST_PAGE_SIZE,
    parentOrderTimeStart: unixStartOfShanghaiDay(dateRange.startDate),
    parentOrderTimeEnd: unixEndOfShanghaiDay(dateRange.endDate),
    queryType: ORDER_STATUS_ALL,
    sortType: 1,
    timeZone: TIME_ZONE,
    sellerNoteLabelList: [],
  };
  if (ORDER_FULFILLMENT_MODE !== null) request.fulfillmentMode = ORDER_FULFILLMENT_MODE;
  return request;
}

async function queryRecentOrderList(page, mallId, pageNumber, dateRange) {
  const request = orderListRequest(pageNumber, dateRange);
  const result = await orderApiResult(
    page,
    RECENT_ORDER_LIST_ENDPOINT,
    request,
    { mallId, label: `订单列表接口 page=${pageNumber}` },
  );
  return { request, result };
}

function collectStrings(value, output = [], depth = 0) {
  if (depth > 6 || value == null) return output;
  if (typeof value === "string") {
    const text = cleanText(value);
    if (text) output.push(text);
    return output;
  }
  if (typeof value !== "object") return output;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 50)) collectStrings(item, output, depth + 1);
    return output;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (/status|state|状态|发货|shipping|ship/i.test(key)) collectStrings(nested, output, depth + 1);
  }
  return output;
}

function orderStatusInfo(item) {
  const statusTexts = [...new Set(collectStrings(item))];
  const joined = statusTexts.join(" ");
  const parentOrder = item?.parentOrderMap || {};
  const orderLines = Array.isArray(item?.orderList) ? item.orderList : [];
  const parentOrderStatus = finiteNumber(parentOrder.parentOrderStatus);
  const orderStatusCodes = orderLines
    .map((line) => finiteNumber(line?.orderStatus))
    .filter((value) => value !== null);
  const cancelQuantity = sumOrderLineNumber(orderLines, "cancelQuantity");
  const shippedQuantity = sumOrderLineNumber(orderLines, "shippedQuantity");
  const fulfillmentQuantity = sumOrderLineNumber(orderLines, "fulfillmentQuantity");
  const unShippedQuantity = sumOrderLineNumber(orderLines, "unShippedQuantity");
  const hasTextShippedSignal = SHIPPED_RE.test(joined) && !UNSHIPPED_RE.test(joined);
  const hasApiShippedSignal = Boolean(
    cleanText(parentOrder.parentShippingTimeStr || parentOrder.parentReceiptTimeStr) ||
      shippedQuantity > 0 ||
      fulfillmentQuantity > 0,
  );
  const allOrderLinesCancelled = orderStatusCodes.length > 0 && orderStatusCodes.every((value) => value === 3);
  const cancelledByQuantity = cancelQuantity > 0 && shippedQuantity === 0 && fulfillmentQuantity === 0;
  const isCancelled = parentOrderStatus === 3 || allOrderLinesCancelled || cancelledByQuantity;
  return {
    statusTexts: statusTexts.slice(0, 20),
    parentOrderStatus,
    orderStatusCodes,
    cancelQuantity,
    shippedQuantity,
    fulfillmentQuantity,
    unShippedQuantity,
    isCancelled,
    hasStatusSignal: statusTexts.length > 0,
    hasShippedSignal: hasTextShippedSignal || hasApiShippedSignal,
    hasTextShippedSignal,
    hasApiShippedSignal,
  };
}

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sumOrderLineNumber(orderLines, key) {
  return orderLines.reduce((sum, line) => {
    const value = finiteNumber(line?.[key]);
    return sum + (value || 0);
  }, 0);
}

function parentOrderSnFromItem(item) {
  return cleanText(item?.parentOrderMap?.parentOrderSn || item?.parentOrderSn || item?.parent_order_sn || "");
}

function htmlDecode(value) {
  return String(value || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function textFromHtml(html) {
  return cleanText(
    htmlDecode(
      String(html || "")
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " "),
    ),
  );
}

function extractAssignedExpression(source) {
  const trimmedSource = String(source || "").trimStart();
  if (!trimmedSource) return "";
  if (trimmedSource.startsWith("JSON.parse(")) return readBalancedExpression(trimmedSource, "(", ")");
  if (trimmedSource[0] === "{") return readBalancedExpression(trimmedSource, "{", "}");
  if (trimmedSource[0] === "[") return readBalancedExpression(trimmedSource, "[", "]");
  return trimmedSource.split(";")[0].trim();
}

function readBalancedExpression(source, openChar, closeChar) {
  let depth = 0;
  let inString = false;
  let quote = "";
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        inString = false;
        quote = "";
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      inString = true;
      quote = char;
      continue;
    }
    if (char === openChar) depth += 1;
    if (char === closeChar) {
      depth -= 1;
      if (depth === 0) return source.slice(0, index + 1).trim();
    }
  }
  return "";
}

function extractRawData(html) {
  const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptRegex.exec(String(html || ""))) !== null) {
    const scriptContent = match[1] || "";
    const assignMatch = /window\.rawData\s*=\s*/.exec(scriptContent);
    if (!assignMatch) continue;
    const expression = extractAssignedExpression(scriptContent.slice(assignMatch.index + assignMatch[0].length));
    if (!expression) continue;
    try {
      return Function("\"use strict\"; return (" + expression + ");")();
    } catch {
      return null;
    }
  }
  return null;
}

function parseMoney(text) {
  const matches = Array.from(String(text || "").matchAll(MONEY_REGEX));
  if (!matches.length) return null;
  const raw = matches[matches.length - 1][0];
  const normalized = raw.replace(/[,\s]/g, "");
  const negative = normalized.includes("-") || normalized.includes("−");
  const numericText = normalized.replace(/[^\d.]/g, "");
  if (!numericText) return null;
  const amount = Number.parseFloat(numericText);
  if (!Number.isFinite(amount)) return null;
  return negative ? -amount : amount;
}

function buildLabelSegments(panelText, labels) {
  const positions = labels
    .map((label) => ({ label, index: panelText.indexOf(label) }))
    .filter((item) => item.index >= 0)
    .sort((a, b) => a.index - b.index);
  const segments = {};
  positions.forEach((current, index) => {
    const start = current.index + current.label.length;
    const end = index + 1 < positions.length ? positions[index + 1].index : panelText.length;
    segments[current.label] = panelText.slice(start, end).trim();
  });
  return segments;
}

function parseIncomeFromText(bodyText, fallbackParentOrderSn) {
  const incomeIndex = bodyText.indexOf("销售收益");
  if (incomeIndex < 0) return null;
  const panelText = bodyText.slice(incomeIndex, incomeIndex + 3000);
  const detailSegments = buildLabelSegments(panelText, INCOME_LABELS);
  const snapshot = {};
  const details = [];

  for (const field of INCOME_FIELDS) {
    const labels = [field.label, ...(field.aliases || [])];
    const matchedLabel = labels.find((label) => detailSegments[label]);
    const segment = matchedLabel ? detailSegments[matchedLabel] : "";
    const moneySegment = trimIncomeSegment(field.key, segment);
    const amount = parseMoney(moneySegment);
    if (!Number.isFinite(amount)) continue;
    snapshot[field.key] = amount;
    details.push({
      parentOrderSn: fallbackParentOrderSn,
      detailType: field.detailType,
      detailName: matchedLabel || field.label,
      amount,
      rawText: cleanText(moneySegment),
    });
  }

  if (details.length === 0) return null;

  return {
    parentOrderSn: fallbackParentOrderSn,
    siteName: extractFieldValue(bodyText, /站点名[:：]\s*([^\s]+)/),
    countryName: extractFieldValue(bodyText, /国家\/地区[:：]\s*([^\s]+)/),
    orderStatus: extractFieldValue(bodyText, /状态[:：]\s*([^\s]+)/),
    snapshot,
    details,
    rawPanelText: panelText,
  };
}

function trimIncomeSegment(fieldKey, segment) {
  const text = cleanText(segment);
  if (fieldKey === "estimatedIncome") {
    return text.split(/收货信息|订单记录|备注/)[0].trim();
  }
  return text;
}

function extractFieldValue(text, pattern) {
  const match = String(text || "").match(pattern);
  return cleanText(match?.[1] || "");
}

function parseAmountFromRawValue(value) {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return parseMoney(value);
  if (typeof value !== "object") return null;
  const text = value.digitalText || value.amountText || value.amountStr || value.displayText || value.text || value.valueText;
  if (text) return parseMoney(text);
  return null;
}

function parseIncomeFromRawData(rawData) {
  if (!rawData || typeof rawData !== "object") return null;
  const matches = {};

  function visit(value, pathParts = [], depth = 0) {
    if (depth > 8 || value == null) return;
    if (typeof value !== "object") return;

    for (const [key, nested] of Object.entries(value)) {
      const nextPath = [...pathParts, key];
      const pathText = nextPath.join(".");
      for (const field of INCOME_FIELDS) {
        if (matches[field.key] !== undefined) continue;
        if (!field.rawKeys.some((pattern) => pattern.test(pathText))) continue;
        const amount = parseAmountFromRawValue(nested);
        if (Number.isFinite(amount)) matches[field.key] = amount;
      }
      visit(nested, nextPath, depth + 1);
    }
  }

  visit(rawData);
  return Object.keys(matches).length ? matches : null;
}

function hasEnoughIncomeData(record) {
  const snapshot = record?.snapshot || {};
  const numericValues = Object.values(snapshot).filter((value) => Number.isFinite(value));
  return numericValues.length >= 3 || Number.isFinite(snapshot.estimatedIncome);
}

function zeroIncomeSnapshot() {
  return Object.fromEntries(INCOME_FIELDS.map((field) => [field.key, 0]));
}

function cancelledOrderRecord(candidate) {
  return {
    parentOrderSn: candidate.parentOrderSn,
    siteName: "",
    countryName: "",
    orderStatus: "已取消",
    snapshot: zeroIncomeSnapshot(),
    details: INCOME_FIELDS.map((field) => ({
      parentOrderSn: candidate.parentOrderSn,
      detailType: field.detailType,
      detailName: field.label,
      amount: 0,
      rawText: "已取消订单按 0 记录",
    })),
    source: {
      type: "orderList",
      reason: "cancelled",
    },
  };
}

async function fetchOrderDetail(page, mallId, parentOrderSn) {
  const endpoint = `${ORDER_DETAIL_ENDPOINT}?parent_order_sn=${encodeURIComponent(parentOrderSn)}`;
  let response;
  try {
    response = await temuPageRequest(page, {
      origin: orderOrigin(),
      endpoint,
      method: "GET",
      mallId,
      label: `订单详情 ${parentOrderSn}`,
      timeoutMs: DETAIL_TIMEOUT_MS,
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
  } catch (error) {
    return {
      ok: false,
      parentOrderSn,
      error: errorMessage(error),
      url: "",
    };
  }

  if (!response?.ok) {
    return {
      ok: false,
      parentOrderSn,
      error: `HTTP ${response?.status || "unknown"}`,
      url: response?.url || "",
    };
  }

  const html = response.bodyText || "";
  const bodyText = textFromHtml(html);
  const rawData = extractRawData(html);
  const rawSnapshot = parseIncomeFromRawData(rawData) || {};
  const domRecord = parseIncomeFromText(bodyText, parentOrderSn);
  const snapshot = {
    ...rawSnapshot,
    ...(domRecord?.snapshot || {}),
  };
  const record = {
    parentOrderSn,
    siteName: domRecord?.siteName || "",
    countryName: domRecord?.countryName || "",
    orderStatus: domRecord?.orderStatus || "",
    snapshot,
    details: domRecord?.details || [],
    source: {
      type: domRecord ? (rawData ? "dom+rawData" : "dom") : (rawData ? "rawData" : "html"),
      url: response.url,
      rawDataTopLevelKeys: rawData && typeof rawData === "object" && !Array.isArray(rawData) ? Object.keys(rawData).slice(0, 30) : [],
      rawSnapshotKeys: Object.keys(rawSnapshot),
      htmlTextLength: bodyText.length,
    },
  };

  return {
    ok: hasEnoughIncomeData(record),
    record,
    error: hasEnoughIncomeData(record) ? "" : "订单详情页未解析到足够销售收益字段",
  };
}

async function collectDetailCandidates(page, shopName, mallInfo, dateRange, targetCount, skipped) {
  const seen = new Set();
  const candidates = [];
  let cancelledCandidateCount = 0;
  let totalItemNum = 0;
  let rawOrderCount = 0;

  for (let pageNumber = 1; pageNumber <= MAX_LIST_PAGES && candidates.length < MAX_DETAIL_ATTEMPTS; pageNumber += 1) {
    const listPage = await queryRecentOrderList(page, mallInfo.mallId, pageNumber, dateRange);
    const pageItems = Array.isArray(listPage.result.pageItems) ? listPage.result.pageItems : [];
    totalItemNum = Number(listPage.result.totalItemNum || totalItemNum || pageItems.length);
    rawOrderCount += pageItems.length;
    if (pageItems.length === 0) break;

    for (const item of pageItems) {
      if (candidates.length >= MAX_DETAIL_ATTEMPTS) break;
      const parentOrderSn = parentOrderSnFromItem(item);
      if (!parentOrderSn) continue;
      if (seen.has(parentOrderSn)) {
        skipped.duplicate += 1;
        continue;
      }
      seen.add(parentOrderSn);

      const statusInfo = orderStatusInfo(item);
      if (statusInfo.isCancelled) {
        cancelledCandidateCount += 1;
        candidates.push({
          kind: "cancelled",
          parentOrderSn,
          listStatus: statusInfo.statusTexts,
          listStatusInfo: statusInfo,
        });
        continue;
      }
      if (statusInfo.hasStatusSignal && !statusInfo.hasShippedSignal) {
        skipped.notShipped += 1;
        continue;
      }

      candidates.push({
        parentOrderSn,
        listStatus: statusInfo.statusTexts,
        listStatusInfo: statusInfo,
      });
    }

    const totalPages = Math.ceil(totalItemNum / ORDER_LIST_PAGE_SIZE);
    if (pageNumber >= totalPages) break;
  }

  return {
    candidates: candidates.slice(0, Math.max(targetCount, MAX_DETAIL_ATTEMPTS)),
    cancelledCandidateCount,
    totalItemNum,
    rawOrderCount,
  };
}

async function collectDetailsUntilTarget(candidates, concurrency, targetCount, mapper) {
  let nextIndex = 0;
  const results = [];
  const workerCount = Math.max(1, Math.min(concurrency, candidates.length));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < candidates.length) {
        if (results.filter((result) => result.detail.ok).length >= targetCount) break;
        const index = nextIndex;
        nextIndex += 1;
        const result = await mapper(candidates[index], index);
        results.push(result);
      }
    }),
  );
  return results;
}

async function collectShopOrders(page, shopName, mallInfo, dateRange, remainingLimit) {
  const orders = [];
  const failedDetails = [];
  const skipped = {
    cancelledAsZero: 0,
    notShipped: 0,
    duplicate: 0,
    noIncome: 0,
  };
  const startedAt = Date.now();
  const candidateResult = await collectDetailCandidates(page, shopName, mallInfo, dateRange, remainingLimit, skipped);
  let detailAttempts = 0;
  await collectDetailsUntilTarget(
    candidateResult.candidates,
    DETAIL_CONCURRENCY,
    remainingLimit,
    async (candidate) => {
      if (candidate.kind === "cancelled") {
        const record = cancelledOrderRecord(candidate);
        if (orders.length < remainingLimit) {
          skipped.cancelledAsZero += 1;
          orders.push({
            ...record,
            listStatus: candidate.listStatus,
            listStatusInfo: candidate.listStatusInfo,
          });
          console.error(`${shopName}: saved ${orders.length}/${remainingLimit} ${candidate.parentOrderSn} cancelled=0`);
        }
        return { candidate, detail: { ok: true, record, skippedDetail: true } };
      }

      const detail = await fetchOrderDetail(page, mallInfo.mallId, candidate.parentOrderSn);
      detailAttempts += 1;

      if (detail.ok) {
        if (orders.length < remainingLimit) {
          orders.push({
            ...detail.record,
            listStatus: candidate.listStatus,
            listStatusInfo: candidate.listStatusInfo,
          });
          console.error(`${shopName}: saved ${orders.length}/${remainingLimit} ${candidate.parentOrderSn}`);
        }
      } else {
        skipped.noIncome += 1;
        failedDetails.push({
          parentOrderSn: candidate.parentOrderSn,
          error: detail.error,
          url: detail.url,
          listStatus: candidate.listStatus,
          listStatusInfo: candidate.listStatusInfo,
        });
      }

      if (detailAttempts % DETAIL_PROGRESS_EVERY === 0 || detailAttempts === candidateResult.candidates.length) {
        console.error(
          `${shopName}: detail progress ${detailAttempts}/${candidateResult.candidates.length} saved=${orders.length} failed=${failedDetails.length}`,
        );
      }

      return { candidate, detail };
    },
  );

  const elapsedMs = Date.now() - startedAt;

  return {
    shopName,
    region: activeOrderRegion,
    mallId: mallInfo.mallId,
    mallName: mallInfo.mallName,
    dateRange,
    orders,
    stats: {
      totalItemNum: candidateResult.totalItemNum,
      rawOrderCount: candidateResult.rawOrderCount,
      detailAttempts,
      detailCandidateCount: candidateResult.candidates.length,
      cancelledCandidateCount: candidateResult.cancelledCandidateCount,
      detailConcurrency: DETAIL_CONCURRENCY,
      requestedDetailConcurrency: REQUESTED_DETAIL_CONCURRENCY,
      detailConcurrencyCap: DETAIL_CONCURRENCY_CAP,
      detailTimeoutMs: DETAIL_TIMEOUT_MS,
      elapsedMs,
      ordersPerSecond: elapsedMs > 0 ? orders.length / (elapsedMs / 1000) : 0,
      savedOrders: orders.length,
      skipped,
      failedDetailCount: failedDetails.length,
      maxListPages: MAX_LIST_PAGES,
      maxDetailAttempts: MAX_DETAIL_ATTEMPTS,
    },
    failedDetails: failedDetails.slice(0, 20),
  };
}

async function runAccountRegion(account, region, dateRange, remainingLimit, { perShopLimit = 0 } = {}) {
  activeOrderRegion = region;
  const shops = shopListForAccount(account);
  if (shops.length === 0) fail("NO_SHOPS_CONFIGURED", `${account.label || account.id} 没有配置目标店铺`);

  const { browser, context, page } = await connectCdpChrome(targetUrlFor(region), account);
  const shopResults = [];
  try {
    let activePage = await ensureOrdersPage(context, page);
    const mallList = await orderMallList(activePage);
    const knownShops = [...new Set([...(account.knownShops || []), ...shops])];

    for (const shopName of shops) {
      if (!perShopLimit && shopResults.reduce((sum, shop) => sum + shop.orders.length, 0) >= remainingLimit) break;
      const mallInfo = mallInfoForShop(mallList.malls, shopName);
      if (DOM_SWITCH_ENABLED) {
        activePage = await switchShopByDom(context, activePage, shopName, knownShops);
      }
      const mallScope = await verifyMallScopeByApi(activePage, shopName, mallInfo);
      const used = shopResults.reduce((sum, shop) => sum + shop.orders.length, 0);
      const targetCount = perShopLimit || remainingLimit - used;
      const shopResult = await collectShopOrders(activePage, shopName, mallInfo, dateRange, targetCount);
      shopResult.mallListEndpoint = `${orderOrigin()}${mallList.endpoint}`;
      shopResult.mallScope = mallScope;
      shopResults.push(shopResult);
    }

    return {
      account,
      region,
      ok: true,
      shops: shopResults,
    };
  } catch (error) {
    return {
      account,
      region,
      ok: false,
      error: errorMessage(error),
      shops: shopResults,
    };
  } finally {
    if (process.env.TEMU_CLOSE_CHROME_PAGES !== "0") {
      await closeCdpPages(context).catch(() => {});
    }
    await browser.close().catch(() => {});
    await closeCdpChromeProcess(account.cdpPort).catch(() => {});
  }
}

function shopEligibleOrderCount(shop) {
  const total = Number(shop?.stats?.totalItemNum);
  const skipped = shop?.stats?.skipped || {};
  const notShipped = Number(skipped.notShipped || 0);
  const duplicate = Number(skipped.duplicate || 0);
  const eligible = Number.isFinite(total) ? total - notShipped - duplicate : shop?.orders?.length || 0;
  return Math.max(0, eligible);
}

function shopExpectedOrderCount(shop, limit) {
  return Math.min(limit, shopEligibleOrderCount(shop));
}

function resultSavedOrderCount(result) {
  return (result.shops || []).reduce((sum, shop) => sum + (shop.orders?.length || 0), 0);
}

function resultExpectedOrderCount(result, limit, perShopLimit) {
  const shops = result.shops || [];
  if (!perShopLimit) {
    return Math.min(limit, shops.reduce((sum, shop) => sum + shopEligibleOrderCount(shop), 0));
  }
  return shops.reduce((sum, shop) => sum + shopExpectedOrderCount(shop, perShopLimit), 0);
}

function targetOrderCount(results, limit, perShopLimit) {
  return results.reduce((sum, result) => sum + resultExpectedOrderCount(result, limit, perShopLimit), 0);
}

function targetMet(results, limit, perShopLimit) {
  if (!perShopLimit) {
    return results.every((result) => resultSavedOrderCount(result) >= resultExpectedOrderCount(result, limit, perShopLimit));
  }
  return results.every((result) =>
    (result.shops || []).every((shop) => (shop.orders?.length || 0) >= shopExpectedOrderCount(shop, perShopLimit)),
  );
}

function buildMessage(results, dateRange, limit, perShopLimit) {
  const saved = results
    .flatMap((result) => result.shops || [])
    .reduce((sum, shop) => sum + (shop.orders?.length || 0), 0);
  const scope = dateRange.startDate === dateRange.endDate ? dateRange.startDate : `${dateRange.startDate}..${dateRange.endDate}`;
  const expected = targetOrderCount(results, limit, perShopLimit);
  const targetText = perShopLimit ? `每店铺 ${perShopLimit} 单，保存 ${saved}/${expected} 单` : `每账号每区域最多 ${limit} 单，保存 ${saved}/${expected} 单`;
  const parts = [`订单收入验证 ${scope}: ${targetText}`];
  for (const result of results) {
    const label = `${result.account?.label || result.account?.id || "账号"} ${result.region?.label || result.region?.code || "区域"}`;
    if (!result.ok) {
      parts.push(`【${label}】失败：${result.error}`);
      continue;
    }
    const shopParts = (result.shops || []).map((shop) => `${shop.shopName} ${shop.orders.length} 单`);
    parts.push(`【${label}】${shopParts.join("，") || "0 单"}`);
  }
  return parts.join("；");
}

async function main() {
  const dateRange = dateRangeFromEnv();
  const rawConfig = JSON.parse(await fs.readFile(accountsPath, "utf8"));
  const selectedIds = selectedAccountIds();
  const accounts = (rawConfig.accounts || []).filter((account) => selectedIds.length === 0 || selectedIds.includes(account.id));
  if (accounts.length === 0) {
    fail("NO_MATCHING_ACCOUNTS", selectedIds.length ? `找不到账号：${selectedIds.join(",")}` : "账号配置为空");
  }

  const results = [];
  for (const account of accounts) {
    for (const region of ORDER_REGIONS) {
      console.error(`Running order sales income account: ${account.label || account.id} ${region.label}`);
      results.push(await runAccountRegion(account, region, dateRange, ORDER_LIMIT, { perShopLimit: ORDER_LIMIT_PER_SHOP }));
    }
  }

  const outputPath = path.join(reportDir, `temu-order-sales-income-${stamp}.json`);
  const savedOrders = results
    .flatMap((result) => result.shops || [])
    .reduce((sum, shop) => sum + (shop.orders?.length || 0), 0);
  const message = buildMessage(results, dateRange, ORDER_LIMIT, ORDER_LIMIT_PER_SHOP);
  const expectedOrders = targetOrderCount(results, ORDER_LIMIT, ORDER_LIMIT_PER_SHOP);
  const hasTargetMet = targetMet(results, ORDER_LIMIT, ORDER_LIMIT_PER_SHOP);
  const output = {
    generatedAt: new Date().toISOString(),
    accountsPath,
    targetUrls: ORDER_REGIONS.map((region) => targetUrlFor(region)),
    orderRegions: ORDER_REGIONS,
    shopScope: "semi-managed",
    dateRange,
    limit: ORDER_LIMIT,
    limitPerShop: ORDER_LIMIT_PER_SHOP,
    fulfillmentMode: ORDER_FULFILLMENT_MODE,
    pageSize: ORDER_LIST_PAGE_SIZE,
    domSwitchEnabled: DOM_SWITCH_ENABLED,
    detailHardConcurrencyCap: DETAIL_HARD_CONCURRENCY_CAP,
    savedOrders,
    expectedOrders,
    targetMet: hasTargetMet,
    message,
    results,
  };

  await fs.writeFile(outputPath, JSON.stringify(output, null, 2));
  console.log(message);
  console.log(`Saved JSON: ${outputPath}`);

  if (savedOrders === 0 || results.some((result) => !result.ok) || !hasTargetMet) {
    process.exitCode = 1;
  }
}

await main().catch(async (error) => {
  const outputPath = path.join(reportDir, `temu-order-sales-income-${stamp}.error.json`);
  const output = {
    generatedAt: new Date().toISOString(),
    accountsPath,
    targetUrls: ORDER_REGIONS.map((region) => targetUrlFor(region)),
    ok: false,
    error: errorMessage(error),
  };
  await fs.writeFile(outputPath, JSON.stringify(output, null, 2)).catch(() => {});
  console.error(errorMessage(error));
  console.error(`Saved JSON: ${outputPath}`);
  process.exitCode = 1;
});
