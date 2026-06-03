import fs from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { closeCdpChromeProcess, closeCdpPages } from "./cdp-page-cleanup.mjs";
import {
  ensureConsentChecked as ensureSharedConsentChecked,
} from "./temu-consent-helper.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const accountsPath = process.env.TEMU_ACCOUNTS_CONFIG || path.join(rootDir, "temu-accounts.json");
const reportDir = process.env.TEMU_REPORT_DIR || path.join(rootDir, "temu-reports");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const targetUrl =
  process.env.TEMU_PRICE_ADJUST_URL || "https://agentseller.temu.com/main/adjust-price-manage/order-price";
const rejectReason = "0";
const shouldReject = process.argv.includes("--reject") || process.env.TEMU_PRICE_ADJUST_REJECT === "1";
const pageSettleMs = positiveInteger(process.env.TEMU_PRICE_ADJUST_SETTLE_MS, 1200);

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
      Object.fromEntries(indexes.map((index) => [index, nodes[index]?.value || ""])),
    indexes,
  );
}

async function trySavedPasswordAutofill(page) {
  let rememberedPhone = "";

  for (const tab of ["", "手机号登录", "邮箱登录", "手机号登录"]) {
    if (tab) {
      await page.getByText(tab, { exact: true }).click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(800).catch(() => {});
      if (page.isClosed()) return true;
    }

    const inputs = await visibleInputMeta(page);
    const { usernameIndex, passwordIndex } = findLoginInputIndexes(inputs);
    if (usernameIndex < 0 || passwordIndex < 0) continue;

    const username = page.locator("input").nth(usernameIndex);
    const password = page.locator("input").nth(passwordIndex);
    for (const field of [username, password, username]) {
      await field.click({ timeout: 3000 }).catch(() => {});
      await page.keyboard.press("ArrowDown").catch(() => {});
      await page.waitForTimeout(250).catch(() => {});
      await page.keyboard.press("Enter").catch(() => {});
      await page.waitForTimeout(800).catch(() => {});
      if (page.isClosed()) return true;
    }

    const values = await valuesByInputIndex(page, [usernameIndex, passwordIndex]);
    const usernameValue = values[usernameIndex] || "";
    const passwordValue = values[passwordIndex] || "";
    const usernameMeta = inputs.find((input) => input.index === usernameIndex);
    const isEmailForm = /邮箱|email|子账号邮箱/i.test(usernameMeta?.placeholder || "");
    const isPhoneForm = /手机|phone/i.test(usernameMeta?.placeholder || "");

    if (isEmailForm && usernameValue && !usernameValue.includes("@")) {
      rememberedPhone = usernameValue.replace(/\D/g, "") || usernameValue;
      continue;
    }

    if (isPhoneForm && !usernameValue && rememberedPhone && passwordValue) {
      await username.fill(rememberedPhone, { timeout: 5000 });
      await page.waitForTimeout(300);
      return true;
    }

    if (usernameValue.length > 0 && passwordValue.length > 0) return true;
  }
  return false;
}

async function tryConfiguredCredentials(page) {
  const account =
    process.env.TEMU_LOGIN_ACCOUNT ||
    process.env.TEMU_LOGIN_PHONE ||
    process.env.TEMU_LOGIN_EMAIL ||
    "";
  const password = process.env.TEMU_LOGIN_PASSWORD || "";
  if (!account || !password) return false;

  await page.getByText(account.includes("@") ? "邮箱登录" : "手机号登录", { exact: true }).click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(800);

  const inputs = await visibleInputMeta(page);
  const { usernameIndex, passwordIndex } = findLoginInputIndexes(inputs);
  if (usernameIndex < 0 || passwordIndex < 0) return false;

  await page.locator("input").nth(usernameIndex).fill(account, { timeout: 5000 });
  await page.locator("input").nth(passwordIndex).fill(password, { timeout: 5000 });
  return true;
}

