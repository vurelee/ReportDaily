import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeCdpChromeProcess, closeCdpPages } from "./cdp-page-cleanup.mjs";
import { connectCdpChrome } from "./chrome-cdp.mjs";
import {
  bodyText,
  enterAgentAuthenticationIfShown,
  isAgentAuthenticationUrl,
  loginSellerIfNeeded,
  needsVerification,
  waitForMatchingPage,
} from "./temu-login-helper.mjs";
import { resolveMallByExactName } from "./temu-mall-resolver.mjs";
import { temuPageApiPost } from "./temu-page-api-client.mjs";
import { closeTemuPopups } from "./temu-popup-cleaner.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const accountsPath = process.env.TEMU_ACCOUNTS_CONFIG || path.join(rootDir, "temu-accounts.json");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const sourceRunId = `temu-profit-reconciliation-${stamp}`;

const USER_INFO_ENDPOINT = "/api/seller/auth/userInfo";
const UNSETTLE_ENDPOINT = "/api/xiaowenhou/settle-flow/sm/unsettle/page-query";
const SETTLED_ORDER_ENDPOINT = "/api/xiaowenhou/settle-flow/sm/settled/o/page-query";
const SETTLED_PO_ENDPOINT = "/api/xiaowenhou/settle-flow/sm/settled/po/page-query";
const STML_RECON_LIST_ENDPOINT = "/portal/selene/seller/portal/recon/list";
const DEFAULT_SUBMIT_PATH = "/api/integrations/temu/profit-reconciliation/batch-upsert";
const DEFAULT_ONLINE_LABEL_FEE_SUBMIT_PATH = "/api/integrations/finance/temu-online-label-fees/batch-upsert";
const SUPPORTED_ONLINE_LABEL_RECONCILIATION_TYPES = new Set([1, 2, 3, 5]);

const REGION_DEFS = {
  EU: { key: "eu", code: "EU", label: "欧区", origin: "https://agentseller-eu.temu.com" },
  US: { key: "us", code: "US", label: "美区", origin: "https://agentseller-us.temu.com" },
};

