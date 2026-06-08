import { temuPageApiPost } from "./temu-page-api-client.mjs";
import { resolveMallByExactName } from "./temu-mall-resolver.mjs";

export const SELLER_ORIGIN = "https://seller.kuajingmaihuo.com";
export const USER_INFO_ENDPOINT = "/bg/quiet/api/mms/userInfo";
export const WITHDRAW_CASH_RECORD_ENDPOINT = "/api/merchant/payment/account/withdraw/cash/record";
export const SUCCESSFUL_WITHDRAWAL_STATUSES = new Set(["银行受理成功"]);

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function amountValue(amount) {
  const parsed = Number(amount?.value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatAmountObject(value, currencyCode = "CNY") {
  return {
    value,
    symbol: "¥",
    currencyCode,
    digitalText: (value / 100).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }),
  };
}

async function defaultSellerApiPost(page, endpoint, body = {}, { mallId } = {}, label = "Seller Center API") {
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
    throw new Error(`${label} HTTP ${response?.status || "unknown"}：${(response?.bodyText || "").slice(0, 1000)}`);
  }
  const responseBody = response.json;
  if (!responseBody || typeof responseBody !== "object") {
    throw new Error(`${label} 返回非 JSON：${(response.bodyText || "").slice(0, 1000)}`);
  }
  const errorCode = responseBody.errorCode ?? responseBody.error_code;
  if (responseBody.success === false || (errorCode !== undefined && Number(errorCode) !== 1000000)) {
    const message = responseBody.errorMsg || responseBody.error_msg || responseBody.message || "unknown";
    throw new Error(`${label} 返回失败：code=${errorCode ?? "unknown"} msg=${message}`);
  }
  return responseBody.result ?? {};
}

async function resolveMallIdByShopName(page, shopName, sellerApiPost) {
  const result = await sellerApiPost(page, USER_INFO_ENDPOINT, {}, {}, `${shopName} 卖家中心店铺列表接口`);
  return resolveMallByExactName(result, shopName).mallId;
}

export async function collectSuccessfulWithdrawalRecordsByShopName(page, shopName, {
  mallId,
  sellerApiPost = defaultSellerApiPost,
  pageSize = 100,
  maxPages = 50,
} = {}) {
  if (!shopName) throw new Error("提现记录采集缺少店铺名");
  const resolvedMallId = String(mallId || (await resolveMallIdByShopName(page, shopName, sellerApiPost)));
  if (!resolvedMallId) throw new Error(`${shopName} 提现记录采集缺少 mallId`);

  const records = [];
  let total = 0;

  for (let pageNo = 1; pageNo <= maxPages; pageNo += 1) {
    const body = { page: pageNo, pageSize };
    const result = await sellerApiPost(
      page,
      WITHDRAW_CASH_RECORD_ENDPOINT,
      body,
      { mallId: resolvedMallId },
      `${shopName} 提现记录接口`,
    );
    const resultList = Array.isArray(result.resultList) ? result.resultList : [];
    total = Number(result.total || resultList.length || total);
    records.push(...resultList);
    if (records.length >= total || resultList.length === 0) break;
  }

  const targetRecords = records.filter((record) => SUCCESSFUL_WITHDRAWAL_STATUSES.has(cleanText(record.withdrawCashStatus)));
  const totalsByStatus = Object.fromEntries([...SUCCESSFUL_WITHDRAWAL_STATUSES].map((status) => [status, 0]));
  for (const record of targetRecords) {
    const status = cleanText(record.withdrawCashStatus);
    totalsByStatus[status] += amountValue(record.withdrawCashAmountFormat);
  }

  const totalAmountInCents = Object.values(totalsByStatus).reduce((sum, value) => sum + value, 0);
  return {
    endpoint: `${SELLER_ORIGIN}${WITHDRAW_CASH_RECORD_ENDPOINT}`,
    request: {
      mallId: resolvedMallId,
      pageSize,
    },
    totalRecords: total,
    matchedRecords: targetRecords.map((record) => ({
      fundAccount: record.fundAccount || "",
      createTime: record.createTime || "",
      withdrawCashAmount: record.withdrawCashAmount || "",
      withdrawCashStatus: record.withdrawCashStatus || "",
      statusCode: record.statusCode ?? null,
      beneficiaryAccount: record.beneficiaryAccount || "",
      withdrawOrderId: record.withdrawOrderId || "",
      withdrawCashAmountFormat: record.withdrawCashAmountFormat || formatAmountObject(0),
    })),
    totalsByStatus: Object.fromEntries(
      Object.entries(totalsByStatus).map(([status, value]) => [status, formatAmountObject(value)]),
    ),
    totalAmount: formatAmountObject(totalAmountInCents),
  };
}
