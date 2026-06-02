import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./temu-config.mjs";
import { connectCdpChrome } from "./chrome-cdp.mjs";
import { closeCdpChromeProcess, closeCdpPages } from "./cdp-page-cleanup.mjs";
import { closeTemuPopups } from "./temu-popup-cleaner.mjs";
import { createTemuNetworkCapture } from "./temu-network-capture.mjs";
import { ensureConsentChecked } from "./temu-consent-helper.mjs";

const now = new Date();
const stamp = now.toISOString().replace(/[:.]/g, "-");
await fs.mkdir(config.reportDir, { recursive: true });

const jsonPath = path.join(config.reportDir, `${config.reportPrefix}-${stamp}.json`);
const DAY_MS = 24 * 60 * 60 * 1000;
const SHANGHAI_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;
const API_BASE_URL = "https://ads.temu.com/api/v1/coconut";
const PRODUCT_API_PAGE_SIZE = 50;
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

function firstMatch(value, regex) {
  return String(value || "").match(regex)?.[1] || "";
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

const reportHeaderAliases = {
  sales: ["申报价销售额（全店）", "申报价销售额（全域）"],
  netSales: ["净申报价销售额（全店）", "净申报价销售额（全域）"],
  quantity: ["件数（全店）", "件数（全域）"],
  netQuantity: ["净件数（全店）", "净件数（全域）"],
  impressions: ["曝光量（全店）", "曝光量（全域）"],
  clicks: ["点击量（全店）", "点击量（全域）"],
  ctr: ["点击率(CTR)（全店）", "点击率(CTR)（全域）"],
  cvr: ["转化率(CVR)（全店）", "转化率(CVR)（全域）"],
};

function headerIndex(headers, candidates) {
  for (const candidate of candidates) {
    const index = headers.findIndex((header) => header === candidate);
    if (index >= 0) return index;
  }
  return -1;
}

function hasAnyHeader(headers, candidates) {
  return candidates.some((candidate) => headers.includes(candidate));
}

function safeFilePart(value) {
  return String(value || "unknown")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "unknown";
}

function debugShopSwitch(message) {
  if (process.env.TEMU_DEBUG_SHOP_SWITCH === "1") {
    console.error(`[shop-switch] ${message}`);
  }
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

async function waitForTextPattern(page, pattern, timeout = 15000) {
  await page.getByText(pattern).first().waitFor({ state: "visible", timeout });
}

async function reportTableState(page) {
  const expectedHeaders = [
    ...reportHeaderAliases.quantity,
    ...reportHeaderAliases.sales,
    ...reportHeaderAliases.netSales,
  ];
  return await page.evaluate((expectedHeaders) => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const isVisible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const visibleText = Array.from(document.querySelectorAll("*"))
      .filter(isVisible)
      .map((node) => clean(node.innerText || node.textContent || ""))
      .filter(Boolean);
    const headers = Array.from(document.querySelectorAll("th"))
      .filter(isVisible)
      .map((node) => clean(node.innerText || node.textContent || ""))
      .filter(Boolean);
    const bodyText = clean(document.body?.innerText || document.body?.textContent || "");
    const hasTargetHeader = expectedHeaders.some((header) => headers.includes(header));
    const loadingHints = [
      "加载中",
      "正在加载",
      "查询中",
      "请稍后",
      "Loading",
    ].filter((hint) => bodyText.includes(hint));
    return {
      hasTargetHeader,
      headerCount: headers.length,
      headers: headers.slice(0, 30),
      loadingHints,
      bodySnippet: bodyText.slice(0, 240),
      visibleLabels: visibleText
        .filter((text) => ["今日", "昨日", "商品数据报表", "当前区域:"].includes(text))
        .slice(0, 12),
    };
  }, expectedHeaders).catch(() => ({
    hasTargetHeader: false,
    headerCount: 0,
    headers: [],
    loadingHints: [],
    bodySnippet: "",
    visibleLabels: [],
  }));
}

async function reportTableSignature(page) {
  return await page.evaluate(() => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const isVisible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const table = Array.from(document.querySelectorAll("table")).filter(isVisible)[1] ||
      Array.from(document.querySelectorAll("table")).filter(isVisible)[0];
    if (!table) return "";
    return Array.from(table.querySelectorAll("tr"))
      .filter(isVisible)
      .slice(0, 6)
      .map((row) =>
        Array.from(row.querySelectorAll("td,th"))
          .map((cell) => clean(cell.innerText || cell.textContent || ""))
          .join("\t"),
      )
      .join("\n")
      .slice(0, 3000);
  }).catch(() => "");
}

async function waitForReportTableReady(page, timeoutMs = 25000, options = {}) {
  const { previousSignature = "", requireSignatureChange = false } = options;
  const deadline = Date.now() + timeoutMs;
  let lastState = null;
  while (Date.now() < deadline) {
    await dismissBlockingModals(page).catch(() => {});
    lastState = await reportTableState(page);
    lastState.signature = await reportTableSignature(page);
    lastState.signatureChanged = !previousSignature || lastState.signature !== previousSignature;
    if (lastState.hasTargetHeader && (!requireSignatureChange || lastState.signatureChanged)) {
      return lastState;
    }
    await page.waitForTimeout(1000);
  }
  if (!lastState) lastState = await reportTableState(page);
  lastState.signature = await reportTableSignature(page);
  lastState.signatureChanged = !previousSignature || lastState.signature !== previousSignature;
  return lastState;
}

