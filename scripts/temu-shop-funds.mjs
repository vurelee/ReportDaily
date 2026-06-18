import fs from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { closeCdpChromeProcess, closeCdpPages } from "./cdp-page-cleanup.mjs";
import {
  enterAgentAuthenticationIfShown,
  isAgentAuthenticationUrl,
  loginSellerIfNeeded,
  needsVerification,
  waitForMatchingPage,
} from "./temu-login-helper.mjs";
import { temuPageApiPost } from "./temu-page-api-client.mjs";
import { extractMallList, resolveMallByExactName } from "./temu-mall-resolver.mjs";
import { closeTemuPopups } from "./temu-popup-cleaner.mjs";
import { collectSuccessfulWithdrawalRecordsByShopName } from "./temu-shop-withdrawal-records.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const accountsPath = process.env.TEMU_ACCOUNTS_CONFIG || path.join(rootDir, "temu-accounts.json");
const reportDir = process.env.TEMU_REPORT_DIR || path.join(rootDir, "temu-reports");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const targetUrl = process.env.TEMU_SHOP_FUNDS_URL || "https://seller.kuajingmaihuo.com/labor/account";
const SELLER_ORIGIN = "https://seller.kuajingmaihuo.com";
const USER_INFO_ENDPOINT = "/bg/quiet/api/mms/userInfo";
const MALL_ENTITY_ENDPOINT = "/api/merchant/payment/account/mall/entity/query";
const AMOUNT_INFO_ENDPOINT = "/api/merchant/payment/account/amount/info";
const WITHDRAW_CASH_RECORD_ENDPOINT = "/api/merchant/payment/account/withdraw/cash/record";
const AGENT_USER_INFO_ENDPOINT = "/api/seller/auth/userInfo";
const SEMI_UNSETTLE_ENDPOINT = "/api/xiaowenhou/settle-flow/sm/unsettle/page-query";
const FULL_WAIT_SETTLEMENT_ENDPOINT = "/api/merchant/settle/detail/full/wait-settlement";
const SETTLED_WITHDRAWAL_STATUSES = new Set(["发起申请", "银行处理中"]);

const AGENT_REGIONS = [
  { key: "eu", label: "欧区", origin: "https://agentseller-eu.temu.com" },
  { key: "us", label: "美区", origin: "https://agentseller-us.temu.com" },
  { key: "global", label: "全球区", origin: "https://agentseller.temu.com" },
];

const FUND_SHOP_REGISTRY = {
  "setonr": {
    semiManaged: ["SETONR Products", "SETONR Origin"],
    fullManaged: ["SETONR"],
  },
  "whitine-leeev": {
    semiManaged: ["Whitine Products Global", "LEEEV Global Outlet", "LEEEV"],
    fullManaged: ["Whitine Products"],
  },
  wonder: {
    semiManaged: ["Wonder Products"],
    fullManaged: [],
  },
};

await fs.mkdir(reportDir, { recursive: true });

