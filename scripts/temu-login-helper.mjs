import {
  consentAppearsChecked,
  ensureConsentChecked,
} from "./temu-consent-helper.mjs";

export { consentAppearsChecked, ensureConsentChecked };

const SELLER_HOST = "seller.kuajingmaihuo.com";
const AGENT_SELLER_HOST_RE = /^agentseller(?:-[a-z]+)?\.temu\.com$/;
const SELLER_AUTH_LABELS = ["确认授权并前往", "授权并前往", "授权登录", "同意并登录", "登录"];

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultFail(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  throw error;
}

function failWith(options, key, code, message) {
  const fail = options.fail || defaultFail;
  fail(options.errorCodes?.[key] || code, options.messages?.[key] || message);
}

function parsedUrl(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

export function isSellerCenterUrl(url) {
  return parsedUrl(url)?.hostname === SELLER_HOST;
}

export function isAgentSellerUrl(url) {
  const host = parsedUrl(url)?.hostname || "";
  return AGENT_SELLER_HOST_RE.test(host);
}

export function isAgentAuthenticationUrl(url) {
  const parsed = parsedUrl(url);
  return Boolean(parsed && AGENT_SELLER_HOST_RE.test(parsed.hostname) && parsed.pathname.startsWith("/auth/authentication"));
}

export function isSellerLoginUrl(url) {
  const parsed = parsedUrl(url);
  if (!parsed || parsed.hostname !== SELLER_HOST) return false;
  return (
    parsed.pathname.includes("/login") ||
    parsed.pathname.includes("/settle/seller-login") ||
    parsed.pathname.includes("/settle/activity-login")
  );
}

function isSellerAuthorizeUrl(url) {
  const parsed = parsedUrl(url);
  return Boolean(parsed && parsed.hostname === SELLER_HOST && parsed.pathname.includes("/settle/seller-login"));
}

export function needsVerification(text) {
  return /请输入.*验证码|短信验证码|手机验证码|安全验证|验证身份|获取验证码|发送验证码|拖动滑块|滑块验证|verification/i.test(
    text,
  );
}

export function isSellerLoginFormText(text) {
  return text.includes("扫码登录") || text.includes("手机号登录") || text.includes("邮箱登录");
}

export function isSellerAuthorizeText(text) {
  return /授权登录|确认授权并前往|授权并前往|同意并登录/.test(text);
}

export function isSellerSubmittingText(text) {
  return /登录中|授权中|提交中|正在登录|正在授权/.test(text);
}

export function isSellerKeyFailureText(text) {
  return /获取公钥失败|公钥.*失败|请刷新页面/.test(text);
}

export async function bodyText(page, timeout = 10000) {
  return await page.locator("body").innerText({ timeout }).catch(() => "");
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
    (nodes, indexes) => Object.fromEntries(indexes.map((index) => [index, nodes[index]?.value || ""])),
    indexes,
  );
}

export async function hasVisiblePasswordInput(page) {
  if (!page || page.isClosed()) return false;
  return (await visibleInputMeta(page)).some((input) => input.visible && input.type === "password");
}

export async function trySavedPasswordAutofill(page, options = {}) {
  let rememberedPhone = "";
  const tabs = options.tabs || ["", "手机号登录", "邮箱登录", "手机号登录"];

  for (const tab of tabs) {
    if (!page || page.isClosed()) return true;

    if (tab) {
      await page.getByText(tab, { exact: true }).click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(800).catch(() => {});
      await ensureConsentChecked(page).catch(() => {});
      if (page.isClosed()) return true;
    }

    await ensureConsentChecked(page).catch(() => {});

    const inputs = await visibleInputMeta(page).catch(() => []);
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
      if (options.isResolved && (await options.isResolved(page).catch(() => false))) return true;
    }

    const values = await valuesByInputIndex(page, [usernameIndex, passwordIndex]).catch(() => ({}));
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
      await username.fill(rememberedPhone, { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(300).catch(() => {});
      return true;
    }

    if (usernameValue.length > 0 && passwordValue.length > 0) return true;
  }

  return false;
}