async function clickVisibleExactLabel(page, labelText) {
  const labelRect = await page.evaluate((labelText) => {
    const labels = Array.from(document.querySelectorAll("label"));
    const label = labels.find((node) => {
      const text = (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return (
        text === labelText &&
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== "hidden" &&
        style.display !== "none"
      );
    });
    if (!label) return false;
    label.scrollIntoView({ block: "center", inline: "center" });
    const rect = label.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }, labelText);

  if (!labelRect) return false;
  await page.mouse.click(labelRect.x + labelRect.width / 2, labelRect.y + labelRect.height / 2);
  return true;
}

async function isVisibleExactLabelActive(page, labelText, activeClassFragment) {
  return await page.evaluate(
    ({ labelText, activeClassFragment }) => {
      const labels = Array.from(document.querySelectorAll("label"));
      const label = labels.find((node) => {
        const text = (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return (
          text === labelText &&
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none"
        );
      });
      return Boolean(
        label &&
          (label.getAttribute("data-checked") === "true" ||
            String(label.className || "").includes(activeClassFragment)),
      );
    },
    { labelText, activeClassFragment },
  );
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

async function assertLoggedIn(page) {
  if (!(await isLoggedIn(page))) {
    fail("LOGIN_STATE_UNAVAILABLE", "Temu login state is unavailable");
  }
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

async function visibleInputMeta(page) {
  return await page.locator("input").evaluateAll((nodes) =>
    nodes.map((input, index) => ({
      index,
      type: input.getAttribute("type") || "text",
      placeholder: input.getAttribute("placeholder") || "",
      valueLength: input.value?.length || 0,
      visible: !!(input.offsetWidth || input.offsetHeight || input.getClientRects().length),
    })),
  );
}

function findLoginInputIndexes(inputs) {
  const visible = inputs.filter((input) => input.visible);
  const password = visible.find((input) => input.type === "password");
  const username =
    visible.find((input) => /手机|邮箱|账号|email|phone/i.test(input.placeholder)) ||
    visible.find((input) => input.type === "text" && input.placeholder);

  return {
    usernameIndex: username?.index ?? -1,
    passwordIndex: password?.index ?? -1,
  };
}

async function valuesByInputIndex(page, indexes) {
  return await page.locator("input").evaluateAll(
    (nodes, indexes) =>
      Object.fromEntries(
        indexes.map((index) => [index, nodes[index]?.value || ""]),
      ),
    indexes,
  );
}

async function trySavedPasswordAutofill(page) {
  for (const tab of ["", "邮箱登录", "手机号登录"]) {
    if (tab) {
      await page.getByText(tab, { exact: true }).click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(800);
    }

    const inputs = await visibleInputMeta(page);
    const { usernameIndex, passwordIndex } = findLoginInputIndexes(inputs);
    if (usernameIndex < 0 || passwordIndex < 0) continue;

    const username = page.locator("input").nth(usernameIndex);
    const password = page.locator("input").nth(passwordIndex);

    for (const field of [username, password, username]) {
      await field.click({ timeout: 3000 }).catch(() => {});
      await page.keyboard.press("ArrowDown").catch(() => {});
      await page.waitForTimeout(250);
      await page.keyboard.press("Enter").catch(() => {});
      await page.waitForTimeout(800);
    }

    const values = await valuesByInputIndex(page, [usernameIndex, passwordIndex]);
    if ((values[usernameIndex] || "").length > 0 && (values[passwordIndex] || "").length > 0) {
      return true;
    }
  }

  return false;
}

function configuredCredentials() {
  const account =
    process.env.TEMU_LOGIN_ACCOUNT ||
    process.env.TEMU_LOGIN_PHONE ||
    process.env.TEMU_LOGIN_EMAIL ||
    "";
  const password = process.env.TEMU_LOGIN_PASSWORD || "";
  return { account, password };
}

async function tryConfiguredCredentials(page) {
  const { account, password } = configuredCredentials();
  if (!account || !password) return false;

  const preferredTab = account.includes("@") ? "邮箱登录" : "手机号登录";
  await page.getByText(preferredTab, { exact: true }).click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(800);

  const inputs = await visibleInputMeta(page);
  const { usernameIndex, passwordIndex } = findLoginInputIndexes(inputs);
  if (usernameIndex < 0 || passwordIndex < 0) return false;

  await page.locator("input").nth(usernameIndex).fill(account, { timeout: 5000 });
  await page.locator("input").nth(passwordIndex).fill(password, { timeout: 5000 });
  return true;
}

async function clickAuthorizeLogin(page) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!(await ensureConsentChecked(page))) {
      fail("AUTO_LOGIN_CONSENT_NOT_CHECKED", "授权复选框未成功勾选");
    }

    const authButton = page.locator("button").filter({ hasText: /授权登录|登录/ }).last();
    const clicked =
      ((await authButton.count().catch(() => 0)) > 0 &&
        (await authButton.click({ timeout: 5000 }).then(() => true).catch(() => false))) ||
      (await clickTextByRect(page, "授权登录", (rects) =>
        rects.sort((a, b) => b.y - a.y)[0] || null,
      )) ||
      (await clickTextByRect(page, "登录", (rects) =>
        rects.sort((a, b) => b.y - a.y)[0] || null,
      ));

    if (!clicked) fail("AUTO_LOGIN_AUTHORIZE_BUTTON_NOT_FOUND", "找不到授权登录按钮");

    await page.waitForTimeout(2500).catch(() => {});
    if (page.isClosed()) return;
    const text = await bodyText(page).catch(() => "");
    if (!text.includes("授权登录") && !text.includes("手机号登录") && !text.includes("邮箱登录")) return;
  }
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
  if (!text.includes("授权登录") && !text.includes("密码")) {
    fail("AUTO_LOGIN_FORM_NOT_FOUND", "卖家中心登录表单未出现");
  }

  if (!(await ensureConsentChecked(sellerPage))) {
    fail("AUTO_LOGIN_CONSENT_NOT_CHECKED", "授权复选框未成功勾选");
  }

  const hasCredentials = (await trySavedPasswordAutofill(sellerPage)) || (await tryConfiguredCredentials(sellerPage));
  if (!hasCredentials) {
    fail("AUTO_LOGIN_PASSWORD_NOT_FILLED", "Chrome 保存密码未自动填充，且没有运行时账号密码");
  }

  await clickAuthorizeLogin(sellerPage);
  await new Promise((resolve) => setTimeout(resolve, 8000));

  const afterLoginText = await bodyText(sellerPage).catch(() => "");
  if (/验证码|短信|verification/i.test(afterLoginText) && !isLoggedInText(afterLoginText)) {
    fail("AUTO_LOGIN_VERIFICATION_REQUIRED", "登录需要短信或验证码");
  }

  const loggedInPage =
    (await waitForLoggedInPage(context, 20000)) ||
    context.pages().find((candidate) => /ads\.temu\.com/.test(candidate.url()) && !candidate.url().includes("login.html")) ||
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

const knownShopNames = [
  ...new Set(
    [
      ...config.shopNames,
      ...config.knownShopNames,
    ].filter(Boolean),
  ),
];

async function visibleShopLabel(page, shopName) {
  const exactMatches = await page.getByText(shopName, { exact: true }).count().catch(() => 0);
  if (exactMatches > 0) return shopName;

  return await page.evaluate((shopName) => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const shopLabelText = (text) => clean(text).replace(/\s*(半托管|全托管)\s*$/, "");
    const isVisible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    return Array.from(document.querySelectorAll("*")).some(
      (node) => isVisible(node) && shopLabelText(node.innerText || node.textContent) === shopName,
    )
      ? shopName
      : "";
  }, shopName);
}

function disambiguateExactShopMatches(candidates) {
  const unique = [...new Set(candidates.filter(Boolean))];
  if (unique.length <= 1) return unique[0] || "";

  const longest = [...unique].sort((a, b) => b.length - a.length)[0];
  return unique.every((name) => name === longest || longest.includes(name)) ? longest : "";
}

async function currentShopName(page) {
  const candidates = await page.evaluate((knownShopNames) => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const shopLabelText = (value) => clean(value).replace(/\s*(半托管|全托管)\s*$/, "");
    const isVisible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const visibleNodes = Array.from(document.querySelectorAll("*")).filter(isVisible);
    const visibleText = (node) => clean(node.innerText || node.textContent || "");
    const matches = knownShopNames.filter((shopName) =>
      visibleNodes.some((node) => {
        const text = visibleText(node);
        return text === shopName || shopLabelText(text) === shopName;
      }),
    );
    const currentRow = visibleNodes
      .map(visibleText)
      .find((text) => /(当前登录店铺|当前店铺)/.test(text));
    if (currentRow) {
      const current = knownShopNames.find((shopName) => currentRow.includes(shopName));
      if (current) return [current];
    }
    return matches;
  }, knownShopNames);
  return disambiguateExactShopMatches(candidates);
}