async function hasVisiblePasswordInput(page) {
  return (await visibleInputMeta(page)).some((input) => input.visible && input.type === "password");
}

async function ensureConsentChecked(page) {
  if (await ensureSharedConsentChecked(page).catch(() => false)) {
    await page.waitForTimeout(500);
    return true;
  }
  return false;
}

function needsVerification(text) {
  return /请输入.*验证码|短信验证码|手机验证码|安全验证|验证身份|获取验证码|发送验证码|拖动滑块|verification/i.test(text);
}

function isSellerLoginFormText(text) {
  return text.includes("扫码登录") || text.includes("手机号登录") || text.includes("邮箱登录");
}

function isSellerAuthorizeText(text) {
  return /授权登录|确认授权并前往|授权并前往/.test(text);
}

async function loginSellerIfNeeded(page) {
  const text = await bodyText(page);
  const hasLoginForm = isSellerLoginFormText(text);
  const hasAuthorizeButton = isSellerAuthorizeText(text);
  if (!hasLoginForm && !hasAuthorizeButton) return;

  if (!(await ensureConsentChecked(page))) {
    fail("SELLER_LOGIN_CONSENT_NOT_CHECKED", "卖家中心登录协议复选框未成功勾选");
  }

  const needsPassword = await hasVisiblePasswordInput(page);
  const filled = needsPassword ? (await trySavedPasswordAutofill(page)) || (await tryConfiguredCredentials(page)) : true;
  if (!filled) fail("SELLER_LOGIN_PASSWORD_NOT_FILLED", "卖家中心登录页未能自动填充密码，且没有运行时账号密码");

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!(await ensureConsentChecked(page))) {
      fail("SELLER_LOGIN_CONSENT_NOT_CHECKED", "卖家中心登录协议复选框未成功勾选");
    }

    const clicked = await clickSellerLoginButton(page);
    if (!clicked) fail("SELLER_LOGIN_BUTTON_NOT_FOUND", "找不到卖家中心登录/授权登录按钮");

    await page.waitForTimeout(5000).catch(() => {});
    if (page.isClosed()) return;
    const afterText = await bodyText(page);
    if (needsVerification(afterText) && (afterText.includes("登录") || isSellerAuthorizeText(afterText))) {
      fail("SELLER_LOGIN_VERIFICATION_REQUIRED", "卖家中心登录需要短信或验证码");
    }
    if (!isSellerLoginFormText(afterText) && !isSellerAuthorizeText(afterText)) return;
  }

  fail("SELLER_LOGIN_NOT_SUBMITTED", "卖家中心登录/授权仍停留在登录页，请检查协议勾选或登录提示");
}

