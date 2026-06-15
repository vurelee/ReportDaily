import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SUCCESSFUL_WITHDRAWAL_STATUSES } from "./temu-shop-withdrawal-records.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportDir = process.env.TEMU_REPORT_DIR || path.join(rootDir, "temu-reports");
const args = process.argv.slice(2);
const targetTradeType = "货款提现";
const targetStatus = "银行受理成功";
const batchUpsertPath = "/api/integrations/finance/withdraw-records/batch-upsert";
const latestPath = "/api/integrations/finance/withdraw-records/latest";
const noSinceValues = new Set(["none", "all", "off", "false", "no"]);
const maxBatchRecords = 500;

async function loadLocalEnv() {
  const envPath = path.join(rootDir, ".env.local");
  let text = "";
  try {
    text = await fs.readFile(envPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equalIndex = line.indexOf("=");
    if (equalIndex <= 0) continue;
    const key = line.slice(0, equalIndex).trim();
    let value = line.slice(equalIndex + 1).trim();
    if (!key || process.env[key]) continue;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
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

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeNameForMatch(value) {
  return cleanText(value).toLowerCase();
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function parseOptions() {
  const sinceRaw = cleanText(getFlagValue("--since"));
  const sinceLower = sinceRaw.toLowerCase();
  let sinceMode = "auto";
  let since = "";

  if (!sinceRaw || sinceLower === "auto") {
    sinceMode = "auto";
  } else if (noSinceValues.has(sinceLower)) {
    sinceMode = "none";
  } else if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(sinceRaw)) {
    sinceMode = "manual";
    since = sinceRaw;
  } else {
    throw new Error(`--since 必须是 auto、none，或 YYYY-MM-DD HH:mm:ss：${sinceRaw}`);
  }

  return {
    inputPath: cleanText(getFlagValue("--input")),
    accountId: cleanText(getFlagValue("--account") || process.env.TEMU_ACCOUNT_ID),
    shopName: cleanText(getFlagValue("--shop")),
    sinceMode,
    since,
    dryRun: hasFlag("--dry-run"),
  };
}

async function findLatestShopFundsReport() {
  const entries = await fs.readdir(reportDir);
  const matches = entries
    .filter((name) => /^temu-(withdraw-records|shop-funds)-.+\.json$/.test(name) && !name.endsWith(".error.json"))
    .map((name) => path.join(reportDir, name));
  const stats = await Promise.all(matches.map(async (filePath) => ({ filePath, stat: await fs.stat(filePath) })));
  stats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  if (!stats[0]) throw new Error(`No withdraw-records or shop-funds report found in ${reportDir}`);
  return stats[0].filePath;
}

async function loadJson(inputPath) {
  return JSON.parse(await fs.readFile(inputPath, "utf8"));
}

function recordArraysFromContainer(container) {
  if (Array.isArray(container)) return [container];
  if (!container || typeof container !== "object") return [];
  return ["records", "matchedRecords", "resultList"].flatMap((key) => (Array.isArray(container[key]) ? [container[key]] : []));
}

function successfulRecordCandidatesFromShop(shop) {
  const containers = [
    ["successfulWithdrawalRecords", shop.successfulWithdrawalRecords],
    ["successfulWithdrawRecords", shop.successfulWithdrawRecords],
    ["withdrawalIncomeRecords", shop.withdrawalIncomeRecords],
    ["settledFunds.successfulWithdrawalRecords", shop.settledFunds?.successfulWithdrawalRecords],
  ];

  const sourceNames = [];
  const records = [];
  for (const [sourceName, container] of containers) {
    const arrays = recordArraysFromContainer(container);
    if (arrays.length === 0) continue;
    sourceNames.push(sourceName);
    records.push(...arrays.flat());
  }

  const warnings = [];
  const pendingMatchedRecords = shop.settledFunds?.withdrawalRecords?.matchedRecords;
  if (records.length === 0 && Array.isArray(pendingMatchedRecords) && pendingMatchedRecords.length > 0) {
    warnings.push(
      `${shop.shopName || "(unknown shop)"}: ignored settledFunds.withdrawalRecords.matchedRecords because it is the pending settled-funds list, not successful withdrawal income.`,
    );
  }

  return {
    records,
    source: sourceNames.join(",") || "",
    warnings,
  };
}

function entriesFromReport(report) {
  const entries = [];

  if (Array.isArray(report.records)) {
    entries.push({
      accountId: cleanText(report.accountId),
      accountLabel: cleanText(report.accountLabel),
      shopName: cleanText(report.shopName || report.store?.name),
      records: report.records,
      source: "records",
      warnings: [],
    });
  }

  if (Array.isArray(report.shops)) {
    for (const shop of report.shops) {
      const candidates = successfulRecordCandidatesFromShop(shop);
      entries.push({
        accountId: cleanText(report.accountId),
        accountLabel: cleanText(report.accountLabel),
        shopName: cleanText(shop.shopName),
        records: candidates.records,
        source: candidates.source,
        warnings: candidates.warnings,
      });
    }
  }

  for (const result of Array.isArray(report.results) ? report.results : []) {
    const accountId = cleanText(result.account?.id || result.accountId);
    const accountLabel = cleanText(result.account?.label || result.accountLabel);
    for (const shop of Array.isArray(result.shops) ? result.shops : []) {
      const candidates = successfulRecordCandidatesFromShop(shop);
      entries.push({
        accountId,
        accountLabel,
        shopName: cleanText(shop.shopName),
        records: candidates.records,
        source: candidates.source,
        warnings: candidates.warnings,
      });
    }
  }

  return entries;
}

function amountFromRecord(record) {
  const cents = Number(record.withdrawCashAmountFormat?.value);
  if (Number.isFinite(cents)) return Number((cents / 100).toFixed(2));

  const candidates = [
    record.withdrawCashAmountFormat?.digitalText,
    record.withdrawCashAmount,
    record.amount,
  ];
  for (const candidate of candidates) {
    const match = String(candidate ?? "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
    if (!match) continue;
    const amount = Number(match[0]);
    if (Number.isFinite(amount)) return amount;
  }
  return null;
}

function normalizeRecord(record) {
  const tradeType = cleanText(record.fundAccount || record.tradeType);
  const status = cleanText(record.withdrawCashStatus || record.status);
  const withdrawAt = cleanText(record.createTime || record.withdrawAt);
  const amount = amountFromRecord(record);
  return {
    tradeType,
    withdrawAt,
    amount,
    status,
    bankAccount: cleanText(record.beneficiaryAccount || record.bankAccount),
    sourceKey: cleanText(record.withdrawOrderId) || `${withdrawAt}|${amount}|${status}|${cleanText(record.beneficiaryAccount)}`,
  };
}

function accountMatches(entry, accountId) {
  if (!accountId) return true;
  return entry.accountId === accountId;
}

function shopMatches(entry, shopName) {
  if (!shopName) return true;
  return normalizeNameForMatch(entry.shopName) === normalizeNameForMatch(shopName);
}

function buildPayloads(entries, options) {
  const warnings = [];
  const groups = new Map();

  for (const entry of entries) {
    if (!accountMatches(entry, options.accountId)) continue;
    if (!shopMatches(entry, options.shopName)) continue;
    warnings.push(...entry.warnings);
    if (!entry.shopName) {
      warnings.push("Skipped records without shopName; ERP payload requires store.name.");
      continue;
    }

    const groupKey = normalizeNameForMatch(entry.shopName);
    const group = groups.get(groupKey) || {
      accountId: entry.accountId,
      shopName: entry.shopName,
      records: [],
      sourceNames: new Set(),
    };
    if (entry.source) group.sourceNames.add(entry.source);

    for (const rawRecord of entry.records) {
      const record = normalizeRecord(rawRecord);
      if (record.tradeType !== targetTradeType) continue;
      if (!SUCCESSFUL_WITHDRAWAL_STATUSES.has(record.status) || record.status !== targetStatus) continue;
      if (!record.withdrawAt || record.amount === null) {
        warnings.push(`${entry.shopName}: skipped one record with missing withdrawAt or amount.`);
        continue;
      }
      group.records.push(record);
    }

    groups.set(groupKey, group);
  }

  const payloads = [];
  for (const group of groups.values()) {
    const seen = new Set();
    const deduped = [];
    for (const record of group.records) {
      if (seen.has(record.sourceKey)) continue;
      seen.add(record.sourceKey);
      deduped.push(record);
    }
    if (deduped.length === 0) continue;

    payloads.push({
      accountId: group.accountId,
      source: [...group.sourceNames].join(","),
      store: {
        platform: "TEMU",
        name: group.shopName,
      },
      records: deduped.map(({ sourceKey, ...record }, index) => ({
        sequence: index + 1,
        ...record,
      })),
    });
  }

  payloads.sort((a, b) => a.store.name.localeCompare(b.store.name));
  return { payloads, warnings: [...new Set(warnings)] };
}

function baseUrl() {
  return String(process.env.STOCKHELP_BASE_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
}

function apiUrl() {
  return `${baseUrl()}${batchUpsertPath}`;
}

function latestApiUrl(storeName) {
  const params = new URLSearchParams({ platform: "TEMU", storeName });
  return `${baseUrl()}${latestPath}?${params.toString()}`;
}

function integrationToken() {
  return process.env.STOCKHELP_INTEGRATION_API_TOKEN || process.env.INTEGRATION_API_TOKEN || "";
}

function authHeaders() {
  const token = integrationToken();
  if (!token) {
    throw new Error("Missing STOCKHELP_INTEGRATION_API_TOKEN or INTEGRATION_API_TOKEN.");
  }
  return {
    Authorization: `Bearer ${token}`,
  };
}

async function fetchLatestCursor(storeName) {
  const response = await fetch(latestApiUrl(storeName), {
    method: "GET",
    headers: authHeaders(),
  });
  const bodyText = await response.text();
  if (response.status === 404) {
    return {
      cursor: "",
      reason: "store-not-found",
      store: null,
      latestRecord: null,
    };
  }
  if (!response.ok) {
    throw new Error(`${storeName}: ERP latest API HTTP ${response.status}: ${bodyText.slice(0, 1000)}`);
  }

  const body = bodyText ? JSON.parse(bodyText) : {};
  const data = body?.data && typeof body.data === "object" ? body.data : {};
  const latestRecord = data.latestRecord || null;
  return {
    cursor: cleanText(latestRecord?.withdrawAtText),
    reason: data.store ? (latestRecord ? "latest-record" : "latest-record-null") : "store-not-found",
    store: data.store || null,
    latestRecord,
  };
}

function renumberRecords(records) {
  return records.map(({ sequence, ...record }, index) => ({
    sequence: index + 1,
    ...record,
  }));
}

function filterRecordsAfter(records, since) {
  if (!since) return renumberRecords(records);
  return renumberRecords(records.filter((record) => record.withdrawAt > since));
}

async function applySince(payloads, options) {
  if (options.sinceMode === "none") {
    return payloads.map((payload) => ({
      ...payload,
      records: renumberRecords(payload.records),
      since: {
        mode: "none",
        cursor: "",
        note: "latest query skipped; submitting all collected successful records and relying on ERP upsert idempotency.",
      },
    }));
  }

  if (options.sinceMode === "manual") {
    return payloads.map((payload) => ({
      ...payload,
      records: filterRecordsAfter(payload.records, options.since),
      since: {
        mode: "manual",
        cursor: options.since,
        note: "submitting records later than the manual cursor.",
      },
    }));
  }

  const resolved = [];
  for (const payload of payloads) {
    const latest = await fetchLatestCursor(payload.store.name);
    const hasCursor = Boolean(latest.cursor);
    resolved.push({
      ...payload,
      records: hasCursor ? filterRecordsAfter(payload.records, latest.cursor) : renumberRecords(payload.records),
      since: {
        mode: "auto",
        cursor: latest.cursor,
        reason: latest.reason,
        storeFound: Boolean(latest.store),
        latestRecordFound: Boolean(latest.latestRecord),
        note: hasCursor
          ? "latest cursor found; submitting records later than latestRecord.withdrawAtText."
          : "store missing or latestRecord is null; submitting all collected successful records.",
      },
    });
  }
  return resolved;
}

function sinceLabel(options) {
  if (options.sinceMode === "manual") return `manual ${options.since}`;
  if (options.sinceMode === "none") return "none (latest query skipped)";
  return "auto (default; query ERP latest cursor per store)";
}

function sinceSummary(payload) {
  const since = payload.since || {};
  if (since.mode === "manual") return `manual cursor ${since.cursor}; records later than this time`;
  if (since.mode === "none") return "none; latest query skipped and all collected successful records are kept";
  if (since.cursor) return `auto cursor ${since.cursor}; records later than latestRecord.withdrawAtText`;
  return `auto cursor none (${since.reason || "no latest record"}); all collected successful records are kept`;
}

function sinceRuleText(options) {
  if (options.sinceMode !== "auto") return "";
  return "Auto-since rule: if the ERP latest API cannot find the store or latestRecord is null, all collected successful records are kept; if latestRecord.withdrawAtText exists, only later records are kept.";
}

function apiUrlTextForOutput() {
  const baseUrl = String(process.env.STOCKHELP_BASE_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
  return {
    batch: `${baseUrl}${batchUpsertPath}`,
    latest: `${baseUrl}${latestPath}?platform=TEMU&storeName=<shopName>`,
  };
}

function formatAmount(value) {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function summarizePayload(payload) {
  const times = payload.records.map((record) => record.withdrawAt).sort();
  const totalAmount = payload.records.reduce((sum, record) => sum + record.amount, 0);
  return {
    count: payload.records.length,
    start: times[0] || "-",
    end: times[times.length - 1] || "-",
    totalAmount,
  };
}

function splitPayload(payload, batchSize = maxBatchRecords) {
  if (payload.records.length <= batchSize) return [payload];
  const chunks = [];
  for (let index = 0; index < payload.records.length; index += batchSize) {
    chunks.push({
      ...payload,
      records: payload.records.slice(index, index + batchSize),
      chunkIndex: chunks.length + 1,
    });
  }
  return chunks.map((chunk) => ({
    ...chunk,
    chunkCount: chunks.length,
  }));
}

function printDryRun({ inputPath, options, payloads, warnings }) {
  const urls = apiUrlTextForOutput();
  console.log("Dry run: no ERP batch-upsert request sent.");
  console.log(`Input: ${inputPath}`);
  console.log(`Batch API URL: ${urls.batch}`);
  console.log(`Latest API URL: ${urls.latest}`);
  console.log(`Account filter: ${options.accountId || "(none)"}`);
  console.log(`Shop filter: ${options.shopName || "(none)"}`);
  console.log(`Since: ${sinceLabel(options)}`);
  const ruleText = sinceRuleText(options);
  if (ruleText) console.log(ruleText);

  if (payloads.length === 0) {
    console.log("No payloads would be submitted.");
  }

  for (const payload of payloads) {
    const summary = summarizePayload(payload);
    console.log(`Payload store: ${JSON.stringify(payload.store)}`);
    console.log(`Since cursor: ${sinceSummary(payload)}`);
    console.log(
      `Records: ${summary.count}; range: ${summary.start} -> ${summary.end}; totalAmount: CNY ${formatAmount(summary.totalAmount)}`,
    );
    if (summary.count > maxBatchRecords) {
      console.log(`Batch split: ${Math.ceil(summary.count / maxBatchRecords)} requests; max ${maxBatchRecords} records per request.`);
    }
  }

  for (const warning of warnings) {
    console.warn(`Warning: ${warning}`);
  }
}

async function submitPayload(payload) {
  const response = await fetch(apiUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify({
      store: payload.store,
      records: payload.records,
    }),
  });
  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`${payload.store.name}: ERP API HTTP ${response.status}: ${bodyText.slice(0, 1000)}`);
  }
  const body = bodyText ? JSON.parse(bodyText) : {};
  return body?.data || null;
}

async function main() {
  const options = parseOptions();
  const inputPath = path.resolve(options.inputPath || (await findLatestShopFundsReport()));
  const report = await loadJson(inputPath);
  const entries = entriesFromReport(report);
  const { payloads: unfilteredPayloads, warnings } = buildPayloads(entries, options);
  const payloads = await applySince(unfilteredPayloads, options);

  if (options.dryRun) {
    printDryRun({ inputPath, options, payloads, warnings });
    return;
  }

  const submitPayloads = payloads.filter((payload) => payload.records.length > 0);
  if (submitPayloads.length === 0) {
    console.log("No payloads to submit.");
    for (const payload of payloads) {
      console.log(`${payload.store.name}: no records after since filter (${sinceSummary(payload)}).`);
    }
    for (const warning of warnings) console.warn(`Warning: ${warning}`);
    return;
  }

  for (const payload of submitPayloads) {
    const summary = summarizePayload(payload);
    const chunks = splitPayload(payload);
    const totals = {
      addedCount: 0,
      updatedCount: 0,
      skippedCount: 0,
    };
    for (const chunk of chunks) {
      const result = await submitPayload(chunk);
      if (result) {
        totals.addedCount += Number(result.addedCount || 0);
        totals.updatedCount += Number(result.updatedCount || 0);
        totals.skippedCount += Number(result.skippedCount || 0);
      }
      if (chunks.length > 1) {
        const chunkSummary = summarizePayload(chunk);
        console.log(
          `${payload.store.name}: submitted chunk ${chunk.chunkIndex}/${chunk.chunkCount}, ${chunkSummary.count} records, ${chunkSummary.start} -> ${chunkSummary.end}`,
        );
      }
    }
    const resultText = `; ERP added ${totals.addedCount}, updated ${totals.updatedCount}, skipped ${totals.skippedCount}`;
    console.log(
      `${payload.store.name}: submitted ${summary.count} records, ${summary.start} -> ${summary.end}, CNY ${formatAmount(summary.totalAmount)}${resultText}`,
    );
  }
}

await loadLocalEnv();
await main().catch((error) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
