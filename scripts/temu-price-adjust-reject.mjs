import fs from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { closeCdpChromeProcess, closeCdpPages } from "./cdp-page-cleanup.mjs";
import {
  enterAgentAuthenticationIfShown,
  isSellerAuthorizeText,
  isSellerLoginFormText,
  loginSellerIfNeeded,
} from "./temu-login-helper.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const accountsPath = process.env.TEMU_ACCOUNTS_CONFIG || path.join(rootDir, "temu-accounts.json");
const reportDir = process.env.TEMU_REPORT_DIR || path.join(rootDir, "temu-reports");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const agentSellerOrigin = "https://agentseller.temu.com";
const agentSellerEntryUrl =
  process.env.TEMU_PRICE_ADJUST_ENTRY_URL ||
  process.env.TEMU_AGENTSELLER_ENTRY_URL ||
  `${agentSellerOrigin}/goods/list`;
const rejectReason = "0";
const shouldReject = process.argv.includes("--reject") || process.env.TEMU_PRICE_ADJUST_REJECT === "1";
const pageSettleMs = positiveInteger(process.env.TEMU_PRICE_ADJUST_SETTLE_MS, 1200);
const priceAdjustPageSize = positiveInteger(process.env.TEMU_PRICE_ADJUST_PAGE_SIZE, 200);
const priceAdjustMaxPages = positiveInteger(process.env.TEMU_PRICE_ADJUST_MAX_PAGES, 100);
const priceAdjustPollCount = positiveInteger(process.env.TEMU_PRICE_ADJUST_POLL_COUNT, 8);
const priceAdjustPollMs = positiveInteger(process.env.TEMU_PRICE_ADJUST_POLL_MS, 1500);
const priceAdjustPageQueryApi = "/api/kiana/magnus/mms/price-adjust/page-query";
const priceAdjustBatchReviewApi = "/api/kiana/magnus/mms/price-adjust/batch-review";

await fs.mkdir(reportDir, { recursive: true });