async function clickSellerLoginButton(page) {
  for (const label of ["确认授权并前往", "授权并前往", "授权登录", "登录"]) {
    const button = page.locator("button").filter({ hasText: label }).first();
    const box = await button.boundingBox({ timeout: 3000 }).catch(() => null);
    if (box) {
      await clickCdpPoint(page, box.x + box.width / 2, box.y + box.height / 2);
      return true;
    }
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

async function waitForMatchingPage(context, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matched = [...context.pages()].reverse().find((candidate) => !candidate.isClosed() && predicate(candidate));
    if (matched) return matched;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

async function enterAgentAuthenticationIfShown(context, page) {
  if (!page.url().startsWith("https://agentseller.temu.com/auth/authentication")) return null;

  const clickPoint = await agentChinaSellerCenterPoint(page);
  if (!clickPoint) return null;
  const beforePages = new Set(context.pages());
  await clickCdpPoint(page, clickPoint.x, clickPoint.y);
  await new Promise((resolve) => setTimeout(resolve, 2500));

  return (
    (await waitForMatchingPage(
      context,
      (candidate) =>
        !beforePages.has(candidate) &&
        (candidate.url().startsWith("https://seller.kuajingmaihuo.com/") ||
          candidate.url().startsWith("https://agentseller.temu.com/")),
      5000,
    )) ||
    (await waitForMatchingPage(
      context,
      (candidate) =>
        candidate.url().startsWith("https://seller.kuajingmaihuo.com/") ||
        (candidate.url().startsWith("https://agentseller.temu.com/") &&
          !candidate.url().startsWith("https://agentseller.temu.com/auth/authentication")),
      3000,
    )) ||
    (page.isClosed() ? null : page)
  );
}

async function agentChinaSellerCenterPoint(page) {
  return await page.evaluate(() => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const isVisible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const center = (rect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
    const regionRows = Array.from(document.querySelectorAll("div, button, a"))
      .filter((node) => {
        const text = clean(node.innerText || node.textContent);
        const className = String(node.className || "");
        return isVisible(node) && text.includes("中国地区") && text.includes("商家中心") && !text.includes("其他地区") && !text.includes("敬请期待") && !className.includes("disabled");
      })
      .map((node) => ({ node, rect: node.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width > 0 && rect.height > 0)
      .sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height);
    const row = regionRows[0];
    return row ? { x: row.rect.left + row.rect.width * 0.72, y: row.rect.top + row.rect.height / 2 } : null;
  });
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

    const text = await bodyText(activePage);
    if (activePage.url().startsWith(targetUrl) && text.includes("价格申报视角")) return activePage;

    const authenticatedPage = await enterAgentAuthenticationIfShown(context, activePage);
    if (authenticatedPage) {
      activePage = preferredAgentSellerPage(context, authenticatedPage);
      await activePage.bringToFront().catch(() => {});
      await waitSettled(activePage);
      continue;
    }

    await loginSellerIfNeeded(activePage);
    activePage = preferredAgentSellerPage(context, activePage);
    await waitSettled(activePage);

    if (isAgentSellerShell(activePage, await bodyText(activePage)) || isSellerCenterShell(activePage)) {
      await activePage.goto(targetUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
      await waitSettled(activePage);
    }
  }

  await captureDiagnostics(activePage, "target-page-not-ready").catch(() => "");
  fail("PRICE_ADJUST_PAGE_NOT_READY", "完成登录/授权后仍未进入调价管理页");
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
    const currentRow = visibleNodes.map(visibleText).find((text) => /(当前登录店铺|当前店铺)/.test(text));
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
    const visibleTexts = Array.from(document.querySelectorAll("*")).filter(isVisible).map((node) => clean(node.innerText || node.textContent || ""));
    const visibleCount = knownShops.filter((name) =>
      visibleTexts.some((text) => text === name || text.replace(/\s*(半托管|全托管)\s*$/, "") === name),
    ).length;
    return visibleTexts.some((text) => text === "切换店铺" || text.startsWith("切换店铺 ")) || visibleCount >= 2;
  }, knownShops).catch(() => false);
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
      .map((node) => ({ text: clean(node.innerText || node.textContent || ""), rect: node.getBoundingClientRect() }))
      .filter(({ text, rect }) => rect.width <= 360 && rect.height <= 100 && (text === targetText || shopLabelText(text) === targetText))
      .sort((a, b) => a.rect.top - b.rect.top || b.rect.right - a.rect.right);
    const match = candidates[0];
    return match ? { x: match.rect.x + match.rect.width / 2, y: match.rect.y + match.rect.height / 2 } : null;
  }, targetText);
  if (!point) return false;
  await clickCdpPoint(page, point.x, point.y);
  return true;
}

