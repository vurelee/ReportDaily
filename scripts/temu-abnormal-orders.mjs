import fs from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { closeCdpChromeProcess, closeCdpPages } from "./cdp-page-cleanup.mjs";
import { closeTemuPopups } from "./temu-popup-cleaner.mjs";
import { createTemuNetworkCapture } from "./temu-network-capture.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const accountsPath = process.env.TEMU_ACCOUNTS_CONFIG || path.join(rootDir, "temu-accounts.json");
const reportDir = process.env.TEMU_REPORT_DIR || path.join(rootDir, "temu-reports");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const targetUrl =
  process.env.TEMU_ABNORMAL_ORDER_URL || "https://agentseller.temu.com/lgst/auth-warehouse/abnormal-order";
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

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
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
  const page =
    pages.find((candidate) => candidate.url().startsWith("https://agentseller.temu.com/")) ||
    (await context.newPage());
  return { browser, context, page };
}

async function bodyText(page, timeout = 10000) {
  return await page.locator("body").innerText({ timeout }).catch(() => "");
}

async function waitSettled(page, usePopupCleaner = true) {
  await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(600);
  if (usePopupCleaner && !isSellerCenterShell(page)) await closeTemuPopups(page);
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

    if (usernameValue.length > 0 && passwordValue.length > 0) {
      return true;
    }
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
  const result = await page.evaluate(() => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const isVisible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const consentPattern = /已阅读|阅读并同意|同意|隐私|协议|授权|共享|须知/;
    const checkboxText = (node) => {
      const label = node.closest("label");
      const row =
        node.closest("label") ||
        node.closest('[class*="checkbox"]') ||
        node.closest('[class*="Check"]') ||
        node.closest("div");
      return normalize([label?.innerText, row?.innerText, node.parentElement?.innerText].filter(Boolean).join(" "));
    };
    const checkedByStyle = (node) => {
      if (node instanceof HTMLInputElement) return Boolean(node.checked);
      const aria = node.getAttribute("aria-checked");
      if (aria) return aria === "true";
      const className = String(node.className || "");
      const text = normalize(node.innerText || node.textContent);
      return /checked|selected|active/i.test(className) || /^✓|✔/.test(text);
    };
    const clickNode = (node) => {
      const clickable = node.closest("label") || node.closest('[role="checkbox"]') || node.parentElement || node;
      const target = isVisible(clickable) ? clickable : node;
      target.dispatchEvent(new MouseEvent("mousedown", { view: window, bubbles: true, cancelable: true }));
      target.dispatchEvent(new MouseEvent("mouseup", { view: window, bubbles: true, cancelable: true }));
      target.dispatchEvent(new MouseEvent("click", { view: window, bubbles: true, cancelable: true }));
      if (typeof target.click === "function") target.click();
      if (node instanceof HTMLInputElement && !node.checked) {
        node.checked = true;
        node.dispatchEvent(new Event("input", { bubbles: true }));
        node.dispatchEvent(new Event("change", { bubbles: true }));
      }
    };
    const checkboxSelectors = [
      'input[type="checkbox"]',
      '[role="checkbox"]',
      '[class*="checkbox"]',
      '[class*="Checkbox"]',
      '[class*="checkBox"]',
      '[class*="CBX"]',
    ];
    const checkboxes = Array.from(document.querySelectorAll(checkboxSelectors.join(","))).filter(isVisible);
    let checkbox =
      checkboxes.find((input) => consentPattern.test(checkboxText(input))) ||
      checkboxes.find((input) => input.getBoundingClientRect().width <= 40 && input.getBoundingClientRect().height <= 40) ||
      null;

    if (!checkbox) {
      const textNodes = Array.from(document.querySelectorAll("label,div,span,p")).filter((node) => {
        if (!isVisible(node)) return false;
        const text = normalize(node.innerText || node.textContent);
        return consentPattern.test(text) && text.length < 300;
      });
      const textNode = textNodes[0] || null;
      if (textNode) {
        const rect = textNode.getBoundingClientRect();
        const candidates = Array.from(document.elementsFromPoint(Math.max(1, rect.left - 18), rect.top + rect.height / 2));
        checkbox =
          candidates.find((node) => node.matches?.(checkboxSelectors.join(","))) ||
          candidates.find((node) => node.getBoundingClientRect().width <= 40 && node.getBoundingClientRect().height <= 40) ||
          textNode;
      }
    }

    if (!checkbox) return { found: false, checked: true };
    if (!checkedByStyle(checkbox)) {
      clickNode(checkbox);
    }
    return { found: true, checked: checkedByStyle(checkbox), text: checkboxText(checkbox) };
  });

  if (result.checked) {
    await page.waitForTimeout(500);
    return true;
  }

  for (const pattern of [/我已阅读并同意/, /您授权.*共享/, /授权.*店铺名称/, /账号ID和店铺名称/, /隐私政策/, /账号使用须知/]) {
    const rect = await page
      .getByText(pattern)
      .first()
      .boundingBox({ timeout: 2000 })
      .catch(() => null);
    if (!rect) continue;
    await page.mouse.click(Math.max(1, rect.x - 22), rect.y + rect.height / 2);
    await page.waitForTimeout(500);
    if (await consentAppearsChecked(page)) return true;
  }

  const checkbox = page.locator('input[type="checkbox"]').first();
  if ((await checkbox.count().catch(() => 0)) === 0) return false;
  await checkbox.evaluate((input) => {
    input.checked = true;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForTimeout(500);
  return await checkbox.isChecked().catch(() => false);
}

async function consentAppearsChecked(page) {
  return await page.evaluate(() => {
    const isVisible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const checkedByStyle = (node) => {
      if (node instanceof HTMLInputElement) return Boolean(node.checked);
      const aria = node.getAttribute("aria-checked");
      if (aria) return aria === "true";
      const className = String(node.className || "");
      const text = String(node.innerText || node.textContent || "").trim();
      return /checked|selected|active/i.test(className) || /^✓|✔/.test(text);
    };
    const nodes = Array.from(
      document.querySelectorAll(
        'input[type="checkbox"],[role="checkbox"],[class*="checkbox"],[class*="Checkbox"],[class*="checkBox"],[class*="CBX"]',
      ),
    ).filter(isVisible);
    if (nodes.length === 0) return false;
    return nodes.some(checkedByStyle);
  });
}

async function handleConsentPrompt(page) {
  const text = await bodyText(page, 3000);
  if (!/勾选|阅读并同意|请.*同意|协议|隐私/.test(text)) return false;

  const checked = await ensureConsentChecked(page);
  for (const label of ["同意", "确定", "我知道了"]) {
    const button = page.locator("button").filter({ hasText: label }).last();
    if ((await button.count().catch(() => 0)) === 0) continue;
    if (!(await button.isVisible().catch(() => false))) continue;
    await button.click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(500);
    return true;
  }

  return checked;
}

function needsVerification(text) {
  return /请输入.*验证码|短信验证码|手机验证码|安全验证|验证身份|获取验证码|发送验证码|拖动滑块|verification/i.test(text);
}

async function loginSellerIfNeeded(page) {
  const text = await bodyText(page);
  const hasLoginForm = isSellerLoginFormText(text);
  const hasAuthorizeButton = isSellerAuthorizeText(text);
  debugAbnormal(`loginSellerIfNeeded url=${page.url()} loginForm=${hasLoginForm} authorize=${hasAuthorizeButton}`);
  if (!hasLoginForm && !hasAuthorizeButton) return;

  const needsPassword = await hasVisiblePasswordInput(page);
  const filled = needsPassword ? (await trySavedPasswordAutofill(page)) || (await tryConfiguredCredentials(page)) : true;
  if (!filled) fail("SELLER_LOGIN_PASSWORD_NOT_FILLED", "卖家中心登录页未能自动填充密码，且没有运行时账号密码");

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!(await ensureConsentChecked(page))) {
      fail("SELLER_LOGIN_CONSENT_NOT_CHECKED", "卖家中心登录协议复选框未成功勾选");
    }

    const clicked = await clickSellerLoginButton(page);
    if (!clicked) fail("SELLER_LOGIN_BUTTON_NOT_FOUND", "找不到卖家中心登录/授权登录按钮");
    debugAbnormal(`seller login click attempt=${attempt + 1} clicked=${clicked} url=${page.url()}`);

    await page.waitForTimeout(5000).catch(() => {});
    if (page.isClosed()) return;
    const afterText = await bodyText(page);
    debugAbnormal(
      `seller after click attempt=${attempt + 1} url=${page.url()} loginForm=${isSellerLoginFormText(afterText)} authorize=${isSellerAuthorizeText(afterText)}`,
    );
    if (needsVerification(afterText) && (afterText.includes("登录") || isSellerAuthorizeText(afterText))) {
      fail("SELLER_LOGIN_VERIFICATION_REQUIRED", "卖家中心登录需要短信或验证码");
    }
    if (!isSellerLoginFormText(afterText) && !isSellerAuthorizeText(afterText)) {
      return;
    }
    if (!(await handleConsentPrompt(page))) break;
  }

  fail("SELLER_LOGIN_NOT_SUBMITTED", "卖家中心登录/授权仍停留在登录页，请检查协议勾选或登录提示");
}

