import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectCdpChrome } from "../chrome-cdp.mjs";
import { closeCdpChromeProcess, closeCdpPages } from "../cdp-page-cleanup.mjs";
import {
  bodyText,
  enterAgentAuthenticationIfShown,
  isAgentAuthenticationUrl,
  loginSellerIfNeeded,
  needsVerification,
  waitForMatchingPage,
} from "../temu-login-helper.mjs";
import { resolveMallByExactName } from "../temu-mall-resolver.mjs";
import { temuPageApiPost } from "../temu-page-api-client.mjs";
import { closeTemuPopups } from "../temu-popup-cleaner.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const accountsPath = path.join(rootDir, "temu-accounts.json");
const reportDir = path.join(rootDir, "temu-reports", "debug");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

const accountId = process.env.TEMU_ACCOUNT_ID || "setonr";
const shopName = process.env.TEMU_SETTLE_SHOP || "SETONR Products";
const startDate = process.env.TEMU_SETTLE_START_DATE || "2026-04-01";
const endDate = process.env.TEMU_SETTLE_END_DATE || "2026-04-10";
const pageSize = Number.parseInt(process.env.TEMU_SETTLE_PAGE_SIZE || "200", 10);
const maxPages = Number.parseInt(process.env.TEMU_SETTLE_MAX_PAGES || "5", 10);

const region = {
  key: "eu",
  label: "欧区",
  origin: "https://agentseller-eu.temu.com",
};

const targetUrl = `${region.origin}/labor/settle`;
const USER_INFO_ENDPOINT = "/api/seller/auth/userInfo";
const UNSETTLE_ENDPOINT = "/api/xiaowenhou/settle-flow/sm/unsettle/page-query";
const SETTLED_ORDER_ENDPOINT = "/api/xiaowenhou/settle-flow/sm/settled/o/page-query";
const SETTLED_PO_ENDPOINT = "/api/xiaowenhou/settle-flow/sm/settled/po/page-query";

