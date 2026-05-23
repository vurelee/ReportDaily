import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./temu-config.mjs";
import { connectCdpChrome } from "./chrome-cdp.mjs";

const now = new Date();
const stamp = now.toISOString().replace(/[:.]/g, "-");
await fs.mkdir(config.reportDir, { recursive: true });

const jsonPath = path.join(config.reportDir, `${config.reportPrefix}-${stamp}.json`);

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
  const cleaned = String(value || "").replace(/[￥,\s]/g, "");
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

async function waitSettled(page) {
  await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(500);
  await dismissBlockingModals(page);
}

async function dismissBlockingModals(page) {
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
  const checkedBefore = await page.locator('input[type="checkbox"]').first().isChecked().catch(() => false);
  if (!checkedBefore) {
    const consentRect = await page
      .getByText(/您授权跨境卖家中心/)
      .first()
      .boundingBox({ timeout: 5000 })
      .catch(() => null);

    if (consentRect) {
      await page.mouse.click(consentRect.x + 8, consentRect.y + 8);
      await page.waitForTimeout(500);
    }

    const checkbox = page.locator('input[type="checkbox"]').first();
    const checkedAfterClick = await checkbox.isChecked().catch(() => false);
    if (!checkedAfterClick && (await checkbox.count().catch(() => 0)) > 0) {
      await checkbox.evaluate((input) => {
        input.click();
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await page.waitForTimeout(500);
    }
  }

  const checked = await page.locator('input[type="checkbox"]').first().isChecked().catch(() => true);
  if (!checked) {
    const consentRect = await page
      .locator("label")
      .filter({ hasText: /您授权跨境卖家中心/ })
      .first()
      .boundingBox({ timeout: 3000 })
      .catch(() => null);

    if (consentRect) {
      await page.mouse.click(consentRect.x + 10, consentRect.y + 10);
      await page.waitForTimeout(500);
    }
  }

  const checkedAfter = await page.locator('input[type="checkbox"]').first().isChecked().catch(() => true);
  if (!checkedAfter) fail("AUTO_LOGIN_CONSENT_NOT_CHECKED", "授权复选框未成功勾选");

  const authButton = page.locator("button").filter({ hasText: "授权登录" }).last();
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
  return "";
}

async function currentShopName(page) {
  for (const shopName of knownShopNames) {
    if (await visibleShopLabel(page, shopName)) return shopName;
  }

  return "";
}

async function isShopSwitcherPage(page) {
  const text = await bodyText(page);
  const visibleShopChecks = await Promise.all(
    knownShopNames.map(async (name) => (await page.getByText(name, { exact: true }).count().catch(() => 0)) > 0),
  );
  const visibleShopCount = visibleShopChecks.filter(Boolean).length;
  return (text.includes("切换店铺") || visibleShopCount >= 2) && text.includes("半托管") && text.includes("切换");
}

async function openShopSwitcher(page) {
  if (await isShopSwitcherPage(page)) return;

  await dismissBlockingModals(page);

  const current = await currentShopName(page);
  if (!current) {
    fail("SHOP_CURRENT_UNKNOWN", "无法识别当前店铺；请把当前店铺全名加入 TEMU_KNOWN_SHOPS");
  }

  const currentLabel = await visibleShopLabel(page, current);
  await page.getByText(currentLabel || current, { exact: true }).first().click({ timeout: 8000 });
  await page.waitForTimeout(500);
  await page.getByText("切换", { exact: true }).click({ timeout: 8000 });
  await page.waitForTimeout(800);
}

async function clickShopSwitchButton(page, shopName) {
  const clickPoint = await page.evaluate((shopName) => {
    const normalizedText = (node) => (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
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

    const labels = Array.from(document.querySelectorAll("*"))
      .filter((node) => {
        if (!isVisible(node)) return false;
        return normalizedText(node) === shopName;
      })
      .map((node) => node.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .sort((a, b) => a.width * a.height - b.width * b.height);

    for (const labelRect of labels) {
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
  await page.mouse.click(clickPoint.x, clickPoint.y);
  return true;
}

async function switchShop(page, shopName) {
  const onSwitcher = await isShopSwitcherPage(page);
  const current = await currentShopName(page);
  if (!onSwitcher && current === shopName) return;

  await openShopSwitcher(page);

  if (!(await clickShopSwitchButton(page, shopName))) {
    fail("SHOP_TARGET_NOT_FOUND", `店铺切换列表中找不到精确店名：${shopName}`);
  }

  await waitSettled(page);
  await page.goto(config.temuHomeUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
  await waitSettled(page);
  await waitForText(page, shopName, 15000).catch(() => {});

  const after = await currentShopName(page);
  if (after !== shopName) {
    fail("SHOP_SWITCH_VERIFY_FAILED", `切换后店铺不匹配；目标=${shopName}，当前=${after || "unknown"}`);
  }
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

async function openProductDataForDate(page) {
  await page.goto(config.temuReportUrl, { waitUntil: "domcontentloaded" });
  await waitSettled(page);
  await assertLoggedIn(page);
  await ensureRegion(page);

  const productReportTab = page.getByText("商品数据报表", { exact: true });
  if ((await productReportTab.count().catch(() => 0)) === 0) {
    fail("PRODUCT_REPORT_TAB_NOT_FOUND", "找不到商品数据报表标签页");
  }
  await productReportTab.click({ timeout: 10000 });
  await waitSettled(page);

  let filterClicked = false;
  let filterActive = false;
  for (let attempt = 0; attempt < 3 && !filterActive; attempt += 1) {
    filterClicked = (await clickVisibleExactLabel(page, config.reportDateLabel)) || filterClicked;
    if (filterClicked) {
      await waitSettled(page);
      filterActive = await isVisibleExactLabelActive(page, config.reportDateLabel, "RD_active");
    }
  }
  if (!filterClicked) {
    fail("DATE_FILTER_NOT_FOUND", `找不到${config.reportDateLabel}筛选按钮`);
  }
  if (!filterActive) {
    fail("DATE_FILTER_NOT_ACTIVE", `${config.reportDateLabel}筛选未处于选中状态`);
  }
  await waitForTextPattern(page, /件数（全店）|申报价销售额（全店）|净申报价销售额（全店）/, 15000).catch(() =>
    fail("REPORT_TABLE_NOT_READY", "商品数据表格未加载完成"),
  );
}

async function extractRows(page) {
  const headers = await page.locator("th").evaluateAll((cells) =>
    cells.map((cell) => (cell.innerText || cell.textContent || "").replace(/\s+/g, " ").trim()),
  );
  if (!headers.includes("件数（全店）")) {
    fail("REPORT_HEADER_MISSING", "商品数据表缺少 件数（全店） 列");
  }

  const rawRows = await page.locator("table").nth(1).locator("tr").evaluateAll((rows) =>
    rows.map((row) =>
      Array.from(row.querySelectorAll("td,th")).map((cell) =>
        (cell.innerText || cell.textContent || "").replace(/\s+/g, " ").trim(),
      ),
    ),
  );

  const indexOf = (name) => headers.findIndex((header) => header === name);
  const indexes = {
    product: 0,
    status: indexOf("状态"),
    totalCost: indexOf("总花费"),
    sales: indexOf("申报价销售额（全店）"),
    netSales: indexOf("净申报价销售额（全店）"),
    quantity: indexOf("件数（全店）"),
    netQuantity: indexOf("净件数（全店）"),
    clicks: indexOf("点击量（全店）"),
    cvr: indexOf("转化率(CVR)（全店）"),
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
      clicks: cellAt(cells, indexes.clicks),
      cvr: cellAt(cells, indexes.cvr),
      salesValue: moneyToNumber(cellAt(cells, indexes.netSales) || cellAt(cells, indexes.sales)),
    }));
}

async function sortBySalesDesc(page) {
  const sortCandidates = [config.sortMetric, "净申报价销售额（全店）", "申报价销售额（全店）"];
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

function buildSummary(rows, updateTime) {
  const total = rows.find((row) => row.productText.startsWith("共"));
  const products = rows
    .filter((row) => !row.productText.startsWith("共"))
    .sort((a, b) => b.salesValue - a.salesValue);
  const top = products.slice(0, 5);

  if (!total) {
    fail("REPORT_TOTAL_ROW_MISSING", "未读取到全店汇总行");
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

function buildMessage(reports) {
  const updateTimes = [...new Set(reports.map((report) => report.updateTime).filter(Boolean))];
  const sortMetrics = [...new Set(reports.map((report) => report.sortMetricUsed).filter(Boolean))];
  const title = config.accountLabel
    ? `Temu 欧区${config.reportDateLabel}商品数据（${config.accountLabel}）`
    : `Temu 欧区${config.reportDateLabel}商品数据`;
  return [
    title,
    updateTimes.length ? `更新时间：${updateTimes.join(" / ")}` : null,
    sortMetrics.length ? `排序：${sortMetrics.join(" / ")} 从高到低` : null,
    "",
    reports.map(formatShopSummary).join("\n\n"),
  ]
    .filter((line) => line !== null)
    .join("\n");
}

const { browser, context, page } = await connectCdpChrome(config.temuHomeUrl);

try {
  const startPage = preferredWorkPage(context, page);
  await closeStaleAuthPages(context, startPage);
  await startPage.goto(config.temuHomeUrl, { waitUntil: "domcontentloaded" });
  await waitSettled(startPage);
  const activePage = await ensureLoggedIn(context, startPage);
  await closeStaleAuthPages(context, activePage);
  const reports = [];

  for (const shopName of config.shopNames) {
    await switchShop(activePage, shopName);
    await openProductDataForDate(activePage);

    const { rows, sortMetricUsed } = await sortBySalesDesc(activePage);
    const pageText = await bodyText(activePage);
    const updateTime = pageText.match(/数据更新时间:\s*([0-9:\-\s]+)/)?.[1]?.trim() || "";
    const summary = buildSummary(rows, updateTime);
    reports.push({ shopName, rows, sortMetricUsed, ...summary });
  }

  const message = buildMessage(reports);

  await fs.writeFile(
    jsonPath,
    JSON.stringify(
      {
        generatedAt: now.toISOString(),
        accountLabel: config.accountLabel,
        region: config.targetRegion,
        date: config.reportDate,
        dateLabel: config.reportDateLabel,
        sortMetric: config.sortMetric,
        message,
        shops: reports,
      },
      null,
      2,
    ),
  );

  console.log(message);
  console.log(`Saved JSON: ${jsonPath}`);
} catch (error) {
  const message = [
    "Temu 巡检失败",
    `时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`,
    `错误：${error instanceof Error ? error.message : String(error)}`,
  ].join("\n");

  const page = context.pages()[0];
  if (page) await page.title().catch(() => "");
  console.error(message);

  throw error;
} finally {
  await browser.close().catch(() => {});
}
