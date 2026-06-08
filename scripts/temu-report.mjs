import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./temu-config.mjs";
import { connectCdpChrome } from "./chrome-cdp.mjs";
import { closeCdpChromeProcess, closeCdpPages } from "./cdp-page-cleanup.mjs";
import { closeTemuPopups } from "./temu-popup-cleaner.mjs";
import { createTemuNetworkCapture } from "./temu-network-capture.mjs";
import { loginSellerIfNeeded } from "./temu-login-helper.mjs";
import { temuPageApiPost } from "./temu-page-api-client.mjs";
import { extractMallList, resolveMallByExactName } from "./temu-mall-resolver.mjs";

const now = new Date();
const stamp = now.toISOString().replace(/[:.]/g, "-");
await fs.mkdir(config.reportDir, { recursive: true });

const jsonPath = path.join(config.reportDir, `${config.reportPrefix}-${stamp}.json`);
const DAY_MS = 24 * 60 * 60 * 1000;
const SHANGHAI_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;
const API_BASE_URL = "https://ads.temu.com/api/v1/coconut";
const PRODUCT_API_PAGE_SIZE = 50;
const PRODUCT_DATA_SOURCE = "api";
const PRODUCT_SORT_METRIC = "API 净申报价销售额（全域）";
const networkCapture = createTemuNetworkCapture({
  kind: "product-report",
  reportDir: config.reportDir,
  stamp,
  accountLabel: config.accountLabel,
  reportPrefix: config.reportPrefix,
  reportDate: config.reportDate,
  reportDateLabel: config.reportDateLabel,
  region: config.targetRegion,
});

class TemuReportError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "TemuReportError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new TemuReportError(code, message);
}

