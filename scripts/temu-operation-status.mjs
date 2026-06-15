import fs from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { closeCdpChromeProcess, closeCdpPages } from "./cdp-page-cleanup.mjs";
import {
  enterAgentAuthenticationIfShown,
  loginSellerIfNeeded,
} from "./temu-login-helper.mjs";
import { temuPageApiPost } from "./temu-page-api-client.mjs";
import { extractMallList, resolveMallByExactName } from "./temu-mall-resolver.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const accountsPath = process.env.TEMU_ACCOUNTS_CONFIG || path.join(rootDir, "temu-accounts.json");
const reportDir = process.env.TEMU_REPORT_DIR || path.join(rootDir, "temu-reports");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const targetUrl = process.env.TEMU_OPERATION_STATUS_URL || "https://agentseller.temu.com/goods/list";
const AGENT_SELLER_ORIGIN = "https://agentseller.temu.com";
const PAGE_QUERY_ENDPOINT = "/visage-agent-seller/product/skc/pageQuery";
const OPERATION_PAGE_SIZE = parsePositiveInteger(process.env.TEMU_OPERATION_PAGE_SIZE, 100);
const OPERATION_ACCOUNT_RETRY_ATTEMPTS = parsePositiveInteger(process.env.TEMU_OPERATION_ACCOUNT_RETRY_ATTEMPTS, 2);
const OPERATION_ACCOUNT_RETRY_DELAY_MS = parsePositiveInteger(process.env.TEMU_OPERATION_ACCOUNT_RETRY_DELAY_MS, 1500);
const compareEnabled = process.env.TEMU_OPERATION_COMPARE !== "0";
const IN_SALE_STATUS_RULE = "skcSiteStatus=1";

await fs.mkdir(reportDir, { recursive: true });

class TemuOperationStatusError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "TemuOperationStatusError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new TemuOperationStatusError(code, message);
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

function safeFilePart(value) {
  return String(value || "unknown")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "unknown";
}