async function isShopSwitcherPage(page) {
  return await page.evaluate((knownShopNames) => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const isVisible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const visibleTexts = Array.from(document.querySelectorAll("*"))
      .filter(isVisible)
      .map((node) => clean(node.innerText || node.textContent || ""));
    const visibleShopCount = knownShopNames.filter((name) =>
      visibleTexts.some((text) => text === name || text.replace(/\s*(半托管|全托管)\s*$/, "") === name),
    ).length;
    const hasSwitcherTitle = visibleTexts.some((text) => text === "切换店铺" || text.startsWith("切换店铺 "));
    return hasSwitcherTitle || visibleShopCount >= 2;
  }, knownShopNames).catch(() => false);
}

async function waitForShopSwitcherPage(page, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isShopSwitcherPage(page)) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

async function waitForShopSwitcherPageInContext(context, fallbackPage, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const candidate of context.pages()) {
      if (candidate.isClosed()) continue;
      if (await isShopSwitcherPage(candidate)) {
        await candidate.bringToFront().catch(() => {});
        return candidate;
      }
    }
    await fallbackPage.waitForTimeout(300).catch(() => {});
  }
  return null;
}

async function clickCdpPoint(page, x, y) {
  debugShopSwitch(`cdp click x=${Math.round(x)} y=${Math.round(y)} url=${page.url()}`);
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
    await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  } finally {
    await client.detach().catch(() => {});
  }
  await page.waitForTimeout(300);
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

async function clickTopRightCurrentShopMenu(page, currentShop) {
  const point = await page.evaluate((currentShop) => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const shopLabelText = (value) => clean(value).replace(/\s*(半托管|全托管)\s*$/, "");
    const isVisible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const clickableAncestor = (node) => {
      let current = node;
      for (let depth = 0; current && depth < 6; depth += 1, current = current.parentElement) {
        if (!isVisible(current)) continue;
        const style = window.getComputedStyle(current);
        const role = current.getAttribute("role") || "";
        if (
          style.cursor === "pointer" ||
          ["BUTTON", "A"].includes(current.tagName) ||
          /button|menuitem/i.test(role) ||
          current.onclick
        ) {
          return current;
        }
      }
      return node;
    };

    const candidates = Array.from(document.querySelectorAll("button, a, div, span"))
      .filter(isVisible)
      .map((node) => {
        const text = clean(node.innerText || node.textContent || "");
        const clickable = clickableAncestor(node);
        const rect = clickable.getBoundingClientRect();
        const style = window.getComputedStyle(clickable);
        return {
          text,
          label: shopLabelText(text),
          rect,
          pointer: style.cursor === "pointer" || ["BUTTON", "A"].includes(clickable.tagName),
        };
      })
      .filter(({ text, label, rect }) => {
        if (label !== currentShop && text !== currentShop) return false;
        if (rect.top > 90 || rect.bottom < 0) return false;
        if (rect.right < window.innerWidth * 0.6) return false;
        if (rect.width > 420 || rect.height > 120) return false;
        return rect.width > 0 && rect.height > 0;
      })
      .sort(
        (a, b) =>
          Number(b.pointer) - Number(a.pointer) ||
          a.rect.top - b.rect.top ||
          b.rect.right - a.rect.right ||
          b.rect.width * b.rect.height - a.rect.width * a.rect.height,
      );

    const match = candidates[0];
    if (!match) return null;
    return {
      x: match.rect.x + match.rect.width / 2,
      y: match.rect.y + match.rect.height / 2,
    };
  }, currentShop);

  if (!point) return false;
  await clickCdpPoint(page, point.x, point.y);
  return true;
}

async function hasCurrentShopPopover(page) {
  return await page.evaluate(() => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const isVisible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    return Array.from(document.querySelectorAll("*")).some((node) => {
      if (!isVisible(node)) return false;
      const rect = node.getBoundingClientRect();
      const text = clean(node.innerText || node.textContent || "");
      return rect.top < 260 && text.includes("当前登录店铺") && text.includes("切换");
    });
  }).catch(() => false);
}

async function waitForCurrentShopPopover(page, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await hasCurrentShopPopover(page)) return true;
    await page.waitForTimeout(200);
  }
  return false;
}

async function clickCurrentShopPopoverSwitch(page) {
  const point = await page.evaluate(() => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const isVisible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const center = (rect) => ({
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
    });
    const hasCurrentShopAncestor = (node) => {
      let current = node;
      for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
        if (!isVisible(current)) continue;
        const text = clean(current.innerText || current.textContent || "");
        const rect = current.getBoundingClientRect();
        if (rect.top < 260 && text.includes("当前登录店铺")) return true;
      }
      return false;
    };

    const candidates = Array.from(document.querySelectorAll("button, a, div, span"))
      .filter((node) => {
        if (!isVisible(node)) return false;
        const text = clean(node.innerText || node.textContent || "");
        if (!/^切换\s*$/.test(text)) return false;
        const rect = node.getBoundingClientRect();
        if (rect.top > 280 || rect.right < window.innerWidth * 0.55) return false;
        return true;
      })
      .map((node) => ({
        node,
        rect: node.getBoundingClientRect(),
        inCurrentShopPopover: hasCurrentShopAncestor(node),
      }))
      .sort(
        (a, b) =>
          Number(b.inCurrentShopPopover) - Number(a.inCurrentShopPopover) ||
          a.rect.top - b.rect.top ||
          b.rect.right - a.rect.right,
      );

    const match = candidates[0];
    return match ? center(match.rect) : null;
  });

  if (!point) return false;
  await clickCdpPoint(page, point.x, point.y);
  return true;
}

