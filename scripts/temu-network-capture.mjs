import fs from "node:fs/promises";
import path from "node:path";

const enabledValues = new Set(["1", "true", "yes", "on"]);
const fetchResourceTypes = new Set(["fetch", "xhr"]);
const sensitiveKeyPattern = /cookie|authorization|password|passwd|pwd|token|secret|sign|signature|csrf|xsrf|session|ticket|credential|key/i;
const businessKeywordPattern =
  /report|data|product|goods|sku|spu|sale|sales|amount|quantity|order|warehouse|abnormal|auth-warehouse|po|region|shop|商品|销售|件数|订单|异常|区域|店铺/i;
const telemetryKeywordPattern =
  /log|metric|analytics|tracking|track|beacon|collect|monitor|perf|performance|sentry|rum|stat/i;
const noisyEndpointPattern =
  /\/pmm\/api\/pmm\/|\/bg-loran-portal\/behavior\/audit\/tracker|\/api\/server\/_stm|\/api\/phantom\/|\/drogon-api\//i;

function isEnabled() {
  return enabledValues.has(String(process.env.TEMU_CAPTURE_NETWORK || "").trim().toLowerCase());
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function safeFilePart(value) {
  return String(value || "unknown")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "unknown";
}

function truncate(value, maxLength) {
  const text = String(value || "");
  return text.length > maxLength ? `${text.slice(0, maxLength)}...<truncated ${text.length - maxLength} chars>` : text;
}

function redactScalar(key, value) {
  if (sensitiveKeyPattern.test(String(key || ""))) return "<redacted>";
  if (typeof value !== "string") return value;
  return value
    .replace(/(authorization|token|sign|signature|csrf|xsrf|session|ticket|password|passwd|pwd)=([^&\s]+)/gi, "$1=<redacted>")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1<redacted>");
}

function sanitizeObject(value, depth = 0) {
  if (depth > 10) return "<max-depth>";
  if (Array.isArray(value)) {
    const items = value.slice(0, 20).map((item) => sanitizeObject(item, depth + 1));
    if (value.length > 20) items.push(`<truncated ${value.length - 20} items>`);
    return items;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    const sanitized = {};
    for (const [key, item] of entries.slice(0, 80)) {
      sanitized[key] = sensitiveKeyPattern.test(key) ? "<redacted>" : sanitizeObject(item, depth + 1);
    }
    if (entries.length > 80) sanitized.__truncatedKeys = entries.length - 80;
    return sanitized;
  }
  if (typeof value === "string") return truncate(redactScalar("", value), 1200);
  return value;
}

function sanitizeHeaders(headers = {}) {
  const keep = {};
  for (const [key, value] of Object.entries(headers)) {
    keep[key] = redactScalar(key, value);
  }
  return keep;
}

function sanitizeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    for (const [key] of url.searchParams) {
      if (sensitiveKeyPattern.test(key)) {
        url.searchParams.set(key, "<redacted>");
      }
    }
    return url.toString();
  } catch {
    return truncate(redactScalar("url", rawUrl), 4000);
  }
}

function urlHost(rawUrl) {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return "";
  }
}

function parsePayload(text, contentType = "") {
  if (!text) return null;
  const trimmed = String(text).trim();
  if (!trimmed) return null;

  if (contentType.includes("application/json") || trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return sanitizeObject(JSON.parse(trimmed));
    } catch {
      return { preview: truncate(redactScalar("payload", trimmed), 5000) };
    }
  }

  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    /^[^=&]+=[\s\S]*&?[^=&]*=?[\s\S]*$/.test(trimmed)
  ) {
    try {
      const params = new URLSearchParams(trimmed);
      const body = {};
      for (const [key, value] of params.entries()) {
        body[key] = redactScalar(key, value);
      }
      return body;
    } catch {
      return { preview: truncate(redactScalar("payload", trimmed), 5000) };
    }
  }

  return { preview: truncate(redactScalar("payload", trimmed), 5000) };
}

function scoreRequest({ url, method, postData, contentType, responsePreview }) {
  const text = [url, method, contentType, postData, responsePreview].filter(Boolean).join("\n");
  let score = 0;
  if (businessKeywordPattern.test(text)) score += 3;
  if (/\/api\/|\/bg\/|\/api\?|\/query|\/list|\/search|\/page/i.test(url)) score += 2;
  if (/POST|PUT|PATCH/i.test(method)) score += 1;
  if (telemetryKeywordPattern.test(url) && score < 5) score -= 2;
  return score;
}

function shouldCaptureRequest(request) {
  const rawUrl = request.url();
  const host = urlHost(rawUrl);
  if (!host.includes("temu.com") && !host.includes("kuajingmaihuo.com")) return false;
  if (!fetchResourceTypes.has(request.resourceType())) return false;
  if (process.env.TEMU_CAPTURE_NETWORK_ALL !== "1" && noisyEndpointPattern.test(rawUrl)) return false;
  return true;
}

function responseContentType(response) {
  return String(response.headers()["content-type"] || "").toLowerCase();
}

function shouldReadResponseBody(response) {
  const contentType = responseContentType(response);
  return (
    contentType.includes("application/json") ||
    contentType.includes("text/") ||
    contentType.includes("application/x-www-form-urlencoded")
  );
}

function waitForSettled(promises, timeoutMs) {
  return Promise.race([
    Promise.allSettled(promises),
    new Promise((resolve) => setTimeout(() => resolve([]), timeoutMs)),
  ]);
}