async function openShopSwitcher(page, knownShops) {
  if (await isShopSwitcherOpen(page, knownShops)) return;
  const current = await currentShopName(page, knownShops);
  if (!current) fail("SHOP_CURRENT_UNKNOWN", "无法识别当前店铺");
  if (!(await clickVisibleTextPoint(page, current))) {
    await page.getByText(current, { exact: true }).last().click({ timeout: 8000 });
  }
  await page.waitForTimeout(500);
  if (!(await clickVisibleTextPoint(page, "切换"))) {
    await page.getByText("切换", { exact: true }).last().click({ timeout: 8000 });
  }
  await page.waitForTimeout(1000);
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

async function switchShop(context, page, shopName, knownShops) {
  let activePage = page;
  const current = await currentShopName(activePage, knownShops);
  if (current !== shopName) {
    await openShopSwitcher(activePage, knownShops);
    if (!(await clickShopSwitchButton(activePage, shopName))) {
      fail("SHOP_TARGET_NOT_FOUND", `店铺切换列表中找不到精确店名：${shopName}`);
    }
    await waitSettled(activePage);
  }
  await activePage.goto(targetUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
  await waitSettled(activePage);
  activePage = preferredAgentSellerPage(context, activePage);
  const after = await currentShopName(activePage, knownShops);
  if (after !== shopName) {
    fail("SHOP_SWITCH_VERIFY_FAILED", `切换后店铺不匹配；目标=${shopName}，当前=${after || "unknown"}`);
  }
  return activePage;
}

function isPriceAdjustPageReady(text) {
  return text.includes("价格申报视角") && text.includes("待卖家确认");
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

async function clickConfirmingTab(page) {
  await page.getByText(/待卖家确认\(\d+\)/).first().click({ timeout: 8000 }).catch(async () => {
    await page.getByText("待卖家确认").first().click({ timeout: 8000 });
  });
  await waitSettled(page);
}

async function extractPendingRowsFromDom(page) {
  return await page.evaluate(() => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const isVisible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const table = Array.from(document.querySelectorAll("table"))
      .filter(isVisible)
      .find((candidate) => {
        const text = clean(candidate.innerText || candidate.textContent);
        return text.includes("单号") && text.includes("货品信息") && text.includes("调整后申报价格");
      });
    if (!table) return [];
    const rowNodes = Array.from(table.querySelectorAll("tr")).filter((row) => {
      const text = clean(row.innerText || row.textContent);
      return /^HJD\d+/.test(text) && text.includes("商品调价");
    });
    return rowNodes.map((row) => {
      const text = clean(row.innerText || row.textContent);
      const orderSn = text.match(/HJD\d+/)?.[0] || "";
      const skcId = text.match(/SKC ID[:：]\s*(\d+)/)?.[1] || "";
      const productName = text
        .replace(orderSn, "")
        .replace(/SKC ID[:：]\s*\d+.*/, "")
        .trim();
      return { orderSn, skcId, productName, rowText: text.slice(0, 1000) };
    }).filter((row) => row.orderSn);
  });
}

async function selectVisiblePendingRows(page) {
  return await page.evaluate(() => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const isVisible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const clicked = [];
    const rows = Array.from(document.querySelectorAll("tr")).filter((row) => {
      const text = clean(row.innerText || row.textContent);
      return /^HJD\d+/.test(text) && text.includes("商品调价");
    });
    for (const row of rows) {
      const checkbox = Array.from(row.querySelectorAll('[role="checkbox"], input[type="checkbox"], [class*="checkbox"], [class*="Checkbox"], [class*="CBX"]'))
        .filter(isVisible)
        .find((node) => {
          const rect = node.getBoundingClientRect();
          return rect.width <= 40 && rect.height <= 40;
        });
      if (!checkbox) continue;
      const aria = checkbox.getAttribute("aria-checked");
      const checked = checkbox instanceof HTMLInputElement
        ? checkbox.checked
        : aria === "true" || /checked|selected|active/i.test(String(checkbox.className || ""));
      if (!checked) {
        const rect = checkbox.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const target = document.elementFromPoint(x, y) || checkbox;
        target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: x, clientY: y }));
        target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, clientX: x, clientY: y }));
        target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: x, clientY: y }));
        if (typeof target.click === "function") target.click();
      }
      clicked.push(clean(row.innerText || row.textContent).match(/HJD\d+/)?.[0] || "");
    }
    return clicked.filter(Boolean);
  });
}