async function openShopSwitcher(page) {
  if (await isShopSwitcherPage(page)) return page;

  await dismissBlockingModals(page);

  const current = await currentShopName(page);
  debugShopSwitch(`open current=${current || "unknown"} url=${page.url()}`);
  if (!current) {
    fail("SHOP_CURRENT_UNKNOWN", "无法识别当前店铺；请把当前店铺全名加入 TEMU_KNOWN_SHOPS");
  }

  const currentLabel = await visibleShopLabel(page, current);
  debugShopSwitch(`currentLabel=${currentLabel || current}`);
  let menuOpened = false;
  for (let attempt = 0; attempt < 3 && !menuOpened; attempt += 1) {
    const clicked =
      (await clickTopRightCurrentShopMenu(page, current)) ||
      (await clickVisibleTextPoint(page, currentLabel || current)) ||
      (await page
        .getByText(currentLabel || current, { exact: true })
        .last()
        .click({ timeout: 8000 })
        .then(() => true)
        .catch(() => false));
    if (!clicked) break;
    menuOpened = await waitForCurrentShopPopover(page, 4000);
    debugShopSwitch(`menu attempt=${attempt + 1} clicked=${clicked} opened=${menuOpened}`);
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!menuOpened) {
      const clickedMenu =
        (await clickTopRightCurrentShopMenu(page, current)) ||
        (await clickVisibleTextPoint(page, currentLabel || current));
      if (clickedMenu) {
        menuOpened = await waitForCurrentShopPopover(page, 4000);
      }
      debugShopSwitch(`reopen attempt=${attempt + 1} clicked=${clickedMenu} opened=${menuOpened}`);
    }

    const clickedSwitch =
      (await clickCurrentShopPopoverSwitch(page)) ||
      (await clickVisibleTextPoint(page, "切换")) ||
      (await page
        .getByText("切换", { exact: true })
        .last()
        .click({ timeout: 8000 })
        .then(() => true)
        .catch(() => false));
    debugShopSwitch(`popover switch attempt=${attempt + 1} clicked=${clickedSwitch}`);
    if (!clickedSwitch) continue;

    const samePageSwitcher = await waitForShopSwitcherPage(page, 6000);
    debugShopSwitch(`samePageSwitcher=${samePageSwitcher}`);
    if (samePageSwitcher) return page;
    const switcherPage = await waitForShopSwitcherPageInContext(page.context(), page, 8000);
    debugShopSwitch(`contextSwitcher=${Boolean(switcherPage)} url=${switcherPage?.url() || ""}`);
    if (switcherPage) return switcherPage;
    menuOpened = await hasCurrentShopPopover(page);
    debugShopSwitch(`popoverStillOpen=${menuOpened}`);
  }

  const switcherPage = await waitForShopSwitcherPageInContext(page.context(), page, 15000);
  debugShopSwitch(`finalContextSwitcher=${Boolean(switcherPage)} url=${switcherPage?.url() || ""}`);
  return switcherPage || page;
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
    const center = (rect) => ({
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
    });
    const switchButtonCandidates = (root = document) =>
      Array.from(root.querySelectorAll("button, div, span, a"))
        .map((node) => ({ node, text: normalizedText(node), rect: node.getBoundingClientRect() }))
        .filter(({ text, rect, node }) => {
          if (!isVisible(node)) return false;
          if (!/^切换\s*[>›»]?$/.test(text)) return false;
          return rect.width > 0 && rect.height > 0;
        });

    const labelNodes = Array.from(document.querySelectorAll("*"))
      .filter((node) => {
        if (!isVisible(node)) return false;
        return shopLabelText(node) === shopName;
      })
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
      const switchButtons = switchButtonCandidates()
        .filter(({ rect }) => {
          const buttonCenter = center(rect);
          const sameRow = Math.abs(buttonCenter.y - labelCenter.y) <= Math.max(56, labelRect.height * 1.5);
          return sameRow && rect.left > labelRect.right;
        })
        .sort((a, b) => a.rect.left - b.rect.left);

      const button = switchButtons[0];
      if (button) return center(button.rect);
    }

    const rows = Array.from(document.querySelectorAll("*"))
      .filter((node) => {
        if (!isVisible(node)) return false;
        const text = normalizedText(node);
        return text.includes(shopName) && /\b切换\b|切换/.test(text);
      })
      .map((node) => ({ node, text: normalizedText(node), rect: node.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width > 0 && rect.height > 0)
      .sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height);

    for (const row of rows) {
      const nestedButton = switchButtonCandidates(row.node).sort((a, b) => a.rect.left - b.rect.left)[0];
      if (nestedButton) return center(nestedButton.rect);

      const rowCenter = center(row.rect);
      const sameRowButton = switchButtonCandidates()
        .filter(({ rect }) => {
          const buttonCenter = center(rect);
          const sameRow = Math.abs(buttonCenter.y - rowCenter.y) <= Math.max(56, row.rect.height * 1.5);
          return sameRow && rect.left > row.rect.left;
        })
        .sort((a, b) => a.rect.left - b.rect.left)[0];
      if (sameRowButton) return center(sameRowButton.rect);
    }

    return null;
  }, shopName);

  if (!clickPoint) return false;
  await clickCdpPoint(page, clickPoint.x, clickPoint.y);
  return true;
}

async function clickShopSwitchButtonWithRetry(page, shopName, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isShopSwitcherPage(page))) {
      await dismissBlockingModals(page);
    }
    if (await clickShopSwitchButton(page, shopName)) return true;

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await page.waitForTimeout(Math.min(2500, remaining));

    if (!(await isShopSwitcherPage(page))) {
      await openShopSwitcher(page).catch(() => {});
    }
  }

  return false;
}

async function waitForCurrentShop(page, shopName, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastCurrent = "";
  while (Date.now() < deadline) {
    await dismissBlockingModals(page).catch(() => {});
    const current = await currentShopName(page).catch(() => "");
    if (current) lastCurrent = current;
    if (current === shopName) return { matched: true, current };
    await page.waitForTimeout(1000);
  }

  const current = await currentShopName(page).catch(() => "");
  return { matched: current === shopName, current: current || lastCurrent };
}