class TemuPriceAdjustRejectError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "TemuPriceAdjustRejectError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new TemuPriceAdjustRejectError(code, message);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function selectedAccountIds() {
  return String(process.env.TEMU_ACCOUNT_ID || process.env.TEMU_ACCOUNT_IDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function shopListForAccount(account) {
  const override = String(process.env.TEMU_PRICE_ADJUST_SHOPS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return override.length > 0 ? override : account.shops || [];
}

function safeFilePart(value) {
  return String(value || "unknown")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "unknown";
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
    `--remote-debugging-port=${account.cdpPort}`,
    `--user-data-dir=${account.cdpProfileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-features=CalculateNativeWinOcclusion",
    "--window-size=1600,1000",
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

async function ensureCdpChrome(account, url = agentSellerEntryUrl) {
  if (await isCdpReady(account)) return;
  launchWithOpen(account, url);
  try {
    await waitForCdp(account);
  } catch (error) {
    if (!launchWithChromeBinary(account, url)) throw error;
    await waitForCdp(account, 25000);
  }
}

async function connectCdpChrome(account, url = agentSellerEntryUrl) {
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
  const page = process.env.TEMU_FORCE_NEW_CDP_PAGE === "1"
    ? await context.newPage()
    : pages.find((candidate) => candidate.url().startsWith("https://agentseller.temu.com/")) ||
      pages.find((candidate) => candidate.url().startsWith("https://seller.kuajingmaihuo.com/")) ||
      pages[0] ||
      (await context.newPage());
  return { browser, context, page };
}

async function bodyText(page, timeout = 10000) {
  return await page.locator("body").innerText({ timeout }).catch(() => "");
}

async function waitSettled(page) {
  if (!page || page.isClosed()) return;
  await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
  if (page.isClosed()) return;
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  if (page.isClosed()) return;
  await page.waitForTimeout(pageSettleMs).catch(() => {});
}

function isAgentSellerApiPage(page) {
  return page.url().startsWith(`${agentSellerOrigin}/`) && !page.url().startsWith(`${agentSellerOrigin}/auth/authentication`);
}

function isSellerCenterShell(page) {
  return page.url().startsWith("https://seller.kuajingmaihuo.com/");
}

function preferredAgentSellerPage(context, fallbackPage) {
  const pages = [...context.pages()].reverse().filter((candidate) => !candidate.isClosed());
  return (
    pages.find((candidate) => candidate.url().startsWith(agentSellerEntryUrl)) ||
    pages.find(
      (candidate) =>
        candidate.url().startsWith(`${agentSellerOrigin}/`) &&
        !candidate.url().startsWith(`${agentSellerOrigin}/auth/authentication`),
    ) ||
    pages.find((candidate) => candidate.url().startsWith("https://seller.kuajingmaihuo.com/")) ||
    pages.find((candidate) => candidate.url().startsWith(`${agentSellerOrigin}/auth/authentication`)) ||
    (fallbackPage && !fallbackPage.isClosed() ? fallbackPage : pages[0])
  );
}

async function ensureAgentSellerPage(context, page) {
  let activePage = page;
  await activePage.goto(agentSellerEntryUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
  await waitSettled(activePage);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    activePage = preferredAgentSellerPage(context, activePage);
    await activePage.bringToFront().catch(() => {});
    await waitSettled(activePage);

    const text = await bodyText(activePage);
    if (isAgentSellerApiPage(activePage) && !isSellerLoginFormText(text) && !isSellerAuthorizeText(text)) return activePage;

    const authenticatedPage = await enterAgentAuthenticationIfShown(context, activePage);
    if (authenticatedPage) {
      activePage = preferredAgentSellerPage(context, authenticatedPage);
      await activePage.bringToFront().catch(() => {});
      await waitSettled(activePage);
      continue;
    }

    activePage = (await loginSellerIfNeeded(context, activePage, { fail })) || activePage;
    activePage = preferredAgentSellerPage(context, activePage);
    await waitSettled(activePage);

    if (isAgentSellerApiPage(activePage) || isSellerCenterShell(activePage)) {
      await activePage.goto(agentSellerEntryUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
      await waitSettled(activePage);
    }
  }

  await captureDiagnostics(activePage, "agentseller-page-not-ready").catch(() => "");
  fail("PRICE_ADJUST_AGENTSELLER_NOT_READY", "完成登录/授权后仍未进入可调用 API 的 AgentSeller 页面");
}

async function captureDiagnostics(page, reason) {
  const baseName = `debug-price-adjust-${safeFilePart(reason)}-${stamp}`;
  const jsonOutputPath = path.join(reportDir, `${baseName}.json`);
  const screenshotPath = path.join(reportDir, `${baseName}.png`);
  const diagnostics = {
    generatedAt: new Date().toISOString(),
    reason,
    url: page.url(),
    title: await page.title().catch(() => ""),
    screenshotPath,
    bodyText: (await bodyText(page, 3000)).slice(0, 4000),
  };
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  await fs.writeFile(jsonOutputPath, JSON.stringify(diagnostics, null, 2));
  return jsonOutputPath;
}

function getPriceAdjustPageResult(responseBody) {
  return responseBody?.result || responseBody || {};
}

function getPriceAdjustPageRows(responseBody) {
  const result = getPriceAdjustPageResult(responseBody);
  for (const candidate of [
    result.pageItems,
    result.dataList,
    result.list,
    result.records,
    result.items,
    result.orderList,
    result.submitOrders,
  ]) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function getPriceAdjustPageTotal(responseBody) {
  const result = getPriceAdjustPageResult(responseBody);
  const rawTotal = result.total ?? result.totalCount ?? result.count ?? result.totalSize;
  if (rawTotal == null) return null;
  const total = Number(rawTotal);
  return Number.isFinite(total) && total >= 0 ? total : null;
}

function firstRowValue(row, keys) {
  for (const key of keys) {
    const value = cleanText(row?.[key]);
    if (value) return value;
  }
  return "";
}

function normalizePriceAdjustRows(responseBody) {
  return getPriceAdjustPageRows(responseBody)
    .map((row) => {
      const submitId = firstRowValue(row, [
        "id",
        "adjustId",
        "adjustID",
        "adjustOrderId",
        "adjustOrderID",
        "priceAdjustId",
        "priceAdjustID",
        "priceAdjustmentId",
        "priceAdjustmentID",
      ]);
      return {
        submitId,
        orderSn: submitId,
        priceOrderSn: firstRowValue(row, ["priceOrderSn", "priceOrderSN", "orderSn", "orderSN", "orderNo", "orderId", "orderID"]) || submitId,
        skcId: firstRowValue(row, ["productSkcId", "skcId", "skcID", "skc_id"]),
        productName: firstRowValue(row, ["productName", "goodsName", "goodsTitle"]),
        raw: row,
      };
    })
    .filter((row) => row.submitId);
}

function uniquePriceAdjustRows(rows) {
  const seen = new Set();
  const result = [];
  for (const row of rows || []) {
    const submitId = cleanText(row.submitId || row.orderSn);
    if (!submitId || seen.has(submitId)) continue;
    seen.add(submitId);
    result.push(row);
  }
  return result;
}

async function postPriceAdjustJson(page, endpoint, body, { mallId: providedMallId } = {}) {
  const url = endpoint.startsWith("http") ? endpoint : `${agentSellerOrigin}${endpoint}`;
  return await page.evaluate(
    async ({ endpoint, url, body, providedMallId }) => {
      const text = (value) => String(value ?? "").trim();
      const mallId = text(
        providedMallId ||
          localStorage.getItem("agentseller-mall-info-id") ||
          localStorage.getItem("MALL_ID") ||
          localStorage.getItem("mallId") ||
          localStorage.getItem("currentMallId") ||
          localStorage.getItem("selectedMallId") ||
          localStorage.getItem("lastMallId") ||
          "",
      );

      async function getAntiContentValue() {
        try {
          if (!window.__temuPriceAdjustChunkRequire) {
            const factories = {};
            const chunks = self["webpackJsonp_bg-agent-seller-lgst"] || [];
            for (const chunk of chunks) {
              const modules = chunk && chunk[1];
              if (modules && typeof modules === "object") Object.assign(factories, modules);
            }
            const cache = {};
            const chunkRequire = function(id) {
              const key = String(id);
              if (cache[key]) return cache[key].exports;
              const factory = factories[key];
              if (!factory) throw new Error("module " + key + " not found");
              const module = { exports: {} };
              cache[key] = module;
              factory.call(module.exports, module, module.exports, chunkRequire);
              return module.exports;
            };
            chunkRequire.d = function(exports, definition) {
              Object.keys(definition).forEach((key) => {
                if (!Object.prototype.hasOwnProperty.call(exports, key)) {
                  Object.defineProperty(exports, key, {
                    enumerable: true,
                    get: definition[key],
                  });
                }
              });
            };
            chunkRequire.o = function(object, property) {
              return Object.prototype.hasOwnProperty.call(object, property);
            };
            chunkRequire.r = function(exports) {
              if (typeof Symbol !== "undefined" && Symbol.toStringTag) {
                Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
              }
              Object.defineProperty(exports, "__esModule", { value: true });
            };
            chunkRequire.n = function(module) {
              const getter = module && module.__esModule ? () => module.default : () => module;
              chunkRequire.d(getter, { a: getter });
              return getter;
            };
            window.__temuPriceAdjustChunkRequire = chunkRequire;
          }

          const riskUtil = window.__temuPriceAdjustChunkRequire && window.__temuPriceAdjustChunkRequire(65531);
          if (riskUtil && typeof riskUtil.cN === "function") return await riskUtil.cN();
          if (riskUtil && typeof riskUtil.xy === "function") return riskUtil.xy();
        } catch {
        }
        return "";
      }

      if (window.__FETCH__ && typeof window.__FETCH__.post === "function") {
        try {
          const raw = await window.__FETCH__.post(endpoint, body || {}, {
            headers: mallId ? { mallid: mallId } : {},
          });
          return {
            responseOk: true,
            status: 200,
            endpoint,
            source: "__FETCH__.post",
            mallId,
            raw,
            text: "",
          };
        } catch {
        }
      }

      const headers = {
        accept: "application/json, text/plain, */*",
        "Content-Type": "application/json",
      };
      const antiContent = await getAntiContentValue();
      if (antiContent) headers["Anti-Content"] = antiContent;
      if (mallId) headers.mallid = mallId;

      const response = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify(body || {}),
      });
      const rawText = await response.text();
      let raw = null;
      try {
        raw = JSON.parse(rawText);
      } catch {
        raw = rawText;
      }
      return {
        responseOk: response.ok,
        status: response.status,
        endpoint,
        source: "window.fetch",
        mallId,
        raw,
        text: typeof raw === "string" ? raw.slice(0, 1000) : "",
      };
    },
    { endpoint, url, body, providedMallId },
  );
}

function assertPriceAdjustApiResult(response, label) {
  if (!response?.responseOk) {
    fail("PRICE_ADJUST_API_HTTP_FAILED", `${label} HTTP ${response?.status || "unknown"}${response?.text ? `：${response.text}` : ""}`);
  }
  const raw = response.raw;
  if (!raw || typeof raw !== "object") {
    fail("PRICE_ADJUST_API_NON_JSON", `${label} 返回非 JSON`);
  }
  const errorCode = raw.errorCode ?? raw.error_code;
  if (raw.success === false || (errorCode !== undefined && Number(errorCode) !== 1000000)) {
    fail(
      "PRICE_ADJUST_API_RESPONSE_FAILED",
      `${label} 返回失败：code=${errorCode ?? "unknown"} msg=${raw.errorMsg || raw.error_msg || raw.message || "unknown"}`,
    );
  }
  return raw.result || {};
}

async function priceAdjustApiResult(page, endpoint, body = {}, options = {}, label = "调价 API") {
  const response = await postPriceAdjustJson(page, endpoint, body, options);
  return assertPriceAdjustApiResult(response, label);
}

async function priceAdjustApiMallList(page) {
  const result = await priceAdjustApiResult(page, "/api/seller/auth/userInfo", {}, {}, "店铺列表接口");
  const malls = result.mallList || [];
  if (!Array.isArray(malls) || malls.length === 0) {
    fail("PRICE_ADJUST_API_MALL_LIST_EMPTY", "店铺列表接口没有返回可用店铺");
  }
  return malls;
}

function mallInfoForShop(malls, shopName) {
  const matches = (malls || []).filter((mall) => cleanText(mall.mallName) === shopName);
  if (matches.length !== 1) {
    fail("PRICE_ADJUST_API_SHOP_NOT_FOUND", `店铺列表接口中找不到唯一精确店名：${shopName}；匹配数=${matches.length}`);
  }

  const mall = matches[0];
  const mallId = cleanText(mall.mallId);
  if (!mallId) fail("PRICE_ADJUST_API_MALL_ID_MISSING", `店铺列表接口中 ${shopName} 缺少 mallId`);
  return {
    source: "api",
    mallId,
    mallName: cleanText(mall.mallName),
    managedType: mall.managedType ?? null,
    mallMode: mall.mallMode ?? null,
    uniqueId: mall.uniqueId || "",
  };
}

async function queryPriceAdjustPendingPage(page, mallId, pageNo) {
  const requestBody = {
    pageInfo: {
      pageSize: priceAdjustPageSize,
      pageNo,
    },
    status: 1,
  };
  const response = await postPriceAdjustJson(page, priceAdjustPageQueryApi, requestBody, { mallId });
  assertPriceAdjustApiResult(response, "查询调价列表");
  return {
    pageNo,
    pageSize: priceAdjustPageSize,
    mallId: response.mallId || "",
    source: response.source || "",
    total: getPriceAdjustPageTotal(response.raw),
    rows: normalizePriceAdjustRows(response.raw),
  };
}

async function queryAllPriceAdjustPendingRows(page, mallId) {
  const rows = [];
  const seen = new Set();
  const pages = [];
  let total = null;
  let responseMallId = "";

  for (let pageNo = 1; pageNo <= priceAdjustMaxPages; pageNo += 1) {
    const pageResult = await queryPriceAdjustPendingPage(page, mallId, pageNo);
    total = pageResult.total ?? total;
    responseMallId ||= pageResult.mallId;
    pages.push({
      pageNo: pageResult.pageNo,
      pageSize: pageResult.pageSize,
      total: pageResult.total,
      count: pageResult.rows.length,
      source: pageResult.source,
    });
    for (const row of uniquePriceAdjustRows(pageResult.rows)) {
      if (seen.has(row.submitId)) continue;
      seen.add(row.submitId);
      rows.push(row);
    }
    if (!pageResult.rows.length || (total != null && rows.length >= total) || pageResult.rows.length < priceAdjustPageSize) {
      return {
        rows,
        total: total ?? rows.length,
        pageCount: pageNo,
        pageSize: priceAdjustPageSize,
        mallId: responseMallId || mallId,
        pages,
      };
    }
  }

  fail("PRICE_ADJUST_QUERY_TOO_MANY_PAGES", `查询调价列表超过最大页数 ${priceAdjustMaxPages}，已停止以避免误操作`);
}

function chunkItems(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function buildPriceAdjustRejectRequest(rows) {
  const submitOrders = [];
  const rejectReasons = {};
  for (const row of uniquePriceAdjustRows(rows)) {
    const submitId = cleanText(row.submitId || row.orderSn);
    if (!submitId || rejectReasons[submitId]) continue;
    submitOrders.push(submitId);
    rejectReasons[submitId] = rejectReason;
  }
  return {
    batchResult: 2,
    submitOrders,
    rejectReasons,
  };
}

function assertSafePriceAdjustRejectRequest(request) {
  if (!request || request.batchResult !== 2) {
    fail("PRICE_ADJUST_REJECT_SAFETY_CHECK_FAILED", `batch-review 不是拒绝动作：${JSON.stringify(request)}`);
  }
  if (!Array.isArray(request.submitOrders) || request.submitOrders.length === 0) {
    fail("PRICE_ADJUST_REJECT_EMPTY", "没有可拒绝的调价单 ID");
  }
  if (request.submitOrders.some((id) => !/^\d+$/.test(cleanText(id)))) {
    fail("PRICE_ADJUST_REJECT_ID_CHECK_FAILED", `submitOrders 包含非内部数字 ID：${JSON.stringify(request.submitOrders)}`);
  }
  if (!request.rejectReasons || Object.values(request.rejectReasons).some((value) => String(value) !== rejectReason)) {
    fail("PRICE_ADJUST_REJECT_REASON_CHECK_FAILED", `batch-review 拒绝原因不是 0：${JSON.stringify(request.rejectReasons)}`);
  }
}

async function rejectPriceAdjustRowsByApi(page, mallId, rows) {
  const request = buildPriceAdjustRejectRequest(rows);
  assertSafePriceAdjustRejectRequest(request);
  const response = await postPriceAdjustJson(page, priceAdjustBatchReviewApi, request, { mallId });
  assertPriceAdjustApiResult(response, "拒绝调价");
  return {
    source: response.source || "",
    mallId: response.mallId || "",
    submittedCount: request.submitOrders.length,
    request,
    response: response.raw,
  };
}

async function waitForPriceAdjustPendingAfterReject(page, mallId, beforeCount) {
  let snapshot = {
    rows: [],
    total: beforeCount,
    pageCount: 0,
    pages: [],
  };

  for (let attempt = 1; attempt <= priceAdjustPollCount; attempt += 1) {
    if (attempt > 1) await new Promise((resolve) => setTimeout(resolve, priceAdjustPollMs));
    snapshot = await queryAllPriceAdjustPendingRows(page, mallId);
    if (snapshot.total === 0 || snapshot.total < beforeCount) {
      return {
        snapshot,
        attempts: attempt,
        settled: true,
      };
    }
  }

  return {
    snapshot,
    attempts: priceAdjustPollCount,
    settled: false,
  };
}

async function collectAndMaybeRejectShop(page, shopName, apiMalls) {
  const apiSwitch = mallInfoForShop(apiMalls, shopName);
  const beforeSnapshot = await queryAllPriceAdjustPendingRows(page, apiSwitch.mallId);
  const beforeRows = uniquePriceAdjustRows(beforeSnapshot.rows);
  const pendingBefore = beforeSnapshot.total ?? beforeRows.length;

  if (pendingBefore > 0 && beforeRows.length === 0) {
    fail("PRICE_ADJUST_PENDING_IDS_EMPTY", `${shopName} 待卖家确认数量为 ${pendingBefore}，但接口未返回可提交调价 ID`);
  }

  if (!shouldReject || beforeRows.length === 0) {
    return {
      shopName,
      source: "api",
      rejected: false,
      rejectReason,
      pendingBefore,
      pendingAfter: pendingBefore,
      pageSize: beforeSnapshot.pageSize,
      pageCount: beforeSnapshot.pageCount,
      mallId: beforeSnapshot.mallId || apiSwitch.mallId,
      apiSwitch,
      rowsBefore: beforeRows,
      pages: beforeSnapshot.pages,
      actions: [],
    };
  }

  const actions = [];
  for (const batch of chunkItems(beforeRows, priceAdjustPageSize)) {
    actions.push(await rejectPriceAdjustRowsByApi(page, apiSwitch.mallId, batch));
  }

  const afterPoll = await waitForPriceAdjustPendingAfterReject(page, apiSwitch.mallId, pendingBefore);
  const afterSnapshot = afterPoll.snapshot;
  const pendingAfter = afterSnapshot.total ?? afterSnapshot.rows.length;

  return {
    shopName,
    source: "api",
    rejected: true,
    rejectReason,
    pendingBefore,
    pendingAfter,
    submittedCount: beforeRows.length,
    rejectedCount: Math.max(0, pendingBefore - pendingAfter),
    pageSize: beforeSnapshot.pageSize,
    pageCount: beforeSnapshot.pageCount,
    afterPollAttempts: afterPoll.attempts,
    afterPollSettled: afterPoll.settled,
    mallId: afterSnapshot.mallId || beforeSnapshot.mallId || apiSwitch.mallId,
    apiSwitch,
    rowsBefore: beforeRows,
    rowsAfter: afterSnapshot.rows,
    pages: beforeSnapshot.pages,
    actions,
  };
}

async function runAccount(account) {
  const shops = shopListForAccount(account);
  if (shops.length === 0) fail("NO_SHOPS_CONFIGURED", `${account.label || account.id} 没有配置店铺`);

  const { browser, context, page } = await connectCdpChrome(account, agentSellerEntryUrl);
  try {
    const activePage = await ensureAgentSellerPage(context, page);
    const apiMalls = await priceAdjustApiMallList(activePage);
    const shopReports = [];
    for (const shopName of shops) {
      shopReports.push(await collectAndMaybeRejectShop(activePage, shopName, apiMalls));
    }
    return { account, ok: true, shops: shopReports };
  } catch (error) {
    return {
      account,
      ok: false,
      error: errorMessage(error),
    };
  } finally {
    if (process.env.TEMU_CLOSE_CHROME_PAGES !== "0") {
      await closeCdpPages(context);
    }
    await browser.close().catch(() => {});
    if (process.env.TEMU_CLOSE_CHROME_PROCESS !== "0") {
      await closeCdpChromeProcess(account.cdpPort);
    }
  }
}

function buildMessage(results) {
  return results
    .map((result) => {
      const label = result.account.label || result.account.id;
      if (!result.ok) return `【${label}】失败：${result.error}`;
      return [
        `【${label}】`,
        ...result.shops.map((shop) => {
          const rejectedCount = shop.rejected ? Number(shop.rejectedCount ?? Math.max(0, Number(shop.pendingBefore || 0) - Number(shop.pendingAfter || 0))) : 0;
          const submittedText = shop.submittedCount != null ? `，已提交 ${Number(shop.submittedCount || 0)}` : "";
          return `${shop.shopName}: 待拒绝 ${shop.pendingBefore}${submittedText}，已拒绝 ${rejectedCount}，剩余 ${shop.pendingAfter}`;
        }),
      ].join("\n");
    })
    .join("\n\n");
}

const accountConfig = JSON.parse(await fs.readFile(accountsPath, "utf8"));
const selectedIds = selectedAccountIds();
const accounts = (accountConfig.accounts || []).filter((account) => selectedIds.length === 0 || selectedIds.includes(account.id));
if (accounts.length === 0) {
  fail("NO_MATCHING_ACCOUNTS", selectedIds.length ? `找不到账号：${selectedIds.join(",")}` : "账号配置为空");
}

const results = [];
for (const account of accounts) {
  console.log(`Running price adjust reject account: ${account.label || account.id}`);
  results.push(await runAccount(account));
}

const message = buildMessage(results);
const outputPath = path.join(reportDir, `temu-price-adjust-reject-${stamp}.json`);
await fs.writeFile(
  outputPath,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      accountsPath,
      agentSellerEntryUrl,
      dryRun: !shouldReject,
      rejectReason,
      api: {
        mallList: `${agentSellerOrigin}/api/seller/auth/userInfo`,
        pageQuery: `${agentSellerOrigin}/api/kiana/magnus/mms/price-adjust/page-query`,
        batchReview: `${agentSellerOrigin}/api/kiana/magnus/mms/price-adjust/batch-review`,
        mallIdHeader: true,
        pageQueryBody: {
          pageInfo: { pageSize: priceAdjustPageSize, pageNo: "<page>" },
          status: 1,
        },
        rejectPayloadShape: {
          batchResult: 2,
          submitOrders: ["<adjust id>"],
          rejectReasons: { "<adjust id>": rejectReason },
        },
      },
      message,
      results,
    },
    null,
    2,
  ),
);

console.log(message);
console.log(`Saved JSON: ${outputPath}`);

if (results.some((result) => !result.ok || result.shops?.some((shop) => shop.pendingAfter > 0 && shouldReject))) {
  process.exitCode = 1;
}
