import fs from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { closeCdpChromeProcess, closeCdpPages } from "./cdp-page-cleanup.mjs";
import { closeTemuPopups } from "./temu-popup-cleaner.mjs";
import { createTemuNetworkCapture } from "./temu-network-capture.mjs";
import {
  ensureConsentChecked,
  enterAgentAuthenticationIfShown,
  loginSellerIfNeeded,
} from "./temu-login-helper.mjs";
import { temuPageApiPost } from "./temu-page-api-client.mjs";
import { extractMallList, resolveMallByExactName } from "./temu-mall-resolver.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const accountsPath = process.env.TEMU_ACCOUNTS_CONFIG || path.join(rootDir, "temu-accounts.json");
const reportDir = process.env.TEMU_REPORT_DIR || path.join(rootDir, "temu-reports");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const targetUrl =
  process.env.TEMU_ABNORMAL_ORDER_URL || "https://agentseller.temu.com/lgst/auth-warehouse/abnormal-order";
const AGENT_SELLER_ORIGIN = "https://agentseller.temu.com";
const abnormalSource = String(process.env.TEMU_ABNORMAL_SOURCE || "api").toLowerCase();
const abnormalApiDomFallback = process.env.TEMU_ABNORMAL_API_DOM_FALLBACK !== "0";
const ABNORMAL_API_PAGE_SIZE = parsePositiveInteger(process.env.TEMU_ABNORMAL_API_PAGE_SIZE, 10);
const ABNORMAL_QUERY_TAB_VALUE = 6;
const ABNORMAL_DISPLAY_ORDER_STATUS = 99;
const networkCapture = createTemuNetworkCapture({
  kind: "abnormal-orders",
  reportDir,
  stamp,
  accountLabel: process.env.TEMU_ACCOUNT_ID || process.env.TEMU_ACCOUNT_IDS || "all",
  targetUrl,
});

await fs.mkdir(reportDir, { recursive: true });

class TemuAbnormalError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "TemuAbnormalError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new TemuAbnormalError(code, message);
}