class TemuShopFundsError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "TemuShopFundsError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new TemuShopFundsError(code, message);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function moneyNumber(value) {
  const parsed = Number(String(value || "").replace(/[￥¥,\s]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function amountValue(amount) {
  const parsed = Number(amount?.value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function amountTextFromValue(value) {
  return (value / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function shanghaiTodayParts() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(byType.year),
    month: Number(byType.month),
    day: Number(byType.day),
  };
}

function dateKey(parts) {
  return [
    String(parts.year).padStart(4, "0"),
    String(parts.month).padStart(2, "0"),
    String(parts.day).padStart(2, "0"),
  ].join("-");
}

function addDays(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function compareDateParts(a, b) {
  return dateKey(a).localeCompare(dateKey(b));
}

function recentDateWindows(totalDays = 60, maxWindowDays = 30) {
  const end = shanghaiTodayParts();
  const start = addDays(end, -(totalDays - 1));
  const windows = [];
  for (let cursor = start; compareDateParts(cursor, end) <= 0;) {
    const windowEnd = [addDays(cursor, maxWindowDays - 1), end].sort(compareDateParts)[0];
    windows.push({
      startDate: dateKey(cursor),
      endDate: dateKey(windowEnd),
    });
    cursor = addDays(windowEnd, 1);
  }
  return windows;
}

function selectedAccountIds() {
  return String(process.env.TEMU_ACCOUNT_ID || process.env.TEMU_ACCOUNT_IDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function shopListForAccount(account) {
  const override = String(process.env.TEMU_FUNDS_SHOPS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (override.length > 0) return override;
  const registry = FUND_SHOP_REGISTRY[account.id] || {};
  return [
    ...new Set([
      ...(account.shops || []),
      ...(registry.semiManaged || []),
      ...(registry.fullManaged || []),
    ]),
  ];
}

function pendingShopType(account, shopName) {
  const registry = FUND_SHOP_REGISTRY[account.id] || {};
  if ((registry.semiManaged || []).includes(shopName)) return "semi-managed";
  if ((registry.fullManaged || []).includes(shopName)) return "full-managed";
  return "";
}

function execFileText(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (error) {
        if (error.code === 1) {
          resolve("");
          return;
        }
        reject(new Error(`${command} ${args.join(" ")} failed: ${stderr || error.message}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function cdpEndpoint(account) {
  return `http://127.0.0.1:${account.cdpPort}`;
}

async function isCdpReady(account) {
  try {
    const response = await fetch(`${cdpEndpoint(account)}/json/version`);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForCdp(account, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isCdpReady(account)) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  fail("CDP_ENDPOINT_NOT_READY", `Chrome CDP endpoint not ready: ${cdpEndpoint(account)}`);
}

function chromeArgs(account, url) {
  return [
    ...(process.env.TEMU_CDP_HEADLESS === "1" ? ["--headless=new"] : []),
    `--remote-debugging-port=${account.cdpPort}`,
    `--user-data-dir=${account.cdpProfileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-features=CalculateNativeWinOcclusion",
    "--window-size=1440,1000",
    url,
  ];
}

function launchWithOpen(account, url) {
  spawn("open", ["-na", "Google Chrome", "--args", ...chromeArgs(account, url)], {
    detached: true,
    stdio: "ignore",
  }).unref();
}

function launchWithChromeBinary(account, url) {
  const chromeExecutable = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (!existsSync(chromeExecutable)) return false;
  spawn(chromeExecutable, chromeArgs(account, url), { detached: true, stdio: "ignore" }).unref();
  return true;
}

async function resetCdpChrome(account) {
  const stdout = await execFileText("lsof", [
    "-tiTCP:" + String(account.cdpPort),
    "-sTCP:LISTEN",
  ]);
  const pids = stdout
    .split(/\s+/)
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isFinite(value));

  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process may have exited between lsof and kill.
    }
  }

  if (pids.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

async function ensureCdpChrome(account, url = targetUrl) {
  if (await isCdpReady(account)) return;

  if (process.env.TEMU_CDP_HEADLESS === "1") {
    if (!launchWithChromeBinary(account, url)) {
      fail("CHROME_EXECUTABLE_NOT_FOUND", "Google Chrome executable not found for headless CDP launch");
    }
    await waitForCdp(account, 25000);
    return;
  }

  launchWithOpen(account, url);
  try {
    await waitForCdp(account);
  } catch (error) {
    if (!launchWithChromeBinary(account, url)) throw error;
    await waitForCdp(account, 25000);
  }
}

async function connectCdpChrome(account, url = targetUrl) {
  await ensureCdpChrome(account, url);
  try {
    return await openCdpSession(account);
  } catch {
    await resetCdpChrome(account);
    await ensureCdpChrome(account, url);
    return await openCdpSession(account);
  }
}

async function openCdpSession(account) {
  const browser = await chromium.connectOverCDP(cdpEndpoint(account));
  const context = browser.contexts()[0] || (await browser.newContext());
  const pages = context.pages().filter((candidate) => !candidate.isClosed());
  const page =
    pages.find((candidate) => candidate.url().startsWith("https://seller.kuajingmaihuo.com/")) ||
    pages[0] ||
    (await context.newPage());
  return { browser, context, page };
}

async function waitSettled(page) {
  if (!page || page.isClosed()) return;
  await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
  if (page.isClosed()) return;
  await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
  if (page.isClosed()) return;
  await page.waitForTimeout(700).catch(() => {});
  if (page.isClosed()) return;
  await closeTemuPopups(page).catch(() => {});
}

async function bodyText(page, timeout = 10000) {
  return await page.locator("body").innerText({ timeout }).catch(() => "");
}

function agentTargetUrl(region) {
  return `${region.origin}/labor/settle`;
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

async function ensureAgentSettlePage(context, page, region) {
  let activePage = page.isClosed() ? await context.newPage() : page;
  const target = agentTargetUrl(region);
  await activePage.goto(target, { waitUntil: "domcontentloaded" }).catch(() => {});

  for (let attempt = 0; attempt < 6; attempt += 1) {
    await waitSettled(activePage);
    const text = await bodyText(activePage, 3000);
    if (needsVerification(text)) {
      fail("AGENT_SELLER_VERIFICATION_REQUIRED", `${region.label} AgentSeller 页面需要短信或验证码`);
    }
    if (!activePage.isClosed() && activePage.url().startsWith(target)) return activePage;

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
    await activePage.goto(target, { waitUntil: "domcontentloaded" }).catch(() => {});
  }

  fail("AGENT_SETTLE_PAGE_NOT_READY", `${region.label} AgentSeller 结算页未进入成功`);
}

async function sellerApiPost(page, endpoint, body = {}, { mallId } = {}, label = "Seller Center API") {
  const response = await temuPageApiPost(page, {
    origin: SELLER_ORIGIN,
    endpoint,
    body,
    mallId,
    label,
    headers: {
      accept: "*/*",
    },
  });

  if (!response?.ok) {
    fail("SELLER_API_HTTP_FAILED", `${label} HTTP ${response?.status || "unknown"}：${(response?.bodyText || "").slice(0, 1000)}`);
  }
  const responseBody = response.json;
  if (!responseBody || typeof responseBody !== "object") {
    fail("SELLER_API_RESPONSE_NOT_JSON", `${label} 返回非 JSON：${(response.bodyText || "").slice(0, 1000)}`);
  }
  const errorCode = responseBody.errorCode ?? responseBody.error_code;
  if (responseBody.success === false || (errorCode !== undefined && Number(errorCode) !== 1000000)) {
    const message = responseBody.errorMsg || responseBody.error_msg || responseBody.message || "unknown";
    fail("SELLER_API_RESPONSE_FAILED", `${label} 返回失败：code=${errorCode ?? "unknown"} msg=${message}`);
  }
  return responseBody.result ?? {};
}

async function agentSellerApiPost(page, region, endpoint, body = {}, { mallId } = {}, label = "AgentSeller API") {
  const response = await temuPageApiPost(page, {
    origin: region.origin,
    endpoint,
    body,
    mallId,
    label,
  });

  if (!response?.ok) {
    fail("AGENT_API_HTTP_FAILED", `${label} HTTP ${response?.status || "unknown"}：${(response?.bodyText || "").slice(0, 1000)}`);
  }
  const responseBody = response.json;
  if (!responseBody || typeof responseBody !== "object") {
    fail("AGENT_API_RESPONSE_NOT_JSON", `${label} 返回非 JSON：${(response.bodyText || "").slice(0, 1000)}`);
  }
  const errorCode = responseBody.errorCode ?? responseBody.error_code;
  if (responseBody.success === false || (errorCode !== undefined && Number(errorCode) !== 1000000)) {
    const message = responseBody.errorMsg || responseBody.error_msg || responseBody.message || "unknown";
    fail("AGENT_API_RESPONSE_FAILED", `${label} 返回失败：code=${errorCode ?? "unknown"} msg=${message}`);
  }
  return responseBody.result ?? {};
}

async function sellerMallList(page) {
  const result = await sellerApiPost(page, USER_INFO_ENDPOINT, {}, {}, "卖家中心店铺列表接口");
  const malls = extractMallList(result);
  if (!Array.isArray(malls) || malls.length === 0) {
    fail("SELLER_MALL_LIST_EMPTY", "卖家中心店铺列表接口没有返回可切换店铺");
  }
  return malls;
}

async function agentMallList(page, region) {
  const result = await agentSellerApiPost(page, region, AGENT_USER_INFO_ENDPOINT, {}, {}, `${region.label} 店铺列表接口`);
  const malls = extractMallList(result);
  if (!Array.isArray(malls) || malls.length === 0) {
    fail("AGENT_MALL_LIST_EMPTY", `${region.label} 店铺列表接口没有返回可切换店铺`);
  }
  return malls;
}

function mallInfoForShop(malls, shopName) {
  let resolved;
  try {
    resolved = resolveMallByExactName(malls, shopName);
  } catch (error) {
    const message = errorMessage(error);
    if (message.includes("缺少 mallId")) {
      fail("SELLER_SHOP_MALL_ID_MISSING", `卖家中心店铺列表中 ${shopName} 缺少 mallId`);
    }
    const matches = extractMallList(malls).filter((mall) => cleanText(mall.mallName ?? mall.mall_name) === shopName);
    fail("SELLER_SHOP_TARGET_NOT_FOUND", `卖家中心店铺列表中找不到唯一精确店名：${shopName}；匹配数=${matches.length}`);
  }

  const mall = resolved.raw;
  return {
    mallId: resolved.mallId,
    mallName: resolved.mallName,
    mallMode: mall.mallMode,
    isSemiManagedMall: mall.isSemiManagedMall,
  };
}

async function waitForSellerPage(context, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const page = [...context.pages()]
      .reverse()
      .find((candidate) => !candidate.isClosed() && candidate.url().startsWith("https://seller.kuajingmaihuo.com/"));
    if (page) return page;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return null;
}

async function ensureFundsPage(context, page) {
  let activePage = page;
  await activePage.goto(targetUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
  await waitSettled(activePage);

  const text = await bodyText(activePage);
  if (needsVerification(text)) fail("SELLER_LOGIN_VERIFICATION_REQUIRED", "卖家中心登录需要短信或验证码");
  activePage =
    (await loginSellerIfNeeded(context, activePage, {
      fail,
      errorCodes: {
        passwordNotFilled: "SELLER_LOGIN_AUTOFILL_NOT_CONFIRMED",
      },
      messages: {
        passwordNotFilled: "卖家中心登录自动填充或登录完成状态未确认，且没有运行时账号密码",
      },
    })) || activePage;
  if (!activePage.url().startsWith(targetUrl)) {
    activePage = (await waitForSellerPage(context, 3000)) || activePage;
  }
  if (!activePage.url().startsWith(targetUrl)) {
    await activePage.goto(targetUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
    await waitSettled(activePage);
  }
  return activePage;
}

async function domAvailableBalance(page) {
  const text = await bodyText(page);
  const match = text.match(/可用余额\(CNY\)\s*¥\s*([0-9,]+(?:\.\d+)?)/);
  return match?.[1] || "";
}

async function collectWithdrawalRecords(page, shopName, mallInfo) {
  const pageSize = 100;
  const records = [];
  let total = 0;

  for (let pageNo = 1; pageNo <= 50; pageNo += 1) {
    const body = { page: pageNo, pageSize };
    const result = await sellerApiPost(
      page,
      WITHDRAW_CASH_RECORD_ENDPOINT,
      body,
      { mallId: mallInfo.mallId },
      `${shopName} 提现记录接口`,
    );
    const resultList = Array.isArray(result.resultList) ? result.resultList : [];
    total = Number(result.total || resultList.length || total);
    records.push(...resultList);
    if (records.length >= total || resultList.length === 0) break;
  }

  const targetRecords = records.filter((record) => SETTLED_WITHDRAWAL_STATUSES.has(cleanText(record.withdrawCashStatus)));
  const totalsByStatus = Object.fromEntries([...SETTLED_WITHDRAWAL_STATUSES].map((status) => [status, 0]));
  for (const record of targetRecords) {
    const status = cleanText(record.withdrawCashStatus);
    totalsByStatus[status] += amountValue(record.withdrawCashAmountFormat);
  }

  const totalAmountInCents = Object.values(totalsByStatus).reduce((sum, value) => sum + value, 0);
  return {
    endpoint: `${SELLER_ORIGIN}${WITHDRAW_CASH_RECORD_ENDPOINT}`,
    request: {
      mallId: mallInfo.mallId,
      pageSize,
    },
    totalRecords: total,
    matchedRecords: targetRecords.map((record) => ({
      fundAccount: record.fundAccount || "",
      createTime: record.createTime || "",
      withdrawCashAmount: record.withdrawCashAmount || "",
      withdrawCashStatus: record.withdrawCashStatus || "",
      statusCode: record.statusCode ?? null,
      beneficiaryAccount: record.beneficiaryAccount || "",
      withdrawOrderId: record.withdrawOrderId || "",
      withdrawCashAmountFormat: record.withdrawCashAmountFormat || formatAmountObject(0),
    })),
    totalsByStatus: Object.fromEntries(
      Object.entries(totalsByStatus).map(([status, value]) => [status, formatAmountObject(value)]),
    ),
    totalAmount: formatAmountObject(totalAmountInCents),
  };
}

async function collectShopFunds(page, shopName, mallInfo, shopType = "") {
  const apiOptions = { mallId: mallInfo.mallId };
  const entity = await sellerApiPost(page, MALL_ENTITY_ENDPOINT, {}, apiOptions, `${shopName} 当前店铺实体接口`);
  const currentMallId = String(entity.mallId || "");
  if (currentMallId !== mallInfo.mallId) {
    fail("SELLER_CURRENT_MALL_MISMATCH", `${shopName} mallId 校验失败；期望=${mallInfo.mallId}，实际=${currentMallId || "unknown"}`);
  }

  const amount = await sellerApiPost(page, AMOUNT_INFO_ENDPOINT, {}, apiOptions, `${shopName} 资金余额接口`);
  const availableBalance = String(amount.availableBalance ?? "");
  const availableBalanceText = amount.availableBalanceFormat?.digitalText || availableBalance;
  const availableBalanceAmountInCents = amountValue(amount.availableBalanceFormat);
  const withdrawalRecords = await collectWithdrawalRecords(page, shopName, mallInfo);
  const successfulWithdrawalRecords = await collectSuccessfulWithdrawalRecordsByShopName(page, shopName, {
    mallId: mallInfo.mallId,
    sellerApiPost,
  });
  const settledAmountInCents = availableBalanceAmountInCents + amountValue(withdrawalRecords.totalAmount);
  const domBalance = await domAvailableBalance(page);

  return {
    shopName,
    mallId: mallInfo.mallId,
    shopType: shopType || (mallInfo.isSemiManagedMall ? "semi-managed" : ""),
    currency: amount.currency || amount.availableBalanceFormat?.currencyCode || "CNY",
    settledFunds: {
      label: "可提现金额",
      availableBalanceLabel: "可用余额",
      availableBalance,
      availableBalanceText,
      availableBalanceAmountInCents,
      withdrawalRecords,
      amountInCents: settledAmountInCents,
      totalAmountText: amountTextFromValue(settledAmountInCents),
      domBalanceText: moneyNumber(domBalance) === moneyNumber(availableBalanceText) ? domBalance : "",
    },
    successfulWithdrawalRecords,
    pendingFunds: null,
    source: "seller-center-page-api",
    apiReport: {
      source: "seller-center-page-api",
      endpoints: {
        mallList: `${SELLER_ORIGIN}${USER_INFO_ENDPOINT}`,
        currentMall: `${SELLER_ORIGIN}${MALL_ENTITY_ENDPOINT}`,
        amountInfo: `${SELLER_ORIGIN}${AMOUNT_INFO_ENDPOINT}`,
        withdrawCashRecord: `${SELLER_ORIGIN}${WITHDRAW_CASH_RECORD_ENDPOINT}`,
      },
      request: {
        mallId: mallInfo.mallId,
        body: {},
      },
    },
  };
}

function formatAmountObject(value, currencyCode = "CNY") {
  return {
    value,
    symbol: "¥",
    currencyCode,
    digitalText: amountTextFromValue(value),
  };
}

function addAmount(totals, key, amount) {
  totals[key] = (totals[key] || 0) + amountValue(amount);
}

function regionAmountSummary(region, result, request) {
  return {
    region: region.key,
    regionLabel: region.label,
    request,
    totalRows: Number(result.total || 0),
    totalAmount: result.totalAmount || formatAmountObject(0),
    productPaymentTotalAmount: result.productPaymentTotalAmount || formatAmountObject(0),
    productRefundTotalAmount: result.productRefundTotalAmount || formatAmountObject(0),
    shippingPaymentTotalAmount: result.shippingPaymentTotalAmount || formatAmountObject(0),
    shippingRefundTotalAmount: result.shippingRefundTotalAmount || formatAmountObject(0),
    dataUpdateTime: result.dataUpdateTime || "",
  };
}

function ensurePendingEntry(pendingByShop, shopName, type) {
  if (!pendingByShop.has(shopName)) {
    pendingByShop.set(shopName, {
      type,
      label: type === "full-managed" ? "预估待结算销售额(CNY)" : "待处理款项总额",
      currency: "CNY",
      totalAmount: formatAmountObject(0),
      regions: {},
      source: "agentseller-settle-page-api",
    });
  }
  return pendingByShop.get(shopName);
}

function recomputePendingTotal(entry) {
  const total = Object.values(entry.regions || {}).reduce((sum, region) => {
    const amount = region.waitSettleAmount || region.totalAmount;
    return sum + amountValue(amount);
  }, 0);
  entry.totalAmount = formatAmountObject(total, entry.currency || "CNY");
}

async function collectSemiPendingRegion(page, region, shopName, mallInfo, dateWindows) {
  const windows = [];
  const totals = {
    totalRows: 0,
    totalAmount: 0,
    productPaymentTotalAmount: 0,
    productRefundTotalAmount: 0,
    shippingPaymentTotalAmount: 0,
    shippingRefundTotalAmount: 0,
  };
  let dataUpdateTime = "";

  for (const dateWindow of dateWindows) {
    const body = {
      pageSize: 1,
      pageNum: 1,
      orderCreateTimeStart: dateWindow.startDate,
      orderCreateTimeEnd: dateWindow.endDate,
    };
    const result = await agentSellerApiPost(
      page,
      region,
      SEMI_UNSETTLE_ENDPOINT,
      body,
      { mallId: mallInfo.mallId },
      `${region.label} ${shopName} 半托待处理款项接口`,
    );
    addAmount(totals, "totalAmount", result.totalAmount);
    addAmount(totals, "productPaymentTotalAmount", result.productPaymentTotalAmount);
    addAmount(totals, "productRefundTotalAmount", result.productRefundTotalAmount);
    addAmount(totals, "shippingPaymentTotalAmount", result.shippingPaymentTotalAmount);
    addAmount(totals, "shippingRefundTotalAmount", result.shippingRefundTotalAmount);
    totals.totalRows += Number(result.total || 0);
    dataUpdateTime = result.dataUpdateTime || dataUpdateTime;
    windows.push(regionAmountSummary(region, result, { mallId: mallInfo.mallId, body }));
  }

  return {
    region: region.key,
    regionLabel: region.label,
    endpoint: `${region.origin}${SEMI_UNSETTLE_ENDPOINT}`,
    label: "待处理款项总额",
    dateWindows,
    totalRows: totals.totalRows,
    totalAmount: formatAmountObject(totals.totalAmount),
    productPaymentTotalAmount: formatAmountObject(totals.productPaymentTotalAmount),
    productRefundTotalAmount: formatAmountObject(totals.productRefundTotalAmount),
    shippingPaymentTotalAmount: formatAmountObject(totals.shippingPaymentTotalAmount),
    shippingRefundTotalAmount: formatAmountObject(totals.shippingRefundTotalAmount),
    dataUpdateTime,
    windows,
  };
}

async function collectFullPendingRegion(page, region, shopName, mallInfo) {
  const result = await agentSellerApiPost(
    page,
    region,
    FULL_WAIT_SETTLEMENT_ENDPOINT,
    {},
    { mallId: mallInfo.mallId },
    `${region.label} ${shopName} 全托预估待结算接口`,
  );
  const amount = result.res?.waitSettleAmount || result.waitSettleAmount || formatAmountObject(0);
  return {
    region: region.key,
    regionLabel: region.label,
    endpoint: `${region.origin}${FULL_WAIT_SETTLEMENT_ENDPOINT}`,
    label: "预估待结算销售额(CNY)",
    request: {
      mallId: mallInfo.mallId,
      body: {},
    },
    waitSettleAmount: amount,
  };
}

async function collectPendingFunds(context, page, account) {
  const registry = FUND_SHOP_REGISTRY[account.id] || {};
  const selectedShops = new Set(shopListForAccount(account));
  const semiManaged = (registry.semiManaged || []).filter((shopName) => selectedShops.has(shopName));
  const fullManaged = (registry.fullManaged || []).filter((shopName) => selectedShops.has(shopName));
  const pendingByShop = new Map();
  const dateWindows = recentDateWindows(60, 30);

  if (semiManaged.length === 0 && fullManaged.length === 0) {
    return { pendingByShop, dateWindows };
  }

  for (const region of AGENT_REGIONS) {
    const needsSemi = region.key !== "global" && semiManaged.length > 0;
    const needsFull = fullManaged.length > 0;
    if (!needsSemi && !needsFull) continue;

    const regionPage = await ensureAgentSettlePage(context, page, region);
    const malls = await agentMallList(regionPage, region);

    if (needsSemi) {
      for (const shopName of semiManaged) {
        const mallInfo = mallInfoForShop(malls, shopName);
        const entry = ensurePendingEntry(pendingByShop, shopName, "semi-managed");
        entry.regions[region.key] = await collectSemiPendingRegion(regionPage, region, shopName, mallInfo, dateWindows);
        recomputePendingTotal(entry);
        console.error(`${shopName}: ${region.label} 待处理款项 CNY ${entry.regions[region.key].totalAmount.digitalText}`);
      }
    }

    if (needsFull) {
      for (const shopName of fullManaged) {
        const mallInfo = mallInfoForShop(malls, shopName);
        const entry = ensurePendingEntry(pendingByShop, shopName, "full-managed");
        entry.regions[region.key] = await collectFullPendingRegion(regionPage, region, shopName, mallInfo);
        recomputePendingTotal(entry);
        console.error(`${shopName}: ${region.label} 预估待结算 CNY ${entry.regions[region.key].waitSettleAmount.digitalText}`);
      }
    }
  }

  return { pendingByShop, dateWindows };
}

async function runAccount(account) {
  console.error(`Running shop funds account: ${account.label || account.id}`);
  const shops = shopListForAccount(account);
  if (shops.length === 0) fail("SHOP_LIST_EMPTY", `${account.id} 没有配置资金统计店铺`);

  const { browser, context, page } = await connectCdpChrome(account, targetUrl);
  const shopResults = [];
  try {
    const activePage = await ensureFundsPage(context, page);
    const malls = await sellerMallList(activePage);

    for (const shopName of shops) {
      const mallInfo = mallInfoForShop(malls, shopName);
      const result = await collectShopFunds(activePage, shopName, mallInfo, pendingShopType(account, shopName));
      shopResults.push(result);
      console.error(`${shopName}: 可提现金额 CNY ${result.settledFunds.totalAmountText}`);
    }

    const pending = await collectPendingFunds(context, activePage, account);
    for (const shop of shopResults) {
      if (pending.pendingByShop.has(shop.shopName)) {
        shop.pendingFunds = pending.pendingByShop.get(shop.shopName);
      }
    }

    return {
      account,
      ok: true,
      pendingDateWindows: pending.dateWindows,
      shops: shopResults,
    };
  } finally {
    await closeCdpPages(context).catch(() => {});
    await browser.close().catch(() => {});
    await closeCdpChromeProcess(account.cdpPort).catch(() => {});
  }
}

function shopMessage(shop) {
  const parts = [`${shop.shopName} 可提现金额 CNY ${shop.settledFunds.totalAmountText}`];
  if (shop.pendingFunds?.totalAmount?.digitalText) {
    parts.push(`${shop.pendingFunds.label} CNY ${shop.pendingFunds.totalAmount.digitalText}`);
  }
  return parts.join("，");
}

async function main() {
  const rawConfig = JSON.parse(await fs.readFile(accountsPath, "utf8"));
  const selectedIds = selectedAccountIds();
  const accounts = (rawConfig.accounts || []).filter((account) => selectedIds.length === 0 || selectedIds.includes(account.id));
  if (accounts.length === 0) {
    fail("ACCOUNT_NOT_FOUND", `没有匹配账号：${selectedIds.join(",") || "(all)"}`);
  }

  const results = [];
  for (const account of accounts) {
    try {
      results.push(await runAccount(account));
    } catch (error) {
      const message = errorMessage(error);
      console.error(`【${account.label || account.id}】失败：${message}`);
      results.push({ account, ok: false, error: message });
    }
  }

  const ok = results.every((result) => result.ok);
  const output = {
    generatedAt: new Date().toISOString(),
    accountsPath,
    targetUrl,
    message: ok
      ? results
          .flatMap((result) => result.shops || [])
          .map(shopMessage)
          .join("；")
      : results.map((result) => (result.ok ? `【${result.account.label || result.account.id}】成功` : `【${result.account.label || result.account.id}】失败：${result.error}`)).join("；"),
    results,
  };

  const outputPath = path.join(reportDir, `temu-shop-funds-${stamp}.json`);
  await fs.writeFile(outputPath, JSON.stringify(output, null, 2));
  console.log(output.message);
  console.log(`Saved JSON: ${outputPath}`);

  if (!ok) process.exitCode = 1;
}

await main().catch(async (error) => {
  const outputPath = path.join(reportDir, `temu-shop-funds-${stamp}.error.json`);
  const output = {
    generatedAt: new Date().toISOString(),
    accountsPath,
    targetUrl,
    ok: false,
    error: errorMessage(error),
  };
  await fs.writeFile(outputPath, JSON.stringify(output, null, 2)).catch(() => {});
  console.error(errorMessage(error));
  console.error(`Saved JSON: ${outputPath}`);
  process.exitCode = 1;
});