export async function tryConfiguredCredentials(page) {
  if (!page || page.isClosed()) return false;
  const account =
    process.env.TEMU_LOGIN_ACCOUNT ||
    process.env.TEMU_LOGIN_PHONE ||
    process.env.TEMU_LOGIN_EMAIL ||
    "";
  const password = process.env.TEMU_LOGIN_PASSWORD || "";
  if (!account || !password) return false;

  await page.getByText(account.includes("@") ? "邮箱登录" : "手机号登录", { exact: true }).click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(800).catch(() => {});
  await ensureConsentChecked(page).catch(() => {});

  const inputs = await visibleInputMeta(page).catch(() => []);
  const { usernameIndex, passwordIndex } = findLoginInputIndexes(inputs);
  if (usernameIndex < 0 || passwordIndex < 0) return false;

  await page.locator("input").nth(usernameIndex).fill(account, { timeout: 5000 });
  await page.locator("input").nth(passwordIndex).fill(password, { timeout: 5000 });
  return true;
}

export async function clickCdpPoint(page, x, y) {
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

export async function sellerAuthorizeButtonPoint(page) {
  return await page.evaluate((labels) => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const isVisible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const isDisabled = (node) => {
      const className = String(node.className || "");
      const style = window.getComputedStyle(node);
      return (
        node.matches(":disabled") ||
        node.hasAttribute("disabled") ||
        node.getAttribute("aria-disabled") === "true" ||
        /disabled|not-allowed/i.test(className) ||
        style.cursor === "not-allowed" ||
        style.pointerEvents === "none"
      );
    };
    const labelSet = new Set(labels);
    return Array.from(document.querySelectorAll('button, a, div[role="button"], span, div'))
      .filter((node) => isVisible(node) && !isDisabled(node) && labelSet.has(clean(node.innerText || node.textContent)))
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return {
          tag: node.tagName,
          x: rect.x + rect.width / 2,
          y: rect.y + rect.height / 2,
          area: rect.width * rect.height,
        };
      })
      .sort((a, b) => (a.tag === "BUTTON" ? 0 : 1) - (b.tag === "BUTTON" ? 0 : 1) || a.area - b.area)[0] || null;
  }, SELLER_AUTH_LABELS);
}

export async function clickSellerLoginButton(page) {
  const point = await sellerAuthorizeButtonPoint(page);
  if (point) {
    await clickCdpPoint(page, point.x, point.y);
    return true;
  }

  const beforeText = await bodyText(page, 3000);
  if (isSellerSubmittingText(beforeText)) return true;

  await page.keyboard.press("Enter").catch(() => {});
  await page.waitForTimeout(500).catch(() => {});
  const text = await bodyText(page, 3000);
  if (!isSellerLoginFormText(text) && !isSellerAuthorizeText(text)) return true;

  for (const label of ["确认授权并前往", "授权并前往", "授权登录", "同意并登录", "登录"]) {
    if (await clickTextByRect(page, label, (rects) => rects.sort((a, b) => b.y - a.y)[0] || null)) return true;
  }

  return false;
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
    await page.waitForTimeout(500).catch(() => {});
    return true;
  }

  return checked;
}

export async function waitForMatchingPage(context, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matched = [...context.pages()].reverse().find((candidate) => !candidate.isClosed() && predicate(candidate));
    if (matched) return matched;
    await wait(500);
  }
  return null;
}

export function livePageFromContext(context, fallbackPage, options = {}) {
  const pages = [...context.pages()].reverse().filter((candidate) => !candidate.isClosed());
  const preferred = options.preferLivePage?.(pages) || null;
  if (preferred) return preferred;
  if (fallbackPage && !fallbackPage.isClosed() && (isSellerLoginUrl(fallbackPage.url()) || isAgentAuthenticationUrl(fallbackPage.url()))) {
    const transitioned = pages.find(
      (candidate) =>
        candidate !== fallbackPage &&
        ((isSellerCenterUrl(candidate.url()) && !isSellerLoginUrl(candidate.url())) ||
          (isAgentSellerUrl(candidate.url()) && !isAgentAuthenticationUrl(candidate.url()))),
    );
    if (transitioned) return transitioned;
  }
  if (fallbackPage && !fallbackPage.isClosed()) return fallbackPage;
  return pages[0] || null;
}