async function clickExactButton(page, label) {
  const point = await page.evaluate((label) => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const isVisible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const buttons = Array.from(document.querySelectorAll("button, [role='button']"))
      .filter((node) => isVisible(node) && clean(node.innerText || node.textContent) === label)
      .map((node) => ({ node, rect: node.getBoundingClientRect(), disabled: node.disabled || node.getAttribute("aria-disabled") === "true" }))
      .filter((item) => !item.disabled)
      .sort((a, b) => b.rect.top - a.rect.top || b.rect.right - a.rect.right);
    const button = buttons[0];
    return button ? { x: button.rect.left + button.rect.width / 2, y: button.rect.top + button.rect.height / 2 } : null;
  }, label);
  if (!point) return false;
  await clickCdpPoint(page, point.x, point.y);
  return true;
}

async function fillRejectReasons(page) {
  const textareas = page.locator("textarea:visible");
  const count = await textareas.count();
  let filled = 0;
  for (let index = 0; index < count; index += 1) {
    if (await textareas.nth(index).fill(rejectReason, { timeout: 3000 }).then(() => true).catch(() => false)) {
      filled += 1;
    }
  }
  return filled;
}

async function rejectVisibleRows(page) {
  const selectedOrderSns = await selectVisiblePendingRows(page);
  if (selectedOrderSns.length === 0) {
    fail("PRICE_ADJUST_SELECT_EMPTY", "待卖家确认表格有数据，但未能勾选任何调价单");
  }

  if (!(await clickExactButton(page, "批量拒绝"))) {
    fail("PRICE_ADJUST_BATCH_REJECT_BUTTON_NOT_FOUND", "找不到可点击的批量拒绝按钮");
  }
  await page.waitForTimeout(1000);

  const modalText = await bodyText(page, 5000);
  if (!modalText.includes("拒绝调价") && !modalText.includes("拒绝原因")) {
    fail("PRICE_ADJUST_REJECT_MODAL_NOT_OPEN", "批量拒绝弹窗未打开");
  }

  const filledCount = await fillRejectReasons(page);
  if (filledCount === 0) {
    fail("PRICE_ADJUST_REJECT_REASON_INPUT_NOT_FOUND", "找不到拒绝原因输入框");
  }

  const requests = [];
  const onRequest = (request) => {
    if (request.url().includes("/api/kiana/magnus/mms/price-adjust/batch-review")) {
      requests.push({
        url: request.url(),
        method: request.method(),
        postData: request.postData() || "",
        mallid: request.headers().mallid || "",
      });
    }
  };
  page.context().on("request", onRequest);
  const responsePromise = page
    .waitForResponse((response) => response.url().includes("/api/kiana/magnus/mms/price-adjust/batch-review"), {
      timeout: 30000,
    })
    .catch(() => null);

  if (!(await clickExactButton(page, "拒绝"))) {
    page.context().off("request", onRequest);
    fail("PRICE_ADJUST_REJECT_SUBMIT_NOT_FOUND", "找不到拒绝弹窗的提交按钮");
  }

  const response = await responsePromise;
  page.context().off("request", onRequest);
  if (!response) fail("PRICE_ADJUST_REJECT_RESPONSE_TIMEOUT", "提交拒绝后未捕获 batch-review 响应");
  const responseText = await response.text().catch(() => "");
  let responseBody = null;
  try {
    responseBody = responseText ? JSON.parse(responseText) : null;
  } catch {
    responseBody = null;
  }

  const request = requests[requests.length - 1] || null;
  const parsedRequest = request?.postData ? JSON.parse(request.postData) : null;
  if (parsedRequest) {
    if (parsedRequest.batchResult !== 2) {
      fail("PRICE_ADJUST_REJECT_SAFETY_CHECK_FAILED", `batch-review 不是拒绝动作：${request.postData}`);
    }
    if (!parsedRequest.rejectReasons || Object.values(parsedRequest.rejectReasons).some((value) => String(value) !== rejectReason)) {
      fail("PRICE_ADJUST_REJECT_REASON_CHECK_FAILED", `batch-review 拒绝原因不是 0：${request.postData}`);
    }
  }
  const errorCode = responseBody?.errorCode ?? responseBody?.error_code;
  if (!response.ok() || responseBody?.success === false || (errorCode !== undefined && Number(errorCode) !== 1000000)) {
    fail(
      "PRICE_ADJUST_REJECT_RESPONSE_FAILED",
      `batch-review 返回失败：status=${response.status()} code=${errorCode ?? "unknown"} msg=${responseBody?.errorMsg || responseBody?.error_msg || responseText}`,
    );
  }

  return {
    selectedOrderSns,
    request,
    requestBodyVisible: Boolean(parsedRequest),
    response: {
      status: response.status(),
      body: responseBody,
      text: responseBody ? "" : responseText.slice(0, 1000),
    },
  };
}