function isSellerLoginFormText(text) {
  return text.includes("扫码登录") || text.includes("手机号登录") || text.includes("邮箱登录");
}

function isSellerAuthorizeText(text) {
  return /授权登录|确认授权并前往|授权并前往/.test(text);
}

async function clickSellerLoginButton(page) {
  for (const label of ["确认授权并前往", "授权并前往", "授权登录", "登录"]) {
    const button = page.locator("button").filter({ hasText: label }).first();
    const box = await button.boundingBox({ timeout: 3000 }).catch(() => null);
    if (box) {
      await clickCdpPoint(page, box.x + box.width / 2, box.y + box.height / 2);
      return true;
    }

    if (
      (await button.count().catch(() => 0)) > 0 &&
      (await button.click({ timeout: 3000 }).then(() => true).catch(() => false))
    ) {
      return true;
    }
  }

  await page.keyboard.press("Enter").catch(() => {});
  await page.waitForTimeout(500);
  const text = await bodyText(page, 3000);
  if (!isSellerLoginFormText(text) && !isSellerAuthorizeText(text)) return true;

  return (
    (await clickTextByRect(page, "确认授权并前往", (rects) => rects.sort((a, b) => b.y - a.y)[0] || null)) ||
    (await clickTextByRect(page, "授权并前往", (rects) => rects.sort((a, b) => b.y - a.y)[0] || null)) ||
    (await clickTextByRect(page, "授权登录", (rects) => rects.sort((a, b) => b.y - a.y)[0] || null)) ||
    (await clickTextByRect(page, "登录", (rects) => rects.sort((a, b) => b.y - a.y)[0] || null))
  );
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
          const style = window.getComputedStyle(node);
          return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        })
        .map((node) => {
          const rect = node.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        });
      return pick(rects);
    },
    { text, pickRectSource: pickRect.toString() },
  );

  if (!rect) return false;
  await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
  return true;
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
  await page.waitForTimeout(6000);

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

    await loginSellerIfNeeded(activePage);
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

