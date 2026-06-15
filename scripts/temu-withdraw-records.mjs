import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { closeCdpChromeProcess, closeCdpPages } from "./cdp-page-cleanup.mjs";
import { connectCdpChrome } from "./chrome-cdp.mjs";
import {
  bodyText,
  loginSellerIfNeeded,
  needsVerification,
  waitForMatchingPage,
} from "./temu-login-helper.mjs";
import { extractMallList, resolveMallByName } from "./temu-mall-resolver.mjs";
import { temuPageApiPost } from "./temu-page-api-client.mjs";
import { closeTemuPopups } from "./temu-popup-cleaner.mjs";
import {
  collectSuccessfulWithdrawalRecordsByShopName,
  SELLER_ORIGIN,
  USER_INFO_ENDPOINT,
} from "./temu-shop-withdrawal-records.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const accountsPath = process.env.TEMU_ACCOUNTS_CONFIG || path.join(rootDir, "temu-accounts.json");
const reportDir = process.env.TEMU_REPORT_DIR || path.join(rootDir, "temu-reports");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const targetUrl = process.env.TEMU_WITHDRAW_RECORDS_URL || "https://seller.kuajingmaihuo.com/labor/account";
const args = process.argv.slice(2);

await fs.mkdir(reportDir, { recursive: true });

class TemuWithdrawRecordsError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "TemuWithdrawRecordsError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new TemuWithdrawRecordsError(code, message);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function getFlagValue(name) {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  if (index === -1) return "";
  const value = args[index + 1] || "";
  return value.startsWith("--") ? "" : value;
}

function hasFlag(name) {
  return args.includes(name);
}

function splitList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseOptions() {
  return {
    accountIds: splitList(getFlagValue("--account") || process.env.TEMU_ACCOUNT_ID || process.env.TEMU_ACCOUNT_IDS),
    shopNames: splitList(getFlagValue("--shop") || process.env.TEMU_WITHDRAW_SHOPS || process.env.TEMU_FUNDS_SHOPS),
    since: cleanText(getFlagValue("--since")),
    submit: hasFlag("--submit"),
    dryRun: hasFlag("--dry-run"),
  };
}

function shopListForAccount(account, options) {
  if (options.shopNames.length > 0) return options.shopNames;
  return [...new Set([...(account.shops || [])])];
}

function cdpOptions(account) {
  return {
    cdpPort: account.cdpPort,
    cdpProfileDir: account.cdpProfileDir,
    temuHomeUrl: targetUrl,
  };
}

async function waitSettled(page) {
  if (!page || page.isClosed()) return;
  await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
  if (page.isClosed()) return;
  await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
  if (page.isClosed()) return;
  await page.waitForTimeout(700).catch(() => {});
  if (page.isClosed()) return;
  await closeTemuPopups(page).catch(() => {});
}

async function waitForSellerPage(context, timeoutMs = 8000) {
  return await waitForMatchingPage(
    context,
    (candidate) => candidate.url().startsWith("https://seller.kuajingmaihuo.com/"),
    timeoutMs,
  );
}

