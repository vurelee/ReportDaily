import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { closeCdpChromeProcess, closeCdpPages } from "./cdp-page-cleanup.mjs";
import { connectCdpChrome } from "./chrome-cdp.mjs";
import {
  bodyText,
  loginSellerIfNeeded,
  needsVerification,
  waitForMatchingPage,
} from "./temu-login-helper.mjs";
import { extractMallList, resolveMallByName } from "./temu-mall-resolver.mjs";
import { temuPageApiPost } from "./temu-page-api-client.mjs";
import { closeTemuPopups } from "./temu-popup-cleaner.mjs";
import { SELLER_ORIGIN, USER_INFO_ENDPOINT } from "./temu-shop-withdrawal-records.mjs";

if (!Object.prototype.hasOwnProperty.call(process.env, "TEMU_CDP_HEADLESS")) {
  process.env.TEMU_CDP_HEADLESS = "1";
}

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const accountsPath = process.env.TEMU_ACCOUNTS_CONFIG || path.join(rootDir, "temu-accounts.json");
const reportDir = process.env.TEMU_REPORT_DIR || path.join(rootDir, "temu-reports");
const defaultCheckpointDir = path.join(reportDir, "checkpoints", "temu-finance-expense-details");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const targetUrl = process.env.TEMU_FINANCE_EXPENSE_URL || "https://seller.kuajingmaihuo.com/labor/bill";
const PAGE_SEARCH_ENDPOINT = "/api/merchant/fund/detail/pageSearch";
const MAX_WINDOW_DAYS = 31;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MONEY_CHANGE_TYPES = [2];
const DEFAULT_FUND_TYPES = [400];
const DEFAULT_PAGE_DELAY_MS = 900;
const DEFAULT_RETRY_ATTEMPTS = 6;
const args = process.argv.slice(2);

await fs.mkdir(reportDir, { recursive: true });

class TemuFinanceExpenseError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "TemuFinanceExpenseError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new TemuFinanceExpenseError(code, message);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function safeFilePart(value) {
  const cleaned = cleanText(value)
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return cleaned || "shop";
}

function getFlagValue(name) {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  if (index === -1) return "";
  const value = args[index + 1] || "";
  return value.startsWith("--") ? "" : value;
}

function hasFlag(name) {
  return args.includes(name);
}