async function enterAgentAuthenticationIfShown(context, page) {
  if (!page.url().startsWith("https://agentseller.temu.com/auth/authentication")) return false;

  const clickPoint = await agentChinaSellerCenterPoint(page);
  if (!clickPoint) return false;
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

    const exactButtons = Array.from(document.querySelectorAll("button, a, div, span"))
      .filter((node) => {
        if (!isVisible(node)) return false;
        const text = clean(node.innerText || node.textContent);
        if (text !== "商家中心") return false;
        const rect = node.getBoundingClientRect();
        if (rect.width > 180 || rect.height > 80) return false;
        const className = String(node.className || "");
        if (/disabled/i.test(className)) return false;
        const style = window.getComputedStyle(node);
        const rowText = clean(node.closest("div")?.parentElement?.innerText || node.parentElement?.innerText || "");
        return rowText.includes("中国地区") && !rowText.includes("其他地区") && style.color !== "rgb(191, 191, 191)";
      })
      .map((node) => ({ rect: node.getBoundingClientRect(), color: window.getComputedStyle(node).color }))
      .sort((a, b) => {
        const aBlue = /rgb\(.*(64|66|69|73|76|80|87|90).*,.*(120|126|130|140|145|150).*,.*(230|240|245|255).*\)/.test(a.color);
        const bBlue = /rgb\(.*(64|66|69|73|76|80|87|90).*,.*(120|126|130|140|145|150).*,.*(230|240|245|255).*\)/.test(b.color);
        return Number(bBlue) - Number(aBlue) || b.rect.left - a.rect.left || a.rect.width * a.rect.height - b.rect.width * b.rect.height;
      });
    if (exactButtons[0]) return center(exactButtons[0].rect);

    const regionRows = Array.from(document.querySelectorAll("div, button, a"))
      .filter((node) => {
        const text = clean(node.innerText || node.textContent);
        const className = String(node.className || "");
        return isVisible(node) && text.includes("中国地区") && text.includes("商家中心") && !text.includes("其他地区") && !text.includes("敬请期待") && !className.includes("disabled");
      })
      .map((node) => ({ node, rect: node.getBoundingClientRect(), text: clean(node.innerText || node.textContent) }))
      .filter(({ rect }) => rect.width > 0 && rect.height > 0)
      .sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height);

    const row = regionRows[0];
    if (!row) return null;

    const clickable = Array.from(row.node.querySelectorAll("div, button, a, span"))
      .filter((node) => {
        if (!isVisible(node)) return false;
        const text = clean(node.innerText || node.textContent);
        if (text !== "商家中心") return false;
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.left > row.rect.left + row.rect.width * 0.45 && style.cursor === "pointer";
      })
      .map((node) => ({ node, rect: node.getBoundingClientRect() }))
      .sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height)[0];

    if (clickable) return center(clickable.rect);
    return { x: row.rect.left + row.rect.width * 0.72, y: row.rect.top + row.rect.height / 2 };
  });
}

function isNoPermissionPage(text) {
  return /暂无权限|无权限|没有权限|无权访问|该区暂无权限|未开通/.test(text);
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
  });
  const { browser, context, page } = await connectCdpChrome(account, targetUrl);
  networkCapture.attach(context);
  try {
    let activePage = await ensureTargetPage(context, page);
    const shopReports = [];
    for (const shopName of shops) {
      networkCapture.mark("abnormal:shop-start", {
        accountId: account.id,
        accountLabel: account.label || account.id,
        shopName,
      });
      activePage = await switchShop(context, activePage, shopName, knownShops);
      const report = await extractAbnormalReport(activePage, shopName, knownShops);
      networkCapture.mark("abnormal:extracted", {
        accountId: account.id,
        accountLabel: account.label || account.id,
        shopName,
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
    await browser.close().catch(() => {});
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