async function captureShopSwitchDiagnostics(page, shopName, reason = "unknown", details = {}) {
  const baseName = `debug-shop-switch-${safeFilePart(config.accountLabel || config.reportPrefix)}-${stamp}-${safeFilePart(shopName)}`;
  const jsonOutputPath = path.join(config.reportDir, `${baseName}.json`);
  const screenshotPath = path.join(config.reportDir, `${baseName}.png`);
  const diagnostics = {
    generatedAt: new Date().toISOString(),
    accountLabel: config.accountLabel,
    targetShop: shopName,
    reason,
    details,
    url: page.url(),
    title: await page.title().catch(() => ""),
    currentShop: await currentShopName(page).catch(() => ""),
    isShopSwitcherPage: await isShopSwitcherPage(page).catch(() => false),
    screenshotPath,
    visibleState: await page
      .evaluate((knownShopNames) => {
        const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const isVisible = (node) => {
          const rect = node.getBoundingClientRect();
          const style = window.getComputedStyle(node);
          return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        };
        const textOf = (node) => clean(node.innerText || node.textContent || "");
        const visibleNodes = Array.from(document.querySelectorAll("*")).filter(isVisible);
        return {
          bodyTextLength: clean(document.body?.innerText || document.body?.textContent || "").length,
          knownShopMatches: knownShopNames.map((name) => ({
            name,
            exactVisibleCount: visibleNodes.filter((node) => textOf(node) === name).length,
            labelVisibleCount: visibleNodes.filter((node) => textOf(node).replace(/\s*(半托管|全托管)\s*$/, "") === name).length,
            bodyIncludes: clean(document.body?.innerText || document.body?.textContent || "").includes(name),
          })),
          switchButtonTexts: visibleNodes
            .map(textOf)
            .filter((text) => /^切换\s*[>›»]?$/.test(text))
            .slice(0, 30),
        };
      }, knownShopNames)
      .catch((error) => ({ error: errorMessage(error) })),
  };

  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  await fs.writeFile(jsonOutputPath, JSON.stringify(diagnostics, null, 2)).catch(() => {});
  return jsonOutputPath;
}

async function switchShop(page, shopName) {
  const onSwitcher = await isShopSwitcherPage(page);
  const current = await currentShopName(page);
  if (current === shopName) {
    if (onSwitcher) {
      await page.goto(config.temuHomeUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
      await waitSettled(page);
    }

    if ((await currentShopName(page)) === shopName) return page;
  }

  let activePage = page;
  let lastAfter = current;
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    debugShopSwitch(`switch attempt=${attempt} target=${shopName} last=${lastAfter || "unknown"}`);
    let switcherPage;
    try {
      switcherPage = await openShopSwitcher(activePage);
    } catch (error) {
      const diagnosticsPath = await captureShopSwitchDiagnostics(activePage, shopName, "open-switcher-failed", {
        attempt,
        lastAfter: lastAfter || "unknown",
        error: errorMessage(error),
      }).catch(() => "");
      fail(
        error?.code || "SHOP_SWITCHER_OPEN_FAILED",
        `${errorMessage(error)}${diagnosticsPath ? `；诊断=${diagnosticsPath}` : ""}`,
      );
    }

    if (!(await clickShopSwitchButtonWithRetry(switcherPage, shopName))) {
      const diagnosticsPath = await captureShopSwitchDiagnostics(switcherPage, shopName, "target-not-clickable", {
        attempt,
        lastAfter,
      }).catch(() => "");
      fail(
        "SHOP_TARGET_NOT_FOUND",
        `店铺切换列表中找不到精确店名：${shopName}${diagnosticsPath ? `；诊断=${diagnosticsPath}` : ""}`,
      );
    }

    await waitSettled(switcherPage);
    await switcherPage.goto(config.temuHomeUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
    await waitSettled(switcherPage);
    await waitForText(switcherPage, shopName, 8000).catch(() => {});

    const verification = await waitForCurrentShop(switcherPage, shopName, 12000);
    lastAfter = verification.current || "";
    debugShopSwitch(
      `switch verify attempt=${attempt} target=${shopName} matched=${verification.matched} current=${lastAfter || "unknown"}`,
    );
    if (verification.matched) return switcherPage;

    activePage = switcherPage;
    if (!lastAfter && attempt < maxAttempts) {
      await activePage.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
      await waitSettled(activePage).catch(() => {});
    }
  }

  const diagnosticsPath = await captureShopSwitchDiagnostics(activePage, shopName, "verify-mismatch", {
    attempts: maxAttempts,
    current: lastAfter || "unknown",
  }).catch(() => "");
  fail(
    "SHOP_SWITCH_VERIFY_FAILED",
    `切换后店铺不匹配；目标=${shopName}，当前=${lastAfter || "unknown"}${diagnosticsPath ? `；诊断=${diagnosticsPath}` : ""}`,
  );
}

async function ensureRegion(page) {
  let text = await bodyText(page);
  if (text.includes(`当前区域:\n${config.targetRegion}`) || text.includes(`当前区域:${config.targetRegion}`)) {
    return;
  }

  const regionControlCount = await page.getByText(/当前区域:/).count().catch(() => 0);
  if (regionControlCount === 0) {
    fail("REGION_CONTROL_NOT_FOUND", `当前店铺页面没有区域切换控件；目标区域=${config.targetRegion}`);
  }

  await page.getByText(/当前区域:/).first().click({ timeout: 8000 });
  await waitForText(page, config.targetRegion, 8000);
  await page.getByText(config.targetRegion, { exact: true }).last().click({ timeout: 8000 });
  await waitSettled(page);

  text = await bodyText(page);
  if (!text.includes(config.targetRegion)) {
    fail("REGION_SWITCH_VERIFY_FAILED", `区域切换失败；目标区域=${config.targetRegion}`);
  }
}

async function openProductReportPage(context, page) {
  let activePage = page;
  await activePage.goto(config.temuReportUrl, { waitUntil: "domcontentloaded" });
  await waitSettled(activePage);
  if (!(await isLoggedIn(activePage))) {
    activePage = await attemptAutoLogin(context, activePage);
    await activePage.goto(config.temuReportUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
    await waitSettled(activePage);
  }
  await assertLoggedIn(activePage);
  await ensureRegion(activePage);

  const productReportTab = activePage.getByText("商品数据报表", { exact: true });
  if ((await productReportTab.count().catch(() => 0)) === 0) {
    fail("PRODUCT_REPORT_TAB_NOT_FOUND", "找不到商品数据报表标签页");
  }
  await productReportTab.click({ timeout: 10000 });
  await waitSettled(activePage);
  return activePage;
}

async function selectReportDate(page) {
  if (await isVisibleExactLabelActive(page, config.reportDateLabel, "RD_active")) {
    return { clicked: false };
  }

  let filterClicked = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const clicked = await clickVisibleExactLabel(page, config.reportDateLabel);
    filterClicked = clicked || filterClicked;
    if (clicked) {
      await waitSettled(page);
      if (await isVisibleExactLabelActive(page, config.reportDateLabel, "RD_active")) {
        return { clicked: true };
      }
    }
  }
  if (!filterClicked) {
    fail("DATE_FILTER_NOT_FOUND", `找不到${config.reportDateLabel}筛选按钮`);
  }
  fail("DATE_FILTER_NOT_ACTIVE", `${config.reportDateLabel}筛选未处于选中状态`);
}

async function openProductDataForDate(context, page) {
  let lastState = null;
  let activePage = page;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    activePage = await openProductReportPage(context, activePage);
    const previousSignature = await reportTableSignature(activePage);
    const dateSelection = await selectReportDate(activePage);

    lastState = await waitForReportTableReady(activePage, attempt === 0 ? 20000 : 30000, {
      previousSignature,
      requireSignatureChange: dateSelection.clicked,
    });
    if (lastState?.hasTargetHeader) {
      return activePage;
    }

    console.error(
      [
        `Report table wait retry ${attempt + 1}/3`,
        `date=${config.reportDateLabel}`,
        `headers=${lastState?.headerCount ?? 0}`,
        `loading=${(lastState?.loadingHints || []).join(",") || "none"}`,
        `labels=${(lastState?.visibleLabels || []).join(",") || "none"}`,
        `signatureChanged=${lastState?.signatureChanged === true ? "yes" : "no"}`,
      ].join(" | "),
    );
  }

  const details = [
    `date=${config.reportDateLabel}`,
    `headers=${lastState?.headerCount ?? 0}`,
    `loading=${(lastState?.loadingHints || []).join(",") || "none"}`,
    `labels=${(lastState?.visibleLabels || []).join(",") || "none"}`,
    `signatureChanged=${lastState?.signatureChanged === true ? "yes" : "no"}`,
    `body=${lastState?.bodySnippet || "empty"}`,
  ].join(" | ");
  fail(
    "REPORT_TABLE_NOT_READY",
    `商品数据表格未加载完成；已重试 3 次；${details}`,
  );
}