function selectedAccountIds() {
  return String(process.env.TEMU_ACCOUNT_ID || process.env.TEMU_ACCOUNT_IDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function shopListForAccount(account) {
  const override = String(process.env.TEMU_OPERATION_SHOPS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return override.length > 0 ? override : account.shops || [];
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
  const page = process.env.TEMU_FORCE_NEW_CDP_PAGE === "1"
    ? await context.newPage()
    : pages.find((candidate) => candidate.url().startsWith("https://agentseller.temu.com/")) ||
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
  await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
  if (page.isClosed()) return;
  await page.waitForTimeout(700).catch(() => {});
}

function isAgentSellerShell(page, text) {
  return page.url().startsWith("https://agentseller.temu.com/") && text.includes("TEMU Agent Center");
}

function isSellerCenterShell(page) {
  return page.url().startsWith("https://seller.kuajingmaihuo.com/");
}

function preferredAgentSellerPage(context, fallbackPage) {
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

async function ensureTargetPage(context, page) {
  let activePage = page;
  await activePage.goto(targetUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
  await waitSettled(activePage);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    activePage = preferredAgentSellerPage(context, activePage);
    await activePage.bringToFront().catch(() => {});
    await waitSettled(activePage);

    let text = await bodyText(activePage);
    if (activePage.url().startsWith(targetUrl)) return activePage;

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
    text = await bodyText(activePage);

    if (activePage.url().startsWith(targetUrl)) return activePage;
    if (isAgentSellerShell(activePage, text) || isSellerCenterShell(activePage)) {
      await activePage.goto(targetUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
      await waitSettled(activePage);
      continue;
    }
  }

  fail("OPERATION_STATUS_PAGE_NOT_READY", "直接访问商品列表并完成登录/授权后，仍未进入商品列表页");
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
  const responseLabel = response?.endpoint ? `${label} (${response.endpoint})` : label;
  if (!response?.ok) {
    fail("API_HTTP_FAILED", `${responseLabel} HTTP ${response?.status || "unknown"}：${(response?.bodyText || "").slice(0, 1000)}`);
  }

  const body = response.json;
  if (!body || typeof body !== "object") {
    fail("API_RESPONSE_NOT_JSON", `${responseLabel} 返回非 JSON：${(response.bodyText || "").slice(0, 1000)}`);
  }

  const errorCode = body.errorCode ?? body.error_code;
  if (body.success === false || (errorCode !== undefined && Number(errorCode) !== 1000000)) {
    fail(
      "API_RESPONSE_FAILED",
      `${responseLabel} 返回失败：code=${errorCode ?? "unknown"} msg=${apiFailureMessage(body) || "unknown"}`,
    );
  }

  return body;
}

async function agentSellerApiBody(page, endpoint, body = undefined, options = {}, label = "Agent Seller API") {
  const response = await agentSellerApiPost(page, endpoint, body, { ...options, label });
  return assertAgentSellerApiResponse(response, label);
}

async function agentSellerApiResult(page, endpoint, body = undefined, options = {}, label = "Agent Seller API") {
  return (await agentSellerApiBody(page, endpoint, body, options, label)).result || {};
}

async function operationApiMallList(page) {
  const body = await agentSellerApiBody(page, "/api/seller/auth/userInfo", {}, {}, "店铺列表接口");
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

async function pageQuery(page, mallId, pageNumber) {
  const request = { page: pageNumber, pageSize: OPERATION_PAGE_SIZE };
  const result = await agentSellerApiResult(
    page,
    PAGE_QUERY_ENDPOINT,
    request,
    { mallId },
    `商品列表接口 page=${pageNumber}`,
  );
  return { request, result };
}

async function collectAllPageItems(page, mallId) {
  const firstPage = await pageQuery(page, mallId, 1);
  const total = Number.parseInt(String(firstPage.result.total ?? "0"), 10);
  const pages = [firstPage];
  let items = Array.isArray(firstPage.result.pageItems) ? firstPage.result.pageItems : [];
  const totalPages = Number.isFinite(total) && total > 0 ? Math.ceil(total / OPERATION_PAGE_SIZE) : 1;

  for (let pageNumber = 2; pageNumber <= totalPages; pageNumber += 1) {
    const nextPage = await pageQuery(page, mallId, pageNumber);
    const nextItems = Array.isArray(nextPage.result.pageItems) ? nextPage.result.pageItems : [];
    pages.push(nextPage);
    items = items.concat(nextItems);
    if (nextItems.length === 0) break;
  }

  const bySkc = new Map();
  for (const item of items) {
    const skcKey = String(item?.productSkcId || item?.productId || "");
    if (!skcKey) continue;
    bySkc.set(skcKey, item);
  }

  return {
    request: {
      pageSize: OPERATION_PAGE_SIZE,
      pages: pages.map((entry) => entry.request.page),
    },
    total: Number.isFinite(total) ? total : bySkc.size,
    rawItemCount: items.length,
    items: [...bySkc.values()],
  };
}

function itemSiteNames(item) {
  const bindSites = Array.isArray(item?.productSemiManaged?.bindSites)
    ? item.productSemiManaged.bindSites
    : [];
  return [...new Set(bindSites.map((site) => cleanText(site.siteName)).filter(Boolean))];
}

function itemSiteIds(item) {
  const bindSites = Array.isArray(item?.productSemiManaged?.bindSites)
    ? item.productSemiManaged.bindSites
    : [];
  return [...new Set(bindSites.map((site) => String(site.siteId || "")).filter(Boolean))];
}

function regionsForSites(sites) {
  const joined = sites.join(" ");
  const regions = [];
  if (joined.includes("德国站") || joined.includes("德国")) regions.push("eu");
  if (joined.includes("英国站") || joined.includes("英国")) regions.push("uk");
  if (joined.includes("美国站") || joined.includes("美国")) regions.push("us");
  return regions;
}

function regionLabel(region) {
  return {
    eu: "欧区",
    uk: "英区",
    us: "美区",
    unmapped: "未映射",
  }[region] || region;
}

function isItemInSale(item) {
  return Number(item?.skcSiteStatus) === 1 && Number(item?.removeStatus || 0) === 0;
}

function productInSale(product) {
  if (!product) return false;
  if (Array.isArray(product.rawItems) && product.rawItems.length > 0) {
    return product.rawItems.some(isItemInSale);
  }
  return product.inSale === true;
}

function productStatusText(product) {
  if (!product) return "缺失";
  if (productInSale(product)) return "在售";
  const codes = [...new Set(product.statusCodes.map((code) => String(code)))].filter(Boolean);
  const siteCodes = [...new Set((product.skcSiteStatusCodes || []).map((code) => String(code)))].filter(Boolean);
  if (siteCodes.length > 0) return `非在售(site=${siteCodes.join("/")})`;
  return codes.length ? `非在售(status=${codes.join("/")})` : "非在售";
}

function buildSpuProducts(items) {
  const productsBySpu = new Map();

  for (const item of items) {
    const spuId = String(item?.productId || "");
    if (!spuId) continue;

    const product =
      productsBySpu.get(spuId) ||
      {
        spuId,
        productName: cleanText(item.productName),
        goodsIds: [],
        skcIds: [],
        imageUrl: cleanText(item.mainImageUrl),
        sites: [],
        siteIds: [],
        inSaleSites: [],
        statusCodes: [],
        skcSiteStatusCodes: [],
        removeStatusCodes: [],
        skcCount: 0,
        inSaleSkcCount: 0,
        inSale: false,
        regions: [],
        rawItems: [],
      };

    const goodsId = String(item?.goodsId || "");
    const skcId = String(item?.productSkcId || "");
    if (goodsId && !product.goodsIds.includes(goodsId)) product.goodsIds.push(goodsId);
    if (skcId && !product.skcIds.includes(skcId)) product.skcIds.push(skcId);
    if (!product.imageUrl) product.imageUrl = cleanText(item.mainImageUrl);
    if (!product.productName) product.productName = cleanText(item.productName);

    const sites = itemSiteNames(item);
    const siteIds = itemSiteIds(item);
    product.sites = [...new Set([...product.sites, ...sites])];
    product.siteIds = [...new Set([...product.siteIds, ...siteIds])];
    product.statusCodes.push(item?.skcStatus ?? null);
    product.skcSiteStatusCodes.push(item?.skcSiteStatus ?? null);
    product.removeStatusCodes.push(item?.removeStatus ?? null);
    product.skcCount += 1;
    if (isItemInSale(item)) {
      product.inSale = true;
      product.inSaleSkcCount += 1;
      product.inSaleSites = [...new Set([...product.inSaleSites, ...sites])];
    }
    product.rawItems.push({
      productId: String(item?.productId || ""),
      productSkcId: String(item?.productSkcId || ""),
      goodsId,
      skcStatus: item?.skcStatus ?? null,
      skcSiteStatus: item?.skcSiteStatus ?? null,
      skcTopStatus: item?.skcTopStatus ?? null,
      removeStatus: item?.removeStatus ?? null,
      sites,
    });

    productsBySpu.set(spuId, product);
  }

  return [...productsBySpu.values()].map((product) => {
    const regionSites = product.inSale ? product.inSaleSites : product.sites;
    const regions = regionsForSites(regionSites);
    return {
      ...product,
      regions,
      regionLabels: regions.map(regionLabel),
      statusText: productStatusText(product),
    };
  });
}

function regionCounts(products) {
  const counts = { eu: 0, uk: 0, us: 0, unmapped: 0 };
  for (const product of products) {
    if (!product.inSale) continue;
    if (product.regions.length === 0) {
      counts.unmapped += 1;
      continue;
    }
    for (const region of product.regions) {
      counts[region] = (counts[region] || 0) + 1;
    }
  }
  return counts;
}

function compareShopWithPrevious(currentShop, previousShop) {
  if (!previousShop) {
    return {
      previousShopFound: false,
      previousInSaleSpuCount: 0,
      previousInSaleSpuIds: [],
      missingInSaleProducts: [],
    };
  }

  const currentBySpu = new Map((currentShop.products || []).map((product) => [product.spuId, product]));
  const previousInSale = (previousShop.products || []).filter(productInSale);
  const previousInSaleSpuIds = previousInSale.map((product) => product.spuId).filter(Boolean);
  const missingInSaleProducts = [];

  for (const previousProduct of previousInSale) {
    const currentProduct = currentBySpu.get(previousProduct.spuId);
    if (productInSale(currentProduct)) continue;
    missingInSaleProducts.push({
      spuId: previousProduct.spuId,
      productName: previousProduct.productName || "",
      goodsIds: previousProduct.goodsIds || [],
      skcIds: previousProduct.skcIds || [],
      previousSites: previousProduct.inSaleSites?.length ? previousProduct.inSaleSites : previousProduct.sites || [],
      previousRegions: previousProduct.regions || regionsForSites(previousProduct.inSaleSites || previousProduct.sites || []),
      previousRegionLabels: previousProduct.regionLabels || regionsForSites(previousProduct.inSaleSites || previousProduct.sites || []).map(regionLabel),
      currentStatus: productStatusText(currentProduct),
      currentSkcIds: currentProduct?.skcIds || [],
      currentStatusCodes: currentProduct?.statusCodes || [],
    });
  }

  return {
    previousShopFound: true,
    previousGeneratedAt: previousShop.generatedAt || "",
    previousInSaleSpuCount: previousInSaleSpuIds.length,
    previousInSaleSpuIds,
    missingInSaleProducts,
  };
}

async function findOperationReportPaths() {
  const entries = await fs.readdir(reportDir).catch(() => []);
  const matches = entries
    .filter((name) => /^temu-operation-status-.+\.json$/.test(name))
    .map((name) => path.join(reportDir, name));

  const stats = await Promise.all(
    matches.map(async (filePath) => ({ filePath, stat: await fs.stat(filePath) })),
  );
  stats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  return stats.map((entry) => entry.filePath);
}

function reportShopIndex(report) {
  const index = new Map();
  for (const result of report?.results || []) {
    for (const shop of result.shops || []) {
      index.set(shop.shopName, {
        ...shop,
        generatedAt: report.generatedAt || "",
      });
    }
  }
  return index;
}

async function loadPreviousOperationReport() {
  if (!compareEnabled) return null;
  const override = process.env.TEMU_OPERATION_COMPARE_INPUT || "";
  const candidatePaths = override ? [path.resolve(override)] : await findOperationReportPaths();

  for (const filePath of candidatePaths) {
    try {
      const report = JSON.parse(await fs.readFile(filePath, "utf8"));
      return { filePath, report, shopIndex: reportShopIndex(report) };
    } catch {
      continue;
    }
  }

  return null;
}

function summarizeShop(shop) {
  const counts = shop.regionCounts || {};
  const anomalyCount = shop.missingInSaleProducts?.length || 0;
  return [
    `${shop.shopName}: ${regionLabel("eu")} ${counts.eu || 0}｜${regionLabel("uk")} ${counts.uk || 0}｜${regionLabel("us")} ${counts.us || 0}`,
    `在售SPU ${shop.inSaleSpuCount}/${shop.totalSpuCount}`,
    anomalyCount ? `下架异常 ${anomalyCount}` : "下架异常 0",
  ].join("，");
}

function briefProductName(value, maxLength = 34) {
  const compact = cleanText(value);
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
}

function summarizeAnomaly(product) {
  const name = briefProductName(product.productName);
  const regions = (product.previousRegionLabels || []).join("/") || "-";
  return `${product.spuId}${name ? ` ${name}` : ""}（${regions}，${product.currentStatus}）`;
}

function buildMessage(results) {
  return results
    .map((result) => {
      const label = result.account.label || result.account.id;
      if (!result.ok) return `【${label}】失败：${result.error}`;
      const shopLines = result.shops.map((shop) => {
        const anomalyLines = (shop.missingInSaleProducts || []).slice(0, 5).map((product) => `  - ${summarizeAnomaly(product)}`);
        const more = (shop.missingInSaleProducts || []).length > 5 ? [`  - 另有 ${(shop.missingInSaleProducts || []).length - 5} 个未展开`] : [];
        return [summarizeShop(shop), ...anomalyLines, ...more].join("\n");
      });
      return [`【${label}】`, ...shopLines].join("\n");
    })
    .join("\n\n");
}

async function collectOperationReportByApi(page, shopName, apiMalls, previousShopIndex) {
  const apiSwitch = mallInfoForShop(apiMalls, shopName);
  const pageData = await collectAllPageItems(page, apiSwitch.mallId);
  const products = buildSpuProducts(pageData.items).sort((a, b) => {
    if (a.inSale !== b.inSale) return a.inSale ? -1 : 1;
    return Number(a.spuId) - Number(b.spuId);
  });
  const counts = regionCounts(products);
  const previousShop = previousShopIndex?.get(shopName) || null;
  const comparison = compareShopWithPrevious(
    { products },
    previousShop,
  );

  return {
    shopName,
    currentShopName: shopName,
    source: "direct-api",
    apiSwitch,
    totalSkcCount: pageData.items.length,
    totalSpuCount: products.length,
    inSaleSpuCount: products.filter((product) => product.inSale).length,
    regionCounts: counts,
    products,
    missingInSaleProducts: comparison.missingInSaleProducts,
    newAbnormalSpuIds: comparison.missingInSaleProducts.map((product) => product.spuId).filter(Boolean),
    comparison,
    apiReport: {
      source: "direct-api",
      endpoints: {
        mallList: `${AGENT_SELLER_ORIGIN}/api/seller/auth/userInfo`,
        rows: `${AGENT_SELLER_ORIGIN}${PAGE_QUERY_ENDPOINT}`,
      },
      request: {
        mallId: apiSwitch.mallId,
        pageSize: OPERATION_PAGE_SIZE,
        pages: pageData.request.pages,
      },
      inSaleStatusRule: IN_SALE_STATUS_RULE,
      total: pageData.total,
      rawItemCount: pageData.rawItemCount,
      rowCount: pageData.items.length,
    },
  };
}

async function runAccountOnce(account, previousShopIndex) {
  const shops = shopListForAccount(account);
  if (shops.length === 0) fail("NO_SHOPS_CONFIGURED", `${account.label || account.id} 没有配置店铺`);

  const { browser, context, page } = await connectCdpChrome(account, targetUrl);
  try {
    const activePage = await ensureTargetPage(context, page);
    const apiMalls = await operationApiMallList(activePage);
    const shopReports = [];

    for (const shopName of shops) {
      shopReports.push(await collectOperationReportByApi(activePage, shopName, apiMalls, previousShopIndex));
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

async function runAccount(account, previousShopIndex) {
  const previousErrors = [];

  for (let attempt = 1; attempt <= OPERATION_ACCOUNT_RETRY_ATTEMPTS; attempt += 1) {
    const result = await runAccountOnce(account, previousShopIndex);
    if (result.ok || attempt === OPERATION_ACCOUNT_RETRY_ATTEMPTS) {
      return {
        ...result,
        attempts: attempt,
        previousErrors,
      };
    }

    previousErrors.push(result.error || `attempt ${attempt} failed`);
    console.error(
      `Retrying operation status account: ${account.label || account.id} attempt ${attempt + 1}/${OPERATION_ACCOUNT_RETRY_ATTEMPTS}: ${result.error || "unknown error"}`,
    );
    await new Promise((resolve) => setTimeout(resolve, OPERATION_ACCOUNT_RETRY_DELAY_MS));
  }

  return {
    account,
    ok: false,
    attempts: OPERATION_ACCOUNT_RETRY_ATTEMPTS,
    previousErrors,
    error: previousErrors[previousErrors.length - 1] || "account retry failed",
  };
}

const accountConfig = JSON.parse(await fs.readFile(accountsPath, "utf8"));
const selectedIds = selectedAccountIds();
const accounts = (accountConfig.accounts || []).filter((account) =>
  selectedIds.length === 0 ? account.dailyReportEnabled !== false : selectedIds.includes(account.id),
);
if (accounts.length === 0) {
  fail("NO_MATCHING_ACCOUNTS", selectedIds.length ? `找不到账号：${selectedIds.join(",")}` : "账号配置为空");
}

const previous = await loadPreviousOperationReport();
const results = [];
for (const account of accounts) {
  console.log(`Running operation status account: ${account.label || account.id}`);
  results.push(await runAccount(account, previous?.shopIndex || new Map()));
}

const outputPath = path.join(reportDir, `temu-operation-status-${stamp}.json`);
const message = buildMessage(results);

await fs.writeFile(
  outputPath,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      accountsPath,
      targetUrl,
      pageQueryEndpoint: `${AGENT_SELLER_ORIGIN}${PAGE_QUERY_ENDPOINT}`,
      operationSource: "direct-api",
      inSaleStatusRule: IN_SALE_STATUS_RULE,
      pageSize: OPERATION_PAGE_SIZE,
      comparedWith: previous?.filePath || "",
      message,
      results,
    },
    null,
    2,
  ),
);

console.log(message);
console.log(`Saved JSON: ${outputPath}`);
if (previous?.filePath) console.log(`Compared JSON: ${previous.filePath}`);

if (results.some((result) => !result.ok)) {
  process.exitCode = 1;
}