async function sellerLoginState(page) {
  if (!page || page.isClosed()) return { type: "transition_closed", text: "" };

  const text = await bodyText(page, 3000);
  if (needsVerification(text)) return { type: "verification_required", text };

  const hasPassword = await hasVisiblePasswordInput(page).catch(() => false);
  const url = page.url();
  const hasLoginText = isSellerLoginFormText(text);
  const hasAuthorizeText = isSellerAuthorizeText(text);
  const hasAuthorizeButton = !hasPassword && Boolean(await sellerAuthorizeButtonPoint(page).catch(() => null));
  const isLoginUrl = isSellerLoginUrl(url);

  if (isLoginUrl && isSellerKeyFailureText(text)) {
    return { type: "seller_reload_required", text };
  }
  if ((isLoginUrl || hasLoginText || hasAuthorizeText) && isSellerSubmittingText(text)) {
    return { type: "seller_submitting", text };
  }
  if ((isSellerAuthorizeUrl(url) || isSellerCenterUrl(url)) && !hasPassword && (hasAuthorizeText || hasAuthorizeButton)) {
    return { type: "seller_authorize", text };
  }
  if ((isLoginUrl || hasLoginText) && (hasPassword || hasLoginText)) {
    return { type: "seller_identity_login", text };
  }
  if (isLoginUrl) return { type: "seller_pending", text };
  return { type: "ready", text };
}

export async function waitForSellerLoginResolved(context, page, options = {}) {
  const timeoutMs = options.timeoutMs ?? 8000;
  const deadline = Date.now() + timeoutMs;
  let activePage = page;

  while (Date.now() < deadline) {
    activePage = livePageFromContext(context, activePage, options);
    if (!activePage) return null;
    await activePage.waitForLoadState("domcontentloaded", { timeout: 1000 }).catch(() => {});

    const state = await sellerLoginState(activePage);
    if (state.type === "verification_required") {
      failWith(options, "verificationRequired", "SELLER_LOGIN_VERIFICATION_REQUIRED", "卖家中心登录需要短信或验证码");
    }
    if (state.type === "ready") return activePage;
    await activePage.waitForTimeout(500).catch(() => {});
  }

  return null;
}