async function extractRows(page) {
  const headers = await page.locator("th").evaluateAll((cells) =>
    cells.map((cell) => (cell.innerText || cell.textContent || "").replace(/\s+/g, " ").trim()),
  );
  if (!hasAnyHeader(headers, reportHeaderAliases.quantity)) {
    fail("REPORT_HEADER_MISSING", "商品数据表缺少 件数 列");
  }

  const rawRows = await page.locator("table").nth(1).locator("tr").evaluateAll((rows) =>
    rows.map((row) =>
      Array.from(row.querySelectorAll("td,th")).map((cell) =>
        (cell.innerText || cell.textContent || "").replace(/\s+/g, " ").trim(),
      ),
    ),
  );

  const indexes = {
    product: 0,
    status: headers.findIndex((header) => header === "状态"),
    totalCost: headers.findIndex((header) => header === "总花费"),
    sales: headerIndex(headers, reportHeaderAliases.sales),
    netSales: headerIndex(headers, reportHeaderAliases.netSales),
    quantity: headerIndex(headers, reportHeaderAliases.quantity),
    netQuantity: headerIndex(headers, reportHeaderAliases.netQuantity),
    impressions: headerIndex(headers, reportHeaderAliases.impressions),
    clicks: headerIndex(headers, reportHeaderAliases.clicks),
    ctr: headerIndex(headers, reportHeaderAliases.ctr),
    cvr: headerIndex(headers, reportHeaderAliases.cvr),
  };

  const cellAt = (cells, index) => (index >= 0 ? cells[index] || "" : "");

  return rawRows
    .filter((cells) => cells.length >= Math.min(headers.length, 8))
    .map((cells) => ({
      cells,
      productText: cells[0],
      productName: compactProductName(cells[0]),
      productId: firstMatch(cells[0], /商品ID:\s*(\d+)/),
      spuId: firstMatch(cells[0], /SPU ID:\s*(\d+)/),
      status: cellAt(cells, indexes.status),
      totalCost: cellAt(cells, indexes.totalCost),
      quantity: cellAt(cells, indexes.quantity),
      sales: cellAt(cells, indexes.sales),
      netSales: cellAt(cells, indexes.netSales),
      displaySales: cellAt(cells, indexes.netSales) || cellAt(cells, indexes.sales),
      displaySalesLabel: indexes.netSales >= 0 ? "净销售额" : "销售额",
      netQuantity: cellAt(cells, indexes.netQuantity),
      impressions: cellAt(cells, indexes.impressions),
      clicks: cellAt(cells, indexes.clicks),
      ctr: cellAt(cells, indexes.ctr),
      cvr: cellAt(cells, indexes.cvr),
      salesValue: moneyToNumber(cellAt(cells, indexes.netSales) || cellAt(cells, indexes.sales)),
    }));
}

async function sortBySalesDesc(page) {
  const sortCandidates = [
    config.sortMetric,
    ...reportHeaderAliases.netSales,
    ...reportHeaderAliases.sales,
  ];
  let sortMetricUsed = "";
  for (const candidate of [...new Set(sortCandidates)]) {
    if (await visibleColumnHeaderExists(page, candidate)) {
      sortMetricUsed = candidate;
      break;
    }
  }

  if (!sortMetricUsed) {
    fail("SORT_COLUMN_NOT_FOUND", `找不到销售额排序列；尝试过：${sortCandidates.join(", ")}`);
  }

  let rows = await extractRows(page);
  for (let attempt = 0; attempt < 3 && !(looksSalesDesc(rows) && (await isSortDescActive(page, sortMetricUsed))); attempt += 1) {
    if (!(await clickVisibleSorter(page, sortMetricUsed))) {
      fail("SORT_HEADER_NOT_CLICKABLE", `找不到可点击的排序表头：${sortMetricUsed}`);
    }
    await waitSettled(page);
    rows = await extractRows(page);
  }

  if (!looksSalesDesc(rows)) {
    fail("SORT_DESC_VERIFY_FAILED", `表格数据未按 ${sortMetricUsed} 降序排列`);
  }

  if (!(await isSortDescActive(page, sortMetricUsed))) {
    fail("SORT_ICON_VERIFY_FAILED", `${sortMetricUsed} 表头未显示蓝色降序三角`);
  }

  if (rows.length === 0) {
    fail("REPORT_EMPTY", "商品数据表为空");
  }

  return { rows, sortMetricUsed };
}