function fail(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  throw error;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function sanitizeKey(key, value) {
  if (/cookie|authorization|password|passwd|pwd|token|secret|sign|signature|csrf|xsrf|session|ticket|credential|anti-content/i.test(key)) {
    return "<redacted>";
  }
  return value;
}

function sanitizeHeaders(headers = {}) {
  const result = {};
  for (const [key, value] of Object.entries(headers || {})) {
    result[key] = sanitizeKey(key, value);
  }
  return result;
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function truncateText(value, limit = 3000) {
  const text = String(value || "");
  return text.length > limit ? `${text.slice(0, limit)}...<truncated ${text.length - limit} chars>` : text;
}

function createProbeCapture() {
  const requestMeta = new Map();
  const events = [];
  const pending = new Set();
  const interesting = /\/api\/|settle|unsettle|payment|arriv|receive|到账|结算/i;

  function onRequest(request) {
    const url = request.url();
    if (!url.includes("temu.com") || !interesting.test(url)) return;
    const postData = request.postData() || "";
    requestMeta.set(request, {
      at: new Date().toISOString(),
      url,
      method: request.method(),
      resourceType: request.resourceType(),
      headers: sanitizeHeaders(request.headers()),
      postData: parseJson(postData) || truncateText(postData, 2000),
    });
  }

  function onResponse(response) {
    const request = response.request();
    const meta = requestMeta.get(request);
    if (!meta) return;
    const task = (async () => {
      let responseText = "";
      let responseJson = null;
      const contentType = String(response.headers()["content-type"] || "");
      if (/json|text/i.test(contentType)) {
        try {
          responseText = (await response.body()).toString("utf8");
          responseJson = parseJson(responseText);
        } catch (error) {
          responseText = errorMessage(error);
        }
      }
      events.push({
        at: new Date().toISOString(),
        request: meta,
        response: {
          status: response.status(),
          ok: response.ok(),
          url: response.url(),
          headers: sanitizeHeaders(response.headers()),
          body: responseJson || null,
          bodyPreview: responseJson ? "" : truncateText(responseText, 3000),
        },
      });
    })();
    pending.add(task);
    task.finally(() => pending.delete(task));
  }

  return {
    attach(context) {
      context.on("request", onRequest);
      context.on("response", onResponse);
    },
    detach(context) {
      context.off("request", onRequest);
      context.off("response", onResponse);
    },
    async settle(timeoutMs = 5000) {
      await Promise.race([
        Promise.allSettled([...pending]),
        new Promise((resolve) => setTimeout(resolve, timeoutMs)),
      ]);
    },
    events,
  };
}

async function waitSettled(page) {
  if (!page || page.isClosed()) return;
  await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
  if (page.isClosed()) return;
  await page.waitForLoadState("networkidle", { timeout: 7000 }).catch(() => {});
  if (page.isClosed()) return;
  await page.waitForTimeout(1000).catch(() => {});
  if (page.isClosed()) return;
  await closeTemuPopups(page).catch(() => {});
}

async function authorizeSellerPage(context, page) {
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

async function ensureAgentSettlePage(context, page) {
  let activePage = page?.isClosed() ? await context.newPage() : page;
  await activePage.goto(targetUrl, { waitUntil: "domcontentloaded" }).catch(() => {});

  for (let attempt = 0; attempt < 7; attempt += 1) {
    await waitSettled(activePage);
    const text = await bodyText(activePage, 3000);
    if (needsVerification(text)) {
      fail("AGENT_SELLER_VERIFICATION_REQUIRED", `${region.label} AgentSeller 页面需要短信或验证码`);
    }
    if (!activePage.isClosed() && activePage.url().startsWith(targetUrl)) return activePage;

    if (!activePage.isClosed() && isAgentAuthenticationUrl(activePage.url())) {
      const authPage = await enterAgentAuthenticationIfShown(context, activePage);
      if (!authPage || isAgentAuthenticationUrl(authPage.url())) {
        fail("AGENT_AUTH_ENTRY_NOT_FOUND", `${region.label} AgentSeller 认证页找不到中国地区商家中心入口`);
      }
      activePage = await authorizeSellerPage(context, authPage);
      activePage =
        (await waitForMatchingPage(
          context,
          (candidate) => candidate.url().startsWith(region.origin) && !isAgentAuthenticationUrl(candidate.url()),
          10000,
        )) || activePage;
      continue;
    }

    if (!activePage.isClosed() && activePage.url().startsWith("https://seller.kuajingmaihuo.com/settle/seller-login")) {
      await authorizeSellerPage(context, activePage);
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

  fail("AGENT_SETTLE_PAGE_NOT_READY", `${region.label} AgentSeller 结算页未进入成功`);
}

async function apiPost(page, endpoint, body, { mallId = "", label = endpoint } = {}) {
  const response = await temuPageApiPost(page, {
    origin: region.origin,
    endpoint,
    body,
    mallId,
    label,
  });
  const json = response.json || null;
  return {
    ok: response.ok,
    status: response.status,
    url: response.url,
    endpoint,
    label,
    request: {
      method: "POST",
      headers: {
        accept: "application/json, text/plain, */*",
        "content-type": "application/json",
        mallid: mallId || undefined,
        "Anti-Content": "generated-by-page-runtime-redacted",
      },
      body,
    },
    json,
    bodyPreview: json ? "" : truncateText(response.bodyText || "", 3000),
  };
}

function apiCode(call) {
  return call?.json?.errorCode ?? call?.json?.error_code ?? call?.json?.code ?? null;
}

function apiMessage(call) {
  return call?.json?.errorMsg || call?.json?.error_msg || call?.json?.message || "";
}

function resultOf(call) {
  return call?.json?.result ?? call?.json?.data ?? null;
}

function rowLists(value, prefix = "") {
  if (!value || typeof value !== "object") return [];
  const lists = [];
  for (const [key, item] of Object.entries(value)) {
    const itemPath = prefix ? `${prefix}.${key}` : key;
    if (Array.isArray(item)) {
      if (item.length && item.some((row) => row && typeof row === "object")) {
        lists.push({ path: itemPath, length: item.length, sampleKeys: Object.keys(item[0] || {}) });
      }
      continue;
    }
    if (item && typeof item === "object") lists.push(...rowLists(item, itemPath));
  }
  return lists;
}

function totalCandidates(value, prefix = "") {
  if (!value || typeof value !== "object") return [];
  const totals = [];
  for (const [key, item] of Object.entries(value)) {
    const itemPath = prefix ? `${prefix}.${key}` : key;
    if (/total|count|amount|sum/i.test(key) && (typeof item !== "object" || item === null || item.value !== undefined || item.digitalText !== undefined)) {
      totals.push({ path: itemPath, value: item });
    }
    if (item && typeof item === "object") totals.push(...totalCandidates(item, itemPath));
  }
  return totals;
}

function summarizeCall(call) {
  const result = resultOf(call);
  return {
    endpoint: call.endpoint,
    status: call.status,
    ok: call.ok,
    code: apiCode(call),
    message: apiMessage(call),
    resultKeys: result && typeof result === "object" ? Object.keys(result) : [],
    rowLists: rowLists(result),
    totals: totalCandidates(result).slice(0, 20),
  };
}

function extractRowsFromCall(call) {
  const result = resultOf(call);
  const lists = rowLists(result);
  if (!lists.length) return [];
  const preferred = lists.find((list) => /list|rows|resultList|records/i.test(list.path)) || lists[0];
  return preferred.path.split(".").reduce((cursor, key) => cursor?.[key], result) || [];
}

async function collectPaged(page, endpoint, baseBody, mallId, label) {
  const pages = [];
  let total = 0;
  for (let pageNum = 1; pageNum <= maxPages; pageNum += 1) {
    const body = { ...baseBody, pageSize, pageNum };
    const call = await apiPost(page, endpoint, body, { mallId, label: `${label} p${pageNum}` });
    pages.push(call);
    const result = resultOf(call);
    const rows = extractRowsFromCall(call);
    total = Number(result?.total ?? result?.totalCount ?? result?.count ?? rows.length ?? total);
    if (!call.ok || (apiCode(call) !== null && Number(apiCode(call)) !== 1000000)) break;
    if (!rows.length || rows.length >= total || pageNum * pageSize >= total) break;
    await page.waitForTimeout(300).catch(() => {});
  }
  return pages;
}

async function clickTexts(page) {
  const attempts = ["已到账款项", "已到账", "已结算款项", "已结算", "待处理款项"];
  const clicked = [];
  for (const text of attempts) {
    const rect = await page.evaluate((target) => {
      const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
      return Array.from(document.querySelectorAll("body *"))
        .map((node) => {
          const text = clean(node.innerText || node.textContent || "");
          const rect = node.getBoundingClientRect();
          const style = window.getComputedStyle(node);
          return {
            text,
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
    if (!rect) continue;
    await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await page.waitForTimeout(1200).catch(() => {});
    clicked.push({ text, rect });
  }
  return clicked;
}

async function visibleSettlementTexts(page) {
  return await page.evaluate(() => {
    const terms = /待处理|已到账|结算|款项|订单|PO|SKU|费用|币种|每页|200/;
    return Array.from(document.querySelectorAll("body *"))
      .map((node) => (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim())
      .filter((text) => text && text.length <= 120 && terms.test(text))
      .slice(0, 200);
  });
}

async function searchLoadedScripts(page) {
  const scriptUrls = await page.evaluate(() =>
    Array.from(
      new Set([
        ...Array.from(document.scripts).map((script) => script.src),
        ...performance
          .getEntriesByType("resource")
          .map((entry) => entry.name)
          .filter((name) => /\.js(?:$|\?)/i.test(name)),
      ]),
    ).filter(Boolean),
  );
  const snippets = [];
  const endpoints = new Set();
  for (const url of scriptUrls.slice(0, 80)) {
    let text = "";
    try {
      const response = await fetch(url);
      if (!response.ok) continue;
      text = await response.text();
    } catch {
      continue;
    }
    text = text.replace(/\\\//g, "/");
    if (!/settle-flow|unsettle|已到账|待处理|到账款项|settle\/page-query|arrived|received/i.test(text)) continue;
    const endpointMatches = text.match(/\/api\/[A-Za-z0-9_./-]*(?:settle|unsettle|payment|account|amount|receive|arriv|bill)[A-Za-z0-9_./-]*/gi) || [];
    for (const endpoint of endpointMatches) endpoints.add(endpoint);
    for (const keyword of ["settle-flow", "unsettle/page-query", "已到账", "到账款项", "待处理款项"]) {
      const index = text.indexOf(keyword);
      if (index >= 0) {
        snippets.push({
          url,
          keyword,
          snippet: text.slice(Math.max(0, index - 600), Math.min(text.length, index + 900)),
        });
      }
    }
  }
  return { scriptUrls, endpoints: [...endpoints].sort(), snippets: snippets.slice(0, 20) };
}

function candidateEndpoints(scriptEndpoints) {
  const candidates = new Set([
    UNSETTLE_ENDPOINT,
    "/api/xiaowenhou/settle-flow/sm/settle/page-query",
    "/api/xiaowenhou/settle-flow/sm/settled/page-query",
    "/api/xiaowenhou/settle-flow/sm/received/page-query",
    "/api/xiaowenhou/settle-flow/sm/arrival/page-query",
    "/api/xiaowenhou/settle-flow/sm/arrived/page-query",
    "/api/xiaowenhou/settle-flow/sm/accounted/page-query",
    "/api/xiaowenhou/settle-flow/sm/paid/page-query",
    "/api/xiaowenhou/settle-flow/sm/payment/page-query",
    "/api/xiaowenhou/settle-flow/sm/income/page-query",
    "/api/xiaowenhou/settle-flow/sm/settle-detail/page-query",
  ]);
  for (const endpoint of scriptEndpoints) {
    if (/settle-flow\/sm/i.test(endpoint) && /page-query/i.test(endpoint)) candidates.add(endpoint);
  }
  return [...candidates];
}

function bodyVariants() {
  return [
    {
      name: "accountTime",
      body: {
        accountTimeStart: startDate,
        accountTimeEnd: endDate,
      },
    },
    {
      name: "orderCreateTime",
      body: {
        orderCreateTimeStart: startDate,
        orderCreateTimeEnd: endDate,
      },
    },
    {
      name: "settleTime",
      body: {
        settleTimeStart: startDate,
        settleTimeEnd: endDate,
      },
    },
    {
      name: "paymentTime",
      body: {
        paymentTimeStart: startDate,
        paymentTimeEnd: endDate,
      },
    },
    {
      name: "receiveTime",
      body: {
        receiveTimeStart: startDate,
        receiveTimeEnd: endDate,
      },
    },
    {
      name: "arriveTime",
      body: {
        arriveTimeStart: startDate,
        arriveTimeEnd: endDate,
      },
    },
  ];
}

async function probeAntiContent(page) {
  return await page.evaluate(async () => {
    try {
      if (!window.__codexTemuChunkRequire) return { present: false, reason: "chunkRequire not initialized before first API call" };
      const riskUtil = window.__codexTemuChunkRequire?.(65531);
      const value = typeof riskUtil?.cN === "function"
        ? await riskUtil.cN()
        : typeof riskUtil?.xy === "function"
          ? riskUtil.xy()
          : "";
      return { present: Boolean(value), length: value ? String(value).length : 0 };
    } catch (error) {
      return { present: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

async function main() {
  await fs.mkdir(reportDir, { recursive: true });
  const config = JSON.parse(await fs.readFile(accountsPath, "utf8"));
  const account = (config.accounts || []).find((item) => item.id === accountId);
  if (!account) fail("ACCOUNT_NOT_FOUND", `找不到账号：${accountId}`);

  const capture = createProbeCapture();
  const { browser, context, page } = await connectCdpChrome(targetUrl, {
    cdpPort: account.cdpPort,
    cdpProfileDir: account.cdpProfileDir,
    temuHomeUrl: targetUrl,
  });
  capture.attach(context);

  const outputPath = path.join(reportDir, `temu-settle-details-probe-${accountId}-${stamp}.json`);
  try {
    const activePage = await ensureAgentSettlePage(context, page);
    const beforeTexts = await visibleSettlementTexts(activePage).catch(() => []);

    const mallListCall = await apiPost(activePage, USER_INFO_ENDPOINT, {}, { label: "AgentSeller 店铺列表" });
    const mall = resolveMallByExactName(mallListCall.json, shopName);

    const knownUnsettlePages = await collectPaged(
      activePage,
      UNSETTLE_ENDPOINT,
      {
        orderCreateTimeStart: startDate,
        orderCreateTimeEnd: endDate,
      },
      mall.mallId,
      "半托待处理款项明细",
    );

    const settledOrderPages = await collectPaged(
      activePage,
      SETTLED_ORDER_ENDPOINT,
      {
        accountTimeStart: startDate,
        accountTimeEnd: endDate,
      },
      mall.mallId,
      "半托已到账订单明细",
    );

    const settledPoPages = await collectPaged(
      activePage,
      SETTLED_PO_ENDPOINT,
      {
        accountTimeStart: startDate,
        accountTimeEnd: endDate,
      },
      mall.mallId,
      "半托已到账 PO 汇总",
    );

    const scriptSearch = await searchLoadedScripts(activePage);
    const clickedTexts = await clickTexts(activePage);
    await capture.settle(6000);
    const afterTexts = await visibleSettlementTexts(activePage).catch(() => []);

    const candidateResults = [];
    for (const endpoint of candidateEndpoints(scriptSearch.endpoints)) {
      if (endpoint === UNSETTLE_ENDPOINT) continue;
      for (const variant of bodyVariants()) {
        const call = await apiPost(
          activePage,
          endpoint,
          { ...variant.body, pageSize, pageNum: 1 },
          { mallId: mall.mallId, label: `${endpoint} ${variant.name}` },
        );
        candidateResults.push({ variant: variant.name, call });
        const result = resultOf(call);
        const rows = extractRowsFromCall(call);
        const total = Number(result?.total ?? result?.totalCount ?? result?.count ?? rows.length ?? 0);
        if (call.ok && Number(apiCode(call) ?? 1000000) === 1000000 && (rows.length || total || totalCandidates(result).length)) break;
        await activePage.waitForTimeout(250).catch(() => {});
      }
    }

    const antiContentProbe = await probeAntiContent(activePage);
    await capture.settle(6000);

    const output = {
      generatedAt: new Date().toISOString(),
      accountId,
      shopName,
      dateRange: { startDate, endDate },
      pageSize,
      maxPages,
      region,
      targetUrl,
      mall: {
        mallId: mall.mallId,
        mallName: mall.mallName,
        raw: mall.raw,
      },
      confirmedHeaders: {
        method: "POST",
        accept: "application/json, text/plain, */*",
        "content-type": "application/json",
        credentials: "include",
        mallid: mall.mallId,
        "Anti-Content": antiContentProbe,
      },
      calls: {
        mallList: mallListCall,
        knownUnsettlePages,
        settledOrderPages,
        settledPoPages,
        candidateResults,
      },
      summaries: {
        mallList: summarizeCall(mallListCall),
        knownUnsettlePages: knownUnsettlePages.map(summarizeCall),
        settledOrderPages: settledOrderPages.map(summarizeCall),
        settledPoPages: settledPoPages.map(summarizeCall),
        candidates: candidateResults.map((item) => ({
          variant: item.variant,
          ...summarizeCall(item.call),
        })),
      },
      pageProbe: {
        beforeTexts,
        clickedTexts,
        afterTexts,
      },
      scriptSearch,
      capturedEvents: capture.events,
    };

    await fs.writeFile(outputPath, JSON.stringify(output, null, 2));
    console.log(`Saved JSON: ${outputPath}`);
  } finally {
    capture.detach(context);
    await closeCdpPages(context).catch(() => {});
    await browser.close().catch(() => {});
    await closeCdpChromeProcess(account.cdpPort).catch(() => {});
  }
}

await main().catch(async (error) => {
  const outputPath = path.join(reportDir, `temu-settle-details-probe-${accountId}-${stamp}.error.json`);
  await fs
    .writeFile(
      outputPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          ok: false,
          error: errorMessage(error),
        },
        null,
        2,
      ),
    )
    .catch(() => {});
  console.error(errorMessage(error));
  console.error(`Saved JSON: ${outputPath}`);
  process.exitCode = 1;
});