export async function loginSellerIfNeeded(context, page, options = {}) {
  let activePage = livePageFromContext(context, page, options);
  if (!activePage) return null;

  const maxAttempts = options.maxAttempts ?? 2;
  const maxPendingWaitMs = options.maxPendingWaitMs ?? 12000;
  const maxSubmittingWaitMs = options.maxSubmittingWaitMs ?? 12000;
  const maxSubmittingReloads = options.maxSubmittingReloads ?? 1;
  let pendingStartedAt = null;
  let submittingStartedAt = null;
  let submittingReloads = 0;
  let attempt = 0;

  while (attempt < maxAttempts) {
    activePage = livePageFromContext(context, activePage, options);
    if (!activePage) return null;

    const state = await sellerLoginState(activePage);
    options.debug?.(`loginSellerIfNeeded state=${state.type} url=${activePage.url()}`);

    if (state.type === "ready") return activePage;
    if (state.type === "transition_closed") {
      await wait(300);
      continue;
    }
    if (state.type === "seller_reload_required") {
      if (submittingReloads >= maxSubmittingReloads) {
        failWith(options, "notSubmitted", "SELLER_LOGIN_NOT_SUBMITTED", "卖家中心登录获取公钥失败，刷新后仍未恢复");
      }
      options.debug?.(`loginSellerIfNeeded reload url=${activePage.url()} reason=key_failure`);
      submittingReloads += 1;
      pendingStartedAt = null;
      submittingStartedAt = null;
      await activePage.reload({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
      await activePage.waitForTimeout(1200).catch(() => {});
      continue;
    }
    if (state.type === "seller_pending") {
      pendingStartedAt ||= Date.now();
      if (Date.now() - pendingStartedAt > maxPendingWaitMs) {
        failWith(
          options,
          "notSubmitted",
          "SELLER_LOGIN_NOT_SUBMITTED",
          "卖家中心登录页加载未完成",
        );
      }
      await activePage.waitForTimeout(500).catch(() => {});
      continue;
    }
    if (state.type === "seller_submitting") {
      submittingStartedAt ||= Date.now();
      if (Date.now() - submittingStartedAt > maxSubmittingWaitMs) {
        if (submittingReloads < maxSubmittingReloads && isSellerLoginUrl(activePage.url())) {
          options.debug?.(`loginSellerIfNeeded reload url=${activePage.url()} reason=submitting_timeout`);
          submittingReloads += 1;
          pendingStartedAt = null;
          submittingStartedAt = null;
          await activePage.reload({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
          await activePage.waitForTimeout(1200).catch(() => {});
          continue;
        }
        failWith(options, "notSubmitted", "SELLER_LOGIN_NOT_SUBMITTED", "卖家中心登录提交未完成");
      }
      await activePage.waitForTimeout(500).catch(() => {});
      continue;
    }
    pendingStartedAt = null;
    submittingStartedAt = null;
    if (state.type === "verification_required") {
      failWith(options, "verificationRequired", "SELLER_LOGIN_VERIFICATION_REQUIRED", "卖家中心登录需要短信或验证码");
    }

    if (state.type === "seller_identity_login") {
      const filled =
        (await trySavedPasswordAutofill(activePage, {
          isResolved: async () =>
            Boolean(
              await waitForSellerLoginResolved(context, activePage, {
                ...options,
                timeoutMs: 1500,
              }),
            ),
        })) || (await tryConfiguredCredentials(activePage));

      const resolvedPage = await waitForSellerLoginResolved(context, activePage, {
        ...options,
        timeoutMs: filled ? 2500 : 5000,
      });
      if (resolvedPage) return resolvedPage;

      activePage = livePageFromContext(context, activePage, options);
      if (!activePage) return null;
      const afterFillState = await sellerLoginState(activePage);
      if (afterFillState.type === "ready") return activePage;
      if (afterFillState.type === "transition_closed") continue;
      if (afterFillState.type === "verification_required") {
        failWith(options, "verificationRequired", "SELLER_LOGIN_VERIFICATION_REQUIRED", "卖家中心登录需要短信或验证码");
      }
      if (afterFillState.type === "seller_pending" || afterFillState.type === "seller_submitting" || afterFillState.type === "seller_reload_required") {
        pendingStartedAt = afterFillState.type === "seller_pending" ? Date.now() : null;
        submittingStartedAt = afterFillState.type === "seller_submitting" ? Date.now() : null;
        await activePage.waitForTimeout(500).catch(() => {});
        continue;
      }

      if (!filled) {
        failWith(
          options,
          "passwordNotFilled",
          "SELLER_LOGIN_PASSWORD_NOT_FILLED",
          "卖家中心登录页未能自动填充密码，且没有运行时账号密码",
        );
      }
    }

    if (!(await ensureConsentChecked(activePage).catch(() => false))) {
      failWith(options, "consentNotChecked", "SELLER_LOGIN_CONSENT_NOT_CHECKED", "卖家中心登录协议复选框未成功勾选");
    }

    attempt += 1;

    const clicked = await clickSellerLoginButton(activePage);
    if (!clicked) {
      failWith(options, "buttonNotFound", "SELLER_LOGIN_BUTTON_NOT_FOUND", "找不到卖家中心登录/授权登录按钮");
    }

    const resolvedPage = await waitForSellerLoginResolved(context, activePage, {
      ...options,
      timeoutMs: options.afterClickTimeoutMs ?? 7000,
    });
    if (resolvedPage) return resolvedPage;

    activePage = livePageFromContext(context, activePage, options);
    if (!activePage) return null;
    const afterState = await sellerLoginState(activePage);
    if (afterState.type === "verification_required") {
      failWith(options, "verificationRequired", "SELLER_LOGIN_VERIFICATION_REQUIRED", "卖家中心登录需要短信或验证码");
    }
    if (afterState.type === "ready") return activePage;
    if (afterState.type === "seller_pending" || afterState.type === "seller_submitting" || afterState.type === "seller_reload_required" || afterState.type === "transition_closed") {
      pendingStartedAt = afterState.type === "seller_pending" ? Date.now() : null;
      submittingStartedAt = afterState.type === "seller_submitting" ? Date.now() : null;
      await activePage.waitForTimeout(500).catch(() => {});
      continue;
    }
    if (!(await handleConsentPrompt(activePage))) break;
  }

  failWith(options, "notSubmitted", "SELLER_LOGIN_NOT_SUBMITTED", "卖家中心登录/授权仍停留在登录页，请检查协议勾选或登录提示");
}

export const ensureSellerAuth = loginSellerIfNeeded;

export async function enterAgentAuthenticationIfShown(context, page, options = {}) {
  if (!page || page.isClosed() || !isAgentAuthenticationUrl(page.url())) return null;

  const clickPoint = await agentChinaSellerCenterPoint(page);
  if (!clickPoint) return null;

  const beforePages = new Set(context.pages());
  await clickCdpPoint(page, clickPoint.x, clickPoint.y);
  await wait(options.afterAgentAuthClickMs ?? 2500);

  const isAuthResultPage = (candidate) =>
    isSellerCenterUrl(candidate.url()) || (isAgentSellerUrl(candidate.url()) && !isAgentAuthenticationUrl(candidate.url()));

  return (
    (await waitForMatchingPage(context, (candidate) => !beforePages.has(candidate) && isAuthResultPage(candidate), 5000)) ||
    (await waitForMatchingPage(context, isAuthResultPage, 3000)) ||
    livePageFromContext(context, page, options)
  );
}

export async function agentChinaSellerCenterPoint(page) {
  return await page.evaluate(() => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const isVisible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const center = (rect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
    const isDisabled = (node) => {
      const className = String(node.className || "");
      const style = window.getComputedStyle(node);
      return (
        node.matches(":disabled") ||
        node.hasAttribute("disabled") ||
        node.getAttribute("aria-disabled") === "true" ||
        /disabled|not-allowed/i.test(className) ||
        style.cursor === "not-allowed" ||
        style.pointerEvents === "none"
      );
    };
    const visibleTextNode = (nodes, expectedText) =>
      Array.from(nodes).find(
        (node) => isVisible(node) && !isDisabled(node) && clean(node.innerText || node.textContent).includes(expectedText),
      );

    const authRoot = document.querySelector("#sca-auth-root");
    if (authRoot) {
      for (const row of authRoot.querySelectorAll('[class*="authentication_regionItem"]')) {
        if (!isVisible(row) || isDisabled(row)) continue;
        const rowText = clean(row.innerText || row.textContent);
        if (!rowText.includes("中国地区") || !rowText.includes("商家中心") || rowText.includes("敬请期待")) continue;

        const regionPre = visibleTextNode(row.querySelectorAll('[class*="authentication_regionPre"]'), "中国地区");
        const suffix = Array.from(row.querySelectorAll('[class*="authentication_regionSuffix"]')).find((node) =>
          isVisible(node),
        );
        const goto = visibleTextNode(row.querySelectorAll('[class*="authentication_goto"]'), "商家中心");
        if (!regionPre || !goto || (suffix && isDisabled(suffix))) continue;

        return center(goto.getBoundingClientRect());
      }
    }

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