async function visibleColumnHeaderExists(page, metricName) {
  return await page.evaluate((metricName) => {
    return Array.from(document.querySelectorAll("th")).some((th) => {
      const text = (th.innerText || th.textContent || "").replace(/\s+/g, " ").trim();
      const rect = th.getBoundingClientRect();
      const style = window.getComputedStyle(th);
      return (
        text === metricName &&
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== "hidden" &&
        style.display !== "none"
      );
    });
  }, metricName);
}

async function clickVisibleSorter(page, metricName) {
  const rect = await page.evaluate((metricName) => {
    const inViewport = (rect) =>
      rect.width > 0 &&
      rect.height > 0 &&
      rect.x >= 0 &&
      rect.y >= 0 &&
      rect.x + rect.width <= window.innerWidth &&
      rect.y + rect.height <= window.innerHeight;

    const candidates = Array.from(document.querySelectorAll("th")).filter((th) => {
      const text = (th.innerText || th.textContent || "").replace(/\s+/g, " ").trim();
      const rect = th.getBoundingClientRect();
      const style = window.getComputedStyle(th);
      return (
        text === metricName &&
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== "hidden" &&
        style.display !== "none"
      );
    });
    const header =
      candidates.find((th) => inViewport(th.getBoundingClientRect())) ||
      candidates.find((th) => th.querySelector(".TB_sorter_123")) ||
      candidates[0];
    if (!header) return null;

    header.scrollIntoView({ block: "center", inline: "center" });
    const sorter = header.querySelector(".TB_sorter_123");
    const rect = (sorter || header).getBoundingClientRect();
    if (!inViewport(rect)) return null;
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }, metricName);

  if (!rect) return false;
  await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
  return true;
}

async function isSortDescActive(page, metricName) {
  return await page.evaluate((metricName) => {
    const isBlue = (value) => /rgb\(76,\s*103,\s*255\)|#4c67ff/i.test(value || "");
    const visibleHeaders = Array.from(document.querySelectorAll("th")).filter((th) => {
      const text = (th.innerText || th.textContent || "").replace(/\s+/g, " ").trim();
      const rect = th.getBoundingClientRect();
      return text === metricName && rect.width > 0 && rect.height > 0;
    });

    return visibleHeaders.some((th) =>
      Array.from(th.querySelectorAll('[data-testid="beast-core-table-sorter-down"]')).some((node) => {
        const className = String(node.className || "");
        const style = window.getComputedStyle(node);
        return className.includes("TB_active") || isBlue(style.color) || isBlue(style.fill);
      }),
    );
  }, metricName);
}