async function ensureSellerPage(context, page) {
  let activePage = page && !page.isClosed() ? page : await context.newPage();
  await activePage.goto(targetUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
  await waitSettled(activePage);

  const text = await bodyText(activePage);
  if (needsVerification(text)) fail("SELLER_LOGIN_VERIFICATION_REQUIRED", "卖家中心登录需要短信或验证码");
  activePage =
    (await loginSellerIfNeeded(context, activePage, {
      fail,
      errorCodes: {
        passwordNotFilled: "SELLER_LOGIN_AUTOFILL_NOT_CONFIRMED",
      },
      messages: {
        passwordNotFilled: "卖家中心登录自动填充或登录完成状态未确认，且没有运行时账号密码",
      },
    })) || activePage;

  if (!activePage.url().startsWith("https://seller.kuajingmaihuo.com/")) {
    activePage = (await waitForSellerPage(context, 3000)) || activePage;
  }
  if (!activePage.url().startsWith(targetUrl)) {
    await activePage.goto(targetUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
    await waitSettled(activePage);
  }
  return activePage;
}

async function sellerApiPost(page, endpoint, body = {}, { mallId } = {}, label = "Seller Center API") {
  const response = await temuPageApiPost(page, {
    origin: SELLER_ORIGIN,
    endpoint,
    body,
    mallId,
    label,
    headers: {
      accept: "*/*",
    },
  });

  if (!response?.ok) {
    fail("SELLER_API_HTTP_FAILED", `${label} HTTP ${response?.status || "unknown"}：${(response?.bodyText || "").slice(0, 1000)}`);
  }
  const responseBody = response.json;
  if (!responseBody || typeof responseBody !== "object") {
    fail("SELLER_API_RESPONSE_NOT_JSON", `${label} 返回非 JSON：${(response.bodyText || "").slice(0, 1000)}`);
  }
  const errorCode = responseBody.errorCode ?? responseBody.error_code;
  if (responseBody.success === false || (errorCode !== undefined && Number(errorCode) !== 1000000)) {
    const message = responseBody.errorMsg || responseBody.error_msg || responseBody.message || "unknown";
    fail("SELLER_API_RESPONSE_FAILED", `${label} 返回失败：code=${errorCode ?? "unknown"} msg=${message}`);
  }
  return responseBody.result ?? {};
}

async function sellerMallList(page) {
  const result = await sellerApiPost(page, USER_INFO_ENDPOINT, {}, {}, "卖家中心店铺列表接口");
  const malls = extractMallList(result);
  if (!Array.isArray(malls) || malls.length === 0) {
    fail("SELLER_MALL_LIST_EMPTY", "卖家中心店铺列表接口没有返回可切换店铺");
  }
  return malls;
}

function mallInfoForShop(malls, shopName) {
  try {
    const resolved = resolveMallByName(malls, shopName, { caseInsensitive: true });
    return {
      mallId: resolved.mallId,
      mallName: resolved.mallName,
      raw: resolved.raw,
    };
  } catch (error) {
    fail("SELLER_SHOP_TARGET_NOT_FOUND", errorMessage(error));
  }
}

async function runAccount(account, options) {
  console.error(`Running withdraw records account: ${account.label || account.id}`);
  const shops = shopListForAccount(account, options);
  if (shops.length === 0) fail("SHOP_LIST_EMPTY", `${account.id} 没有配置提现记录店铺`);

  const { browser, context, page } = await connectCdpChrome(targetUrl, cdpOptions(account));
  const shopResults = [];
  try {
    const activePage = await ensureSellerPage(context, page);
    const malls = await sellerMallList(activePage);

    for (const requestedShopName of shops) {
      const mallInfo = mallInfoForShop(malls, requestedShopName);
      const successfulWithdrawalRecords = await collectSuccessfulWithdrawalRecordsByShopName(activePage, mallInfo.mallName, {
        mallId: mallInfo.mallId,
        sellerApiPost,
      });
      const count = successfulWithdrawalRecords.matchedRecords.length;
      const total = successfulWithdrawalRecords.totalAmount.digitalText;
      shopResults.push({
        shopName: mallInfo.mallName,
        requestedShopName,
        mallId: mallInfo.mallId,
        successfulWithdrawalRecords,
        source: "seller-center-withdraw-record-api",
      });
      console.error(`${mallInfo.mallName}: 银行受理成功提现 ${count} 笔，CNY ${total}`);
    }

    return {
      account,
      ok: true,
      shops: shopResults,
    };
  } finally {
    await closeCdpPages(context).catch(() => {});
    await browser.close().catch(() => {});
    await closeCdpChromeProcess(account.cdpPort).catch(() => {});
  }
}

function shopMessage(shop) {
  return `${shop.shopName} 银行受理成功提现 ${shop.successfulWithdrawalRecords.matchedRecords.length} 笔，CNY ${shop.successfulWithdrawalRecords.totalAmount.digitalText}`;
}

function execFileText(command, execArgs, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, execArgs, options, (error, stdout, stderr) => {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      if (error) {
        reject(new Error(`${command} ${execArgs.join(" ")} failed: ${error.message}`));
        return;
      }
      resolve();
    });
  });
}

async function submitOutput(outputPath, options) {
  const submitScript = path.join(rootDir, "scripts/temu-submit-withdraw-records.mjs");
  const submitArgs = [submitScript, "--input", outputPath];
  if (options.shopNames.length === 1) submitArgs.push("--shop", options.shopNames[0]);
  if (options.since) submitArgs.push("--since", options.since);
  if (options.dryRun) submitArgs.push("--dry-run");
  await execFileText(process.execPath, submitArgs, {
    cwd: rootDir,
    env: process.env,
    maxBuffer: 1024 * 1024 * 20,
  });
}

async function main() {
  const options = parseOptions();
  const rawConfig = JSON.parse(await fs.readFile(accountsPath, "utf8"));
  const accounts = (rawConfig.accounts || []).filter(
    (account) => options.accountIds.length === 0 || options.accountIds.includes(account.id),
  );
  if (accounts.length === 0) {
    fail("ACCOUNT_NOT_FOUND", `没有匹配账号：${options.accountIds.join(",") || "(all)"}`);
  }

  const results = [];
  for (const account of accounts) {
    try {
      results.push(await runAccount(account, options));
    } catch (error) {
      const message = errorMessage(error);
      console.error(`【${account.label || account.id}】失败：${message}`);
      results.push({ account, ok: false, error: message });
    }
  }

  const ok = results.every((result) => result.ok);
  const output = {
    generatedAt: new Date().toISOString(),
    accountsPath,
    targetUrl,
    message: ok
      ? results
          .flatMap((result) => result.shops || [])
          .map(shopMessage)
          .join("；")
      : results.map((result) => (result.ok ? `【${result.account.label || result.account.id}】成功` : `【${result.account.label || result.account.id}】失败：${result.error}`)).join("；"),
    results,
  };

  const outputPath = path.join(reportDir, `temu-withdraw-records-${stamp}.json`);
  await fs.writeFile(outputPath, JSON.stringify(output, null, 2));
  console.log(output.message);
  console.log(`Saved JSON: ${outputPath}`);

  if (!ok) {
    process.exitCode = 1;
    return;
  }

  if (options.submit) {
    await submitOutput(outputPath, options);
  }
}

await main().catch(async (error) => {
  const outputPath = path.join(reportDir, `temu-withdraw-records-${stamp}.error.json`);
  const output = {
    generatedAt: new Date().toISOString(),
    accountsPath,
    targetUrl,
    ok: false,
    error: errorMessage(error),
  };
  await fs.writeFile(outputPath, JSON.stringify(output, null, 2)).catch(() => {});
  console.error(errorMessage(error));
  console.error(`Saved JSON: ${outputPath}`);
  process.exitCode = 1;
});