function moneyToNumber(value) {
  const cleaned = String(value || "").replace(/[￥¥,\s]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function compactProductName(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/ 商品ID:.*/, "")
    .trim();
}

function briefProductName(value, maxLength = 26) {
  const compact = compactProductName(value);
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function waitSettled(page) {
  await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(500);
  await dismissBlockingModals(page);
}

async function dismissBlockingModals(page) {
  const primaryResult = await closeTemuPopups(page);
  if (primaryResult.clicked > 0 || primaryResult.hidden > 0) {
    await page.waitForTimeout(500);
  }

  const modal = page.locator('[data-testid="beast-core-modal"], [data-testid="beast-core-modal-container"]');
  const visibleModalCount = await modal
    .evaluateAll((nodes) =>
      nodes.filter((node) => {
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      }).length,
    )
    .catch(() => 0);

  if (visibleModalCount === 0) return;

  for (const label of ["我知道了", "知道了", "确定", "关闭"]) {
    const button = page.getByText(label, { exact: true }).last();
    if ((await button.count().catch(() => 0)) === 0) continue;
    if (!(await button.isVisible().catch(() => false))) continue;

    await button.click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(500);
    return;
  }
}

async function bodyText(page) {
  return await page.locator("body").innerText({ timeout: 10000 }).catch(() => "");
}

async function waitForText(page, text, timeout = 15000) {
  await page.getByText(text, { exact: true }).first().waitFor({ state: "visible", timeout });
}

function isAuthUrl(url) {
  return url.includes("login.html") || url.includes("seller.kuajingmaihuo.com/settle/activity-login");
}

function preferredWorkPage(context, fallback) {
  return (
    [...context.pages()]
      .reverse()
      .find((candidate) => candidate.url().includes("ads.temu.com") && !isAuthUrl(candidate.url())) ||
    fallback
  );
}

async function closeStaleAuthPages(context, keepPage) {
  for (const candidate of context.pages()) {
    if (candidate === keepPage) continue;
    if (isAuthUrl(candidate.url())) {
      await candidate.close().catch(() => {});
    }
  }
}

function isLoggedInText(text) {
  return (
    text.includes("当前区域") ||
    text.includes("数据报表") ||
    text.includes("商品推广") ||
    (text.includes("半托管") && text.includes("切换"))
  );
}

async function isLoggedIn(page) {
  return isLoggedInText(await bodyText(page));
}

async function clickTextByRect(page, text, pickRect) {
  const rect = await page.evaluate(
    ({ text, pickRectSource }) => {
      const pick = new Function("rects", `return (${pickRectSource})(rects);`);
      const rects = Array.from(document.querySelectorAll("*"))
        .filter((node) => {
          const value = (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
          if (value !== text) return false;
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        })
        .map((node) => {
          const rect = node.getBoundingClientRect();
          return {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            text: (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim(),
          };
        });
      return pick(rects);
    },
    { text, pickRectSource: pickRect.toString() },
  );

  if (!rect) return false;
  await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
  return true;
}

async function clickTopRightLogin(page) {
  return await clickTextByRect(page, "登录", (rects) =>
    rects
      .filter((rect) => rect.y < 120)
      .sort((a, b) => b.x - a.x)[0] || null,
  );
}

async function textRects(page, text) {
  return await page.evaluate((text) => {
    return Array.from(document.querySelectorAll("*"))
      .filter((node) => {
        const value = (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
        if (value !== text) return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        };
      });
  }, text);
}

async function clickNonLocalSellerLogin(page) {
  const nonLocalRect = await page
    .getByText("你是一位非当地卖家", { exact: true })
    .boundingBox({ timeout: 5000 })
    .catch(() => null);

  if (!nonLocalRect) return false;

  const rect = (await textRects(page, "登录"))
    .filter((candidate) => candidate.y > nonLocalRect.y && candidate.y < nonLocalRect.y + 140)
    .sort((a, b) => a.y - b.y)[0];

  if (!rect) return false;
  await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
  return true;
}

async function waitForMatchingPage(context, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pages = context.pages();
    const matched = [...pages].reverse().find(predicate);
    if (matched) return matched;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

async function waitForLoggedInPage(context, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const candidate of context.pages()) {
      if (await isLoggedIn(candidate).catch(() => false)) return candidate;
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  return null;
}

async function attemptAutoLogin(context, page) {
  if (process.env.TEMU_AUTO_LOGIN === "0") return page;

  await page.goto(config.temuHomeUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
  await waitSettled(page);
  if (await isLoggedIn(page)) return page;

  let text = await bodyText(page);
  if (!text.includes("你是一位非当地卖家")) {
    await clickTopRightLogin(page);
    await waitForText(page, "你是一位非当地卖家", 10000).catch(() => {});
  }

  if (!(await clickNonLocalSellerLogin(page))) {
    fail("AUTO_LOGIN_NON_LOCAL_BUTTON_NOT_FOUND", "找不到非当地卖家登录入口");
  }
  const sellerPage = await waitForMatchingPage(
    context,
    (candidate) => candidate.url().includes("seller.kuajingmaihuo.com"),
    20000,
  );

  if (!sellerPage) {
    fail("AUTO_LOGIN_SELLER_PAGE_NOT_OPENED", "非当地卖家登录页没有打开");
  }

  await sellerPage.bringToFront().catch(() => {});
  await sellerPage.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
  await waitForText(sellerPage, "授权登录", 15000).catch(() => {});

  if (await isLoggedIn(sellerPage)) return sellerPage;

  text = await bodyText(sellerPage);
  if (
    !text.includes("授权登录") &&
    !text.includes("确认授权并前往") &&
    !text.includes("授权并前往") &&
    !text.includes("同意并登录") &&
    !text.includes("手机号登录") &&
    !text.includes("邮箱登录") &&
    !text.includes("密码")
  ) {
    fail("AUTO_LOGIN_FORM_NOT_FOUND", "卖家中心登录表单未出现");
  }

  const sellerLoginPage = await loginSellerIfNeeded(context, sellerPage, {
    fail,
    errorCodes: {
      buttonNotFound: "AUTO_LOGIN_AUTHORIZE_BUTTON_NOT_FOUND",
      consentNotChecked: "AUTO_LOGIN_CONSENT_NOT_CHECKED",
      notSubmitted: "LOGIN_STATE_UNAVAILABLE",
      passwordNotFilled: "AUTO_LOGIN_PASSWORD_NOT_FILLED",
      verificationRequired: "AUTO_LOGIN_VERIFICATION_REQUIRED",
    },
    messages: {
      buttonNotFound: "找不到授权登录按钮",
      consentNotChecked: "授权复选框未成功勾选",
      notSubmitted: "自动登录后仍未进入 Temu 后台",
      passwordNotFilled: "Chrome 保存密码未自动填充，且没有运行时账号密码",
      verificationRequired: "登录需要短信或验证码",
    },
  });

  if (sellerPage.isClosed()) {
    const loggedInPage = await waitForLoggedInPage(context, 20000);
    if (loggedInPage) return loggedInPage;
    fail("AUTO_LOGIN_PAGE_CLOSED", "卖家中心登录页已关闭，但未找到已登录后台页");
  }

  await new Promise((resolve) => setTimeout(resolve, 8000));

  const afterLoginText = await bodyText(sellerLoginPage || sellerPage).catch(() => "");
  if (/验证码|短信|verification/i.test(afterLoginText) && !isLoggedInText(afterLoginText)) {
    fail("AUTO_LOGIN_VERIFICATION_REQUIRED", "登录需要短信或验证码");
  }

  const loggedInPage =
    (await waitForLoggedInPage(context, 20000)) ||
    context.pages().find((candidate) => /ads\.temu\.com/.test(candidate.url()) && !candidate.url().includes("login.html")) ||
    sellerLoginPage ||
    sellerPage;

  await loggedInPage.goto(config.temuHomeUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
  await waitSettled(loggedInPage);
  return loggedInPage;
}

async function ensureLoggedIn(context, page) {
  if (await isLoggedIn(page)) return page;

  const loggedInPage = await attemptAutoLogin(context, page);
  if (await isLoggedIn(loggedInPage)) return loggedInPage;

  fail("LOGIN_STATE_UNAVAILABLE", "自动登录后仍未进入 Temu 后台");
}

function metricTransValue(metric) {
  return metric?.trans_val || "";
}

function metricNumberValue(metric) {
  if (metric?.trans_val) return moneyToNumber(metric.trans_val);
  const value = metric?.val;
  return Number.isFinite(value) ? value : 0;
}

function formatShanghaiDateTime(timestamp) {
  if (!Number.isFinite(timestamp)) return "";
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
    .formatToParts(new Date(timestamp))
    .reduce((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function apiMetric(summary, key, preferNet = true) {
  const metric = summary?.[key] || {};
  return preferNet ? metric.net_total || metric.total || metric.net_ad || metric.ad : metric.total || metric.net_total || metric.ad || metric.net_ad;
}

function buildApiRow(detail) {
  const summary = detail?.summary || {};
  const spendMetric = apiMetric(summary, "spend", false);
  const quantityMetric = apiMetric(summary, "goods_num", false);
  const netQuantityMetric = apiMetric(summary, "goods_num", true);
  const salesMetric = apiMetric(summary, "order_pay_amt", false);
  const netSalesMetric = apiMetric(summary, "order_pay_amt", true);
  const impressionsMetric = apiMetric(summary, "impr_cnt", false);
  const clicksMetric = apiMetric(summary, "clk_cnt", false);
  const ctrMetric = apiMetric(summary, "ctr", false);
  const cvrMetric = apiMetric(summary, "cvr", false);
  const displaySales = metricTransValue(netSalesMetric) || metricTransValue(salesMetric);
  return {
    productText: detail?.goods_title || "",
    productName: compactProductName(detail?.goods_title || ""),
    productId: String(detail?.goods_id || ""),
    spuId: String(detail?.spu_id || ""),
    imageUrl: String(detail?.goods_image_url || ""),
    status: "",
    totalCost: metricTransValue(spendMetric),
    quantity: metricTransValue(quantityMetric),
    netQuantity: metricTransValue(netQuantityMetric),
    sales: metricTransValue(salesMetric),
    netSales: metricTransValue(netSalesMetric),
    displaySales,
    displaySalesLabel: metricTransValue(netSalesMetric) ? "净销售额" : "销售额",
    impressions: metricTransValue(impressionsMetric),
    clicks: metricTransValue(clicksMetric),
    ctr: metricTransValue(ctrMetric),
    cvr: metricTransValue(cvrMetric),
    salesValue: metricNumberValue(netSalesMetric) || metricNumberValue(salesMetric),
  };
}

function buildApiTotalRow(summary, rowCount) {
  const spendMetric = apiMetric(summary, "spend", false);
  const quantityMetric = apiMetric(summary, "goods_num", false);
  const netQuantityMetric = apiMetric(summary, "goods_num", true);
  const salesMetric = apiMetric(summary, "order_pay_amt", false);
  const netSalesMetric = apiMetric(summary, "order_pay_amt", true);
  const impressionsMetric = apiMetric(summary, "impr_cnt", false);
  const clicksMetric = apiMetric(summary, "clk_cnt", false);
  const ctrMetric = apiMetric(summary, "ctr", false);
  const cvrMetric = apiMetric(summary, "cvr", false);
  const displaySales = metricTransValue(netSalesMetric) || metricTransValue(salesMetric);
  return {
    productText: `共${Number.isFinite(rowCount) ? rowCount : 0}条`,
    productName: `共${Number.isFinite(rowCount) ? rowCount : 0}条`,
    productId: "",
    spuId: "",
    status: "",
    totalCost: metricTransValue(spendMetric),
    quantity: metricTransValue(quantityMetric),
    netQuantity: metricTransValue(netQuantityMetric),
    sales: metricTransValue(salesMetric),
    netSales: metricTransValue(netSalesMetric),
    displaySales,
    displaySalesLabel: metricTransValue(netSalesMetric) ? "净销售额" : "销售额",
    impressions: metricTransValue(impressionsMetric),
    clicks: metricTransValue(clicksMetric),
    ctr: metricTransValue(ctrMetric),
    cvr: metricTransValue(cvrMetric),
    salesValue: metricNumberValue(netSalesMetric) || metricNumberValue(salesMetric),
  };
}

function shanghaiDateParts(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .formatToParts(date)
    .reduce((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
  };
}

function shanghaiDayStartMs(date) {
  const parts = shanghaiDateParts(date);
  return Date.UTC(parts.year, parts.month - 1, parts.day) - SHANGHAI_UTC_OFFSET_MS;
}

function productApiTimeWindow(referenceDate = new Date()) {
  const todayStartTime = shanghaiDayStartMs(referenceDate);
  const startTime = config.reportDate === "yesterday" ? todayStartTime - DAY_MS : todayStartTime;
  const endTime = config.reportDate === "yesterday" ? todayStartTime - 1 : referenceDate.getTime();
  return {
    startTime,
    endTime,
    lastStartTime: startTime - DAY_MS,
    lastEndTime: Math.floor((endTime - DAY_MS) / 1000) * 1000,
    timeType: 1,
  };
}

function queryReportsRequest(timeWindow) {
  return {
    start_ts: timeWindow.startTime,
    end_ts: timeWindow.endTime,
    source: 0,
    sort_type: 0,
    asc_order: true,
    query_type: 0,
    need_query_last_cycle: true,
    site_id: -1,
    columns_type: 21,
    time_type: timeWindow.timeType,
    last_start_ts: timeWindow.lastStartTime,
    last_end_ts: timeWindow.lastEndTime,
  };
}

function adsReportRequest(timeWindow, sortBy) {
  return {
    ad_status: [],
    specific_query_info: "",
    sort_by: sortBy,
    sort_type: "desc",
    start_time: timeWindow.startTime,
    end_time: timeWindow.endTime,
    source: 0,
    need_del_status_ad: true,
    need_calculate_goods_summary: true,
    selected_roas_type: 1,
    filter_cooperative_ad_type: 0,
    data_filter: null,
    ad_group_list: null,
    selected_site_id_list: null,
    ad_phase: -1,
    page_number: 1,
    page_size: PRODUCT_API_PAGE_SIZE,
    columns_type: 21,
    list_id: randomUUID(),
  };
}

async function adsApiPost(page, endpoint, body = {}, label = "Ads API") {
  const url = endpoint.startsWith("http") ? endpoint : `${API_BASE_URL}${endpoint}`;
  return await temuPageApiPost(page, {
    endpoint: url,
    body,
    label,
    headers: {
      "content-type": "application/json;charset=UTF-8",
    },
  });
}

function assertApiResponse(response, label) {
  if (!response?.ok) {
    fail("API_HTTP_FAILED", `${label} HTTP ${response?.status || "unknown"}：${(response?.bodyText || "").slice(0, 1000)}`);
  }

  const body = response.json;
  if (!body || typeof body !== "object") {
    fail("API_RESPONSE_NOT_JSON", `${label} 返回非 JSON：${(response.bodyText || "").slice(0, 1000)}`);
  }

  if (body.success === false || (body.error_code !== undefined && Number(body.error_code) !== 1000000)) {
    fail(
      "API_RESPONSE_FAILED",
      `${label} 返回失败：code=${body.error_code ?? "unknown"} msg=${body.error_msg || body.message || "unknown"}`,
    );
  }

  return body;
}

async function apiMallList(page) {
  const body = assertApiResponse(
    await adsApiPost(page, "/account/mall_list?mallType=2", { mall_type: 2 }, "店铺列表接口"),
    "店铺列表接口",
  );
  const malls = extractMallList(body);
  if (!Array.isArray(malls) || malls.length === 0) {
    fail("API_MALL_LIST_EMPTY", "店铺列表接口没有返回可切换店铺");
  }
  return { body, malls };
}

async function switchShopByApi(page, shopName) {
  if (!page.url().includes("ads.temu.com")) {
    await page.goto(config.temuHomeUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
    await waitSettled(page);
  }

  const mallList = await apiMallList(page);
  let resolved;
  try {
    resolved = resolveMallByExactName(mallList.body, shopName);
  } catch (error) {
    if (errorMessage(error).includes("缺少 mallId")) {
      fail("API_SHOP_MALL_ID_MISSING", `店铺列表接口中 ${shopName} 缺少 mall_id`);
    }
    const matches = mallList.malls.filter((mall) => String(mall.mallName ?? mall.mall_name ?? "").trim() === shopName);
    fail(
      "API_SHOP_TARGET_NOT_FOUND",
      `店铺列表接口中找不到唯一精确店名：${shopName}；匹配数=${matches.length}`,
    );
  }

  const mall = resolved.raw;
  const targetMallId = resolved.mallId;

  const body = assertApiResponse(
    await adsApiPost(
      page,
      `/account/mall_switch?mallType=2&targetMallId=${encodeURIComponent(targetMallId)}`,
      {},
      "店铺切换接口",
    ),
    "店铺切换接口",
  );
  if (body.result?.mall_switch_result !== true) {
    fail("API_SHOP_SWITCH_FAILED", `店铺切换接口未确认成功：${shopName}`);
  }

  await page.waitForTimeout(800);
  return {
    source: "api",
    mallId: targetMallId,
    mallName: resolved.mallName,
    mallType: String(mall.mallType ?? mall.mall_type ?? ""),
    targetDomain: body.result?.target_domain || "",
  };
}

function directApiReportFromResponses({ shopName, switchInfo, timeWindow, queryRequestBody, queryBody, adsRequestBody, adsBody, sortMetricUsed }) {
  const result = adsBody?.result || {};
  if (!result.summary) {
    fail("API_PRODUCT_SUMMARY_MISSING", `${shopName} 商品数据接口没有返回 summary`);
  }

  const rowCount = Number(result.total_goods_num ?? result.ads_detail?.length ?? 0);
  const productRows = (Array.isArray(result.ads_detail) ? result.ads_detail : [])
    .map(buildApiRow)
    .sort((a, b) => b.salesValue - a.salesValue);
  const total = buildApiTotalRow(result.summary, rowCount);
  const updateAt = Number(queryBody?.result?.update_at || 0);
  const apiReport = {
    source: "direct-api",
    ok: true,
    endpoints: {
      summary: `${API_BASE_URL}/reports/queryReports`,
      rows: `${API_BASE_URL}/ad/ads_report`,
      updateTime: `${API_BASE_URL}/reports/queryReports`,
      mallList: `${API_BASE_URL}/account/mall_list?mallType=2`,
      mallSwitch: `${API_BASE_URL}/account/mall_switch?mallType=2&targetMallId=${switchInfo.mallId}`,
    },
    request: {
      ...timeWindow,
      queryReports: queryRequestBody,
      adsReport: {
        sortBy: adsRequestBody.sort_by,
        sortType: adsRequestBody.sort_type,
        pageNumber: adsRequestBody.page_number,
        pageSize: adsRequestBody.page_size,
      },
    },
    switch: switchInfo,
    updateTime: formatShanghaiDateTime(updateAt),
    total,
    top: productRows.slice(0, 5),
    rowCount: productRows.length,
  };
  const summary = { total, top: apiReport.top, updateTime: apiReport.updateTime };

  return {
    shopName,
    source: "direct-api",
    rows: [total, ...productRows],
    sortMetricUsed,
    ...summary,
    apiSwitch: switchInfo,
    apiReport,
    apiComparison: compareApiReport(summary, apiReport),
  };
}

async function collectProductDataByApi(page, shopName, switchInfo) {
  const timeWindow = productApiTimeWindow();
  const queryRequestBody = queryReportsRequest(timeWindow);
  const queryBody = assertApiResponse(
    await adsApiPost(page, "/reports/queryReports", queryRequestBody, `${shopName} 汇总更新时间接口`),
    `${shopName} 汇总更新时间接口`,
  );
  const sortCandidates = [
    { sortBy: 1110, label: "API 净申报价销售额（全域）" },
    { sortBy: 0, label: "API 默认销售额排序" },
  ];
  const errors = [];

  for (const candidate of sortCandidates) {
    const adsRequestBody = adsReportRequest(timeWindow, candidate.sortBy);
    try {
      const adsBody = assertApiResponse(
        await adsApiPost(page, "/ad/ads_report", adsRequestBody, `${shopName} 商品明细接口 sort_by=${candidate.sortBy}`),
        `${shopName} 商品明细接口 sort_by=${candidate.sortBy}`,
      );
      return directApiReportFromResponses({
        shopName,
        switchInfo,
        timeWindow,
        queryRequestBody,
        queryBody,
        adsRequestBody,
        adsBody,
        sortMetricUsed: candidate.label,
      });
    } catch (error) {
      errors.push(errorMessage(error));
    }
  }

  fail("API_PRODUCT_REPORT_FAILED", `${shopName} 商品明细接口失败：${errors.join(" / ")}`);
}

function compareApiReport(summary, apiReport) {
  if (!apiReport) return null;
  return {
    quantityMatches: String(summary.total?.quantity || "") === String(apiReport.total?.quantity || ""),
    salesMatches: String(summary.total?.displaySales || "") === String(apiReport.total?.displaySales || ""),
    updateTimeMatches: !summary.updateTime || !apiReport.updateTime || summary.updateTime === apiReport.updateTime,
  };
}

function refreshApiReports(reports) {
  return reports.map((report) => ({
    ...report,
    apiComparison: compareApiReport(report, report.apiReport),
  }));
}

function formatShopSummary(shopReport) {
  const { shopName, total, top } = shopReport;
  const lines = [
    `【${shopName}】`,
    total
      ? `合计：件数 ${total.quantity}｜${total.displaySalesLabel} ${total.displaySales}`
      : "合计：未读取到汇总行",
    ...top.map(
      (row, index) =>
        `${index + 1}. ${briefProductName(row.productName)}\n` +
        `   件数 ${row.quantity}｜${row.displaySalesLabel} ${row.displaySales}`,
    ),
  ];

  return lines.join("\n");
}

function formatShopFailure(failure) {
  return [`【${failure.shopName}】`, `失败：${failure.error}`].join("\n");
}

function buildMessage(reports, failures = []) {
  const updateTimes = [...new Set(reports.map((report) => report.updateTime).filter(Boolean))];
  const sortMetrics = [...new Set(reports.map((report) => report.sortMetricUsed).filter(Boolean))];
  const title = config.accountLabel
    ? `Temu 欧区${config.reportDateLabel}商品数据（${config.accountLabel}）`
    : `Temu 欧区${config.reportDateLabel}商品数据`;
  const reportBlocks = reports.map(formatShopSummary);
  const failureBlocks = failures.map(formatShopFailure);
  return [
    title,
    updateTimes.length ? `更新时间：${updateTimes.join(" / ")}` : null,
    sortMetrics.length ? `排序：${sortMetrics.join(" / ")} 从高到低` : null,
    "",
    [...reportBlocks, ...failureBlocks].join("\n\n") || "无成功店铺",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

async function collectShopByApi(activePage, shopName) {
  const apiSwitch = await switchShopByApi(activePage, shopName);
  networkCapture.mark("product:shop-selected", { shopName, source: "api", mallId: apiSwitch.mallId, url: activePage.url() });
  const report = await collectProductDataByApi(activePage, shopName, apiSwitch);
  networkCapture.mark("product:extracted", {
    shopName,
    source: "api",
    rowCount: report.rows.length,
    sortMetricUsed: report.sortMetricUsed,
    updateTime: report.updateTime,
    totalQuantity: report.total?.quantity || "",
    totalSales: report.total?.displaySales || "",
    apiQuantity: report.apiReport?.total?.quantity || "",
    apiSales: report.apiReport?.total?.displaySales || "",
    apiMatches: true,
  });
  return { activePage, report };
}

async function writeReportFile(reports, failures) {
  const message = buildMessage(reports, failures);
  await fs.writeFile(
    jsonPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        accountLabel: config.accountLabel,
        region: config.targetRegion,
        date: config.reportDate,
        dateLabel: config.reportDateLabel,
        productSource: PRODUCT_DATA_SOURCE,
        apiDomFallback: false,
        sortMetric: PRODUCT_SORT_METRIC,
        ok: failures.length === 0,
        partial: reports.length > 0 && failures.length > 0,
        failures,
        message,
        shops: reports,
      },
      null,
      2,
    ),
  );

  console.log(message);
  console.log(`Saved JSON: ${jsonPath}`);
}

const { browser, context, page } = await connectCdpChrome(config.temuHomeUrl);
networkCapture.attach(context);
let runOutcome = "failed";

try {
  const startPage = preferredWorkPage(context, page);
  networkCapture.mark("product:script-start", {
    accountLabel: config.accountLabel,
    shops: config.shopNames,
    reportDate: config.reportDate,
    region: config.targetRegion,
    productSource: PRODUCT_DATA_SOURCE,
  });
  await closeStaleAuthPages(context, startPage);
  await startPage.goto(config.temuHomeUrl, { waitUntil: "domcontentloaded" });
  await waitSettled(startPage);
  let activePage = await ensureLoggedIn(context, startPage);
  await closeStaleAuthPages(context, activePage);
  const reports = [];
  const failures = [];

  for (const shopName of config.shopNames) {
    try {
      networkCapture.mark("product:shop-start", { shopName, productSource: PRODUCT_DATA_SOURCE });
      const result = await collectShopByApi(activePage, shopName);

      activePage = result.activePage;
      reports.push(result.report);
    } catch (error) {
      failures.push({ shopName, error: errorMessage(error) });
      networkCapture.mark("product:shop-failed", { shopName, error: errorMessage(error) });
      console.error(`Shop failed: ${shopName}: ${errorMessage(error)}`);
      await activePage.goto(config.temuHomeUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
      await waitSettled(activePage).catch(() => {});
    }
  }

  await networkCapture.settle(5000);
  const reportsWithApi = refreshApiReports(reports);
  await writeReportFile(reportsWithApi, failures);
  runOutcome = failures.length === 0 ? "ok" : reports.length > 0 ? "partial" : "failed";
  if (reports.length === 0 && failures.length > 0) process.exitCode = 1;
} catch (error) {
  const message = [
    "Temu 巡检失败",
    `时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`,
    `错误：${errorMessage(error)}`,
  ].join("\n");

  const page = context.pages()[0];
  if (page) await page.title().catch(() => "");
  console.error(message);

  throw error;
} finally {
  const networkCapturePath = await networkCapture.flush({ outcome: runOutcome }).catch((error) => {
    console.error(`Network capture failed: ${errorMessage(error)}`);
    return "";
  });
  if (networkCapturePath) console.log(`Network capture: ${networkCapturePath}`);
  await closeCdpPages(context);
  await browser.close().catch(() => {});
  await closeCdpChromeProcess(config.cdpPort);
}