async function collectAndMaybeRejectShop(page, shopName) {
  await clickConfirmingTab(page);
  const text = await bodyText(page);
  if (!isPriceAdjustPageReady(text)) {
    const diagnosticsPath = await captureDiagnostics(page, "price-adjust-page-not-ready");
    fail("PRICE_ADJUST_TAB_NOT_READY", `${shopName} 未进入待卖家确认页；诊断=${diagnosticsPath}`);
  }

  const beforeRows = await extractPendingRowsFromDom(page);
  if (!shouldReject || beforeRows.length === 0) {
    return {
      shopName,
      source: "dom-ui",
      rejected: false,
      pendingBefore: beforeRows.length,
      pendingAfter: beforeRows.length,
      rowsBefore: beforeRows,
      actions: [],
    };
  }

  const actions = [];
  while (true) {
    const rows = await extractPendingRowsFromDom(page);
    if (rows.length === 0) break;
    actions.push(await rejectVisibleRows(page));
    await waitSettled(page);
    await clickConfirmingTab(page);
  }

  const afterRows = await extractPendingRowsFromDom(page);
  return {
    shopName,
    source: "dom-ui",
    rejected: true,
    rejectReason,
    pendingBefore: beforeRows.length,
    pendingAfter: afterRows.length,
    rowsBefore: beforeRows,
    rowsAfter: afterRows,
    actions,
  };
}

async function runAccount(account) {
  const shops = shopListForAccount(account);
  const knownShops = [...new Set([...(account.knownShops || []), ...shops])];
  if (shops.length === 0) fail("NO_SHOPS_CONFIGURED", `${account.label || account.id} 没有配置店铺`);

  const { browser, context, page } = await connectCdpChrome(account, targetUrl);
  try {
    let activePage = await ensureTargetPage(context, page);
    const shopReports = [];
    for (const shopName of shops) {
      activePage = await switchShop(context, activePage, shopName, knownShops);
      shopReports.push(await collectAndMaybeRejectShop(activePage, shopName));
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
        ...result.shops.map((shop) =>
          `${shop.shopName}: 待拒绝 ${shop.pendingBefore}，已拒绝 ${shop.rejected ? shop.pendingBefore - shop.pendingAfter : 0}，剩余 ${shop.pendingAfter}`,
        ),
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
      targetUrl,
      dryRun: !shouldReject,
      rejectReason,
      api: {
        statusCount: "POST https://agentseller.temu.com/api/kiana/magnus/mms/price-adjust/status-count",
        pageQuery: "POST https://agentseller.temu.com/api/kiana/magnus/mms/price-adjust/page-query",
        batchReview: "POST https://agentseller.temu.com/api/kiana/magnus/mms/price-adjust/batch-review",
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