class TemuProfitReconciliationError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "TemuProfitReconciliationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new TemuProfitReconciliationError(code, message);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function truthy(value) {
  return /^(1|true|yes|y|on)$/i.test(String(value || "").trim());
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function loadLocalEnv() {
  const envPath = path.join(rootDir, ".env.local");
  let text = "";
  try {
    text = await fs.readFile(envPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equalIndex = line.indexOf("=");
    if (equalIndex <= 0) continue;
    const key = line.slice(0, equalIndex).trim();
    let value = line.slice(equalIndex + 1).trim();
    if (!key || process.env[key]) continue;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
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

function shanghaiDateKey(offsetDays = 0) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const date = new Date(Date.UTC(Number(byType.year), Number(byType.month) - 1, Number(byType.day) + offsetDays));
  return [
    String(date.getUTCFullYear()).padStart(4, "0"),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function shanghaiStartMs(dateKey) {
  const { year, month, day } = parseDateKey(dateKey);
  return new Date(`${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T00:00:00+08:00`).getTime();
}

function shanghaiEndMs(dateKey) {
  const { year, month, day } = parseDateKey(dateKey);
  return new Date(`${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T23:59:59.999+08:00`).getTime();
}

function parseOptions() {
  const startDate = cleanText(process.env.TEMU_PROFIT_START_DATE) || shanghaiDateKey(-1);
  const endDate = cleanText(process.env.TEMU_PROFIT_END_DATE) || startDate;
  parseDateKey(startDate);
  parseDateKey(endDate);
  if (startDate > endDate) fail("INVALID_DATE_RANGE", `开始日期不能晚于结束日期：${startDate} > ${endDate}`);

  const regionRaw = cleanText(process.env.TEMU_PROFIT_REGION || "ALL").toUpperCase();
  const requestedRegions = regionRaw === "ALL"
    ? ["EU", "US"]
    : regionRaw.split(",").map((value) => cleanText(value).toUpperCase()).filter(Boolean);
  const regions = requestedRegions.map((code) => {
    const region = REGION_DEFS[code];
    if (!region) fail("INVALID_REGION", `TEMU_PROFIT_REGION 只支持 EU、US、ALL：${code}`);
    return region;
  });

  const dryRun = truthy(process.env.TEMU_PROFIT_DRY_RUN);
  const defaultReportDir = path.join(rootDir, "temu-reports", dryRun ? "debug" : "");
  const reportDir = process.env.TEMU_REPORT_DIR || defaultReportDir;

  return {
    accountIds: String(process.env.TEMU_ACCOUNT_ID || process.env.TEMU_ACCOUNT_IDS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    shopFilter: String(process.env.TEMU_PROFIT_SHOPS || process.env.TEMU_FUNDS_SHOPS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    regions,
    range: { startDate, endDate },
    dryRun,
    reportDir,
    onlyOnlineLabelFees: truthy(process.env.TEMU_PROFIT_ONLY_ONLINE_LABEL_FEES),
    omitRaw: truthy(process.env.TEMU_PROFIT_OMIT_RAW),
    settlementPageSize: parsePositiveInteger(process.env.TEMU_PROFIT_SETTLEMENT_PAGE_SIZE, 200),
    stmlPageSize: parsePositiveInteger(process.env.TEMU_PROFIT_STML_PAGE_SIZE, 200),
    maxPages: parsePositiveInteger(process.env.TEMU_PROFIT_MAX_PAGES, 200),
  };
}

function selectedShopsForAccount(account, options) {
  if (options.shopFilter.length > 0) return options.shopFilter;
  return account.shops || [];
}

function targetUrlFor(region, pageType) {
  const pagePath = pageType === "stml" ? "/labor/stml-logistics" : "/labor/settle";
  return `${region.origin}${pagePath}`;
}

async function waitSettled(page) {
  if (!page || page.isClosed()) return;
  await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
  if (page.isClosed()) return;
  await page.waitForLoadState("networkidle", { timeout: 7000 }).catch(() => {});
  if (page.isClosed()) return;
  await page.waitForTimeout(800).catch(() => {});
  if (page.isClosed()) return;
  await closeTemuPopups(page).catch(() => {});
}

async function authorizeSellerPage(context, page, region) {
  const sellerPage =
    (await waitForMatchingPage(
      context,
      (candidate) => candidate.url().startsWith("https://seller.kuajingmaihuo.com/settle/seller-login"),
      8000,
    )) || page;

  return (
    (await loginSellerIfNeeded(context, sellerPage, {
      fail,
      errorCodes: {
        buttonNotFound: "AGENT_SELLER_AUTH_BUTTON_NOT_FOUND",
        verificationRequired: "AGENT_SELLER_VERIFICATION_REQUIRED",
      },
      messages: {
        buttonNotFound: `${region.label} AgentSeller 授权页找不到授权按钮`,
        verificationRequired: `${region.label} AgentSeller 授权需要短信或验证码`,
      },
      afterClickTimeoutMs: 4500,
    })) || sellerPage
  );
}

async function ensureAgentPage(context, page, region, pageType) {
  let activePage = page && !page.isClosed() ? page : await context.newPage();
  const targetUrl = targetUrlFor(region, pageType);
  await activePage.goto(targetUrl, { waitUntil: "domcontentloaded" }).catch(() => {});

  for (let attempt = 0; attempt < 7; attempt += 1) {
    await waitSettled(activePage);
    const text = await bodyText(activePage, 3000);
    if (needsVerification(text)) {
      fail("AGENT_SELLER_VERIFICATION_REQUIRED", `${region.label} AgentSeller 页面需要短信、验证码或滑块`);
    }
    if (!activePage.isClosed() && activePage.url().startsWith(targetUrl)) return activePage;

    if (!activePage.isClosed() && isAgentAuthenticationUrl(activePage.url())) {
      const authPage = await enterAgentAuthenticationIfShown(context, activePage);
      if (!authPage || isAgentAuthenticationUrl(authPage.url())) {
        fail("AGENT_AUTH_ENTRY_NOT_FOUND", `${region.label} AgentSeller 认证页找不到中国地区商家中心入口`);
      }
      activePage = await authorizeSellerPage(context, authPage, region);
      activePage =
        (await waitForMatchingPage(
          context,
          (candidate) => candidate.url().startsWith(region.origin) && !isAgentAuthenticationUrl(candidate.url()),
          10000,
        )) || activePage;
      continue;
    }

    if (!activePage.isClosed() && activePage.url().startsWith("https://seller.kuajingmaihuo.com/settle/seller-login")) {
      await authorizeSellerPage(context, activePage, region);
      activePage =
        (await waitForMatchingPage(
          context,
          (candidate) => candidate.url().startsWith(region.origin) && !isAgentAuthenticationUrl(candidate.url()),
          10000,
        )) || activePage;
      continue;
    }

    if (activePage.isClosed()) activePage = await context.newPage();
    await activePage.goto(targetUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
  }

  const label = pageType === "stml" ? "线上面单费用页" : "结算页";
  fail("AGENT_PAGE_NOT_READY", `${region.label} AgentSeller ${label}未进入成功：${targetUrl}`);
}

async function installStmlAntiContentHook(context) {
  await context.addInitScript(() => {
    if (window.__codexProfitStmlHookInstalled) return;
    window.__codexProfitStmlHookInstalled = true;
    window.__codexProfitLatestAntiContent = "";

    const headerEntries = (headers) => {
      try {
        if (!headers) return [];
        if (headers instanceof Headers) return [...headers.entries()];
        if (Array.isArray(headers)) return headers;
        return Object.entries(headers);
      } catch {
        return [];
      }
    };
    const captureAntiContent = (headers) => {
      for (const [key, value] of headerEntries(headers)) {
        if (/anti-content/i.test(String(key || "")) && value) {
          window.__codexProfitLatestAntiContent = String(value);
        }
      }
    };

    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
      const input = args[0];
      const init = args[1] || {};
      captureAntiContent(input?.headers);
      captureAntiContent(init.headers);
      return await originalFetch.apply(window, args);
    };

    const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function setRequestHeader(key, value) {
      if (/anti-content/i.test(String(key || "")) && value) {
        window.__codexProfitLatestAntiContent = String(value);
      }
      return originalSetRequestHeader.call(this, key, value);
    };
  });
}

async function clickExactText(page, text) {
  const rect = await page.evaluate((target) => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    return Array.from(document.querySelectorAll("body *"))
      .map((node) => {
        const nodeText = clean(node.innerText || node.textContent || "");
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return {
          text: nodeText,
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          visible: rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden",
        };
      })
      .filter((item) => item.visible && item.text === target)
      .sort((a, b) => a.width * a.height - b.width * b.height)[0] || null;
  }, text);
  if (!rect) return false;
  await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.waitForTimeout(1500).catch(() => {});
  return true;
}

async function primeStmlPage(page) {
  await clickExactText(page, "已出账").catch(() => false);
  await page.waitForTimeout(1200).catch(() => {});
}

async function agentApiPost(page, region, endpoint, body = {}, { mallId = "", label = endpoint } = {}) {
  const response = await temuPageApiPost(page, {
    origin: region.origin,
    endpoint,
    body,
    mallId,
    label,
  });
  return assertApiResponse(response, label, endpoint, body, mallId);
}

async function stmlApiPost(page, region, endpoint, body = {}, { mallId = "", label = endpoint } = {}) {
  const response = await page.evaluate(
    async ({ origin, endpoint, body, mallId }) => {
      async function antiContentValue() {
        if (window.__codexProfitLatestAntiContent) return window.__codexProfitLatestAntiContent;
        try {
          if (!window.__codexTemuChunkRequire) {
            const factories = {};
            for (const chunkName of ["webpackJsonp_bg-agent-seller-lgst", "webpackJsonp_mms_seller_bg_pc_mms", "webpackJsonp"]) {
              for (const chunk of self[chunkName] || []) {
                const modules = chunk?.[1];
                if (!modules || typeof modules !== "object") continue;
                Object.assign(factories, modules);
              }
            }
            const cache = {};
            const chunkRequire = (id) => {
              const key = String(id);
              if (cache[key]) return cache[key].exports;
              const factory = factories[key];
              if (!factory) throw new Error(`module ${key} not found`);
              const module = { exports: {} };
              cache[key] = module;
              factory.call(module.exports, module, module.exports, chunkRequire);
              return module.exports;
            };
            chunkRequire.d = (exports, definition) => {
              for (const key of Object.keys(definition)) {
                if (!Object.prototype.hasOwnProperty.call(exports, key)) {
                  Object.defineProperty(exports, key, { enumerable: true, get: definition[key] });
                }
              }
            };
            chunkRequire.o = (object, property) => Object.prototype.hasOwnProperty.call(object, property);
            chunkRequire.r = (exports) => {
              if (typeof Symbol !== "undefined" && Symbol.toStringTag) {
                Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
              }
              Object.defineProperty(exports, "__esModule", { value: true });
            };
            chunkRequire.n = (module) => {
              const getter = module && module.__esModule ? () => module.default : () => module;
              chunkRequire.d(getter, { a: getter });
              return getter;
            };
            window.__codexTemuChunkRequire = chunkRequire;
          }
          const riskUtil = window.__codexTemuChunkRequire?.(65531);
          if (typeof riskUtil?.cN === "function") return await riskUtil.cN();
          if (typeof riskUtil?.xy === "function") return riskUtil.xy();
        } catch {
          return "";
        }
        return "";
      }

      const url = endpoint.startsWith("http") ? endpoint : new URL(endpoint, origin).toString();
      const antiContent = await antiContentValue();
      const headers = {
        accept: "application/json, text/plain, */*",
        "content-type": "application/json",
      };
      if (antiContent) headers["Anti-Content"] = antiContent;
      if (mallId) headers.mallid = String(mallId);

      const fetched = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify(body || {}),
      });
      const bodyText = await fetched.text();
      let json = null;
      try {
        json = bodyText ? JSON.parse(bodyText) : null;
      } catch {
        json = null;
      }
      return {
        ok: fetched.ok,
        status: fetched.status,
        statusText: fetched.statusText,
        url: fetched.url,
        json,
        bodyText,
        antiContentPresent: Boolean(antiContent),
        antiContentLength: antiContent ? String(antiContent).length : 0,
      };
    },
    { origin: region.origin, endpoint, body, mallId },
  );
  return assertApiResponse(response, label, endpoint, body, mallId, {
    antiContent: response.antiContentPresent ? `<page-generated redacted length=${response.antiContentLength}>` : "",
  });
}

function assertApiResponse(response, label, endpoint, body, mallId, extra = {}) {
  const call = {
    endpoint,
    url: response?.url || "",
    status: response?.status || 0,
    ok: Boolean(response?.ok),
    request: {
      method: "POST",
      mallId,
      body,
    },
    json: response?.json || null,
    bodyPreview: response?.json ? "" : String(response?.bodyText || "").slice(0, 1000),
    ...extra,
  };

  if (!response?.ok) {
    fail("AGENT_API_HTTP_FAILED", `${label} HTTP ${response?.status || "unknown"}：${call.bodyPreview}`);
  }
  if (!response.json || typeof response.json !== "object") {
    fail("AGENT_API_RESPONSE_NOT_JSON", `${label} 返回非 JSON：${call.bodyPreview}`);
  }
  const bodyJson = response.json;
  const errorCode = bodyJson.errorCode ?? bodyJson.error_code ?? bodyJson.code;
  const numericCode = Number(errorCode);
  const successCodes = new Set([0, 1000000]);
  if (bodyJson.success === false || (errorCode !== undefined && !successCodes.has(numericCode))) {
    const message = bodyJson.errorMsg || bodyJson.error_msg || bodyJson.message || "unknown";
    fail("AGENT_API_RESPONSE_FAILED", `${label} 返回失败：code=${errorCode ?? "unknown"} msg=${message}`);
  }
  return call;
}

function resultOf(call) {
  return call?.json?.result?.res ?? call?.json?.res ?? call?.json?.result ?? call?.json?.data ?? {};
}

function extractRows(result) {
  if (Array.isArray(result?.dataList)) return result.dataList;
  if (Array.isArray(result?.list)) return result.list;
  if (Array.isArray(result?.resultList)) return result.resultList;
  if (Array.isArray(result?.records)) return result.records;
  return [];
}

function totalFromResult(result, fallback = 0) {
  const total = Number(result?.total ?? result?.totalCount ?? result?.totalNum ?? result?.count ?? fallback);
  return Number.isFinite(total) && total >= 0 ? total : fallback;
}

function amountValueCents(amount) {
  const parsed = Number(amount?.value);
  return Number.isFinite(parsed) ? parsed : null;
}

function amountYuanFromFormat(format) {
  if (!format || typeof format !== "object") return null;
  const text = format.amountYuan ?? format.digitalText ?? format.amountText;
  const parsedText = Number(String(text ?? "").replace(/,/g, ""));
  if (Number.isFinite(parsedText)) {
    return format.sign === "-" ? -Math.abs(parsedText) : parsedText;
  }
  const si = Number(format.sellerSettleAmountSi);
  if (Number.isFinite(si)) {
    const amount = si / 100000;
    return format.sign === "-" ? -Math.abs(amount) : amount;
  }
  const cents = amountValueCents(format);
  return cents === null ? null : cents / 100;
}

function amountSummary(amount) {
  if (!amount || typeof amount !== "object") return null;
  return {
    value: amount.value ?? null,
    amountCny: amountValueCents(amount) === null ? amountYuanFromFormat(amount) : amountValueCents(amount) / 100,
    currencyCode: amount.currencyCode || "",
    sign: amount.sign || "",
    digitalText: amount.digitalText ?? amount.amountYuan ?? "",
    raw: amount,
  };
}

function dateTimeString(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }

  const text = cleanText(value);
  if (!text) return "";
  if (/^\d{10,13}$/.test(text)) {
    const epoch = Number(text);
    return new Date(text.length === 10 ? epoch * 1000 : epoch).toISOString();
  }
  return text;
}

function amountCnyFromSummary(amount) {
  if (!amount || typeof amount !== "object") return null;
  const amountCny = Number(amount.amountCny);
  if (Number.isFinite(amountCny)) return amountCny;
  const value = Number(amount.value);
  return Number.isFinite(value) ? value / 100 : null;
}

function currencyFromSummary(amount) {
  const currency = cleanText(amount?.currencyCode);
  return currency || "CNY";
}

function onlineLabelFeePayloadFromRecord(record, dropSummary) {
  const mallId = cleanText(record?.shop?.mallId);
  const reconciliationId = cleanText(record?.reconciliationId);
  const deductTime = dateTimeString(record?.deductTime);
  const amount = amountCnyFromSummary(record?.amount);
  const reconciliationType = Number(record?.reconciliationType ?? 1);
  if (!SUPPORTED_ONLINE_LABEL_RECONCILIATION_TYPES.has(reconciliationType)) {
    dropSummary.unsupportedReconciliationTypeCount += 1;
    const key = String(record?.reconciliationType ?? "");
    dropSummary.unsupportedReconciliationTypes[key] = (dropSummary.unsupportedReconciliationTypes[key] || 0) + 1;
    return null;
  }
  if (!mallId || !reconciliationId || !deductTime || amount === null) {
    dropSummary.invalidRecordCount += 1;
    return null;
  }

  return {
    mallId,
    mallName: cleanText(record?.shop?.name),
    reconciliationId,
    packageSn: cleanText(record?.packageSn) || undefined,
    waybillSn: cleanText(record?.waybillSn) || undefined,
    reconciliationType,
    amount: Math.abs(amount),
    currency: currencyFromSummary(record?.amount),
    deductTime,
    serviceProviderCode: cleanText(record?.serviceProviderCode) || undefined,
    serviceProviderName: cleanText(record?.serviceProviderName) || undefined,
    remark: cleanText(record?.remark) || undefined,
    rawJson: record?.raw ?? undefined,
  };
}

function settlementAmounts(row) {
  const fields = [
    "settleAmount",
    "productPaymentAmount",
    "productPaymentDiscountAmount",
    "productRefundAmount",
    "shippingPaymentAmount",
    "shippingPaymentDiscountAmount",
    "shippingRefundAmount",
    "totalSupplyPrice",
    "singleCouponAmount",
    "fullDiscountAmount",
    "supplyPriceDiscountAmount",
    "shippingActivityDiscountAmount",
  ];
  const output = {};
  for (const field of fields) {
    if (row[field] !== undefined) output[field] = amountSummary(row[field]);
  }
  return output;
}

function normalizeSettlementRow(row, context) {
  return {
    sourceRunId,
    platform: "TEMU",
    accountId: context.account.id,
    accountLabel: context.account.label || context.account.id,
    shop: {
      name: context.shopName,
      mallId: context.mall.mallId,
    },
    region: context.region.code,
    range: context.range,
    recordType: context.recordType,
    settlementState: context.settlementState,
    sourceEndpoint: context.endpoint,
    parentOrderSn: cleanText(row.parentOrderSn),
    settleId: cleanText(row.settleId),
    batchSn: cleanText(row.batchSn),
    transSn: cleanText(row.transSn),
    flowType: cleanText(row.type),
    currency: cleanText(row.currency),
    accountTime: cleanText(row.accountTime),
    amounts: settlementAmounts(row),
    raw: context.options.omitRaw ? null : row,
  };
}

function normalizeSettlementSku(row, sku, index, context) {
  return {
    sourceRunId,
    platform: "TEMU",
    accountId: context.account.id,
    accountLabel: context.account.label || context.account.id,
    shop: {
      name: context.shopName,
      mallId: context.mall.mallId,
    },
    region: context.region.code,
    range: context.range,
    recordType: "settlement_sku",
    parentRecordType: context.recordType,
    settlementState: context.settlementState,
    sourceEndpoint: context.endpoint,
    parentOrderSn: cleanText(row.parentOrderSn),
    settleId: cleanText(row.settleId),
    skuIndex: index + 1,
    skuId: sku.id ?? null,
    skuName: cleanText(sku.name),
    skuExtCode: cleanText(sku.extCode),
    quantity: Number(sku.number ?? 0),
    declarationSupplyPrice: amountSummary(sku.declarationSupplyPrice),
    supplyPrice: amountSummary(sku.supplyPrice),
    promotionalPrice: sku.promotionalPrice ?? null,
    raw: context.options.omitRaw ? null : sku,
  };
}

function normalizeOnlineLabelFee(row, context) {
  return {
    sourceRunId,
    platform: "TEMU",
    accountId: context.account.id,
    accountLabel: context.account.label || context.account.id,
    shop: {
      name: context.shopName,
      mallId: context.mall.mallId,
    },
    region: context.region.code,
    range: context.range,
    recordType: "online_label_fee",
    sourceEndpoint: STML_RECON_LIST_ENDPOINT,
    reconciliationId: cleanText(row.reconciliationId),
    packageSn: cleanText(row.packageSn),
    waybillSn: cleanText(row.waybillSn),
    serviceProviderCode: cleanText(row.serviceProviderCode),
    serviceProviderName: cleanText(row.serviceProviderName),
    reconciliationType: row.reconciliationType ?? null,
    reconciliationTypeDesc: cleanText(row.reconciliationTypeDesc),
    status: row.status ?? null,
    statusDesc: cleanText(row.statusDesc),
    statusInfo: cleanText(row.statusInfo),
    deductTime: row.deductTime ?? null,
    remark: cleanText(row.remark),
    amount: amountSummary(row.priceCurrencyFormat),
    raw: context.options.omitRaw ? null : row,
  };
}

function pageSummary(call, rows, total, pageIndex) {
  return {
    page: pageIndex,
    endpoint: call.endpoint,
    status: call.status,
    total,
    rowCount: rows.length,
    request: call.request,
  };
}

function totalSummaries(result) {
  const keys = [
    "totalAmount",
    "productPaymentTotalAmount",
    "productRefundTotalAmount",
    "shippingPaymentTotalAmount",
    "shippingRefundTotalAmount",
    "dataUpdateTime",
  ];
  const output = {};
  for (const key of keys) {
    if (result?.[key] !== undefined) output[key] = result[key];
  }
  return output;
}

async function collectSettlementPaged(page, context, endpoint, baseBody, recordType, settlementState) {
  const records = [];
  const pages = [];
  let total = 0;
  let totals = {};
  let fetchedRowCount = 0;

  for (let pageNum = 1; pageNum <= context.options.maxPages; pageNum += 1) {
    const body = {
      ...baseBody,
      pageSize: context.options.settlementPageSize,
      pageNum,
    };
    const call = await agentApiPost(page, context.region, endpoint, body, {
      mallId: context.mall.mallId,
      label: `${context.region.label} ${context.shopName} ${settlementState} page=${pageNum}`,
    });
    const result = resultOf(call);
    const rows = extractRows(result);
    total = totalFromResult(result, rows.length || total);
    fetchedRowCount += rows.length;
    if (pageNum === 1) totals = totalSummaries(result);
    pages.push(pageSummary(call, rows, total, pageNum));

    const rowContext = { ...context, endpoint, recordType, settlementState };
    for (const row of rows) {
      records.push(normalizeSettlementRow(row, rowContext));
      const skuItems = Array.isArray(row.skuItems) ? row.skuItems : [];
      skuItems.forEach((sku, index) => records.push(normalizeSettlementSku(row, sku, index, rowContext)));
    }

    if (!rows.length || fetchedRowCount >= total || pageNum * context.options.settlementPageSize >= total) break;
    await page.waitForTimeout(250).catch(() => {});
  }

  return {
    endpoint,
    settlementState,
    recordType,
    pages,
    total,
    totals,
    records,
  };
}

async function collectSettlement(page, context) {
  const { startDate, endDate } = context.range;
  const sections = [];
  sections.push(
    await collectSettlementPaged(
      page,
      context,
      UNSETTLE_ENDPOINT,
      { orderCreateTimeStart: startDate, orderCreateTimeEnd: endDate },
      "settlement_order",
      "unsettled",
    ),
  );
  sections.push(
    await collectSettlementPaged(
      page,
      context,
      SETTLED_ORDER_ENDPOINT,
      { accountTimeStart: startDate, accountTimeEnd: endDate },
      "settlement_flow",
      "settled_order",
    ),
  );
  sections.push(
    await collectSettlementPaged(
      page,
      context,
      SETTLED_PO_ENDPOINT,
      { accountTimeStart: startDate, accountTimeEnd: endDate },
      "settlement_po",
      "settled_po",
    ),
  );
  return {
    ok: true,
    sections,
    records: sections.flatMap((section) => section.records),
  };
}

async function collectOnlineLabelFees(page, context) {
  const records = [];
  const pages = [];
  let total = 0;
  let scrollContext = null;

  for (let pageNum = 1; pageNum <= context.options.maxPages; pageNum += 1) {
    const body = {
      settleStatus: 1,
      deductTimeBegin: shanghaiStartMs(context.range.startDate),
      deductTimeEnd: shanghaiEndMs(context.range.endDate),
      rowCount: context.options.stmlPageSize,
      scrollContext,
    };
    const call = await stmlApiPost(page, context.region, STML_RECON_LIST_ENDPOINT, body, {
      mallId: context.mall.mallId,
      label: `${context.region.label} ${context.shopName} 线上面单已出账 page=${pageNum}`,
    });
    const result = resultOf(call);
    const rows = extractRows(result);
    total = totalFromResult(result, rows.length || total);
    pages.push({
      ...pageSummary(call, rows, total, pageNum),
      hasScrollContext: Boolean(result.scrollContext),
    });

    for (const row of rows) records.push(normalizeOnlineLabelFee(row, context));

    if (!rows.length || records.length >= total || !result.scrollContext) break;
    scrollContext = result.scrollContext;
    await page.waitForTimeout(250).catch(() => {});
  }

  return {
    ok: true,
    endpoint: STML_RECON_LIST_ENDPOINT,
    total,
    pages,
    records,
  };
}

function isManualVerificationError(error) {
  return error?.code === "AGENT_SELLER_VERIFICATION_REQUIRED" || /短信|验证码|滑块|captcha|verification/i.test(errorMessage(error));
}

function shopResultSummary(shopResult) {
  return {
    shopName: shopResult.shopName,
    mallId: shopResult.mall?.mallId || "",
    ok: shopResult.ok,
    settlementRecords: shopResult.settlement?.records?.length || 0,
    onlineLabelFeeRecords: shopResult.onlineLabelFees?.records?.length || 0,
    error: shopResult.error || "",
  };
}

function compactCollectionResults(results) {
  return results.map((accountResult) => ({
    account: accountResult.account,
    ok: accountResult.ok,
    error: accountResult.error || "",
    recordCount: accountResult.records?.length || 0,
    regions: (accountResult.regions || []).map((regionResult) => ({
      region: regionResult.region,
      regionLabel: regionResult.regionLabel,
      origin: regionResult.origin,
      ok: regionResult.ok,
      error: regionResult.error || "",
      targetUrls: regionResult.targetUrls,
      recordCount: regionResult.records?.length || 0,
      summary: regionResult.summary || [],
      shops: (regionResult.shops || []).map((shopResult) => ({
        ...shopResultSummary(shopResult),
        settlement: shopResult.settlement
          ? {
              ok: shopResult.settlement.ok,
              sections: (shopResult.settlement.sections || []).map((section) => ({
                endpoint: section.endpoint,
                settlementState: section.settlementState,
                recordType: section.recordType,
                total: section.total,
                totals: section.totals,
                recordCount: section.records?.length || 0,
                pages: section.pages,
              })),
            }
          : null,
        onlineLabelFees: shopResult.onlineLabelFees
          ? {
              ok: shopResult.onlineLabelFees.ok,
              endpoint: shopResult.onlineLabelFees.endpoint,
              total: shopResult.onlineLabelFees.total,
              recordCount: shopResult.onlineLabelFees.records?.length || 0,
              pages: shopResult.onlineLabelFees.pages,
            }
          : null,
      })),
    })),
  }));
}

async function collectRegion(context, page, account, region, shops, options) {
  const regionResult = {
    region: region.code,
    regionLabel: region.label,
    origin: region.origin,
    ok: true,
    targetUrls: {
      settlement: targetUrlFor(region, "settle"),
      onlineLabelFees: targetUrlFor(region, "stml"),
    },
    shops: [],
    records: [],
  };

  const firstPageType = options.onlyOnlineLabelFees ? "stml" : "settle";
  const firstPage = await ensureAgentPage(context, page, region, firstPageType);
  const mallListCall = await agentApiPost(firstPage, region, USER_INFO_ENDPOINT, {}, { label: `${region.label} 店铺列表接口` });
  const mallsPayload = mallListCall.json;

  for (const shopName of shops) {
    const shopResult = {
      shopName,
      ok: true,
      mall: null,
      settlement: null,
      onlineLabelFees: null,
      records: [],
    };
    try {
      const mall = resolveMallByExactName(mallsPayload, shopName);
      shopResult.mall = {
        mallId: mall.mallId,
        mallName: mall.mallName,
        raw: mall.raw,
      };
      const collectionContext = {
        account,
        region,
        shopName,
        mall: shopResult.mall,
        range: options.range,
        options,
      };
      if (!options.onlyOnlineLabelFees) {
        shopResult.settlement = await collectSettlement(firstPage, collectionContext);
        shopResult.records.push(...shopResult.settlement.records);
      }
    } catch (error) {
      if (isManualVerificationError(error)) throw error;
      shopResult.ok = false;
      shopResult.error = errorMessage(error);
    }
    regionResult.shops.push(shopResult);
  }

  const stmlPage = options.onlyOnlineLabelFees ? firstPage : await ensureAgentPage(context, firstPage, region, "stml");
  await primeStmlPage(stmlPage);
  for (const shopResult of regionResult.shops) {
    if (!shopResult.mall) continue;
    try {
      const collectionContext = {
        account,
        region,
        shopName: shopResult.shopName,
        mall: shopResult.mall,
        range: options.range,
        options,
      };
      shopResult.onlineLabelFees = await collectOnlineLabelFees(stmlPage, collectionContext);
      shopResult.records.push(...shopResult.onlineLabelFees.records);
    } catch (error) {
      if (isManualVerificationError(error)) throw error;
      shopResult.ok = false;
      shopResult.error = shopResult.error ? `${shopResult.error}；${errorMessage(error)}` : errorMessage(error);
    }
  }

  regionResult.records = regionResult.shops.flatMap((shop) => shop.records);
  regionResult.ok = regionResult.shops.every((shop) => shop.ok);
  regionResult.summary = regionResult.shops.map(shopResultSummary);
  return regionResult;
}

async function runAccount(account, options) {
  const shops = selectedShopsForAccount(account, options);
  if (shops.length === 0) fail("SHOP_LIST_EMPTY", `${account.id} 没有配置 TEMU_PROFIT_SHOPS、TEMU_FUNDS_SHOPS 或 account.shops`);

  console.error(`Running profit reconciliation account: ${account.label || account.id}; shops=${shops.join(", ")}; regions=${options.regions.map((region) => region.code).join(",")}`);
  const firstTargetUrl = targetUrlFor(options.regions[0], "settle");
  const { browser, context, page } = await connectCdpChrome(firstTargetUrl, {
    cdpPort: account.cdpPort,
    cdpProfileDir: account.cdpProfileDir,
    temuHomeUrl: firstTargetUrl,
  });

  await installStmlAntiContentHook(context);
  try {
    const regions = [];
    for (const region of options.regions) {
      try {
        const regionResult = await collectRegion(context, page, account, region, shops, options);
        regions.push(regionResult);
        const rowCount = regionResult.records.length;
        console.error(`${account.id}: ${region.label} collected ${rowCount} normalized records.`);
      } catch (error) {
        if (isManualVerificationError(error)) throw error;
        regions.push({
          region: region.code,
          regionLabel: region.label,
          origin: region.origin,
          ok: false,
          error: errorMessage(error),
          shops: [],
          records: [],
        });
        console.error(`${account.id}: ${region.label} failed: ${errorMessage(error)}`);
      }
    }

    return {
      account: {
        id: account.id,
        label: account.label || account.id,
        shops,
        cdpPort: account.cdpPort,
        cdpProfileDir: account.cdpProfileDir,
      },
      ok: regions.every((region) => region.ok),
      regions,
      records: regions.flatMap((region) => region.records || []),
    };
  } finally {
    await closeCdpPages(context).catch(() => {});
    if (process.env.TEMU_CLOSE_CHROME_PROCESS !== "0") {
      await browser.close().catch(() => {});
    }
    await closeCdpChromeProcess(account.cdpPort).catch(() => {});
  }
}

function submitConfig(options) {
  const baseUrl = cleanText(process.env.STOCKHELP_BASE_URL).replace(/\/+$/, "");
  const token = process.env.STOCKHELP_INTEGRATION_API_TOKEN || process.env.INTEGRATION_API_TOKEN || "";
  const defaultPath = options.onlyOnlineLabelFees ? DEFAULT_ONLINE_LABEL_FEE_SUBMIT_PATH : DEFAULT_SUBMIT_PATH;
  const pathValue = cleanText(process.env.TEMU_PROFIT_SUBMIT_PATH) || defaultPath;
  return {
    configured: Boolean(baseUrl && token),
    baseUrl,
    path: pathValue,
    url: baseUrl ? `${baseUrl}${pathValue}` : "",
    token,
  };
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function countSummaryFromChunks(chunks) {
  return chunks.reduce(
    (summary, chunk) => ({
      receivedCount: summary.receivedCount + Number(chunk.receivedCount || 0),
      matchedCount: summary.matchedCount + Number(chunk.matchedCount || 0),
      addedCount: summary.addedCount + Number(chunk.addedCount || 0),
      updatedCount: summary.updatedCount + Number(chunk.updatedCount || 0),
    }),
    { receivedCount: 0, matchedCount: 0, addedCount: 0, updatedCount: 0 },
  );
}

function summarizeProfitResponse(parsed) {
  const data = parsed?.data || {};
  return {
    sourceRunId: data.sourceRunId ?? null,
    range: data.range ?? null,
    receivedRecordCount: Number(data.receivedRecordCount || 0),
    normalizedRecordCount: data.normalizedRecordCount || {},
    settlementSummary: data.settlementSummary || {},
    onlineLabelFeeSummary: data.onlineLabelFeeSummary || {},
    reconciliation: data.reconciliation || null,
  };
}

function submitGroupKey(record) {
  const shop = record?.shop && typeof record.shop === "object" ? record.shop : {};
  return [
    cleanText(record?.accountId),
    cleanText(record?.region),
    cleanText(shop.mallId),
    cleanText(shop.name),
  ].join("\u0000");
}

function groupedProfitRecords(records) {
  const groups = new Map();
  for (const record of records) {
    const key = submitGroupKey(record);
    const group = groups.get(key) || [];
    group.push(record);
    groups.set(key, group);
  }
  return [...groups.values()];
}

async function postProfitPayload(config, payload) {
  const response = await fetch(config.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.token}`,
    },
    body: JSON.stringify(payload),
  });
  const bodyText = await response.text();
  if (!response.ok) {
    return {
      ok: false,
      httpStatus: response.status,
      bodyPreview: bodyText.slice(0, 1000),
    };
  }
  return {
    ok: true,
    httpStatus: response.status,
    response: summarizeProfitResponse(bodyText ? JSON.parse(bodyText) : null),
  };
}

async function submitOnlineLabelFees(output, config, safeConfig) {
  const onlineLabelRecords = output.records.filter((record) => record.recordType === "online_label_fee");
  const dropSummary = {
    invalidRecordCount: 0,
    unsupportedReconciliationTypeCount: 0,
    unsupportedReconciliationTypes: {},
  };
  const fees = onlineLabelRecords.map((record) => onlineLabelFeePayloadFromRecord(record, dropSummary)).filter(Boolean);

  if (fees.length === 0) {
    return {
      ...safeConfig,
      status: "submitted",
      message: "No online_label_fee records to submit.",
      receivedRecordCount: 0,
      droppedRecordCount: onlineLabelRecords.length,
      dropSummary,
      chunkSize: 2000,
      chunks: [],
      summary: { receivedCount: 0, matchedCount: 0, addedCount: 0, updatedCount: 0 },
    };
  }

  const chunks = [];
  const feeChunks = chunkArray(fees, 2000);
  for (let index = 0; index < feeChunks.length; index += 1) {
    const response = await fetch(config.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify({
        sourceRunId: output.sourceRunId,
        fees: feeChunks[index],
      }),
    });
    const bodyText = await response.text();
    if (!response.ok) {
      return {
        ...safeConfig,
        status: "failed",
        httpStatus: response.status,
        failedChunkIndex: index + 1,
        chunkCount: feeChunks.length,
        bodyPreview: bodyText.slice(0, 1000),
        chunks,
      };
    }

    const parsed = bodyText ? JSON.parse(bodyText) : null;
    const data = parsed?.data || {};
    chunks.push({
      index: index + 1,
      httpStatus: response.status,
      receivedCount: Number(data.receivedCount || 0),
      matchedCount: Number(data.matchedCount || 0),
      addedCount: Number(data.addedCount || 0),
      updatedCount: Number(data.updatedCount || 0),
      summaryCount: Array.isArray(data.summaries) ? data.summaries.length : 0,
    });
  }

  return {
    ...safeConfig,
    status: "submitted",
    httpStatus: 200,
    receivedRecordCount: fees.length,
    droppedRecordCount: onlineLabelRecords.length - fees.length,
    dropSummary,
    chunkSize: 2000,
    chunkCount: feeChunks.length,
    chunks,
    summary: countSummaryFromChunks(chunks),
  };
}

async function submitIfEnabled(output, options) {
  const config = submitConfig(options);
  const safeConfig = {
    configured: config.configured,
    baseUrl: config.baseUrl || "",
    path: config.path,
    url: config.url || "",
  };

  if (options.dryRun) {
    return {
      ...safeConfig,
      status: "dry-run",
      message: "TEMU_PROFIT_DRY_RUN=1; no StockHelp request sent.",
    };
  }
  if (!config.configured) {
    return {
      ...safeConfig,
      status: "skipped",
      message: "Missing STOCKHELP_BASE_URL or integration token; no StockHelp request sent.",
    };
  }

  if (options.onlyOnlineLabelFees) {
    return await submitOnlineLabelFees(output, config, safeConfig);
  }

  const recordGroups = output.records.length > 10000 ? groupedProfitRecords(output.records) : [output.records];
  const chunks = [];
  for (let index = 0; index < recordGroups.length; index += 1) {
    const records = recordGroups[index];
    const result = await postProfitPayload(config, {
      sourceRunId: output.sourceRunId,
      platform: "TEMU",
      generatedAt: output.generatedAt,
      range: output.range,
      accounts: output.results.map((item) => item.account),
      records,
    });
    if (!result.ok) {
      return {
        ...safeConfig,
        status: "failed",
        httpStatus: result.httpStatus,
        failedChunkIndex: index + 1,
        chunkCount: recordGroups.length,
        bodyPreview: result.bodyPreview,
        chunks,
      };
    }
    chunks.push({
      index: index + 1,
      httpStatus: result.httpStatus,
      recordCount: records.length,
      response: result.response,
    });
  }
  return {
    ...safeConfig,
    status: "submitted",
    httpStatus: 200,
    receivedRecordCount: output.records.length,
    chunkMode: recordGroups.length > 1 ? "account-region-shop" : "single",
    chunkCount: recordGroups.length,
    chunks,
  };
}

function summaryByType(records) {
  const summary = {};
  for (const record of records) {
    summary[record.recordType] = (summary[record.recordType] || 0) + 1;
  }
  return summary;
}

async function main() {
  await loadLocalEnv();
  const options = parseOptions();
  await fs.mkdir(options.reportDir, { recursive: true });

  const rawConfig = JSON.parse(await fs.readFile(accountsPath, "utf8"));
  const accounts = (rawConfig.accounts || []).filter((account) => options.accountIds.length === 0 || options.accountIds.includes(account.id));
  if (accounts.length === 0) fail("ACCOUNT_NOT_FOUND", `没有匹配账号：${options.accountIds.join(",") || "(all)"}`);

  const results = [];
  for (const account of accounts) {
    try {
      results.push(await runAccount(account, options));
    } catch (error) {
      const message = errorMessage(error);
      console.error(`【${account.label || account.id}】失败：${message}`);
      results.push({
        account: {
          id: account.id,
          label: account.label || account.id,
          shops: selectedShopsForAccount(account, options),
          cdpPort: account.cdpPort,
          cdpProfileDir: account.cdpProfileDir,
        },
        ok: false,
        error: message,
        regions: [],
        records: [],
      });
      if (isManualVerificationError(error)) break;
    }
  }

  const records = results.flatMap((result) => result.records || []);
  const reportResults = options.omitRaw ? compactCollectionResults(results) : results;
  const output = {
    generatedAt: new Date().toISOString(),
    sourceRunId,
    ok: results.every((result) => result.ok),
    dryRun: options.dryRun,
    accountsPath,
    range: options.range,
    regions: options.regions.map((region) => ({ code: region.code, label: region.label, origin: region.origin })),
    reportModel: {
      settlementEndpoints: [UNSETTLE_ENDPOINT, SETTLED_ORDER_ENDPOINT, SETTLED_PO_ENDPOINT],
      onlineLabelFeesEndpoint: STML_RECON_LIST_ENDPOINT,
      pagination: {
        settlement: "pageNum/pageSize",
        onlineLabelFees: "serial scrollContext",
      },
    },
    recordSummary: summaryByType(records),
    records,
    results: reportResults,
  };
  output.stockHelp = await submitIfEnabled(output, options);

  const suffix = output.ok ? "json" : "error.json";
  const outputPath = path.join(options.reportDir, `temu-profit-reconciliation-${stamp}.${suffix}`);
  output.outputPath = outputPath;
  await fs.writeFile(outputPath, JSON.stringify(output, null, 2));

  console.log(`Records: ${records.length}`);
  console.log(`Record summary: ${JSON.stringify(output.recordSummary)}`);
  console.log(`StockHelp: ${output.stockHelp.status}`);
  console.log(`Saved JSON: ${outputPath}`);
  if (!output.ok || output.stockHelp.status === "failed") process.exitCode = 1;
}

await main().catch(async (error) => {
  const dryRun = truthy(process.env.TEMU_PROFIT_DRY_RUN);
  const reportDir = process.env.TEMU_REPORT_DIR || path.join(rootDir, "temu-reports", dryRun ? "debug" : "");
  const outputPath = path.join(reportDir, `temu-profit-reconciliation-${stamp}.error.json`);
  await fs.mkdir(reportDir, { recursive: true }).catch(() => {});
  await fs.writeFile(
    outputPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        sourceRunId,
        ok: false,
        error: errorMessage(error),
      },
      null,
      2,
    ),
  ).catch(() => {});
  console.error(errorMessage(error));
  console.error(`Saved JSON: ${outputPath}`);
  process.exitCode = 1;
});

if (process.env.TEMU_CLOSE_CHROME_PROCESS === "0") {
  process.exit(process.exitCode || 0);
}