function splitList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseInteger(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parsePositiveInteger(value, fallback) {
  const parsed = parseInteger(value, fallback);
  return parsed > 0 ? parsed : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseNumberList(value, fallback) {
  const source = splitList(value);
  if (source.length === 0) return fallback;
  return source.map((item) => {
    const parsed = Number.parseInt(item, 10);
    if (!Number.isFinite(parsed)) fail("INVALID_NUMBER_LIST", `数字列表包含无效值：${item}`);
    return parsed;
  });
}

function dateParts(dateKey) {
  const match = String(dateKey || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) fail("INVALID_DATE", `日期必须是 YYYY-MM-DD：${dateKey}`);
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

function dateKey(parts) {
  return [
    String(parts.year).padStart(4, "0"),
    String(parts.month).padStart(2, "0"),
    String(parts.day).padStart(2, "0"),
  ].join("-");
}

function addDays(date, days) {
  const parts = typeof date === "string" ? dateParts(date) : date;
  const next = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
}

function compareDateKeys(a, b) {
  return String(a).localeCompare(String(b));
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

function shanghaiStartMs(value) {
  return new Date(`${value}T00:00:00+08:00`).getTime();
}

function shanghaiEndMs(value) {
  return new Date(`${value}T23:59:59+08:00`).getTime();
}

function defaultDateRange() {
  const endDate = shanghaiTodayKey();
  return {
    startDate: dateKey(addDays(endDate, -(MAX_WINDOW_DAYS - 1))),
    endDate,
  };
}

function splitDateWindows(startDate, endDate, maxWindowDays = MAX_WINDOW_DAYS) {
  dateParts(startDate);
  dateParts(endDate);
  if (compareDateKeys(startDate, endDate) > 0) {
    fail("INVALID_DATE_RANGE", `开始日期不能晚于结束日期：${startDate} > ${endDate}`);
  }

  const windows = [];
  let cursor = startDate;
  while (compareDateKeys(cursor, endDate) <= 0) {
    const candidateEnd = dateKey(addDays(cursor, maxWindowDays - 1));
    const windowEnd = compareDateKeys(candidateEnd, endDate) <= 0 ? candidateEnd : endDate;
    windows.push({ startDate: cursor, endDate: windowEnd });
    cursor = dateKey(addDays(windowEnd, 1));
  }
  return windows;
}

function parseOptions() {
  const defaults = defaultDateRange();
  const pageSize = parsePositiveInteger(
    getFlagValue("--page-size") || process.env.TEMU_FINANCE_EXPENSE_PAGE_SIZE,
    DEFAULT_PAGE_SIZE,
  );
  if (pageSize > DEFAULT_PAGE_SIZE) fail("INVALID_PAGE_SIZE", "pageSize 不能超过 100");

  return {
    accountIds: splitList(getFlagValue("--account") || process.env.TEMU_ACCOUNT_ID || process.env.TEMU_ACCOUNT_IDS),
    shopNames: splitList(getFlagValue("--shop") || process.env.TEMU_FINANCE_EXPENSE_SHOPS || process.env.TEMU_FUNDS_SHOPS),
    startDate: getFlagValue("--start") || process.env.TEMU_FINANCE_EXPENSE_START_DATE || defaults.startDate,
    endDate: getFlagValue("--end") || process.env.TEMU_FINANCE_EXPENSE_END_DATE || defaults.endDate,
    pageSize,
    maxPages: parseInteger(getFlagValue("--max-pages") || process.env.TEMU_FINANCE_EXPENSE_MAX_PAGES, 0),
    pageDelayMs: parseInteger(
      getFlagValue("--page-delay-ms") || process.env.TEMU_FINANCE_EXPENSE_PAGE_DELAY_MS,
      DEFAULT_PAGE_DELAY_MS,
    ),
    retryAttempts: parsePositiveInteger(
      getFlagValue("--retry-attempts") || process.env.TEMU_FINANCE_EXPENSE_RETRY_ATTEMPTS,
      DEFAULT_RETRY_ATTEMPTS,
    ),
    moneyChangeTypes: parseNumberList(
      getFlagValue("--money-change-type") || process.env.TEMU_FINANCE_EXPENSE_MONEY_CHANGE_TYPE,
      DEFAULT_MONEY_CHANGE_TYPES,
    ),
    fundTypes: hasFlag("--all-flow-out")
      ? []
      : parseNumberList(getFlagValue("--fund-type") || process.env.TEMU_FINANCE_EXPENSE_FUND_TYPE, DEFAULT_FUND_TYPES),
    allKnownShops: hasFlag("--all-known-shops") || process.env.TEMU_FINANCE_EXPENSE_ALL_KNOWN_SHOPS === "1",
    perShopJson: hasFlag("--per-shop-json") || process.env.TEMU_FINANCE_EXPENSE_PER_SHOP_JSON === "1",
    resume: !hasFlag("--no-resume") && process.env.TEMU_FINANCE_EXPENSE_RESUME !== "0",
    resetCheckpoint: hasFlag("--reset-checkpoint") || process.env.TEMU_FINANCE_EXPENSE_RESET_CHECKPOINT === "1",
    checkpointDir: process.env.TEMU_FINANCE_EXPENSE_CHECKPOINT_DIR || defaultCheckpointDir,
  };
}

function shopListForAccount(account, options) {
  if (options.shopNames.length > 0) return options.shopNames;
  if (options.allKnownShops) return [...new Set([...(account.knownShops || []), ...(account.shops || [])])];
  return [...new Set([...(account.shops || [])])];
}

function cdpOptions(account) {
  return {
    cdpPort: account.cdpPort,
    cdpProfileDir: account.cdpProfileDir,
    temuHomeUrl: targetUrl,
  };
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

async function waitForSellerPage(context, timeoutMs = 8000) {
  return await waitForMatchingPage(
    context,
    (candidate) => candidate.url().startsWith("https://seller.kuajingmaihuo.com/"),
    timeoutMs,
  );
}

async function ensureSellerPage(context, page) {
  let activePage = page && !page.isClosed() ? page : await context.newPage();
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

  if (!activePage.url().startsWith("https://seller.kuajingmaihuo.com/")) {
    activePage = (await waitForSellerPage(context, 3000)) || activePage;
  }
  if (!activePage.url().startsWith(targetUrl)) {
    await activePage.goto(targetUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
    await waitSettled(activePage);
  }
  return activePage;
}

function retryableApiFailure(response, responseBody) {
  const errorCode = responseBody?.errorCode ?? responseBody?.error_code;
  const message = responseBody?.errorMsg || responseBody?.error_msg || responseBody?.message || "";
  return response?.status === 429 || Number(errorCode) === 40002 || String(message).includes("网络超时");
}

async function sellerApiPost(page, endpoint, body = {}, { mallId, retryAttempts = DEFAULT_RETRY_ATTEMPTS } = {}, label = "Seller Center API") {
  let lastFailure = "";
  for (let attempt = 1; attempt <= retryAttempts; attempt += 1) {
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

    const responseBody = response?.json;
    if (!response?.ok) {
      lastFailure = `${label} HTTP ${response?.status || "unknown"}：${(response?.bodyText || "").slice(0, 1000)}`;
      if (retryableApiFailure(response, responseBody) && attempt < retryAttempts) {
        const waitMs = Math.min(45000, 3000 * attempt);
        console.error(`${label}: retry ${attempt}/${retryAttempts} after HTTP ${response?.status || "unknown"}, wait ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }
      fail("SELLER_API_HTTP_FAILED", lastFailure);
    }
    if (!responseBody || typeof responseBody !== "object") {
      fail("SELLER_API_RESPONSE_NOT_JSON", `${label} 返回非 JSON：${(response.bodyText || "").slice(0, 1000)}`);
    }
    const errorCode = responseBody.errorCode ?? responseBody.error_code;
    if (responseBody.success === false || (errorCode !== undefined && Number(errorCode) !== 1000000)) {
      const message = responseBody.errorMsg || responseBody.error_msg || responseBody.message || "unknown";
      lastFailure = `${label} 返回失败：code=${errorCode ?? "unknown"} msg=${message}`;
      if (retryableApiFailure(response, responseBody) && attempt < retryAttempts) {
        const waitMs = Math.min(45000, 3000 * attempt);
        console.error(`${label}: retry ${attempt}/${retryAttempts} after code=${errorCode ?? "unknown"}, wait ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }
      fail("SELLER_API_RESPONSE_FAILED", lastFailure);
    }
    return responseBody.result ?? {};
  }
  fail("SELLER_API_RETRY_EXHAUSTED", lastFailure || `${label} 重试耗尽`);
}

async function sellerMallList(page) {
  const result = await sellerApiPost(page, USER_INFO_ENDPOINT, {}, {}, "卖家中心店铺列表接口");
  const malls = extractMallList(result);
  if (!Array.isArray(malls) || malls.length === 0) {
    fail("SELLER_MALL_LIST_EMPTY", "卖家中心店铺列表接口没有返回可切换店铺");
  }
  return malls;
}

function mallInfoForShop(malls, shopName) {
  try {
    const resolved = resolveMallByName(malls, shopName, { caseInsensitive: true });
    return {
      mallId: resolved.mallId,
      mallName: resolved.mallName,
      raw: resolved.raw,
    };
  } catch (error) {
    fail("SELLER_SHOP_TARGET_NOT_FOUND", errorMessage(error));
  }
}

function amountValue(amount) {
  const parsed = Number(amount?.value ?? amount ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatAmountObject(value, currencyCode = "CNY") {
  return {
    value,
    symbol: "¥",
    currencyCode,
    digitalText: (value / 100).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }),
  };
}

function recordKey(record) {
  const fallback = [record?.batchId, record?.transSn, record?.transactionTime, record?.originAmount ?? record?.amount]
    .map(cleanText)
    .filter(Boolean)
    .join("|");
  return cleanText(record?.queryId) || fallback;
}

function requestBodyForWindow(window, options, pageNum) {
  const body = {
    moneyChangeTypeList: options.moneyChangeTypes,
    beginTime: shanghaiStartMs(window.startDate),
    endTime: shanghaiEndMs(window.endDate),
    pageSize: options.pageSize,
    pageNum,
  };
  if (options.fundTypes.length > 0) body.fundType = options.fundTypes;
  return body;
}

function windowKey(window) {
  return `${window.startDate}..${window.endDate}`;
}

function checkpointFingerprint(account, mallInfo, options) {
  return createHash("sha1")
    .update(
      JSON.stringify({
        accountId: account.id,
        mallId: String(mallInfo.mallId),
        targetUrl,
        startDate: options.startDate,
        endDate: options.endDate,
        pageSize: options.pageSize,
        moneyChangeTypeList: options.moneyChangeTypes,
        fundType: options.fundTypes,
        dateWindows: options.dateWindows,
      }),
    )
    .digest("hex")
    .slice(0, 16);
}

function checkpointPath(account, mallInfo, options, fingerprint) {
  const rangePart = `${options.startDate}_to_${options.endDate}`;
  return path.join(
    options.checkpointDir,
    [
      "temu-finance-expense-details",
      safeFilePart(account.id),
      safeFilePart(mallInfo.mallName),
      rangePart,
      fingerprint,
    ].join("-") + ".checkpoint.jsonl",
  );
}

async function removeFileIfExists(filePath) {
  await fs.rm(filePath, { force: true }).catch(() => {});
}

function checkpointMeta(account, shopName, mallInfo, options, fingerprint) {
  return {
    type: "meta",
    version: 1,
    createdAt: new Date().toISOString(),
    fingerprint,
    accountId: account.id,
    accountLabel: account.label || account.id,
    shopName,
    mallId: String(mallInfo.mallId),
    targetUrl,
    dateRange: {
      startDate: options.startDate,
      endDate: options.endDate,
      windows: options.dateWindows,
    },
    filters: {
      moneyChangeTypeList: options.moneyChangeTypes,
      fundType: options.fundTypes,
      pageSize: options.pageSize,
    },
  };
}

async function ensureCheckpointStarted(filePath, meta) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.access(filePath);
  } catch {
    await fs.appendFile(filePath, `${JSON.stringify(meta)}\n`);
  }
}

async function appendCheckpointPage(filePath, meta, entry) {
  await ensureCheckpointStarted(filePath, meta);
  await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`);
}

async function readCheckpointEntries(filePath, fingerprint) {
  let content = "";
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const entries = [];
  for (const line of content.split(/\n/)) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed?.type === "page" && parsed.fingerprint === fingerprint) {
      entries.push(parsed);
    }
  }
  return entries;
}

function applyRecord(records, seen, record) {
  const key = recordKey(record);
  if (key && seen.has(key)) return 0;
  if (key) seen.add(key);
  records.push(record);
  return amountValue(record.amountFormat ?? record.amount);
}

async function loadCheckpointState(account, shopName, mallInfo, options) {
  const fingerprint = checkpointFingerprint(account, mallInfo, options);
  const filePath = checkpointPath(account, mallInfo, options, fingerprint);
  const meta = checkpointMeta(account, shopName, mallInfo, options, fingerprint);

  if (options.resetCheckpoint) await removeFileIfExists(filePath);
  if (!options.resume) {
    return {
      filePath,
      meta,
      resumed: false,
      records: [],
      seen: new Set(),
      windowStates: new Map(),
      totalAmountInCents: 0,
    };
  }

  const entries = await readCheckpointEntries(filePath, fingerprint);
  if (entries.length === 0) {
    return {
      filePath,
      meta,
      resumed: false,
      records: [],
      seen: new Set(),
      windowStates: new Map(),
      totalAmountInCents: 0,
    };
  }

  const entriesByWindow = new Map();
  for (const entry of entries) {
    const key = windowKey(entry.window || {});
    if (!entriesByWindow.has(key)) entriesByWindow.set(key, new Map());
    const pageMap = entriesByWindow.get(key);
    if (!pageMap.has(entry.pageNum)) pageMap.set(entry.pageNum, entry);
  }

  const records = [];
  const seen = new Set();
  const windowStates = new Map();
  let totalAmountInCents = 0;

  for (const window of options.dateWindows) {
    const key = windowKey(window);
    const pageMap = entriesByWindow.get(key);
    if (!pageMap) continue;

    let total = 0;
    let collected = 0;
    let pageCount = 0;
    let completed = false;
    let outcomeAmount = null;
    let outcomeBillNumber = null;

    for (let pageNum = 1; pageMap.has(pageNum); pageNum += 1) {
      const entry = pageMap.get(pageNum);
      const resultList = Array.isArray(entry.resultList) ? entry.resultList : [];
      total = Number(entry.total || total || resultList.length || 0);
      collected += resultList.length;
      pageCount += 1;
      outcomeAmount = entry.outcomeAmount || outcomeAmount;
      outcomeBillNumber = entry.outcomeBillNumber ?? outcomeBillNumber;
      for (const record of resultList) {
        totalAmountInCents += applyRecord(records, seen, record);
      }
      if (collected >= total || resultList.length === 0 || resultList.length < options.pageSize) {
        completed = true;
        break;
      }
    }

    if (pageCount > 0) {
      windowStates.set(key, {
        ...window,
        total,
        collected,
        pageCount,
        nextPageNum: pageCount + 1,
        outcomeAmount,
        outcomeBillNumber,
        completed,
        partial: false,
      });
    }
  }

  return {
    filePath,
    meta,
    resumed: records.length > 0 || windowStates.size > 0,
    records,
    seen,
    windowStates,
    totalAmountInCents,
  };
}

async function collectFinanceExpenseDetailsByShopName(page, shopName, mallInfo, options, account) {
  const checkpoint = await loadCheckpointState(account, shopName, mallInfo, options);
  const records = checkpoint.records;
  const seen = checkpoint.seen;
  const windowResults = [];
  let totalAmountInCents = checkpoint.totalAmountInCents;
  let partial = false;

  if (checkpoint.resumed) {
    console.error(`${shopName}: resumed checkpoint ${checkpoint.filePath}`);
  }

  for (const window of options.dateWindows) {
    const existingWindow = checkpoint.windowStates.get(windowKey(window));
    let windowTotal = existingWindow?.total || 0;
    let collectedInWindow = existingWindow?.collected || 0;
    let pageCount = existingWindow?.pageCount || 0;
    let outcomeAmount = existingWindow?.outcomeAmount || null;
    let outcomeBillNumber = existingWindow?.outcomeBillNumber ?? null;

    if (existingWindow?.completed) {
      console.error(`${shopName} ${window.startDate}..${window.endDate}: checkpoint complete, skip ${pageCount} pages`);
      windowResults.push({
        ...window,
        total: windowTotal,
        collected: collectedInWindow,
        pageCount,
        outcomeAmount,
        outcomeBillNumber,
        partial: false,
      });
      continue;
    }

    for (let pageNum = existingWindow?.nextPageNum || 1; ; pageNum += 1) {
      if (options.maxPages > 0 && pageNum > options.maxPages) {
        partial = true;
        break;
      }

      const body = requestBodyForWindow(window, options, pageNum);
      const result = await sellerApiPost(
        page,
        PAGE_SEARCH_ENDPOINT,
        body,
        { mallId: mallInfo.mallId, retryAttempts: options.retryAttempts },
        `${shopName} 财务支出明细 pageSearch`,
      );
      const resultList = Array.isArray(result.resultList) ? result.resultList : [];
      windowTotal = Number(result.total || windowTotal || resultList.length || 0);
      outcomeAmount = result.outcomeAmountFormat || outcomeAmount;
      outcomeBillNumber = result.outcomeBillNumber ?? outcomeBillNumber;
      pageCount += 1;
      collectedInWindow += resultList.length;

      for (const record of resultList) {
        totalAmountInCents += applyRecord(records, seen, record);
      }

      if (options.resume) {
        await appendCheckpointPage(checkpoint.filePath, checkpoint.meta, {
          type: "page",
          version: 1,
          writtenAt: new Date().toISOString(),
          fingerprint: checkpoint.meta.fingerprint,
          window,
          pageNum,
          total: windowTotal,
          resultList,
          outcomeAmount,
          outcomeBillNumber,
        });
      }

      console.error(
        `${shopName} ${window.startDate}..${window.endDate} page ${pageNum}: ${resultList.length}/${windowTotal}`,
      );

      if (collectedInWindow >= windowTotal || resultList.length === 0 || resultList.length < options.pageSize) {
        break;
      }
      if (options.pageDelayMs > 0) await sleep(options.pageDelayMs);
    }

    windowResults.push({
      ...window,
      total: windowTotal,
      collected: collectedInWindow,
      pageCount,
      outcomeAmount,
      outcomeBillNumber,
      partial: options.maxPages > 0 && pageCount >= options.maxPages && collectedInWindow < windowTotal,
    });
  }

  const isPartial = partial || windowResults.some((window) => window.partial);
  const result = {
    endpoint: `${SELLER_ORIGIN}${PAGE_SEARCH_ENDPOINT}`,
    request: {
      mallId: mallInfo.mallId,
      pageSize: options.pageSize,
      moneyChangeTypeList: options.moneyChangeTypes,
      fundType: options.fundTypes,
      maxWindowDays: MAX_WINDOW_DAYS,
    },
    rowCount: records.length,
    totalAmount: formatAmountObject(totalAmountInCents),
    windows: windowResults,
    partial: isPartial,
    checkpoint: {
      enabled: options.resume,
      path: checkpoint.filePath,
      resumed: checkpoint.resumed,
      retained: options.resume && isPartial,
    },
    records,
  };

  if (!result.partial && options.resume) {
    await removeFileIfExists(checkpoint.filePath);
  }
  return result;
}

async function runAccount(account, options) {
  console.error(`Running finance expense details account: ${account.label || account.id}`);
  const shops = shopListForAccount(account, options);
  if (shops.length === 0) fail("SHOP_LIST_EMPTY", `${account.id} 没有配置财务支出明细店铺`);

  const { browser, context, page } = await connectCdpChrome(targetUrl, cdpOptions(account));
  const shopResults = [];
  try {
    const activePage = await ensureSellerPage(context, page);
    const malls = await sellerMallList(activePage);

    for (const requestedShopName of shops) {
      try {
        const mallInfo = mallInfoForShop(malls, requestedShopName);
        const details = await collectFinanceExpenseDetailsByShopName(activePage, mallInfo.mallName, mallInfo, options, account);
        shopResults.push({
          ok: true,
          shopName: mallInfo.mallName,
          requestedShopName,
          mallId: mallInfo.mallId,
          financeExpenseDetails: details,
          source: "seller-center-finance-expense-page-search",
        });
        console.error(`${mallInfo.mallName}: 支出明细 ${details.rowCount} 条，CNY ${details.totalAmount.digitalText}`);
      } catch (error) {
        const message = errorMessage(error);
        console.error(`${requestedShopName}: 支出明细采集失败：${message}`);
        shopResults.push({
          ok: false,
          requestedShopName,
          shopName: requestedShopName,
          error: message,
        });
      }
    }

    return {
      account,
      ok: shopResults.every((shop) => shop.ok),
      shops: shopResults,
    };
  } finally {
    await closeCdpPages(context).catch(() => {});
    await browser.close().catch(() => {});
    await closeCdpChromeProcess(account.cdpPort).catch(() => {});
  }
}

function shopMessage(shop) {
  if (!shop.ok) return `${shop.requestedShopName} 支出明细采集失败：${shop.error}`;
  const details = shop.financeExpenseDetails;
  const marker = details.partial ? "（部分）" : "";
  return `${shop.shopName} 支出明细${marker} ${details.rowCount} 条，CNY ${details.totalAmount.digitalText}`;
}

function resultMessage(result) {
  const shopMessages = (result.shops || []).map(shopMessage).filter(Boolean);
  if (shopMessages.length > 0) return shopMessages.join("；");
  if (result.ok) return `【${result.account.label || result.account.id}】成功`;
  return `【${result.account.label || result.account.id}】失败：${result.error || "unknown"}`;
}

async function writePerShopJson(output, options, stampValue) {
  if (!options.perShopJson) return [];
  const paths = [];
  const rangePart = `${options.startDate}_to_${options.endDate}`;
  for (const result of output.results || []) {
    for (const shop of result.shops || []) {
      if (!shop.ok) continue;
      const shopFileName = [
        "temu-finance-expense-details",
        safeFilePart(shop.shopName),
        rangePart,
        stampValue,
      ].join("-");
      const shopPath = path.join(reportDir, `${shopFileName}.json`);
      const shopOutput = {
        ...output,
        message: shopMessage(shop),
        results: [
          {
            ...result,
            shops: [shop],
          },
        ],
      };
      await fs.writeFile(shopPath, JSON.stringify(shopOutput, null, 2));
      paths.push(shopPath);
    }
  }
  return paths;
}

async function main() {
  const parsedOptions = parseOptions();
  const dateWindows = splitDateWindows(parsedOptions.startDate, parsedOptions.endDate);
  const options = { ...parsedOptions, dateWindows };
  const rawConfig = JSON.parse(await fs.readFile(accountsPath, "utf8"));
  const accounts = (rawConfig.accounts || []).filter(
    (account) => options.accountIds.length === 0 || options.accountIds.includes(account.id),
  );
  if (accounts.length === 0) {
    fail("ACCOUNT_NOT_FOUND", `没有匹配账号：${options.accountIds.join(",") || "(all)"}`);
  }

  const results = [];
  for (const account of accounts) {
    try {
      results.push(await runAccount(account, options));
    } catch (error) {
      const message = errorMessage(error);
      console.error(`【${account.label || account.id}】失败：${message}`);
      results.push({ account, ok: false, error: message });
    }
  }

  const ok = results.every(
    (result) => result.ok && (result.shops || []).every((shop) => shop.ok !== false),
  );
  const partial = results.some((result) =>
    (result.shops || []).some((shop) => shop.ok !== false && shop.financeExpenseDetails?.partial),
  );
  const output = {
    generatedAt: new Date().toISOString(),
    accountsPath,
    targetUrl,
    dateRange: {
      startDate: options.startDate,
      endDate: options.endDate,
      windows: dateWindows,
    },
    filters: {
      moneyChangeTypeList: options.moneyChangeTypes,
      fundType: options.fundTypes,
      pageSize: options.pageSize,
      maxPages: options.maxPages,
      allKnownShops: options.allKnownShops,
      pageDelayMs: options.pageDelayMs,
      retryAttempts: options.retryAttempts,
      resume: options.resume,
      resetCheckpoint: options.resetCheckpoint,
      checkpointDir: options.checkpointDir,
    },
    ok,
    partial,
    message: ok
      ? results
          .flatMap((result) => result.shops || [])
          .map(shopMessage)
          .join("；")
      : results
          .map(resultMessage)
          .join("；"),
    results,
  };

  const outputPath = path.join(reportDir, `temu-finance-expense-details-${stamp}.json`);
  await fs.writeFile(outputPath, JSON.stringify(output, null, 2));
  const perShopPaths = await writePerShopJson(output, options, stamp);
  output.perShopJsonPaths = perShopPaths;
  if (perShopPaths.length > 0) {
    await fs.writeFile(outputPath, JSON.stringify(output, null, 2));
  }
  console.log(output.message);
  console.log(`Saved JSON: ${outputPath}`);
  for (const perShopPath of perShopPaths) {
    console.log(`Saved shop JSON: ${perShopPath}`);
  }

  if (!ok) {
    process.exitCode = 1;
  }
}

await main().catch(async (error) => {
  const outputPath = path.join(reportDir, `temu-finance-expense-details-${stamp}.error.json`);
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