export function createTemuNetworkCapture(options = {}) {
  const enabled = isEnabled();
  const maxEvents = positiveInteger(process.env.TEMU_CAPTURE_NETWORK_MAX_EVENTS, 800);
  const maxBodyChars = positiveInteger(process.env.TEMU_CAPTURE_NETWORK_MAX_BODY_CHARS, 120000);
  const reportDir = options.reportDir || process.cwd();
  const stamp = options.stamp || new Date().toISOString().replace(/[:.]/g, "-");
  const kind = safeFilePart(options.kind || "network");
  const label = safeFilePart(options.accountLabel || options.accountId || options.reportPrefix || "all");
  const outputPath = path.join(reportDir, `temu-network-capture-${kind}-${label}-${stamp}.json`);

  if (!enabled) {
    return {
      enabled: false,
      outputPath: "",
      attach() {},
      detach() {},
      mark() {},
      async settle() {},
      getEvents() {
        return [];
      },
      async flush() {
        return "";
      },
    };
  }

  const requestMeta = new Map();
  const pending = new Set();
  const events = [];
  const markers = [];
  const attachedContexts = new Set();
  let skippedEvents = 0;
  let currentMarker = null;

  function pushEvent(event) {
    if (events.length >= maxEvents) {
      skippedEvents += 1;
      return;
    }
    events.push(event);
  }

  function mark(label, data = {}) {
    currentMarker = {
      at: new Date().toISOString(),
      label,
      data: sanitizeObject(data),
    };
    markers.push(currentMarker);
  }

  function onRequest(request) {
    if (!shouldCaptureRequest(request)) return;
    const headers = request.headers();
    const contentType = String(headers["content-type"] || "").toLowerCase();
    const postData = request.postData() || "";
    requestMeta.set(request, {
      at: new Date().toISOString(),
      url: sanitizeUrl(request.url()),
      rawUrl: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      headers: sanitizeHeaders(headers),
      postData: parsePayload(postData, contentType),
      postDataPreview: truncate(redactScalar("payload", postData), 5000),
      marker: currentMarker,
    });
  }

  function onResponse(response) {
    const request = response.request();
    if (!requestMeta.has(request)) return;

    const task = (async () => {
      const requestInfo = requestMeta.get(request);
      const headers = response.headers();
      const contentType = responseContentType(response);
      let responseText = "";
      let responseBody = null;
      let bodyError = "";

      if (shouldReadResponseBody(response)) {
        try {
          const body = await response.body();
          responseText = body.toString("utf8");
          responseBody = parsePayload(responseText, contentType);
        } catch (error) {
          bodyError = error instanceof Error ? error.message : String(error);
        }
      }

      const responsePreview = truncate(redactScalar("response", responseText), maxBodyChars);
      const score = scoreRequest({
        url: requestInfo.rawUrl,
        method: requestInfo.method,
        postData: requestInfo.postDataPreview,
        contentType,
        responsePreview,
      });

      pushEvent({
        type: "response",
        at: new Date().toISOString(),
        score,
        request: {
          at: requestInfo.at,
          url: requestInfo.url,
          method: requestInfo.method,
          resourceType: requestInfo.resourceType,
          headers: requestInfo.headers,
          postData: requestInfo.postData,
          postDataPreview: requestInfo.postDataPreview,
        },
        response: {
          status: response.status(),
          ok: response.ok(),
          url: sanitizeUrl(response.url()),
          headers: sanitizeHeaders(headers),
          contentType,
          body: responseBody,
          bodyPreview: responsePreview,
          bodyError,
        },
        marker: requestInfo.marker,
      });
    })();

    pending.add(task);
    task.finally(() => pending.delete(task));
  }

  function onRequestFailed(request) {
    if (!requestMeta.has(request)) return;
    const requestInfo = requestMeta.get(request);
    pushEvent({
      type: "requestfailed",
      at: new Date().toISOString(),
      request: {
        at: requestInfo.at,
        url: requestInfo.url,
        method: requestInfo.method,
        resourceType: requestInfo.resourceType,
        headers: requestInfo.headers,
        postData: requestInfo.postData,
        postDataPreview: requestInfo.postDataPreview,
      },
      failure: request.failure()?.errorText || "",
      marker: requestInfo.marker,
    });
  }

  function attach(context) {
    if (!context || attachedContexts.has(context)) return;
    context.on("request", onRequest);
    context.on("response", onResponse);
    context.on("requestfailed", onRequestFailed);
    attachedContexts.add(context);
  }

  function detach(context) {
    if (!context || !attachedContexts.has(context)) return;
    context.off("request", onRequest);
    context.off("response", onResponse);
    context.off("requestfailed", onRequestFailed);
    attachedContexts.delete(context);
  }

  async function flush(extra = {}) {
    await settle(positiveInteger(process.env.TEMU_CAPTURE_NETWORK_FLUSH_TIMEOUT_MS, 7000));
    for (const context of [...attachedContexts]) detach(context);
    await fs.mkdir(reportDir, { recursive: true });
    const sortedEvents = [...events].sort((a, b) => {
      const scoreDiff = (b.score || 0) - (a.score || 0);
      return scoreDiff || String(a.at).localeCompare(String(b.at));
    });
    await fs.writeFile(
      outputPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          options: sanitizeObject(options),
          extra: sanitizeObject(extra),
          maxEvents,
          maxBodyChars,
          skippedEvents,
          markers,
          events: sortedEvents,
        },
        null,
        2,
      ),
    );
    return outputPath;
  }

  async function settle(timeoutMs = 3000) {
    await waitForSettled([...pending], timeoutMs);
  }

  function getEvents() {
    return events;
  }

  return {
    enabled,
    outputPath,
    attach,
    detach,
    mark,
    settle,
    getEvents,
    flush,
  };
}