function looksSalesDesc(rows) {
  const total = rows.find((row) => row.productText.startsWith("共"));
  const productRows = rows.filter((row) => !row.productText.startsWith("共"));
  if (productRows.length === 0) return false;

  const firstRowsAreZero =
    (total?.salesValue || 0) > 0 &&
    productRows.slice(0, Math.min(5, productRows.length)).every((row) => row.salesValue === 0);
  if (firstRowsAreZero) return false;

  if (productRows.length === 1) {
    return (total?.salesValue || 0) === 0 || productRows[0].salesValue > 0;
  }

  return productRows[0].salesValue >= productRows[1].salesValue;
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

function latestEvent(events, predicate) {
  return [...events].reverse().find(predicate) || null;
}

function productApiReportFromNetwork(shopName) {
  if (!networkCapture.enabled) return null;
  const events = networkCapture.getEvents();
  const shopEvents = events.filter((event) => event.marker?.data?.shopName === shopName);
  const adEvents = shopEvents.filter((event) => event.request?.url?.includes("/api/v1/coconut/ad/ads_report"));
  const startTimes = adEvents
    .map((event) => Number(event.request?.postData?.start_time || 0))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (startTimes.length === 0) return null;

  const reportStartTime = Math.max(...startTimes);
  const reportAdEvents = adEvents.filter((event) => Number(event.request?.postData?.start_time || 0) === reportStartTime);
  const sortedEvent =
    latestEvent(reportAdEvents, (event) => Number(event.request?.postData?.sort_by) === 1110) ||
    latestEvent(reportAdEvents, (event) => String(event.request?.postData?.sort_type || "").toLowerCase() === "desc");
  const summaryEvent = latestEvent(reportAdEvents, (event) => Number(event.request?.postData?.sort_by) === 0) || sortedEvent;
  const queryEvent = latestEvent(
    shopEvents,
    (event) =>
      event.request?.url?.includes("/api/v1/coconut/reports/queryReports") &&
      Number(event.request?.postData?.start_ts || 0) === reportStartTime,
  );
  if (!summaryEvent?.response?.body?.result) return null;

  const summary = summaryEvent.response.body.result.summary || {};
  const quantityMetric = apiMetric(summary, "goods_num", false);
  const netQuantityMetric = apiMetric(summary, "goods_num", true);
  const salesMetric = apiMetric(summary, "order_pay_amt", false);
  const netSalesMetric = apiMetric(summary, "order_pay_amt", true);
  const displaySales = metricTransValue(netSalesMetric) || metricTransValue(salesMetric);
  const rows = (sortedEvent?.response?.body?.result?.ads_detail || []).map(buildApiRow);
  const top = rows.slice(0, 5);
  const updateAt = Number(queryEvent?.response?.body?.result?.update_at || 0);

  return {
    source: "network-capture",
    ok: true,
    endpoints: {
      summary: summaryEvent.request.url,
      rows: sortedEvent?.request?.url || "",
      updateTime: queryEvent?.request?.url || "",
    },
    request: {
      startTime: reportStartTime,
      endTime: Number(summaryEvent.request?.postData?.end_time || 0),
      sortBy: sortedEvent?.request?.postData?.sort_by ?? null,
      sortType: sortedEvent?.request?.postData?.sort_type || "",
      pageNumber: sortedEvent?.request?.postData?.page_number || null,
      pageSize: sortedEvent?.request?.postData?.page_size || null,
    },
    updateTime: formatShanghaiDateTime(updateAt),
    total: {
      quantity: metricTransValue(quantityMetric),
      netQuantity: metricTransValue(netQuantityMetric),
      sales: metricTransValue(salesMetric),
      netSales: metricTransValue(netSalesMetric),
      displaySales,
      displaySalesLabel: metricTransValue(netSalesMetric) ? "净销售额" : "销售额",
      salesValue: metricNumberValue(netSalesMetric) || metricNumberValue(salesMetric),
    },
    top,
    rowCount: rows.length,
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

async function pageApiPost(page, endpoint, body = {}) {
  const url = endpoint.startsWith("http") ? endpoint : `${API_BASE_URL}${endpoint}`;
  return await page.evaluate(
    async ({ url, body }) => {
      const response = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: {
          accept: "application/json, text/plain, */*",
          "content-type": "application/json;charset=UTF-8",
        },
        body: JSON.stringify(body || {}),
      });
      const text = await response.text();
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      return {
        ok: response.ok,
        status: response.status,
        url: response.url,
        body: parsed,
        text: parsed ? "" : text.slice(0, 1000),
      };
    },
    { url, body },
  );
}

function assertApiResponse(response, label) {
  if (!response?.ok) {
    fail("API_HTTP_FAILED", `${label} HTTP ${response?.status || "unknown"}：${response?.text || ""}`);
  }

  const body = response.body;
  if (!body || typeof body !== "object") {
    fail("API_RESPONSE_NOT_JSON", `${label} 返回非 JSON：${response.text || ""}`);
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
    await pageApiPost(page, "/account/mall_list?mallType=2", { mall_type: 2 }),
    "店铺列表接口",
  );
  const malls = body.result?.query_mall_detail_resp_dtolist || [];
  if (!Array.isArray(malls) || malls.length === 0) {
    fail("API_MALL_LIST_EMPTY", "店铺列表接口没有返回可切换店铺");
  }
  return malls;
}

async function switchShopByApi(page, shopName) {
  if (!page.url().includes("ads.temu.com")) {
    await page.goto(config.temuHomeUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
    await waitSettled(page);
  }

  const malls = await apiMallList(page);
  const matches = malls.filter((mall) => String(mall.mall_name || "").trim() === shopName);
  if (matches.length !== 1) {
    fail(
      "API_SHOP_TARGET_NOT_FOUND",
      `店铺列表接口中找不到唯一精确店名：${shopName}；匹配数=${matches.length}`,
    );
  }

  const mall = matches[0];
  const targetMallId = String(mall.mall_id || "");
  if (!targetMallId) {
    fail("API_SHOP_MALL_ID_MISSING", `店铺列表接口中 ${shopName} 缺少 mall_id`);
  }

  const body = assertApiResponse(
    await pageApiPost(page, `/account/mall_switch?mallType=2&targetMallId=${encodeURIComponent(targetMallId)}`, {}),
    "店铺切换接口",
  );
  if (body.result?.mall_switch_result !== true) {
    fail("API_SHOP_SWITCH_FAILED", `店铺切换接口未确认成功：${shopName}`);
  }

  await page.waitForTimeout(800);
  return {
    source: "api",
    mallId: targetMallId,
    mallName: String(mall.mall_name || ""),
    mallType: String(mall.mall_type || ""),
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
    await pageApiPost(page, "/reports/queryReports", queryRequestBody),
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
        await pageApiPost(page, "/ad/ads_report", adsRequestBody),
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
  return reports.map((report) => {
    if (report.source === "direct-api") {
      return {
        ...report,
        apiComparison: compareApiReport(report, report.apiReport),
      };
    }

    const apiReport = productApiReportFromNetwork(report.shopName) || report.apiReport || null;
    return {
      ...report,
      apiReport,
      apiComparison: compareApiReport(report, apiReport),
    };
  });
}

function buildSummary(rows, updateTime) {
  const total = rows.find((row) => row.productText.startsWith("共"));
  const products = rows
    .filter((row) => !row.productText.startsWith("共"))
    .sort((a, b) => b.salesValue - a.salesValue);
  const top = products.slice(0, 5);

  if (!total) {
    fail("REPORT_TOTAL_ROW_MISSING", "未读取到汇总行");
  }

  return { total, top, updateTime };
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

async function collectShopByDom(context, activePage, shopName) {
  activePage = await switchShop(activePage, shopName);
  networkCapture.mark("product:shop-selected", { shopName, source: "dom", url: activePage.url() });
  activePage = await openProductDataForDate(context, activePage);
  networkCapture.mark("product:report-open", { shopName, source: "dom", url: activePage.url() });

  const { rows, sortMetricUsed } = await sortBySalesDesc(activePage);
  const pageText = await bodyText(activePage);
  const updateTime = pageText.match(/数据更新时间:\s*([0-9:\-\s]+)/)?.[1]?.trim() || "";
  const summary = buildSummary(rows, updateTime);
  await networkCapture.settle(2000);
  const apiReport = productApiReportFromNetwork(shopName);
  const apiComparison = compareApiReport(summary, apiReport);
  networkCapture.mark("product:extracted", {
    shopName,
    source: "dom",
    rowCount: rows.length,
    sortMetricUsed,
    updateTime,
    totalQuantity: summary.total?.quantity || "",
    totalSales: summary.total?.displaySales || "",
    apiQuantity: apiReport?.total?.quantity || "",
    apiSales: apiReport?.total?.displaySales || "",
    apiMatches:
      apiComparison &&
      apiComparison.quantityMatches &&
      apiComparison.salesMatches &&
      apiComparison.updateTimeMatches,
  });
  return {
    activePage,
    report: { shopName, source: "dom", rows, sortMetricUsed, ...summary, apiReport, apiComparison },
  };
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
        productSource: config.productSource,
        apiDomFallback: config.apiDomFallback,
        sortMetric: config.sortMetric,
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
    productSource: config.productSource,
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
      networkCapture.mark("product:shop-start", { shopName, productSource: config.productSource });
      let result;
      if (config.productSource === "api") {
        try {
          result = await collectShopByApi(activePage, shopName);
        } catch (error) {
          if (!config.apiDomFallback) throw error;
          console.error(`API collection failed, falling back to DOM: ${shopName}: ${errorMessage(error)}`);
          networkCapture.mark("product:api-fallback-dom", { shopName, error: errorMessage(error) });
          result = await collectShopByDom(context, activePage, shopName);
          result.report = {
            ...result.report,
            source: "dom-fallback",
            apiError: errorMessage(error),
          };
        }
      } else {
        result = await collectShopByDom(context, activePage, shopName);
      }

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