if (!["api", "dom"].includes(abnormalSource)) {
  fail("INVALID_ABNORMAL_SOURCE", `TEMU_ABNORMAL_SOURCE 只能是 api 或 dom，当前=${abnormalSource}`);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function displayText(value) {
  const text = cleanText(value);
  return text || "-";
}

function safeFilePart(value) {
  return String(value || "unknown")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "unknown";
}

function debugAbnormal(message) {
  if (process.env.TEMU_DEBUG_ABNORMAL === "1") {
    console.error(`[abnormal] ${message}`);
  }
}

function selectedAccountIds() {
  return String(process.env.TEMU_ACCOUNT_ID || process.env.TEMU_ACCOUNT_IDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function shopListForAccount(account) {
  return String(process.env.TEMU_ABNORMAL_SHOPS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .concat(process.env.TEMU_ABNORMAL_SHOPS ? [] : account.shops || []);
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

async function waitForCdp(account, timeoutMs = 20000) {
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
  const pages = context.pages();
  const page = process.env.TEMU_FORCE_NEW_CDP_PAGE === "1"
    ? await context.newPage()
    : pages.find((candidate) => candidate.url().startsWith("https://agentseller.temu.com/")) ||
      (await context.newPage());
  return { browser, context, page };
}

async function bodyText(page, timeout = 10000) {
  return await page.locator("body").innerText({ timeout }).catch(() => "");
}

async function waitSettled(page, usePopupCleaner = true) {
  if (!page || page.isClosed()) return;
  await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
  if (page.isClosed()) return;
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
  if (page.isClosed()) return;
  await page.waitForTimeout(600).catch(() => {});
  if (page.isClosed()) return;
  if (usePopupCleaner && !isSellerCenterShell(page)) await closeTemuPopups(page).catch(() => {});
}

async function waitForMatchingPage(context, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matched = [...context.pages()].reverse().find(predicate);
    if (matched) return matched;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

async function enterSellerCentralIfShown(context, page) {
  const text = await bodyText(page);
  if (!text.includes("Seller Central") || !text.includes("进入")) {
    return null;
  }

  if (!(await ensureConsentChecked(page))) {
    fail("SELLER_CENTRAL_CONSENT_NOT_CHECKED", "Seller Central 授权复选框未成功勾选");
  }
  await page.getByText("进入", { exact: true }).first().click({ timeout: 8000 });
  await page.waitForTimeout(6000).catch(() => {});
  if (page.isClosed()) return null;

  const agentPage =
    (await waitForMatchingPage(
      context,
      (candidate) => candidate.url().startsWith("https://agentseller.temu.com/"),
      15000,
    )) || page;

  await agentPage.bringToFront().catch(() => {});
  await waitSettled(agentPage);
  return agentPage;
}

async function ensureTargetPage(context, page) {
  let activePage = page;
  debugAbnormal(`ensureTargetPage start url=${activePage.url()}`);
  await activePage.goto(targetUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
  await waitSettled(activePage);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    activePage = preferredAbnormalNavigationPage(context, activePage);
    await activePage.bringToFront().catch(() => {});
    await waitSettled(activePage);
    debugAbnormal(`attempt=${attempt + 1} active=${activePage.url()} title=${await activePage.title().catch(() => "")}`);

    let text = await bodyText(activePage);
    if (isTargetPage(text) || isNoPermissionPage(text)) return activePage;
    if (isAgentSellerShell(activePage, text)) {
      await activePage.goto(targetUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
      await waitSettled(activePage);
      continue;
    }

    const authenticatedPage = await enterAgentAuthenticationIfShown(context, activePage);
    if (authenticatedPage) {
      activePage = preferredAbnormalNavigationPage(context, authenticatedPage);
      await activePage.bringToFront().catch(() => {});
      await waitSettled(activePage);
      debugAbnormal(`after auth active=${activePage.url()} title=${await activePage.title().catch(() => "")}`);
      continue;
    }

    activePage = (await loginSellerIfNeeded(context, activePage, { fail, debug: debugAbnormal })) || activePage;
    activePage = preferredAbnormalNavigationPage(context, activePage);
    await waitSettled(activePage);
    debugAbnormal(`after seller login active=${activePage.url()} title=${await activePage.title().catch(() => "")}`);

    text = await bodyText(activePage);
    if (isTargetPage(text) || isNoPermissionPage(text)) return activePage;
    if (isAgentSellerShell(activePage, text)) {
      await activePage.goto(targetUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
      await waitSettled(activePage);
      continue;
    }
    if (isSellerCenterShell(activePage)) {
      await activePage.goto(targetUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
      await waitSettled(activePage);
      continue;
    }

    const agentPage = await waitForMatchingPage(
      context,
      (candidate) => candidate.url().startsWith("https://agentseller.temu.com/"),
      2000,
    );
    if (agentPage) {
      activePage = agentPage;
      await activePage.bringToFront().catch(() => {});
      await waitSettled(activePage);
      text = await bodyText(activePage);
      if (isTargetPage(text) || isNoPermissionPage(text)) return activePage;
      if (isAgentSellerShell(activePage, text)) {
        await activePage.goto(targetUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
        await waitSettled(activePage);
        continue;
      }
    }

    const enteredPage = await enterSellerCentralIfShown(context, activePage);
    if (enteredPage) {
      activePage = enteredPage;
      await activePage.goto(targetUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
      await waitSettled(activePage);
      continue;
    }

    await activePage.goto(targetUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
    await waitSettled(activePage);
  }

  const diagnosticsPath = await captureAbnormalPageDiagnostics(activePage, "target-page-not-ready").catch(() => "");
  fail(
    "ABNORMAL_PAGE_NOT_READY",
    `直接访问异常页并完成登录/授权后，仍未进入 Agent Center 异常页${diagnosticsPath ? `；诊断=${diagnosticsPath}` : ""}`,
  );
}

function preferredAbnormalNavigationPage(context, fallbackPage) {
  const pages = [...context.pages()].reverse().filter((candidate) => !candidate.isClosed());
  return (
    pages.find((candidate) => candidate.url().startsWith(targetUrl)) ||
    pages.find(
      (candidate) =>
        candidate.url().startsWith("https://agentseller.temu.com/") &&
        !candidate.url().startsWith("https://agentseller.temu.com/auth/authentication"),
    ) ||
    pages.find((candidate) => candidate.url().startsWith("https://seller.kuajingmaihuo.com/")) ||
    pages.find((candidate) => candidate.url().startsWith("https://agentseller.temu.com/auth/authentication")) ||
    (fallbackPage && !fallbackPage.isClosed() ? fallbackPage : pages[0])
  );
}

async function captureAbnormalPageDiagnostics(page, reason) {
  const baseName = `debug-abnormal-${safeFilePart(reason)}-${stamp}`;
  const jsonOutputPath = path.join(reportDir, `${baseName}.json`);
  const screenshotPath = path.join(reportDir, `${baseName}.png`);
  const visibleState = await page
    .evaluate(() => {
      const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const isVisible = (node) => {
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const visibleTexts = Array.from(document.querySelectorAll("button, a, div, span, h1, h2, h3"))
        .filter(isVisible)
        .map((node) => clean(node.innerText || node.textContent || ""))
        .filter(Boolean);
      return {
        bodyTextLength: clean(document.body?.innerText || document.body?.textContent || "").length,
        bodyTextStart: clean(document.body?.innerText || document.body?.textContent || "").slice(0, 3000),
        buttonsAndLinks: visibleTexts
          .filter((text) => text.length <= 120)
          .slice(0, 200),
      };
    })
    .catch((error) => ({ error: errorMessage(error) }));

  const diagnostics = {
    generatedAt: new Date().toISOString(),
    reason,
    url: page.url(),
    title: await page.title().catch(() => ""),
    screenshotPath,
    visibleState,
  };

  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  await fs.writeFile(jsonOutputPath, JSON.stringify(diagnostics, null, 2));
  return jsonOutputPath;
}

function isTargetPage(text) {
  return text.includes("出库单及异常处理") && text.includes("待推送到仓") && text.includes("异常");
}

function isAgentSellerShell(page, text) {
  return page.url().startsWith("https://agentseller.temu.com/") && text.includes("TEMU Agent Center");
}

function isSellerCenterShell(page) {
  return page.url().startsWith("https://seller.kuajingmaihuo.com/");
}

function isNoPermissionPage(text) {
  return /暂无权限|无权限|没有权限|无权访问|该区暂无权限|未开通/.test(text);
}

function isNoPermissionMessage(value) {
  return /暂无权限|无权限|没有权限|无权访问|该区暂无权限|未开通|permission/i.test(String(value || ""));
}

function apiFailureMessage(body) {
  return body?.errorMsg || body?.error_msg || body?.message || "";
}

async function agentSellerApiPost(page, endpoint, body = undefined, { mallId, label } = {}) {
  return await temuPageApiPost(page, {
    origin: AGENT_SELLER_ORIGIN,
    endpoint,
    body,
    mallId,
    label,
  });
}

function assertAgentSellerApiResponse(response, label) {
  if (!response?.ok) {
    fail("API_HTTP_FAILED", `${label} HTTP ${response?.status || "unknown"}：${(response?.bodyText || "").slice(0, 1000)}`);
  }

  const body = response.json;
  if (!body || typeof body !== "object") {
    fail("API_RESPONSE_NOT_JSON", `${label} 返回非 JSON：${(response.bodyText || "").slice(0, 1000)}`);
  }

  const errorCode = body.errorCode ?? body.error_code;
  if (body.success === false || (errorCode !== undefined && Number(errorCode) !== 1000000)) {
    fail(
      "API_RESPONSE_FAILED",
      `${label} 返回失败：code=${errorCode ?? "unknown"} msg=${apiFailureMessage(body) || "unknown"}`,
    );
  }

  return body;
}

async function agentSellerApiResult(page, endpoint, body = undefined, options = {}, label = "Agent Seller API") {
  const response = await agentSellerApiPost(page, endpoint, body, { ...options, label });
  return assertAgentSellerApiResponse(response, label).result || {};
}

async function abnormalApiMallList(page) {
  const response = await agentSellerApiPost(page, "/api/seller/auth/userInfo", {}, { label: "店铺列表接口" });
  const body = assertAgentSellerApiResponse(response, "店铺列表接口");
  const malls = extractMallList(body);
  if (!Array.isArray(malls) || malls.length === 0) {
    fail("API_MALL_LIST_EMPTY", "店铺列表接口没有返回可切换店铺");
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
      fail("API_SHOP_MALL_ID_MISSING", message);
    }
    fail("API_SHOP_TARGET_NOT_FOUND", message);
  }

  const mall = resolved.raw;
  return {
    source: "api",
    mallId: resolved.mallId,
    mallName: resolved.mallName,
    managedType: mall.managedType ?? null,
    mallMode: mall.mallMode ?? null,
    uniqueId: mall.uniqueId || "",
  };
}

function formatShanghaiTimestamp(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "-";
  const millis = timestamp < 1e12 ? timestamp * 1000 : timestamp;
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .formatToParts(new Date(millis))
    .reduce((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function chargeMethodText(value) {
  const number = Number(value);
  if (number === 0) return "线上付款";
  if (number === 1) return "货到付款";
  return displayText(value);
}

function tailShippingModeText(value) {
  const number = Number(value);
  if (number === 0) return "服务商物流";
  if (number === 1) return "平台物流";
  return displayText(value);
}

function formatEstimatedFreight(tracking) {
  if (tracking?.estimateFreightCurrency) {
    return `${displayText(tracking.estimateFreight)} ${tracking.estimateFreightCurrency}`;
  }
  return "-";
}

function formatWarehouseInfo(tracking) {
  return [
    ["服务商名称", tracking?.cwProviderName],
    ["服务商code", tracking?.cwProviderCode],
    ["仓库名称", tracking?.cwWarehouseName],
    ["仓库code", tracking?.cwWarehouseCode],
    ["物流产品编码", Array.isArray(tracking?.lgstServCodes) ? tracking.lgstServCodes.join(",") : tracking?.lgstServCodes],
  ]
    .map(([label, value]) => `${label}：${displayText(value)}`)
    .join(" ");
}

function formatWaybillInfo(tracking) {
  return [
    ["包裹号", tracking?.innerPackageSn || tracking?.packageSn],
    ["物流商名称", tracking?.carrierService || tracking?.carrierName],
    ["运单号", tracking?.trackingNumber],
  ]
    .map(([label, value]) => `${label}：${displayText(value)}`)
    .join(" ");
}

function flattenAbnormalApiRows(resultList) {
  const rows = [];
  for (const order of Array.isArray(resultList) ? resultList : []) {
    const batches = Array.isArray(order?.cwBatchOrderNoShippingInfoDTOList) && order.cwBatchOrderNoShippingInfoDTOList.length > 0
      ? order.cwBatchOrderNoShippingInfoDTOList
      : [{}];
    for (const batch of batches) {
      const trackingItems = Array.isArray(batch?.trackingNumberInfoDTOList) && batch.trackingNumberInfoDTOList.length > 0
        ? batch.trackingNumberInfoDTOList
        : [{}];
      for (const tracking of trackingItems) {
        rows.push({
          sequence: String(rows.length + 1),
          poNumber: displayText(order?.parentOrderSn),
          batchOrderNumber: displayText(batch?.batchOrderNo),
          orderType: chargeMethodText(tracking?.chargeMethod),
          abnormalReason: displayText(tracking?.orderFailReason || tracking?.displayOrderStatusDes),
          operationGuide: displayText(tracking?.suggestion),
          warehouseInfo: formatWarehouseInfo(tracking),
          waybillInfo: formatWaybillInfo(tracking),
          destination: displayText(order?.regionZhName1),
          lastMileMode: tailShippingModeText(tracking?.tailShippingMode),
          itemCount: displayText(tracking?.quantity),
          skuCount: displayText(tracking?.skuNum),
          estimatedFreight: formatEstimatedFreight(tracking),
          createdAt: formatShanghaiTimestamp(order?.createdAt),
          orderedAt: formatShanghaiTimestamp(tracking?.shippingTime || tracking?.firstRequestTime),
          outboundAt: formatShanghaiTimestamp(tracking?.outboundTime),
        });
      }
    }
  }
  return rows;
}

async function abnormalApiOrderPage(page, mallId, pageNo) {
  const request = {
    pageNo,
    pageSize: ABNORMAL_API_PAGE_SIZE,
    queryTabValue: ABNORMAL_QUERY_TAB_VALUE,
    displayOrderStatusList: [ABNORMAL_DISPLAY_ORDER_STATUS],
  };
  const result = await agentSellerApiResult(
    page,
    "/api/bg/cw/order/pageCwNormalOrderShippingInfo",
    request,
    { mallId },
    `异常明细接口 page=${pageNo}`,
  );
  return { request, result };
}

async function collectAbnormalReportByApi(page, shopName, apiMalls) {
  const apiSwitch = mallInfoForShop(apiMalls, shopName);
  networkCapture.mark("abnormal:shop-selected", {
    shopName,
    source: "api",
    mallId: apiSwitch.mallId,
  });

  let sumResult;
  let firstPage;
  try {
    sumResult = await agentSellerApiResult(
      page,
      "/api/bg/cw/order/queryAbnormalOrderSum",
      {},
      { mallId: apiSwitch.mallId },
      `${shopName} 异常数量接口`,
    );
    firstPage = await abnormalApiOrderPage(page, apiSwitch.mallId, 1);
  } catch (error) {
    if (isNoPermissionMessage(errorMessage(error))) {
      return {
        shopName,
        currentShopName: shopName,
        source: "direct-api",
        apiSwitch,
        hasPermission: false,
        abnormalCount: null,
        tabCount: null,
        rows: [],
        reason: "NO_PERMISSION",
        reasonText: "当前店铺无权限访问出库单异常页",
      };
    }
    throw error;
  }

  const abnormalCount = Number.parseInt(String(sumResult.abnormalOrderSum ?? "0"), 10);
  const totalCount = Number.parseInt(String(firstPage.result.totalCount ?? "0"), 10);
  if (Number.isFinite(abnormalCount) && Number.isFinite(totalCount) && abnormalCount !== totalCount) {
    fail("API_ABNORMAL_COUNT_MISMATCH", `${shopName} 异常数量=${abnormalCount}，明细总数=${totalCount}`);
  }

  const pageResults = [firstPage.result];
  const totalPages = Math.ceil(totalCount / ABNORMAL_API_PAGE_SIZE);
  for (let pageNo = 2; pageNo <= totalPages; pageNo += 1) {
    pageResults.push((await abnormalApiOrderPage(page, apiSwitch.mallId, pageNo)).result);
  }

  const rawRows = pageResults.flatMap((result) => (Array.isArray(result.resultList) ? result.resultList : []));
  const rows = flattenAbnormalApiRows(rawRows);
  return {
    shopName,
    currentShopName: shopName,
    source: "direct-api",
    apiSwitch,
    hasPermission: true,
    abnormalCount: totalCount,
    tabCount: abnormalCount,
    rows,
    apiReport: {
      source: "direct-api",
      endpoints: {
        mallList: `${AGENT_SELLER_ORIGIN}/api/seller/auth/userInfo`,
        abnormalSum: `${AGENT_SELLER_ORIGIN}/api/bg/cw/order/queryAbnormalOrderSum`,
        rows: `${AGENT_SELLER_ORIGIN}/api/bg/cw/order/pageCwNormalOrderShippingInfo`,
      },
      request: {
        mallId: apiSwitch.mallId,
        pageSize: ABNORMAL_API_PAGE_SIZE,
        queryTabValue: ABNORMAL_QUERY_TAB_VALUE,
        displayOrderStatusList: [ABNORMAL_DISPLAY_ORDER_STATUS],
      },
      rawOrderCount: rawRows.length,
      rowCount: rows.length,
    },
  };
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

async function waitForShopSwitcherOpen(page, knownShops, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isShopSwitcherOpen(page, knownShops)) return true;
    await page.waitForTimeout(300);
  }
  return false;
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
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return { text: clean(node.innerText || node.textContent || ""), rect };
      })
      .filter(({ text, rect }) => {
        if (rect.width > 360 || rect.height > 100) return false;
        return text === targetText || shopLabelText(text) === targetText;
      })
      .sort((a, b) => a.rect.top - b.rect.top || b.rect.right - a.rect.right || a.rect.width * a.rect.height - b.rect.width * b.rect.height);
    const match = candidates[0];
    if (!match) return null;
    return {
      x: match.rect.x + match.rect.width / 2,
      y: match.rect.y + match.rect.height / 2,
    };
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
  await waitForShopSwitcherOpen(page, knownShops, 10000);
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
    const switchButtonCandidates = (root = document) =>
      Array.from(root.querySelectorAll("button, div, span, a"))
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
      if (labelRect.width <= 0 || labelRect.height <= 0) continue;
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

async function clickShopSwitchButtonWithRetry(page, shopName, knownShops, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isShopSwitcherOpen(page, knownShops))) {
      await closeTemuPopups(page);
    }
    if (await clickShopSwitchButton(page, shopName)) return true;

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await page.waitForTimeout(Math.min(2500, remaining));

    if (!(await isShopSwitcherOpen(page, knownShops))) {
      await openShopSwitcher(page, knownShops).catch(() => {});
    }
  }

  return false;
}

async function switchShop(context, page, shopName, knownShops) {
  let activePage = page;
  const current = await currentShopName(activePage, knownShops);
  if (current !== shopName) {
    await openShopSwitcher(activePage, knownShops);
    if (!(await clickShopSwitchButtonWithRetry(activePage, shopName, knownShops))) {
      fail("SHOP_TARGET_NOT_FOUND", `店铺切换列表中找不到精确店名：${shopName}`);
    }

    await waitSettled(activePage);
  }

  await activePage.goto(targetUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
  await waitSettled(activePage);
  activePage = await ensureTargetPage(context, activePage);

  const after = await currentShopName(activePage, knownShops);
  if (after !== shopName) {
    fail("SHOP_SWITCH_VERIFY_FAILED", `切换后店铺不匹配；目标=${shopName}，当前=${after || "unknown"}`);
  }
  return activePage;
}

async function extractAbnormalReport(page, shopName, knownShops) {
  const current = await currentShopName(page, knownShops);
  if (current !== shopName) {
    fail("SHOP_VERIFY_BEFORE_EXTRACT_FAILED", `读取异常前店铺不匹配；目标=${shopName}，当前=${current || "unknown"}`);
  }

  const text = await bodyText(page);
  if (!isTargetPage(text)) {
    if (isNoPermissionPage(text)) {
      return {
        shopName,
        currentShopName: current,
        hasPermission: false,
        abnormalCount: null,
        tabCount: null,
        rows: [],
        reason: "NO_PERMISSION",
        reasonText: "当前店铺无权限访问出库单及异常处理页面",
      };
    }
    fail("ABNORMAL_PAGE_NOT_READY", `${shopName} 店铺已验证，但当前页面不是出库单及异常处理页面`);
  }

  const abnormalCount = Number.parseInt(text.match(/异常\s*(\d+)/)?.[1] || "0", 10);
  const totalCount = Number.parseInt(text.match(/共有\s*(\d+)\s*条/)?.[1] || "0", 10);
  if (Number.isFinite(abnormalCount) && Number.isFinite(totalCount) && abnormalCount !== totalCount) {
    fail("ABNORMAL_COUNT_MISMATCH", `${shopName} 异常 tab=${abnormalCount}，底部分页=${totalCount}`);
  }

  const rows = await page.evaluate(() => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const table = Array.from(document.querySelectorAll("table")).find((candidate) => {
      const text = clean(candidate.innerText || candidate.textContent);
      return text.includes("PO单号") && text.includes("异常原因");
    });
    if (!table) return [];

    const rowValues = Array.from(table.querySelectorAll("tr")).map((row) =>
      Array.from(row.querySelectorAll("td,th")).map((cell) => clean(cell.innerText || cell.textContent)),
    );
    const headerIndex = rowValues.findIndex((cells) => cells.includes("PO单号") && cells.includes("异常原因"));
    if (headerIndex < 0) return [];
    const headers = rowValues[headerIndex];
    const dataRows = rowValues.slice(headerIndex + 1).filter((cells) => cells.some(Boolean) && !cells.join("").includes("暂无数据"));
    const indexOf = (name) => headers.findIndex((header) => header === name);
    const cellAt = (cells, name) => {
      const index = indexOf(name);
      return index >= 0 ? cells[index] || "" : "";
    };

    return dataRows.map((cells) => ({
      sequence: cellAt(cells, "序号"),
      poNumber: cellAt(cells, "PO单号"),
      batchOrderNumber: cellAt(cells, "批次订单号"),
      orderType: cellAt(cells, "订单类型"),
      abnormalReason: cellAt(cells, "异常原因"),
      operationGuide: cellAt(cells, "操作指导"),
      warehouseInfo: cellAt(cells, "合作仓信息"),
      waybillInfo: cellAt(cells, "运单信息"),
      destination: cellAt(cells, "目的国家/地区"),
      lastMileMode: cellAt(cells, "尾程模式"),
      itemCount: cellAt(cells, "商品件数"),
      skuCount: cellAt(cells, "商品SKU数"),
      estimatedFreight: cellAt(cells, "预估运费"),
      createdAt: cellAt(cells, "创建时间"),
      orderedAt: cellAt(cells, "下单时间"),
      outboundAt: cellAt(cells, "出库时间"),
    }));
  });

  return {
    shopName,
    currentShopName: current,
    hasPermission: true,
    abnormalCount: totalCount,
    tabCount: abnormalCount,
    rows,
  };
}

async function runAccount(account) {
  const shops = shopListForAccount(account);
  const knownShops = [...new Set([...(account.knownShops || []), ...shops])];
  if (shops.length === 0) fail("NO_SHOPS_CONFIGURED", `${account.label || account.id} 没有配置店铺`);

  networkCapture.mark("abnormal:account-start", {
    accountId: account.id,
    accountLabel: account.label || account.id,
    shops,
    targetUrl,
    abnormalSource,
  });
  const { browser, context, page } = await connectCdpChrome(account, targetUrl);
  networkCapture.attach(context);
  try {
    let activePage = await ensureTargetPage(context, page);
    let apiMalls = null;
    if (abnormalSource === "api") {
      try {
        apiMalls = await abnormalApiMallList(activePage);
      } catch (error) {
        if (!abnormalApiDomFallback) throw error;
        console.error(`Abnormal API mall list failed, falling back to DOM: ${account.label || account.id}: ${errorMessage(error)}`);
        networkCapture.mark("abnormal:api-fallback-dom", {
          accountId: account.id,
          accountLabel: account.label || account.id,
          error: errorMessage(error),
        });
      }
    }

    const shopReports = [];
    for (const shopName of shops) {
      networkCapture.mark("abnormal:shop-start", {
        accountId: account.id,
        accountLabel: account.label || account.id,
        shopName,
        abnormalSource,
      });
      let report;
      if (abnormalSource === "api" && apiMalls) {
        try {
          report = await collectAbnormalReportByApi(activePage, shopName, apiMalls);
        } catch (error) {
          if (!abnormalApiDomFallback) throw error;
          console.error(`Abnormal API collection failed, falling back to DOM: ${shopName}: ${errorMessage(error)}`);
          networkCapture.mark("abnormal:api-fallback-dom", {
            accountId: account.id,
            accountLabel: account.label || account.id,
            shopName,
            error: errorMessage(error),
          });
        }
      }

      if (!report) {
        activePage = await switchShop(context, activePage, shopName, knownShops);
        report = await extractAbnormalReport(activePage, shopName, knownShops);
        report.source = report.source || "dom";
      }

      networkCapture.mark("abnormal:extracted", {
        accountId: account.id,
        accountLabel: account.label || account.id,
        shopName,
        source: report.source || "dom",
        hasPermission: report.hasPermission,
        abnormalCount: report.abnormalCount,
        rowCount: report.rows?.length || 0,
      });
      shopReports.push(report);
    }
    return { account, ok: true, shops: shopReports };
  } catch (error) {
    networkCapture.mark("abnormal:account-failed", {
      accountId: account.id,
      accountLabel: account.label || account.id,
      error: errorMessage(error),
    });
    return {
      account,
      ok: false,
      error: errorMessage(error),
    };
  } finally {
    if (process.env.TEMU_CLOSE_CHROME_PAGES !== "0") {
      await closeCdpPages(context);
    }
    networkCapture.detach(context);
    if (process.env.TEMU_CLOSE_CHROME_PROCESS === "0") {
      try {
        browser.disconnect();
      } catch {
        // The parent runner owns the shared CDP Chrome lifecycle.
      }
    } else {
      await browser.close().catch(() => {});
    }
    await closeCdpChromeProcess(account.cdpPort);
  }
}

const accountConfig = JSON.parse(await fs.readFile(accountsPath, "utf8"));
const selectedIds = selectedAccountIds();
const accounts = (accountConfig.accounts || []).filter((account) => selectedIds.length === 0 || selectedIds.includes(account.id));
if (accounts.length === 0) {
  fail("NO_MATCHING_ACCOUNTS", selectedIds.length ? `找不到账号：${selectedIds.join(",")}` : "账号配置为空");
}

const results = [];
for (const account of accounts) {
  console.log(`Running abnormal orders account: ${account.label || account.id}`);
  results.push(await runAccount(account));
}

const outputPath = path.join(reportDir, `temu-abnormal-orders-${stamp}.json`);
const message = results
  .map((result) => {
    const label = result.account.label || result.account.id;
    if (!result.ok) return `【${label}】失败：${result.error}`;
    return [
      `【${label}】`,
      ...result.shops.map((shop) =>
        shop.hasPermission === false ? `${shop.shopName}: 无权限访问异常页` : `${shop.shopName}: ${shop.abnormalCount} 条异常`,
      ),
    ].join("\n");
  })
  .join("\n\n");

await fs.writeFile(
  outputPath,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      accountsPath,
      targetUrl,
      abnormalSource,
      abnormalApiDomFallback,
      message,
      results,
    },
    null,
    2,
  ),
);

console.log(message);
console.log(`Saved JSON: ${outputPath}`);
const networkCapturePath = await networkCapture.flush({
  outcome: results.some((result) => !result.ok) ? "failed" : "ok",
}).catch((error) => {
  console.error(`Network capture failed: ${errorMessage(error)}`);
  return "";
});
if (networkCapturePath) console.log(`Network capture: ${networkCapturePath}`);

if (results.some((result) => !result.ok)) {
  process.exitCode = 1;
}
