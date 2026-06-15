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
import { closeTemuPopups } from "../temu-popup-cleaner.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const accountsPath = path.join(rootDir, "temu-accounts.json");
const reportDir = path.join(rootDir, "temu-reports", "debug");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

const accountId = process.env.TEMU_ACCOUNT_ID || "setonr";
const shopName = process.env.TEMU_STML_SHOP || "SETONR Products";
const startDate = process.env.TEMU_STML_START_DATE || "2026-04-01";
const endDate = process.env.TEMU_STML_END_DATE || "2026-04-30";
const pageSize = Number.parseInt(process.env.TEMU_STML_PAGE_SIZE || "200", 10);
const maxPages = Number.parseInt(process.env.TEMU_STML_MAX_PAGES || "20", 10);

const region = {
  key: "eu",
  label: "欧区",
  origin: "https://agentseller-eu.temu.com",
};

const targetUrl = `${region.origin}/labor/stml-logistics`;
const USER_INFO_ENDPOINT = "/api/seller/auth/userInfo";

const COMMON_HEADERS = {
  accept: "application/json, text/plain, */*",
  "content-type": "application/json",
};

function fail(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  throw error;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function endpointPath(url) {
  try {
    const parsed = new URL(url, region.origin);
    return `${parsed.pathname}${parsed.search || ""}`;
  } catch {
    return String(url || "");
  }
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
  const interesting = /\/api\/|\/portal\/selene|stml|logistics|waybill|tracking|bill|recon|charge|fee|expense|shipping|freight|adjust/i;

  function onRequest(request) {
    const url = request.url();
    if (!url.includes("temu.com") || !interesting.test(url)) return;
    const postData = request.postData() || "";
    requestMeta.set(request, {
      at: new Date().toISOString(),
      url,
      endpoint: endpointPath(url),
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

async function installPageNetworkHook(context) {
  await context.addInitScript(() => {
    if (window.__codexStmlHookInstalled) return;
    window.__codexStmlHookInstalled = true;
    window.__codexStmlNetwork = [];
    window.__codexStmlLatestAntiContent = "";

    const interesting = /\/api\/|\/portal\/selene|stml|logistics|waybill|tracking|bill|recon|charge|fee|expense|shipping|freight|adjust/i;
    const endpointPath = (url) => {
      try {
        const parsed = new URL(String(url), location.origin);
        return `${parsed.pathname}${parsed.search || ""}`;
      } catch {
        return String(url || "");
      }
    };
    const parseJson = (text) => {
      if (!text || typeof text !== "string") return null;
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    };
    const bodyPreview = (body) => {
      if (!body) return "";
      if (typeof body === "string") return parseJson(body) || body.slice(0, 2000);
      if (body instanceof URLSearchParams) return body.toString();
      if (body instanceof FormData) return "<form-data>";
      return String(body).slice(0, 2000);
    };
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
    const sanitizeHeaders = (headers) => {
      const result = {};
      for (const [key, value] of headerEntries(headers)) {
        const normalized = String(key || "");
        if (/anti-content/i.test(normalized)) {
          const text = String(value || "");
          window.__codexStmlLatestAntiContent = text;
          result[normalized] = text ? `<redacted length=${text.length}>` : "";
          continue;
        }
        if (/cookie|authorization|password|passwd|pwd|token|secret|sign|signature|csrf|xsrf|session|ticket|credential/i.test(normalized)) {
          result[normalized] = "<redacted>";
          continue;
        }
        result[normalized] = value;
      }
      return result;
    };
    const pushEvent = (event) => {
      try {
        window.__codexStmlNetwork.push({
          at: new Date().toISOString(),
          ...event,
        });
      } catch {
        // Keep the page behavior unchanged if debug recording fails.
      }
    };

    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
      const input = args[0];
      const init = args[1] || {};
      const url = typeof input === "string" ? input : input?.url || "";
      const method = init.method || input?.method || "GET";
      const headers = new Headers(input?.headers || {});
      for (const [key, value] of headerEntries(init.headers)) headers.set(key, value);
      let body = init.body;
      if (body === undefined && input instanceof Request) {
        try {
          body = await input.clone().text();
        } catch {
          body = "";
        }
      }
      const shouldRecord = interesting.test(String(url));
      let response;
      try {
        response = await originalFetch.apply(window, args);
      } finally {
        // no-op
      }
      if (shouldRecord) {
        let responseText = "";
        let responseJson = null;
        try {
          const cloned = response.clone();
          responseText = await cloned.text();
          responseJson = parseJson(responseText);
        } catch (error) {
          responseText = error instanceof Error ? error.message : String(error);
        }
        pushEvent({
          transport: "fetch",
          request: {
            url: String(url),
            endpoint: endpointPath(url),
            method,
            headers: sanitizeHeaders(headers),
            postData: bodyPreview(body),
          },
          response: {
            status: response.status,
            ok: response.ok,
            url: response.url,
            body: responseJson,
            bodyPreview: responseJson ? "" : String(responseText || "").slice(0, 3000),
          },
        });
      }
      return response;
    };

    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function open(method, url, ...rest) {
      this.__codexStmlRequest = { method, url: String(url), headers: {} };
      return originalOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.setRequestHeader = function setRequestHeader(key, value) {
      if (this.__codexStmlRequest) this.__codexStmlRequest.headers[key] = value;
      return originalSetRequestHeader.call(this, key, value);
    };
    XMLHttpRequest.prototype.send = function send(body) {
      const meta = this.__codexStmlRequest || {};
      const shouldRecord = interesting.test(String(meta.url || ""));
      if (shouldRecord) {
        this.addEventListener("loadend", () => {
          const responseText = String(this.responseText || "");
          pushEvent({
            transport: "xhr",
            request: {
              url: String(meta.url || ""),
              endpoint: endpointPath(meta.url),
              method: meta.method || "GET",
              headers: sanitizeHeaders(meta.headers || {}),
              postData: bodyPreview(body),
            },
            response: {
              status: this.status,
              ok: this.status >= 200 && this.status < 300,
              url: this.responseURL,
              body: parseJson(responseText),
              bodyPreview: parseJson(responseText) ? "" : responseText.slice(0, 3000),
            },
          });
        });
      }
      return originalSend.call(this, body);
    };
  });
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

async function ensureTargetPage(context, page) {
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

  fail("AGENT_STML_PAGE_NOT_READY", `${region.label} AgentSeller 线上面单费用页未进入成功`);
}

async function apiPost(page, endpoint, body, { mallId = "", label = endpoint } = {}) {
  const response = await page.evaluate(
    async ({ origin, endpoint, body, mallId, commonHeaders }) => {
      const url = endpoint.startsWith("http") ? endpoint : new URL(endpoint, origin).toString();
      const antiContent = window.__codexStmlLatestAntiContent || "";
      const headers = { ...commonHeaders };
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
    {
      origin: region.origin,
      endpoint,
      body,
      mallId,
      commonHeaders: COMMON_HEADERS,
    },
  );
  const json = response.json || null;
  return {
    ok: response.ok,
    status: response.status,
    url: response.url,
    endpoint: endpointPath(response.url || endpoint),
    label,
    request: {
      method: "POST",
      headers: {
        ...COMMON_HEADERS,
        mallid: mallId || undefined,
        "Anti-Content": response.antiContentPresent ? `<page-generated redacted length=${response.antiContentLength}>` : undefined,
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
  return call?.json?.result?.res ?? call?.json?.res ?? call?.json?.result ?? call?.json?.data ?? null;
}

function nestedEntries(value, prefix = "") {
  if (!value || typeof value !== "object") return [];
  const entries = [];
  for (const [key, item] of Object.entries(value)) {
    const itemPath = prefix ? `${prefix}.${key}` : key;
    entries.push({ path: itemPath, value: item });
    if (item && typeof item === "object" && !Array.isArray(item)) {
      entries.push(...nestedEntries(item, itemPath));
    }
  }
  return entries;
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
    requestBody: call.request?.body,
    resultKeys: result && typeof result === "object" ? Object.keys(result) : [],
    rowLists: rowLists(result),
    totals: totalCandidates(result).slice(0, 30),
  };
}

function valueAtPath(value, itemPath) {
  if (!itemPath) return value;
  return itemPath.split(".").reduce((cursor, key) => cursor?.[key], value);
}

function extractRowsFromResult(result) {
  const lists = rowLists(result);
  if (!lists.length) return { path: "", rows: [] };
  const preferred =
    lists.find((list) => /dataList|resultList|records|recordList|rows|list|items/i.test(list.path)) || lists[0];
  return {
    path: preferred.path,
    rows: valueAtPath(result, preferred.path) || [],
  };
}

function extractRowsFromCall(call) {
  return extractRowsFromResult(resultOf(call));
}

function totalFromResult(result, rowsLength = 0) {
  const direct =
    result?.total ??
    result?.totalCount ??
    result?.totalNum ??
    result?.count ??
    result?.totalRecords ??
    result?.pagination?.total ??
    result?.page?.total;
  const numeric = Number(direct);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : rowsLength;
}

function dateValueLike(value) {
  if (typeof value === "string") return /\d{4}-\d{1,2}-\d{1,2}/.test(value) || /^\d{10,13}$/.test(value);
  if (typeof value === "number") return String(Math.trunc(value)).length >= 10;
  return false;
}

function replacementDateValue(oldValue, date, { endOfDay = false } = {}) {
  const timeText = endOfDay ? "23:59:59" : "00:00:00";
  if (typeof oldValue === "number") {
    const time = new Date(`${date}T${timeText}+08:00`).getTime();
    return String(Math.trunc(oldValue)).length === 10 ? Math.floor(time / 1000) : time;
  }
  if (typeof oldValue === "string" && /^\d{10,13}$/.test(oldValue)) {
    const time = String(new Date(`${date}T${timeText}+08:00`).getTime());
    return oldValue.length === 10 ? String(Math.floor(Number(time) / 1000)) : time;
  }
  return endOfDay ? `${date} 23:59:59` : date;
}

function adaptBodyDatesAndPage(value, pageNum) {
  if (Array.isArray(value)) {
    if (value.length === 2 && value.every(dateValueLike)) {
      return [
        replacementDateValue(value[0], startDate),
        replacementDateValue(value[1], endDate, { endOfDay: true }),
      ];
    }
    return value.map((item) => adaptBodyDatesAndPage(item, pageNum));
  }
  if (!value || typeof value !== "object") return value;

  const cloned = {};
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.toLowerCase();
    if (/^(page(num|no|number|index)?|current(page)?|page)$/.test(normalized)) {
      cloned[key] = pageNum;
      continue;
    }
    if (/^(pageSize|limit|size)$/.test(key) || /page[_-]?size/i.test(key)) {
      cloned[key] = pageSize;
      continue;
    }
    if (/^(rowCount|pageRows|pageLimit)$/i.test(key)) {
      cloned[key] = pageSize;
      continue;
    }
    if (dateValueLike(item) && /(start|begin|from|bgn|起始|开始)/i.test(key)) {
      cloned[key] = replacementDateValue(item, startDate);
      continue;
    }
    if (dateValueLike(item) && /(end|to|finish|截止|结束)/i.test(key)) {
      cloned[key] = replacementDateValue(item, endDate, { endOfDay: true });
      continue;
    }
    cloned[key] = adaptBodyDatesAndPage(item, pageNum);
  }
  return cloned;
}

function bodyShapeKey(body) {
  if (!body || typeof body !== "object") return String(body);
  return JSON.stringify(Object.keys(body).sort());
}

function candidateBodies(capturedBodies) {
  const variants = [];
  const seen = new Set();
  for (const body of capturedBodies) {
    if (!body || typeof body !== "object" || Array.isArray(body)) continue;
    const adapted = adaptBodyDatesAndPage(body, 1);
    const key = `captured:${bodyShapeKey(adapted)}:${JSON.stringify(adapted)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    variants.push({ source: "captured", body: adapted });
  }

  const manual = [
    {
      settleStatus: 1,
      rowCount: pageSize,
      deductTimeBegin: `${startDate} 00:00:00`,
      deductTimeEnd: `${endDate} 23:59:59`,
    },
    {
      settleStatus: 1,
      rowCount: pageSize,
      deductTimeBegin: startDate,
      deductTimeEnd: endDate,
    },
    {
      pageNum: 1,
      pageSize,
      billStartTime: startDate,
      billEndTime: endDate,
    },
    {
      pageNum: 1,
      pageSize,
      billTimeStart: startDate,
      billTimeEnd: endDate,
    },
    {
      pageNum: 1,
      pageSize,
      accountTimeStart: startDate,
      accountTimeEnd: endDate,
    },
    {
      pageNum: 1,
      pageSize,
      startDate,
      endDate,
    },
    {
      pageNo: 1,
      pageSize,
      beginDate: startDate,
      endDate,
    },
  ];

  for (const body of manual) {
    const key = `manual:${JSON.stringify(body)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    variants.push({ source: "manual", body });
  }
  return variants;
}

function candidateEndpoints(scriptEndpoints, capturedEvents) {
  const candidates = new Map();
  const add = (endpoint, source) => {
    if (!endpoint || (!endpoint.includes("/api/") && !endpoint.includes("/portal/"))) return;
    const pathOnly = endpointPath(endpoint);
    if (!/stml|logistics|waybill|tracking|bill|recon|charge|fee|expense|shipping|freight|adjust/i.test(pathOnly)) return;
    if (!candidates.has(pathOnly)) candidates.set(pathOnly, new Set());
    candidates.get(pathOnly).add(source);
  };

  add("/portal/selene/seller/portal/metadata", "script-known");
  add("/portal/selene/seller/portal/recon/list_overview", "script-known");
  add("/portal/selene/seller/portal/recon/list", "script-known");
  for (const event of capturedEvents) add(event.request.endpoint, "captured");
  for (const endpoint of scriptEndpoints) add(endpoint, "script");

  return [...candidates.entries()]
    .map(([endpoint, sources]) => ({ endpoint, sources: [...sources].sort() }))
    .sort((a, b) => {
      const endpointPenalty = (endpoint) => (/\/recon\/list$/.test(endpoint) ? 0 : /download|metadata|overview|task/i.test(endpoint) ? 2 : 1);
      const ep = endpointPenalty(a.endpoint) - endpointPenalty(b.endpoint);
      if (ep !== 0) return ep;
      const ac = a.sources.includes("captured") ? 0 : 1;
      const bc = b.sources.includes("captured") ? 0 : 1;
      if (ac !== bc) return ac - bc;
      const ap = /page|query|list|search/i.test(a.endpoint) ? 0 : 1;
      const bp = /page|query|list|search/i.test(b.endpoint) ? 0 : 1;
      return ap - bp || a.endpoint.localeCompare(b.endpoint);
    });
}

async function collectPaged(page, endpoint, firstBody, mallId, label, pageLimit = maxPages) {
  const pages = [];
  let total = 0;
  let rowsPath = "";
  for (let pageNum = 1; pageNum <= pageLimit; pageNum += 1) {
    const body = adaptBodyDatesAndPage(firstBody, pageNum);
    if (pageNum > 1 && pages.length > 0) {
      const previousResult = resultOf(pages[pages.length - 1]);
      if (previousResult?.scrollContext) body.scrollContext = previousResult.scrollContext;
    }
    const call = await apiPost(page, endpoint, body, { mallId, label: `${label} p${pageNum}` });
    pages.push(call);
    const result = resultOf(call);
    const { path: foundRowsPath, rows } = extractRowsFromCall(call);
    rowsPath ||= foundRowsPath;
    total = totalFromResult(result, rows.length || total);
    if (!call.ok || (apiCode(call) !== null && Number(apiCode(call)) !== 1000000)) break;
    if (!rows.length || rows.length >= total || pageNum * pageSize >= total) break;
    await page.waitForTimeout(300).catch(() => {});
  }
  return { pages, total, rowsPath };
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
  if (!rect) return null;
  await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.waitForTimeout(1500).catch(() => {});
  return rect;
}

async function visiblePageTexts(page) {
  return await page.evaluate(() => {
    const terms = /已出账|未出账|支出|调整|订单|运单|面单|物流|费用|币种|时间|每页|200|tracking|bill/i;
    return Array.from(document.querySelectorAll("body *"))
      .map((node) => (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim())
      .filter((text) => text && text.length <= 160 && terms.test(text))
      .slice(0, 240);
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
  for (const url of scriptUrls.slice(0, 120)) {
    let text = "";
    try {
      text = await page.evaluate(async (src) => {
        const response = await fetch(src);
        if (!response.ok) return "";
        return await response.text();
      }, url);
    } catch {
      continue;
    }
    text = text.replace(/\\\//g, "/");
    if (!/stml|logistics|waybill|tracking|bill|charge|fee|expense|shipping|freight|已出账|调整|面单|运单/i.test(text)) continue;
    const endpointMatches = text.match(/\/(?:api|portal)\/[A-Za-z0-9_./-]*(?:stml|logistics|waybill|tracking|bill|recon|charge|fee|expense|shipping|freight|adjust|metadata)[A-Za-z0-9_./-]*/gi) || [];
    for (const endpoint of endpointMatches) endpoints.add(endpoint);
    for (const keyword of ["stml", "stml-logistics", "已出账", "支出", "调整", "运单", "面单", "trackingNo", "waybill"]) {
      const index = text.indexOf(keyword);
      if (index >= 0) {
        snippets.push({
          url,
          keyword,
          snippet: text.slice(Math.max(0, index - 700), Math.min(text.length, index + 1100)),
        });
      }
    }
  }
  return { scriptUrls, endpoints: [...endpoints].sort(), snippets: snippets.slice(0, 40) };
}

function numberFromText(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value).replace(/,/g, "").trim();
  const match = text.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function amountValue(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "object") {
    const directText = value.digitalText ?? value.amountText ?? value.text ?? value.display ?? value.displayText;
    const textAmount = numberFromText(directText);
    if (textAmount !== null) return textAmount;
    const raw = numberFromText(value.amount ?? value.value ?? value.cent ?? value.centAmount);
    if (raw === null) return null;
    if (Number.isInteger(raw) && Math.abs(raw) >= 1000) return raw / 100;
    return raw;
  }
  return numberFromText(value);
}

function firstField(row, patterns) {
  for (const { path: itemPath, value } of nestedEntries(row)) {
    if (value === null || value === undefined || typeof value === "object") continue;
    if (patterns.some((pattern) => pattern.test(itemPath))) return { path: itemPath, value };
  }
  return { path: "", value: "" };
}

function firstAmountField(row) {
  for (const { path: itemPath, value } of nestedEntries(row)) {
    if (!/(amount|fee|price|charge|cost|shipping|freight|expense|adjust|金额|费用)/i.test(itemPath)) continue;
    const amount = amountValue(value);
    if (amount !== null) return { path: itemPath, value, amount };
  }
  return { path: "", value: "", amount: 0 };
}

function inferCurrency(row) {
  for (const { value } of nestedEntries(row)) {
    if (value && typeof value === "object" && value.currencyCode) return String(value.currencyCode);
  }
  const field = firstField(row, [/currencyCode/i, /currency/i, /币种/]);
  if (field.value) return String(field.value);
  return "";
}

function inferRecord(row) {
  const order = firstField(row, [/parent.*order/i, /parentOrderSn/i, /order.*sn/i, /orderNo/i, /order/i, /订单/]);
  const tracking = firstField(row, [/tracking/i, /waybill/i, /shipping.*no/i, /logistics.*no/i, /package.*sn/i, /运单|面单|包裹/]);
  const bill = firstField(row, [/bill.*no/i, /statement/i, /账单|出账/]);
  const type = firstField(row, [/reconciliationTypeDesc/i, /typeDesc/i, /reconciliationType/i, /type/i, /biz/i, /scene/i, /adjust/i, /费用类型|支出|调整/]);
  const time = firstField(row, [/time/i, /date/i, /账单时间|出账时间/]);
  const carrier = firstField(row, [/carrier/i, /provider/i, /channel/i, /service/i, /物流商|渠道|服务/]);
  const amount = firstAmountField(row);
  const currency = inferCurrency(row);
  const groupKey =
    cleanText(tracking.value) ||
    [cleanText(order.value), cleanText(bill.value)].filter(Boolean).join("|") ||
    cleanText(order.value) ||
    cleanText(bill.value);

  return {
    groupKey,
    order,
    tracking,
    bill,
    type,
    amount,
    currency,
    time,
    carrier,
  };
}

function classifyFeeType(record) {
  if (Number(record.type.value) === 3) return "adjust_refund";
  if (Number(record.type.value) === 2) return "adjust_expense";
  if (Number(record.type.value) === 1) return "expense";
  const text = cleanText(`${record.type.value} ${record.bill.value}`);
  if (/退款|返款|退回|refund/i.test(text)) return "adjust_refund";
  if (/调整|adjust/i.test(text)) return "adjust_expense";
  return "expense";
}

function uniqueRowsById(rows) {
  const seen = new Set();
  const unique = [];
  for (const row of rows) {
    const key = cleanText(row?.reconciliationId) || JSON.stringify(row);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(row);
  }
  return unique;
}

function aggregateRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const inferred = inferRecord(row);
    const key = inferred.groupKey || `row:${groups.size + 1}`;
    const feeType = classifyFeeType(inferred);
    const amount = inferred.amount.amount || 0;
    const signedAmount = feeType === "adjust_refund" ? -Math.abs(amount) : Math.abs(amount);
    const group = groups.get(key) || {
      groupKey: key,
      currency: inferred.currency,
      order: cleanText(inferred.order.value),
      tracking: cleanText(inferred.tracking.value),
      bill: cleanText(inferred.bill.value),
      expense: 0,
      adjustExpense: 0,
      adjustRefund: 0,
      finalAmount: 0,
      rows: [],
    };
    if (feeType === "expense") group.expense += Math.abs(amount);
    if (feeType === "adjust_expense") group.adjustExpense += Math.abs(amount);
    if (feeType === "adjust_refund") group.adjustRefund += Math.abs(amount);
    group.finalAmount += signedAmount;
    group.rows.push({
      feeType,
      amount,
      signedAmount,
      type: inferred.type,
      time: inferred.time,
      carrier: inferred.carrier,
      amountField: inferred.amount.path,
    });
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => Math.abs(b.finalAmount) - Math.abs(a.finalAmount));
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

function successfulListCall(call) {
  if (/download|metadata|overview|task/i.test(call?.endpoint || "")) return false;
  const code = apiCode(call);
  const result = resultOf(call);
  const { rows } = extractRowsFromCall(call);
  return call.ok && (code === null || Number(code) === 1000000) && result && (rows.length > 0 || totalFromResult(result, 0) > 0);
}

async function discoverListApi(page, mallId, capturedEvents, scriptSearch) {
  const capturedBodiesByEndpoint = new Map();
  for (const event of capturedEvents) {
    const body = event.request.postData;
    if (!body || typeof body !== "object" || Array.isArray(body)) continue;
    const key = endpointPath(event.request.endpoint);
    if (!capturedBodiesByEndpoint.has(key)) capturedBodiesByEndpoint.set(key, []);
    capturedBodiesByEndpoint.get(key).push(body);
  }

  const attempts = [];
  for (const candidate of candidateEndpoints(scriptSearch.endpoints, capturedEvents).slice(0, 40)) {
    const bodies = candidateBodies(capturedBodiesByEndpoint.get(candidate.endpoint) || []);
    for (const variant of bodies.slice(0, 10)) {
      const call = await apiPost(page, candidate.endpoint, variant.body, {
        mallId,
        label: `candidate ${candidate.endpoint} ${variant.source}`,
      });
      attempts.push({
        endpoint: candidate.endpoint,
        sources: candidate.sources,
        variantSource: variant.source,
        call,
        summary: summarizeCall(call),
      });
      if (successfulListCall(call)) {
        return {
          selected: {
            endpoint: candidate.endpoint,
            sources: candidate.sources,
            variantSource: variant.source,
            firstCall: call,
            rowsPath: extractRowsFromCall(call).path,
          },
          attempts,
        };
      }
      await page.waitForTimeout(200).catch(() => {});
    }
  }

  return { selected: null, attempts };
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
  await installPageNetworkHook(context);
  capture.attach(context);

  const outputPath = path.join(reportDir, `stml-logistics-${accountId}-${stamp}.json`);
  try {
    const activePage = await ensureTargetPage(context, page);
    const beforeTexts = await visiblePageTexts(activePage).catch(() => []);
    const clickedBilledTab = await clickExactText(activePage, "已出账").catch(() => null);
    await capture.settle(8000);
    const pageHookEventsAfterClick = await activePage.evaluate(() => window.__codexStmlNetwork || []).catch(() => []);
    const afterTexts = await visiblePageTexts(activePage).catch(() => []);

    const mallListCall = await apiPost(activePage, USER_INFO_ENDPOINT, {}, { label: "AgentSeller 店铺列表" });
    const mall = resolveMallByExactName(mallListCall.json, shopName);

    const scriptSearch = await searchLoadedScripts(activePage);
    const observedEvents = [...capture.events, ...pageHookEventsAfterClick];
    const discovery = await discoverListApi(activePage, mall.mallId, observedEvents, scriptSearch);

    const selectedBody = discovery.selected?.firstCall?.request?.body || {};
    const metadataCall = await apiPost(activePage, "/portal/selene/seller/portal/metadata", {}, {
      mallId: mall.mallId,
      label: "线上面单账单类型枚举",
    }).catch((error) => ({ error: errorMessage(error) }));
    const overviewCall = discovery.selected
      ? await apiPost(activePage, "/portal/selene/seller/portal/recon/list_overview", selectedBody, {
          mallId: mall.mallId,
          label: "线上面单已出账概览",
        }).catch((error) => ({ error: errorMessage(error) }))
      : null;

    let confirmedPages = null;
    let allRows = [];
    const extraTypeSamples = [];
    const packageGroupSamples = [];
    if (discovery.selected) {
      confirmedPages = await collectPaged(
        activePage,
        discovery.selected.endpoint,
        discovery.selected.firstCall.request.body,
        mall.mallId,
        "线上面单已出账列表",
      );
      for (const pageCall of confirmedPages.pages) {
        allRows = allRows.concat(extractRowsFromCall(pageCall).rows);
      }

      for (const feeType of [
        { code: 2, label: "调整(支出)" },
        { code: 3, label: "调整(退款)" },
      ]) {
        const body = {
          ...discovery.selected.firstCall.request.body,
          reconciliationTypeList: [feeType.code],
          scrollContext: null,
        };
        const pages = await collectPaged(
          activePage,
          discovery.selected.endpoint,
          body,
          mall.mallId,
          `线上面单${feeType.label}样例`,
          2,
        );
        extraTypeSamples.push({
          feeType,
          pages,
          rows: pages.pages.flatMap((pageCall) => extractRowsFromCall(pageCall).rows),
        });
      }

      const adjustmentPackages = [
        ...new Set(
          extraTypeSamples
            .flatMap((sample) => sample.rows || [])
            .map((row) => cleanText(row.packageSn))
            .filter(Boolean),
        ),
      ].slice(0, 8);
      for (const packageSn of adjustmentPackages) {
        const body = {
          ...discovery.selected.firstCall.request.body,
          packageSnList: [packageSn],
          scrollContext: null,
        };
        const pages = await collectPaged(
          activePage,
          discovery.selected.endpoint,
          body,
          mall.mallId,
          `线上面单包裹归集样例 ${packageSn}`,
          1,
        );
        packageGroupSamples.push({
          packageSn,
          pages,
          rows: pages.pages.flatMap((pageCall) => extractRowsFromCall(pageCall).rows),
        });
      }
    }

    const antiContentProbe = await probeAntiContent(activePage);
    const pageHookEventsFinal = await activePage.evaluate(() => window.__codexStmlNetwork || []).catch(() => []);
    await capture.settle(6000);

    const extraTypeRows = extraTypeSamples.flatMap((sample) => sample.rows || []);
    const packageGroupRows = packageGroupSamples.flatMap((sample) => sample.rows || []);
    const aggregation = aggregateRows(uniqueRowsById([...allRows, ...extraTypeRows, ...packageGroupRows]));
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
        ...COMMON_HEADERS,
        credentials: "include",
        mallid: mall.mallId,
        "Anti-Content": antiContentProbe,
      },
      calls: {
        mallList: mallListCall,
        metadata: metadataCall,
        overview: overviewCall,
        discovery,
        confirmedPages,
        extraTypeSamples,
        packageGroupSamples,
      },
      summaries: {
        mallList: summarizeCall(mallListCall),
        metadata: metadataCall?.json ? summarizeCall(metadataCall) : metadataCall,
        overview: overviewCall?.json ? summarizeCall(overviewCall) : overviewCall,
        selected: discovery.selected
          ? {
              endpoint: discovery.selected.endpoint,
              sources: discovery.selected.sources,
              variantSource: discovery.selected.variantSource,
              rowsPath: discovery.selected.rowsPath,
              firstCall: summarizeCall(discovery.selected.firstCall),
            }
          : null,
        attempts: discovery.attempts.map((attempt) => ({
          endpoint: attempt.endpoint,
          sources: attempt.sources,
          variantSource: attempt.variantSource,
          summary: attempt.summary,
        })),
        confirmedPages: confirmedPages?.pages.map(summarizeCall) || [],
        extraTypeSamples: extraTypeSamples.map((sample) => ({
          feeType: sample.feeType,
          rowCount: sample.rows.length,
          pages: sample.pages.pages.map(summarizeCall),
        })),
        packageGroupSamples: packageGroupSamples.map((sample) => ({
          packageSn: sample.packageSn,
          rowCount: sample.rows.length,
          pages: sample.pages.pages.map(summarizeCall),
        })),
      },
      pageProbe: {
        beforeTexts,
        clickedBilledTab,
        afterTexts,
      },
      scriptSearch,
      capturedEvents: capture.events,
      pageHookEvents: pageHookEventsFinal,
      extracted: {
        totalRowsCollected: allRows.length,
        extraTypeRowsCollected: extraTypeRows.length,
        packageGroupRowsCollected: packageGroupRows.length,
        firstRows: allRows.slice(0, 20),
        firstExtraTypeRows: extraTypeRows.slice(0, 20),
        firstPackageGroupRows: packageGroupRows.slice(0, 40),
        inferredFirstRows: allRows.slice(0, 20).map(inferRecord),
        aggregation,
      },
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
  const outputPath = path.join(reportDir, `stml-logistics-${accountId}-${stamp}.error.json`);
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
  console.error(error);
  console.error(`Saved error JSON: ${outputPath}`);
  process.exitCode = 1;
});
