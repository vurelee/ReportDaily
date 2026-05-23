import fs from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { closeCdpPages } from "./cdp-page-cleanup.mjs";
import { closeTemuPopups } from "./temu-popup-cleaner.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const accountsPath = process.env.TEMU_ACCOUNTS_CONFIG || path.join(rootDir, "temu-accounts.json");
const reportDir = process.env.TEMU_REPORT_DIR || path.join(rootDir, "temu-reports");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const targetUrl =
  process.env.TEMU_ABNORMAL_ORDER_URL || "https://agentseller.temu.com/lgst/auth-warehouse/abnormal-order";

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
  if (usePopupCleaner) await closeTemuPopups(page);
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
    const checkboxText = (input) => {
      const label = input.closest("label");
      const row = input.closest("div");
      return normalize([label?.innerText, row?.innerText, input.parentElement?.innerText].filter(Boolean).join(" "));
    };
    const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
    const checkbox =
      checkboxes.find((input) => /已阅读|同意|隐私|协议|授权|须知/.test(checkboxText(input))) ||
      checkboxes[0] ||
      null;

    if (!checkbox) return { found: false, checked: true };
    if (!checkbox.checked) {
      const clickable = checkbox.closest("label") || checkbox.parentElement;
      if (clickable && isVisible(clickable)) {
        clickable.click();
      }
      checkbox.dispatchEvent(new Event("input", { bubbles: true }));
      checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return { found: true, checked: Boolean(checkbox.checked), text: checkboxText(checkbox) };
  });

  if (result.checked) {
    await page.waitForTimeout(500);
    return true;
  }

  for (const pattern of [/我已阅读并同意/, /您授权.*共享/, /隐私政策/, /账号使用须知/]) {
    const rect = await page
      .getByText(pattern)
      .first()
      .boundingBox({ timeout: 2000 })
      .catch(() => null);
    if (!rect) continue;
    await page.mouse.click(Math.max(1, rect.x - 10), rect.y + rect.height / 2);
    await page.waitForTimeout(500);
    if (await page.locator('input[type="checkbox"]').first().isChecked().catch(() => true)) return true;
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
  const hasLoginForm = text.includes("扫码登录") || text.includes("手机号登录") || text.includes("邮箱登录");
  const hasAuthorizeButton = text.includes("授权登录");
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

    await page.waitForTimeout(5000);
    const afterText = await bodyText(page);
    if (needsVerification(afterText) && (afterText.includes("登录") || afterText.includes("授权登录"))) {
      fail("SELLER_LOGIN_VERIFICATION_REQUIRED", "卖家中心登录需要短信或验证码");
    }
    if (
      !afterText.includes("扫码登录") &&
      !afterText.includes("手机号登录") &&
      !afterText.includes("邮箱登录") &&
      !afterText.includes("授权登录")
    ) {
      return;
    }
    if (!(await handleConsentPrompt(page))) break;
  }

  fail("SELLER_LOGIN_NOT_SUBMITTED", "卖家中心登录/授权仍停留在登录页，请检查协议勾选或登录提示");
}

async function clickSellerLoginButton(page) {
  for (const label of ["授权登录", "登录"]) {
    const button = page.locator("button").filter({ hasText: label }).first();
    const box = await button.boundingBox({ timeout: 3000 }).catch(() => null);
    if (box) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
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
  if (!text.includes("扫码登录") && !text.includes("授权登录")) return true;

  return (
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
  await activePage.goto(targetUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
  await waitSettled(activePage);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    let text = await bodyText(activePage);
    if (isTargetPage(text) || isAgentSellerShell(activePage, text)) return activePage;

    const authenticatedPage = await enterAgentAuthenticationIfShown(context, activePage);
    if (authenticatedPage) {
      activePage = authenticatedPage;
      await activePage.bringToFront().catch(() => {});
      await waitSettled(activePage);
      continue;
    }

    await loginSellerIfNeeded(activePage);
    await waitSettled(activePage);

    text = await bodyText(activePage);
    if (isTargetPage(text) || isAgentSellerShell(activePage, text)) return activePage;
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
      if (isTargetPage(text) || isAgentSellerShell(activePage, text)) return activePage;
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

  fail("ABNORMAL_PAGE_NOT_READY", "直接访问异常页并完成登录/授权后，仍未进入 Agent Center 异常页");
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

  const clickPoint = await page.evaluate(() => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const isVisible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const center = (rect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
    const regionItems = Array.from(document.querySelectorAll("div, button, a"))
      .filter((node) => {
        const text = clean(node.innerText || node.textContent);
        const className = String(node.className || "");
        return isVisible(node) && text.includes("商家中心") && !text.includes("敬请期待") && !className.includes("disabled");
      })
      .map((node) => ({ node, rect: node.getBoundingClientRect(), text: clean(node.innerText || node.textContent) }))
      .filter(({ rect }) => rect.width > 0 && rect.height > 0)
      .sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height);

    const target =
      regionItems.find(({ text }) => text === "商家中心") ||
      regionItems.find(({ text }) => text.includes("中国地区") && text.includes("商家中心")) ||
      regionItems[0];
    return target ? center(target.rect) : null;
  });

  if (!clickPoint) return false;
  const beforePages = new Set(context.pages());
  await page.mouse.click(clickPoint.x, clickPoint.y);
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

function isNoPermissionPage(text) {
  return /暂无权限|无权限|没有权限|无权访问|该区暂无权限|未开通/.test(text);
}

async function currentShopName(page, knownShops) {
  const names = await page.evaluate((knownShops) => {
    const visibleText = (node) => (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
    const shopLabelText = (text) => String(text || "").replace(/\s+/g, " ").trim().replace(/\s*(半托管|全托管)\s*$/, "");
    const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const isVisible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };

    const body = visibleText(document.body);
    const currentShop = knownShops.find((shopName) =>
      new RegExp(`当前店铺\\s*${escapeRegExp(shopName)}(?:\\s|半托管|全托管|切换|$)`).test(body),
    );
    if (currentShop) return [currentShop];

    const exactMatches = knownShops.filter((shopName) =>
      Array.from(document.querySelectorAll("*")).some((node) => isVisible(node) && visibleText(node) === shopName),
    );
    if (exactMatches.length > 0) return exactMatches;

    return knownShops.filter((shopName) =>
      Array.from(document.querySelectorAll("*")).some((node) => isVisible(node) && shopLabelText(visibleText(node)) === shopName),
    );
  }, knownShops);
  return names[0] || "";
}

async function isShopSwitcherOpen(page, knownShops) {
  const text = await bodyText(page);
  const visibleCount = (
    await Promise.all(knownShops.map(async (name) => (await page.getByText(name, { exact: true }).count().catch(() => 0)) > 0))
  ).filter(Boolean).length;
  return text.includes("切换店铺") || (visibleCount >= 2 && text.includes("半托管") && text.includes("切换"));
}

async function openShopSwitcher(page, knownShops) {
  if (await isShopSwitcherOpen(page, knownShops)) return;
  await closeTemuPopups(page);
  const current = await currentShopName(page, knownShops);
  if (!current) fail("SHOP_CURRENT_UNKNOWN", "无法识别当前店铺");

  await page.getByText(current, { exact: true }).first().click({ timeout: 8000 });
  await page.waitForTimeout(500);
  await page.getByText("切换", { exact: true }).click({ timeout: 8000 });
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

    const labels = Array.from(document.querySelectorAll("*"))
      .filter((node) => isVisible(node) && shopLabelText(node) === shopName)
      .map((node) => node.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .sort((a, b) => a.width * a.height - b.width * b.height);

    for (const labelRect of labels) {
      const labelCenter = center(labelRect);
      const button = switchButtonCandidates()
        .filter(({ rect }) => Math.abs(center(rect).y - labelCenter.y) <= Math.max(56, labelRect.height * 1.5) && rect.left > labelRect.right)
        .sort((a, b) => a.rect.left - b.rect.left)[0];
      if (button) return center(button.rect);
    }
    return null;
  }, shopName);

  if (!clickPoint) return false;
  await page.mouse.click(clickPoint.x, clickPoint.y);
  return true;
}

async function switchShop(page, shopName, knownShops) {
  const current = await currentShopName(page, knownShops);
  if (current !== shopName) {
    await openShopSwitcher(page, knownShops);
    if (!(await clickShopSwitchButton(page, shopName))) {
      fail("SHOP_TARGET_NOT_FOUND", `店铺切换列表中找不到精确店名：${shopName}`);
    }

    await waitSettled(page);
  }

  await page.goto(targetUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
  await waitSettled(page);

  const after = await currentShopName(page, knownShops);
  if (after !== shopName) {
    fail("SHOP_SWITCH_VERIFY_FAILED", `切换后店铺不匹配；目标=${shopName}，当前=${after || "unknown"}`);
  }
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

  const { browser, context, page } = await connectCdpChrome(account, targetUrl);
  try {
    const activePage = await ensureTargetPage(context, page);
    const shopReports = [];
    for (const shopName of shops) {
      await switchShop(activePage, shopName, knownShops);
      shopReports.push(await extractAbnormalReport(activePage, shopName, knownShops));
    }
    return { account, ok: true, shops: shopReports };
  } catch (error) {
    return {
      account,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await closeCdpPages(context);
    await browser.close().catch(() => {});
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

if (results.some((result) => !result.ok)) {
  process.exitCode = 1;
}
